-- ============================================================================
-- 111_homeowner_tags.sql
-- ----------------------------------------------------------------------------
-- Staff-side categorization for homeowners. NEVER customer-visible.
-- Examples: board_member, vip, advisory_panel, problem_resident,
-- litigation_pending, special_accommodation, do_not_contact,
-- attorney_represented, collections_hold.
--
-- Tags are scoped to (contact, community) so the same person can be a
-- board_member at Community A and a problem_resident at Community B.
-- community_id NULL = portfolio-wide tag (e.g., "VIP at every Bedrock
-- community").
--
-- Time-bounded with granted_at/revoked_at so tag history is preserved
-- (audit-trail discipline; we don't delete historical state). The
-- "currently active" set is WHERE revoked_at IS NULL.
--
-- record_ownership = workpaper. Stays with Bedrock on contract termination.
--
-- Apply AFTER 110. Idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS homeowner_tags (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id          UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  community_id        UUID NULL REFERENCES communities(id) ON DELETE CASCADE,

  tag_key             TEXT NOT NULL CHECK (tag_key IN (
                        'board_member',
                        'vip',
                        'advisory_panel',
                        'problem_resident',
                        'litigation_pending',
                        'special_accommodation',
                        'do_not_contact',
                        'attorney_represented',
                        'collections_hold',
                        'language_assistance',
                        'elderly_assistance',
                        'fraud_flag'
                      )),
  note                TEXT NULL,

  granted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by          TEXT NULL,
  revoked_at          TIMESTAMPTZ NULL,
  revoked_by          TEXT NULL,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast "active tags for this contact" lookup
CREATE INDEX IF NOT EXISTS idx_homeowner_tags_contact_active
  ON homeowner_tags (contact_id, tag_key)
  WHERE revoked_at IS NULL;

-- Fast "everyone with this tag in this community" lookup
CREATE INDEX IF NOT EXISTS idx_homeowner_tags_community_active
  ON homeowner_tags (community_id, tag_key)
  WHERE revoked_at IS NULL AND community_id IS NOT NULL;

-- Fast "everyone with this tag across portfolio" lookup
CREATE INDEX IF NOT EXISTS idx_homeowner_tags_tag_active
  ON homeowner_tags (tag_key, granted_at DESC)
  WHERE revoked_at IS NULL;

DROP TRIGGER IF EXISTS trg_homeowner_tags_set_updated_at ON homeowner_tags;
CREATE TRIGGER trg_homeowner_tags_set_updated_at
  BEFORE UPDATE ON homeowner_tags
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON homeowner_tags TO service_role;

COMMIT;

-- Verify:
--   SELECT tag_key, COUNT(*) FROM homeowner_tags
--    WHERE revoked_at IS NULL
--    GROUP BY tag_key ORDER BY tag_key;
