-- ============================================================================
-- 372_ea_contacts_from_email.sql  (Ed 2026-08-20)
-- ----------------------------------------------------------------------------
-- Tessa's address book gets built from Ed's actual email history instead of
-- being typed in by hand. It held ZERO rows, which is the real reason "Tessa,
-- send an email to the board" had nowhere to go.
--
-- Ed: "is there a way to load and build contacts from my email history so it
-- pops up in tessas search i can verbally ask tessa to send it" and "i would
-- like my contact to include email name and phone and address from email if
-- available."
--
-- Adds what a signature block actually carries (address, mobile) plus the
-- provenance a mined row needs to be trusted: where it came from, how many
-- messages back it up, and when Ed last dealt with the person. Frequency and
-- recency are what make voice search pick the right "Haley" out of three.
--
-- Mined rows never silently overwrite something Ed typed himself — the miner
-- only fills columns that are empty, and source tells the two apart.
--
-- IDEMPOTENT.
-- ============================================================================

BEGIN;

ALTER TABLE ea_contacts ADD COLUMN IF NOT EXISTS address        TEXT;
ALTER TABLE ea_contacts ADD COLUMN IF NOT EXISTS mobile         TEXT;

-- Provenance. 'manual' is anything Ed or a tool added deliberately; 'email'
-- is mined from correspondence. A mined row is a suggestion backed by
-- evidence, and the evidence should be visible.
ALTER TABLE ea_contacts ADD COLUMN IF NOT EXISTS source         TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE ea_contacts ADD COLUMN IF NOT EXISTS message_count  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ea_contacts ADD COLUMN IF NOT EXISTS sent_count     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ea_contacts ADD COLUMN IF NOT EXISTS last_seen_at   TIMESTAMPTZ;

ALTER TABLE ea_contacts DROP CONSTRAINT IF EXISTS ea_contacts_source_check;
ALTER TABLE ea_contacts ADD CONSTRAINT ea_contacts_source_check
  CHECK (source IN ('manual', 'email'));

-- Voice search ranks on these: who Ed writes to most, and most recently.
CREATE INDEX IF NOT EXISTS idx_ea_contacts_rank
  ON ea_contacts (sent_count DESC, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_ea_contacts_org ON ea_contacts (lower(organization));

COMMIT;
