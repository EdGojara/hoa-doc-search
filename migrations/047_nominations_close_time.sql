-- ============================================================================
-- 047_nominations_close_time.sql
-- ----------------------------------------------------------------------------
-- Adds a free-form close-time field to nomination_cycles so the deadline
-- printed on the Call for Nominations letter + the Paper Nomination Form
-- can read like "Friday, May 22, 2026 at 5:00 PM" instead of just the date.
-- Matches how Bedrock's reference letters have always stated the deadline
-- ("5:00 PM on Monday, May 4, 2026" / "Friday May 17, 2024 at 12:00 pm").
--
-- Text rather than TIME so staff can freely write "12:00 PM", "5:00 p.m.",
-- "end of business day," etc. without parsing/format quirks. Nullable; if
-- omitted, the deadline prints date-only the way it does today.
--
-- Apply AFTER 046. Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE nomination_cycles
  ADD COLUMN IF NOT EXISTS nominations_close_time TEXT NULL;

COMMIT;

-- Verify:
--   SELECT id, community_name, nominations_close_at, nominations_close_time
--     FROM nomination_cycles ORDER BY created_at DESC LIMIT 5;
