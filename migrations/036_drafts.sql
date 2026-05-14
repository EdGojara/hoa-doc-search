-- ============================================================================
-- 036_drafts.sql
-- ----------------------------------------------------------------------------
-- Generic "save in progress" / "resume saved drafts" support for any screen
-- in trustEd. One table, one set of routes — each screen (ACC Review,
-- Nominations cycle, Board Packets, Events, Vendor RFP, etc.) serializes its
-- own form state into `state` JSONB and tracks uploaded files in `file_refs`.
--
-- file_refs shape:
--   [{ "field":"photos", "path":"drafts/<id>/p_xxx.jpg",
--      "name":"IMG_4521.jpeg", "type":"image/jpeg", "size":1234567 }, ...]
--
-- Apply AFTER 035. Idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS drafts (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id       UUID NOT NULL,
  draft_type                  TEXT NOT NULL,
  -- Optional context — used to filter "show me MY drafts on THIS screen for THIS community"
  community_name              TEXT NULL,
  community_id                UUID NULL,
  label                       TEXT NULL,
  state                       JSONB NOT NULL DEFAULT '{}'::jsonb,
  file_refs                   JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by                  TEXT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drafts_type_community
  ON drafts (draft_type, community_name, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_drafts_company_updated
  ON drafts (management_company_id, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON drafts TO anon, authenticated, service_role;

COMMIT;

-- Verify:
--   SELECT id, draft_type, community_name, label, updated_at FROM drafts ORDER BY updated_at DESC LIMIT 10;
