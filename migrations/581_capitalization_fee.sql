-- ============================================================================
-- 581_capitalization_fee.sql  (Ed 2026-11-26)
-- ----------------------------------------------------------------------------
-- The capitalization fee (capital contribution) a closing collects, as
-- configuration on the community's homeowner rate row, next to the annual
-- assessment it is a percentage of. One canonical place; nothing copies it.
--
-- WHY: the closing screen showed only the assessment proration. It never showed
-- the capitalization fee the declaration requires on every transfer of title,
-- so staff assembled the amount due at closing by hand.
-- lib/accounting/closing_statement.js now builds the closing statement (due
-- from seller, due from buyer, capitalization fee, other fees, total). Without
-- a configured fee the statement says it is INCOMPLETE; it never shows $0.
--
--   capitalization_fee_pct       percent of the then-current annual assessment,
--                                charged in full (never prorated) to the person
--                                acquiring title. NULL = not configured.
--   capitalization_fee_evidence  where the rule comes from (the governing
--                                document section, or the board action that set
--                                another amount).
--
-- Seeds the community already configured for builder transfers (migration 500,
-- section 7): its declaration sets the fee at 100% of the then-current annual
-- assessment, not prorated, payable at closing by the grantee, unless the
-- board determines otherwise. Seed only when the row has no value yet.
--
-- Record ownership: association configuration (association_record).
-- No ledger, GL, tenure, ownership or sale row changes.
-- ============================================================================
BEGIN;

ALTER TABLE community_assessment_rates ADD COLUMN IF NOT EXISTS capitalization_fee_pct numeric(6,2);
ALTER TABLE community_assessment_rates ADD COLUMN IF NOT EXISTS capitalization_fee_evidence text;
ALTER TABLE community_assessment_rates DROP CONSTRAINT IF EXISTS community_assessment_rates_capitalization_fee_check;
ALTER TABLE community_assessment_rates ADD CONSTRAINT community_assessment_rates_capitalization_fee_check
  CHECK (capitalization_fee_pct IS NULL OR (capitalization_fee_pct >= 0 AND capitalization_fee_pct <= 1000));

UPDATE community_assessment_rates
   SET capitalization_fee_pct = 100,
       capitalization_fee_evidence = 'Declaration Article XIV.D (Capitalization Fee): 100% of the then-current Annual Assessment, payable by the grantee at closing, not prorated, in addition to the Annual Assessment, unless otherwise determined by the Board.',
       updated_at = now()
 WHERE community_id = 'a0000000-0000-4000-8000-000000000006'
   AND owner_class = 'homeowner'
   AND capitalization_fee_pct IS NULL;

COMMIT;
