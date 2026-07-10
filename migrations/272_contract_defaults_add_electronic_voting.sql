-- ============================================================================
-- 272_contract_defaults_add_electronic_voting.sql
-- ----------------------------------------------------------------------------
-- Add Electronic Voting ($750) to the Contract Defaults singleton's
-- default_reimbursables blob so NEW communities inherit it and the Contract
-- Defaults editor (Proposals & Contracts tab) reflects what gets billed.
--
-- Migration 271 backfilled electronic_voting onto every EXISTING contract's
-- rate card. This closes the same gap on the inheritance source for new ones.
-- The contract-save endpoint also guarantees the row server-side (belt +
-- suspenders); this keeps the defaults JSON honest so the editor shows it.
--
-- bedrock_contract_defaults is a Bedrock config singleton (id=1); no new
-- table, existing grants apply. Idempotent: only appends when absent.
-- ============================================================================

BEGIN;

UPDATE bedrock_contract_defaults
   SET default_reimbursables = COALESCE(default_reimbursables, '[]'::jsonb) || jsonb_build_array(
         jsonb_build_object(
           'category',       'electronic_voting',
           'description',    'Electronic Voting',
           'billing_method', 'per_unit',
           'unit_price',     750
         )
       ),
       updated_at = now()
 WHERE id = 1
   AND NOT (
     COALESCE(default_reimbursables, '[]'::jsonb) @> '[{"category":"electronic_voting"}]'::jsonb
   );

COMMIT;
