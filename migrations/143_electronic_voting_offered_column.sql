-- ============================================================================
-- 143_electronic_voting_offered_column.sql
-- ----------------------------------------------------------------------------
-- Adds the missing electronic_voting_offered column to nomination_cycles.
--
-- This column was being WRITTEN to by the frontend (the Call for Nominations
-- form's electronic-voting checkbox + the new AMN tab Meeting & voting
-- config panel) but NEVER existed in any migration. Supabase has been
-- silently accepting the field at insert time only when it auto-creates
-- the column on demand (unlikely with strict schemas) OR more probably
-- has been silently dropping it on every write.
--
-- Symptom: Ed ran the new Save config flow on 2026-06-01 and hit
-- "Could not find the 'electronic_voting_offered' column of
-- 'nomination_cycles' in the schema cache."
--
-- Fix: add the column properly, with NOTIFY at the end so PostgREST
-- picks it up without a manual cache reload (the pattern I'm now
-- baking into every column-adding migration after we hit the cache
-- issue on 139/140/141).
--
-- Apply after 142. Idempotent via IF NOT EXISTS.
-- ============================================================================

BEGIN;

ALTER TABLE nomination_cycles
  ADD COLUMN IF NOT EXISTS electronic_voting_offered BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN nomination_cycles.electronic_voting_offered IS
  'Operator-set flag indicating the community has agreed to offer online/electronic voting in addition to mail/email/in-person. Mirrors voting_methods.online.enabled (both kept in sync by /meeting-config endpoint). When TRUE, the Annual Meeting Notice prints Online Voting as method #1 with the QR-code / unique-link instructions.';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- SELECT id, community_name, annual_meeting_date, electronic_voting_offered,
--        voting_methods->'online'->>'enabled' AS voting_methods_online_enabled
-- FROM nomination_cycles
-- WHERE status IN ('open', 'closed', 'finalized')
-- ORDER BY annual_meeting_date DESC;
