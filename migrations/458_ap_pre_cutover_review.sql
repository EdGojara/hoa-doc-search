-- ============================================================================
-- 458_ap_pre_cutover_review.sql
-- ----------------------------------------------------------------------------
-- Pre-cutover AP review (Ed 2026-09-24). An AP invoice dated before the
-- community's gl_cutover_date is NOT auto-posted to the GL (not even at the
-- cutover date): the period before cutover was converted and certified, and
-- only a person can tell "never recorded" from "already in the converted books".
-- Intake parks it in cutover_review = 'PENDING'; a reviewer decides:
--   ALREADY_IN_CONVERTED_BOOKS  no GL posting (it is in the certified package)
--   NOT_IN_CONVERTED_BOOKS      post the accrual effective gl_cutover_date
--   NEEDS_REVIEW                undecided; stays out of the GL
-- The invoice row, its source document, original invoice date and audit trail
-- are preserved. Record ownership: association_record (the HOA's AP record).
--
-- Also classifies the known LOPF July NRG bills (billing period 6/10-7/09/2026,
-- all present in the certified 7/31 package, expensed and paid by auto-draft on
-- 7/29) as ALREADY_IN_CONVERTED_BOOKS. No GL entries are created or changed.
-- ============================================================================

BEGIN;

ALTER TABLE ap_invoices ADD COLUMN IF NOT EXISTS cutover_review text
  CHECK (cutover_review IN ('PENDING', 'ALREADY_IN_CONVERTED_BOOKS', 'NOT_IN_CONVERTED_BOOKS', 'NEEDS_REVIEW'));
ALTER TABLE ap_invoices ADD COLUMN IF NOT EXISTS cutover_reviewed_at timestamptz;
ALTER TABLE ap_invoices ADD COLUMN IF NOT EXISTS cutover_reviewed_by text;
ALTER TABLE ap_invoices ADD COLUMN IF NOT EXISTS cutover_review_notes text;
CREATE INDEX IF NOT EXISTS idx_ap_invoices_cutover_review ON ap_invoices (community_id, cutover_review)
  WHERE cutover_review IS NOT NULL;

DO $classify$
DECLARE n bigint; je_n0 bigint; je_n1 bigint; ln_n0 bigint; ln_n1 bigint;
BEGIN
  SELECT count(*) INTO je_n0 FROM journal_entries;
  SELECT count(*) INTO ln_n0 FROM journal_entry_lines;

  -- the eight July NRG bills: six voided in July (already net zero in the GL)
  -- and two whose 9/24 re-postings were neutralized (JE-2026-00229 / 00231)
  UPDATE ap_invoices SET
         cutover_review = 'ALREADY_IN_CONVERTED_BOOKS',
         cutover_reviewed_at = now(),
         cutover_reviewed_by = 'Ed (2026-09-24 instruction)',
         cutover_review_notes = 'NRG Business, billing period 6/10-7/09/2026: in the certified LOPF 7/31 package (Vantaca July GL 7/29, 5110, paid by auto-draft). No GL posting.'
   WHERE community_id = 'a0000000-0000-4000-8000-000000000002'
     AND invoice_date = '2026-07-13'
     AND vendor_invoice_number IN ('113 016 455 245', '113 016 455 246', '113 016 455 247', '113 016 455 248',
                                   '113 016 455 249', '113 016 455 250', '113 016 455 251', '113 016 455 252')
     AND total_cents IN (44072, 65427, 46720, 76900, 27260, 1428, 1734, 2630);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 8 THEN RAISE EXCEPTION 'expected to classify 8 July NRG bills, matched %', n; END IF;

  -- none of them may carry a live (un-neutralized, un-voided) GL posting
  SELECT count(*) INTO n FROM ap_invoices i JOIN journal_entries j ON j.id = i.posting_journal_entry_id
   WHERE i.cutover_review = 'ALREADY_IN_CONVERTED_BOOKS'
     AND j.status = 'posted'
     AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_je_id = j.id AND r.status = 'posted');
  IF n <> 0 THEN RAISE EXCEPTION '% already-in-converted-books invoices still have a live GL posting', n; END IF;

  SELECT count(*) INTO je_n1 FROM journal_entries;
  SELECT count(*) INTO ln_n1 FROM journal_entry_lines;
  IF je_n1 <> je_n0 OR ln_n1 <> ln_n0 THEN RAISE EXCEPTION 'GL changed during classification'; END IF;
  --@@END@@
END
$classify$;

COMMIT;
