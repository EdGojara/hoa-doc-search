-- ============================================================================
-- 527_reclassification_runs_and_vendor_line_rules.sql  (Ed 2026-10-14)
-- ----------------------------------------------------------------------------
-- Ed: "reclassify the 2026 year-to-date actual expenses so the financial
-- statements use the same categories as the proposed 2027 budget ... Prepare
-- controlled reclassification journal entries ... Split future Bedrock invoices
-- automatically between Management Fees and Clubhouse Staffing according to the
-- contract, with website services remaining separate."
--
-- 1) accounting_runs gains the process 'reclassification': Kat PREPARES balanced
--    entries that move an amount from one expense account to another, each citing
--    its source document and original posting; the OWNER approves each by name in
--    Kat's queue (authenticated in-app approval, lib/accounting/monthly_runs).
--    Nothing posts at prepare time; originals, invoices and payments are untouched.
--
-- 2) vendor_line_rules: a contract-driven coding rule for a vendor's invoice LINES
--    at one community ("Onsite Staff" -> 5855). It codes the line deterministically,
--    before history-based classification, so a past reclass can never re-teach the
--    classifier the wrong account. Record ownership: workpaper (Bedrock's coding
--    configuration); every rule names the clause it rests on (basis) and its source
--    document. Seeded for Canyon Gate's Bedrock management agreement (Exhibit A).
--
-- No journal entry, invoice, payment or budget changes.
-- ============================================================================
BEGIN;

ALTER TABLE accounting_runs DROP CONSTRAINT IF EXISTS accounting_runs_process_check;
ALTER TABLE accounting_runs ADD CONSTRAINT accounting_runs_process_check
  CHECK (process IN ('recognition', 'interest', 'bank_reconciliation', 'cutoff_adjustment', 'reclassification'));

CREATE TABLE IF NOT EXISTS vendor_line_rules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id       uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  vendor_id          uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  pattern            text NOT NULL,
  gl_account_id      uuid NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  basis              text NOT NULL,
  source_document_id uuid REFERENCES library_documents(id) ON DELETE SET NULL,
  is_active          boolean NOT NULL DEFAULT true,
  created_by         text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendor_line_rules_pattern_check CHECK (length(btrim(pattern)) >= 3),
  CONSTRAINT vendor_line_rules_basis_check CHECK (length(btrim(basis)) >= 10)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_vendor_line_rules_active
  ON vendor_line_rules (community_id, vendor_id, lower(pattern)) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_vendor_line_rules_lookup ON vendor_line_rules (community_id, vendor_id) WHERE is_active;
GRANT SELECT, INSERT, UPDATE, DELETE ON vendor_line_rules TO service_role;
GRANT SELECT ON vendor_line_rules TO authenticated;

-- Canyon Gate: Bedrock management agreement, Exhibit A - Compensation.
INSERT INTO vendor_line_rules (community_id, vendor_id, pattern, gl_account_id, basis, source_document_id, created_by)
SELECT 'a0000000-0000-4000-8000-000000000003', 'e254e558-9285-4a02-9b35-7ea66d07ec91', r.pattern, coa.id, r.basis,
       (SELECT id FROM library_documents WHERE id = 'b90ac42b-f4f5-45d5-a9ad-914c01d7ef4f'), 'migration 527 (Ed 2026-10-14)'
FROM (VALUES
  ('onsite staff|clubhouse (office )?staff', '5855', 'Bedrock management agreement, Exhibit A: "Onsite Staff (4 days week) $2,700.00" monthly. Clubhouse staffing, not the management fee.'),
  ('management fee', '5810', 'Bedrock management agreement, Exhibit A: "Monthly Management Fee $2,500.00".'),
  ('website|portal', '5030', 'Bedrock management agreement, Exhibit A: "Website and homeowner/board Portals $150.00 monthly".')
) AS r(pattern, account_number, basis)
JOIN chart_of_accounts coa ON coa.community_id = 'a0000000-0000-4000-8000-000000000003' AND coa.account_number = r.account_number
WHERE EXISTS (SELECT 1 FROM vendors WHERE id = 'e254e558-9285-4a02-9b35-7ea66d07ec91')
  AND NOT EXISTS (SELECT 1 FROM vendor_line_rules x WHERE x.community_id = 'a0000000-0000-4000-8000-000000000003' AND x.vendor_id = 'e254e558-9285-4a02-9b35-7ea66d07ec91' AND lower(x.pattern) = lower(r.pattern) AND x.is_active);

COMMIT;
