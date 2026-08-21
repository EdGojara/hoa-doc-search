-- ============================================================================
-- 374_vendor_experience_contact.sql  (Ed 2026-08-20)
-- ----------------------------------------------------------------------------
-- How to actually reach the vendor a neighbour recommended.
--
-- Ed: "for vendor directory i think we need to add contact name and phone and
-- email."
--
-- The directory collected who was hired, what it cost and whether the homeowner
-- would use them again, and no way to contact them. A neighbour reading "yes,
-- I'd hire Carlos Painting again, $4,200, great work" then has to go and find
-- Carlos Painting themselves, which is the entire job the directory was meant
-- to do. The most useful field was the missing one.
--
-- All three are OPTIONAL. A homeowner writing up a job from eight months ago
-- may remember the company and the price and not have the number to hand, and
-- a required field there would cost us the whole submission.
--
-- These are BUSINESS contact details, published to neighbours in the same
-- community by design. They are not the homeowner's own details and nothing
-- here changes what we hold about the submitter.
--
-- record_ownership: the directory is homeowner-contributed content scoped to a
-- community, and travels with the association on termination like the rest of
-- vendor_experiences.
--
-- IDEMPOTENT.
-- ============================================================================

BEGIN;

ALTER TABLE vendor_experiences ADD COLUMN IF NOT EXISTS vendor_contact_name TEXT;
ALTER TABLE vendor_experiences ADD COLUMN IF NOT EXISTS vendor_phone        TEXT;
ALTER TABLE vendor_experiences ADD COLUMN IF NOT EXISTS vendor_email        TEXT;

COMMENT ON COLUMN vendor_experiences.vendor_contact_name IS
  'The person the homeowner actually dealt with at the vendor. Optional.';
COMMENT ON COLUMN vendor_experiences.vendor_phone IS
  'Business phone, stored as the homeowner typed it. Optional.';
COMMENT ON COLUMN vendor_experiences.vendor_email IS
  'Business email. Optional.';

-- The detail page shows the most recent contact details on file for a vendor,
-- because several neighbours submitting the same company will not all fill
-- these in and the newest is the most likely to still work.
CREATE INDEX IF NOT EXISTS idx_vendor_experiences_contact_recent
  ON vendor_experiences (community_id, lower(vendor_name), submitted_at DESC)
  WHERE vendor_phone IS NOT NULL OR vendor_email IS NOT NULL;

COMMIT;
