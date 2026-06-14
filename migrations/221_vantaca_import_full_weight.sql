-- ============================================================================
-- 221_vantaca_import_full_weight.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-13: "Vantaca shouldn't be weighted at half — it's legit data
-- from inspections we did."
--
-- The earlier confidence_weight default of 0.5 for source='vantaca_import'
-- assumed Vantaca data was low-trust legacy from a predecessor management
-- firm. That's wrong for Bedrock — Bedrock did its own inspections in
-- Vantaca BEFORE trustEd existed, so Vantaca-imported violations are
-- legitimate Bedrock-own data and should weight the same as trustEd-native
-- (1.0).
--
-- This shift has real escalation-math implications:
--   - 1 Vantaca prior used to count as 0.5 → courtesy_1 (no prior threshold)
--   - 1 Vantaca prior now counts as 1.0 → courtesy_2 ("1 prior" threshold)
--   - 2 Vantaca priors used to count as 1.0 → courtesy_2
--   - 2 Vantaca priors now count as 2.0 → certified_209 (TX §209 notice)
--
-- Future trustEd-created violations at properties with Vantaca history
-- will escalate at the correct stage automatically. Drafts already created
-- under the old math stay at whatever stage they were drafted at; if Ed
-- wants those re-drafted at the higher stage he uses the ✏️ Fix flow per
-- draft, or rejects + re-confirms the underlying observation.
--
-- Predecessor_import rows (data we took over from another firm's system,
-- not Bedrock-own) stay at 0.3 — different trust model.
--
-- Idempotent: only updates rows where source='vantaca_import' AND
-- confidence_weight = 0.5 (the system default at time of import). Rows
-- that have been operator-tuned to a different value are left alone.
-- ============================================================================

BEGIN;

UPDATE violations
   SET confidence_weight = 1.0
 WHERE source = 'vantaca_import'
   AND confidence_weight = 0.5;

COMMIT;
