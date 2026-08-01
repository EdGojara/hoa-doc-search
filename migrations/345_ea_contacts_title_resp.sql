-- ===========================================================================
-- 345_ea_contacts_title_resp.sql
-- ---------------------------------------------------------------------------
-- Round out Tessa's address book so it's a real contact list, not just a name +
-- email: a title and what the person is responsible for (so Ed — and Tessa —
-- know who to reach for what). Additive to ea_contacts (migration 344).
-- ===========================================================================
BEGIN;

ALTER TABLE ea_contacts
  ADD COLUMN IF NOT EXISTS title            TEXT,   -- "VP of Operations", "Relationship Manager"
  ADD COLUMN IF NOT EXISTS responsibilities TEXT;   -- what they handle for us

COMMIT;
