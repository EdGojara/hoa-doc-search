-- ============================================================================
-- 526_contract_term_semantics.sql  (Ed 2026-10-14)
-- ----------------------------------------------------------------------------
-- WHY: two contract-term meanings could not be recorded, so the budget engine
-- priced Canyon Gate's two contracts wrong:
--   * a CEILING ("revised rates ... not to exceed 3% in any given year") was forced
--     into 'max_cpi_or_pct' (greater of CPI or 3%), a MINIMUM increase: United
--     Protective Services' 2027 security cost was overstated by an assumed 3%;
--   * escalation that starts in a later contract year ("increase 5% each year
--     beginning with year 4") was compounded from year 2: Gate Sentry's 2027 cost
--     was overstated by about $700.
--
-- CHANGE (vendor_contracts only):
--   * escalator_kind gains 'cap_pct': increases ALLOWED up to escalator_pct a year,
--     none assumed (lib/contracts/contract_terms reports the most it could cost);
--   * escalator_start_year smallint (>= 2): the contract year escalation begins in;
--     null = from year 2 (the first anniversary), as before;
--   * the two Canyon Gate contracts corrected from their own quoted clauses
--     (extracted_data.term_quotes.escalator), with a note on each saying what
--     changed and why. Nothing else on those rows, and no other row, changes.
-- No budget line, approved budget, GL, invoice or payment changes. Record
-- ownership: association_record (the contract terms).
-- ============================================================================
BEGIN;

ALTER TABLE vendor_contracts DROP CONSTRAINT IF EXISTS vendor_contracts_escalator_kind_check;
ALTER TABLE vendor_contracts ADD CONSTRAINT vendor_contracts_escalator_kind_check
  CHECK (escalator_kind IN ('max_cpi_or_pct', 'fixed_pct', 'cpi_only', 'cap_pct', 'none'));

ALTER TABLE vendor_contracts ADD COLUMN IF NOT EXISTS escalator_start_year smallint;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_contracts_escalator_start_year_check') THEN
    ALTER TABLE vendor_contracts ADD CONSTRAINT vendor_contracts_escalator_start_year_check CHECK (escalator_start_year IS NULL OR escalator_start_year >= 2);
  END IF;
END
$do$;
COMMENT ON COLUMN vendor_contracts.escalator_start_year IS 'Contract year in which escalation begins ("beginning with year 4" = 4). Null = from year 2 (the first anniversary).';

-- United Protective Services (Canyon Gate security, start 10/1/2026). Clause: "Client agrees to pay
-- revised rates which will reimburse UPS for its added costs, including overhead costs eroded by
-- inflationary trends not to exceed 3% in any given year." A ceiling, not an automatic increase.
UPDATE vendor_contracts
   SET escalator_kind = 'cap_pct',
       notes = concat_ws(E'\n', notes, 'Migration 526 (2026-10-14): escalator corrected from "greater of CPI or 3%" (a minimum) to a 3% ceiling, per the clause "revised rates ... not to exceed 3% in any given year". No increase is assumed; the most it could cost is reported.')
 WHERE id = '96321a51-d765-4fe2-ae37-adcfbd87f39a' AND escalator_kind = 'max_cpi_or_pct' AND escalator_pct = 3;

-- Gate Sentry (Canyon Gate visitor management, executed 1/30/2023). Clause: "the Gate Sentry
-- subscription rate will automatically increase 5% each year beginning with year 4."
UPDATE vendor_contracts
   SET escalator_start_year = 4,
       notes = concat_ws(E'\n', notes, 'Migration 526 (2026-10-14): escalation starts in contract year 4, per the clause "increase 5% each year beginning with year 4" (it had been compounded from year 2).')
 WHERE id = '506222f2-dd38-4708-ba45-856f64b3b29d' AND escalator_kind = 'fixed_pct' AND escalator_pct = 5 AND escalator_start_year IS NULL;

COMMIT;
