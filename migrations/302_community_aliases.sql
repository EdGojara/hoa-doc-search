-- ============================================================================
-- 302_community_aliases.sql  (Ed 2026-07-16)
-- ----------------------------------------------------------------------------
-- Ed: "these are auto pays, why can't i put it to GL?"
--
-- Because the email wasn't linked to a community, so the Record-to-GL button
-- was hidden. It couldn't link because the emails name "North Mission Glen MUD",
-- and the resolver only matches a community by its OWN name — "North Mission
-- Glen MUD" is not "Eaglewood". The mapping existed only in a memory note.
--
-- A community is known by more than its name: its MUD / water district, its
-- billing entity, a DBA. This table is where those alternate names live, so a
-- utility bill or an auto-pay confirmation routes to the right community — and,
-- when the alias carries a GL account, codes itself to that community's water
-- account with no history and no touch. (This is the encode-Ed registry the
-- memory note asked for: "remember which community belongs to which mud, that
-- will help in the future.")
--
-- Record ownership: association_record (per community).
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS community_aliases (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id         UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  alias                TEXT NOT NULL,                    -- e.g. "North Mission Glen MUD"
  alias_norm           TEXT NOT NULL,                    -- normalized for matching (lower, no punctuation)
  alias_type           TEXT NOT NULL DEFAULT 'other'
                         CHECK (alias_type IN ('mud', 'water_district', 'billing_entity', 'dba', 'other')),
  -- When a bill arrives under this alias, the expense account it codes to. NULL
  -- when the alias only identifies the community, not the account.
  gl_account_id        UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  notes                TEXT,
  created_by           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One alias points at one community — the same alias must not map two ways.
CREATE UNIQUE INDEX IF NOT EXISTS uq_community_aliases_norm ON community_aliases (alias_norm);
CREATE INDEX IF NOT EXISTS idx_community_aliases_community ON community_aliases (community_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON community_aliases TO service_role;
GRANT SELECT                          ON community_aliases TO authenticated;

-- Seed the one we know (reference_community_mud_registry): Eaglewood is served
-- by North Mission Glen MUD, billed via Si Environmental / First Billing, and
-- codes to 5120 Water. Guarded so re-running is safe.
INSERT INTO community_aliases (community_id, alias, alias_norm, alias_type, gl_account_id, notes, created_by)
SELECT c.id, 'North Mission Glen MUD', 'north mission glen mud', 'mud', a.id,
       'Si Environmental / First Billing auto-pay. Bank-drafted. Seeded from the MUD registry.', 'system (migration 302)'
FROM communities c
JOIN chart_of_accounts a ON a.community_id = c.id AND a.account_number = '5120'
WHERE c.name ILIKE '%eaglewood%'
ON CONFLICT (alias_norm) DO NOTHING;

COMMIT;
