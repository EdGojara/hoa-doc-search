-- ===========================================================================
-- 344_ea_contacts.sql
-- ---------------------------------------------------------------------------
-- Tessa's address book. So Ed can say "contact Melody at New First National
-- Bank" and Tessa resolves it, reads it back to confirm, drafts, and sends on
-- his OK. Company-wide EA contacts (bankers, attorneys, insurance reps, key
-- vendor reps) that have no per-community home — distinct from community_contacts
-- (per-association) and contacts (homeowners). Tessa ALSO searches staff / board
-- / vendors live; this table is the place to SAVE the rest so they resolve next
-- time. Owner-only surface (the API gates it).
--
-- Record ownership: WORKPAPER (Bedrock's internal EA address book).
-- ===========================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS ea_contacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,                 -- the person
  organization  TEXT,                          -- "New First National Bank"
  email         TEXT,
  phone         TEXT,
  role          TEXT,                          -- title / what they do for us
  category      TEXT,                          -- bank | attorney | insurance | vendor | title | other
  notes         TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One entry per email so re-adding the same person updates rather than dupes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ea_contacts_email
  ON ea_contacts (lower(email)) WHERE email IS NOT NULL AND email <> '';

CREATE INDEX IF NOT EXISTS idx_ea_contacts_name ON ea_contacts (lower(name));

DROP TRIGGER IF EXISTS trg_ea_contacts_updated_at ON ea_contacts;
CREATE TRIGGER trg_ea_contacts_updated_at
  BEFORE UPDATE ON ea_contacts
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON ea_contacts TO service_role;
GRANT SELECT                          ON ea_contacts TO authenticated;

COMMIT;
