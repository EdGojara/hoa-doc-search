-- ============================================================================
-- 121_community_map_audit_and_acks.sql
-- ----------------------------------------------------------------------------
-- Security spine for the Community Map module (project_community_map.md, in
-- design 2026-05-28). Creates the audit + confidentiality-acknowledgment
-- tables BEFORE the feature endpoints land, so when board-portal auth ships
-- in Phase 4 the audit infrastructure is already battle-tested by staff use.
--
-- The Community Map exposes per-property data (occupancy, AR, DRV, ACC) by
-- layer + property-click side panel. Board members will eventually access a
-- redacted view scoped to their assigned community. AR/collections data in
-- particular is executive-session-confidential under TX §209.0051(e); we
-- log every property-click + every map-data fetch so any post-hoc dispute
-- about who saw what has receipts. Confidentiality acks ship alongside so
-- the boards' existing fiduciary duty is contemporaneously documented at
-- access time (defensive posture, not a new duty creation — see decisions
-- log re: confidentiality already attaches by §209 + corporate fiduciary).
--
-- Tables added:
--
--   community_map_access_log
--     Every request to the layer-data endpoint OR property-detail endpoint
--     writes one row. Captures who, when, which community, which property
--     (when applicable), which layers were requested, IP, user-agent. Both
--     staff and (future) board accesses go through the same log so audits
--     are uniform. NOT viewable to boards — this is OUR audit, not theirs.
--
--   community_map_acknowledgments
--     Confidentiality acknowledgments. user_id + ack_version + acked_at.
--     The frontend hashes the displayed text and stores the hash so we can
--     prove the user ack'd the EXACT language they saw (not a paraphrase).
--     Quarterly re-ack default — expires_at lets us require a fresh ack
--     when sensitive layers are toggled. Staff sessions also create acks
--     (portfolio-wide, community_id NULL) so the table is exercised in
--     production well before the first board user shows up.
--
-- Record ownership (per CLAUDE.md): both tables are `workpaper` — they
-- are Bedrock's defensive audit infrastructure. Not transferable to an
-- HOA on termination. A board member's own ack history rows are
-- inspectable on request (specific to them), but the broader log is
-- not handed over as part of any termination export.
--
-- Apply AFTER 120. Idempotent.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) community_map_access_log
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_map_access_log (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id           UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  property_id            UUID NULL REFERENCES properties(id) ON DELETE SET NULL,

  -- Who: prefer the FK to user_profiles; fall back to display_name when the
  -- request comes through legacy paths that don't yet carry the JWT (the
  -- STAFF_PASSWORD-only flow Ed is in the middle of phasing out).
  acted_by_user_id       UUID NULL REFERENCES user_profiles(id) ON DELETE SET NULL,
  actor_display_name     TEXT NULL,

  -- Role context — uniform across staff + (future) board access. Lets us
  -- filter "show me every board view of Waterview last quarter" once that
  -- surface ships.
  actor_role             TEXT NOT NULL
                           CHECK (actor_role IN ('staff', 'board_member', 'unknown')),

  -- What action — keep narrow. New action types added as the feature grows.
  action                 TEXT NOT NULL
                           CHECK (action IN (
                             'view_map_layers',     -- GET /api/community-map/:id/layers
                             'view_property',       -- GET /api/community-map/property/:id
                             'export_attempted'     -- reserved — no export surface in v1
                           )),

  -- Which layers were active in the request (e.g., ['occupancy','ar','drv']).
  -- NULL when the action doesn't have layers (property detail clicks).
  layers_requested       TEXT[] NULL,

  -- Forensics
  request_ip             TEXT NULL,
  user_agent             TEXT NULL,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cmal_community_time
  ON community_map_access_log (community_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cmal_user_time
  ON community_map_access_log (acted_by_user_id, created_at DESC)
  WHERE acted_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cmal_property
  ON community_map_access_log (property_id, created_at DESC)
  WHERE property_id IS NOT NULL;
-- Useful for "every board access last 90 days" sweep queries
CREATE INDEX IF NOT EXISTS idx_cmal_role_time
  ON community_map_access_log (actor_role, created_at DESC);

COMMENT ON TABLE community_map_access_log IS
  'Workpaper. Audit log of every Community Map data access. NOT exposed to board surfaces. Bedrock retains for defensive evidentiary record.';

-- ----------------------------------------------------------------------------
-- 2) community_map_acknowledgments
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_map_acknowledgments (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES user_profiles(id) ON DELETE RESTRICT,
  community_id           UUID NULL REFERENCES communities(id) ON DELETE RESTRICT,

  -- Versioned so we can update the ack text and force re-ack without
  -- rewriting history. ack_text_hash = SHA-256 of the exact rendered text
  -- the user saw at click-time. Belt + suspenders: lets us prove later
  -- which version of the language was in front of them.
  ack_version            INTEGER NOT NULL,
  ack_text_hash          TEXT NOT NULL,

  acked_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Quarterly re-ack default — frontend computes this based on policy.
  -- NULL = never expires (rare, for staff portfolio acks).
  expires_at             TIMESTAMPTZ NULL,

  request_ip             TEXT NULL,
  user_agent             TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_cmack_user_acked
  ON community_map_acknowledgments (user_id, acked_at DESC);
CREATE INDEX IF NOT EXISTS idx_cmack_user_community
  ON community_map_acknowledgments (user_id, community_id, acked_at DESC);
-- Hot path: "does this user have an unexpired ack right now?"
-- NOTE: Postgres doesn't allow NOW() in an index predicate (functions in
-- index predicates must be IMMUTABLE; NOW() is STABLE). We use a plain
-- composite index — the expires_at filter happens at view-SELECT time
-- in v_active_community_map_acks, and the planner still picks this index
-- for those reads.
CREATE INDEX IF NOT EXISTS idx_cmack_active
  ON community_map_acknowledgments (user_id, community_id, expires_at);

COMMENT ON TABLE community_map_acknowledgments IS
  'Workpaper. Confidentiality acknowledgments captured at Community Map access time. Documents existing fiduciary duty — does not create new duty. A user''s own ack history is inspectable on request.';

-- ----------------------------------------------------------------------------
-- 3) Helper view — current-active-ack-per-user (hot read)
-- ----------------------------------------------------------------------------
-- The map endpoint checks this on every request to determine whether the
-- user needs to re-ack. One row per (user, community) showing their latest
-- active ack if any. Community-NULL acks are portfolio-wide (staff) and
-- count for every community when the per-community ack is missing.
DROP VIEW IF EXISTS v_active_community_map_acks CASCADE;
CREATE VIEW v_active_community_map_acks AS
SELECT DISTINCT ON (user_id, community_id)
  user_id,
  community_id,
  ack_version,
  acked_at,
  expires_at
FROM community_map_acknowledgments
WHERE expires_at IS NULL OR expires_at > NOW()
ORDER BY user_id, community_id, acked_at DESC;

GRANT SELECT ON v_active_community_map_acks TO service_role, authenticated;

COMMENT ON VIEW v_active_community_map_acks IS
  'Latest unexpired ack per (user, community). Community-NULL rows are portfolio acks valid for every community when a per-community ack is missing. Used by the map endpoint to gate access.';

GRANT INSERT, SELECT ON community_map_access_log TO service_role;
GRANT INSERT, SELECT ON community_map_acknowledgments TO service_role;
GRANT SELECT ON community_map_access_log TO authenticated;
GRANT SELECT ON community_map_acknowledgments TO authenticated;

COMMIT;
