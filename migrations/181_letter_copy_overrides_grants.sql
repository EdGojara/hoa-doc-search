-- 181: Add missing GRANTs on letter_copy_overrides
--
-- Migration 178 created the letter_copy_overrides table but forgot to
-- GRANT permissions to the API roles. The trustEd backend uses the
-- service_role to read/write overrides; without GRANTs, every
-- loadOverrides() call hits 'permission denied for table'.
--
-- Symptom in production: the Letter edits workspace silently fell back
-- to Bedrock defaults in the Current pane (the error is non-fatal —
-- loadOverrides returns {} on permission error — so the editor
-- displayed defaults instead of any override that had been saved).
-- Save would have erroed if the operator tried; load just stayed
-- silent.
--
-- Same scar pattern as the 'DROP VIEW loses GRANTs' rule in CLAUDE.md
-- — must re-issue grants when permissions don't follow table creation.

BEGIN;

GRANT SELECT ON letter_copy_overrides TO anon, authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON letter_copy_overrides TO service_role;

COMMIT;
