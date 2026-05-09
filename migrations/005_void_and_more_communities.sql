-- ============================================================================
-- 005_void_and_more_communities.sql
-- ----------------------------------------------------------------------------
-- Two changes:
--
-- (1) Relax the invoice_number unique constraint so a draft can be voided
--     and then regenerated with the same number. The full unique constraint
--     is replaced with a partial unique index that only enforces uniqueness
--     for non-void invoices. Voided invoices keep their numbers in the
--     audit trail (status='void' in invoice_events) but no longer block a
--     fresh attempt with the same period+type+vantaca_code combination.
--
-- (2) Seed the remaining Bedrock communities as bare records (no contract,
--     no fee schedule yet). Lets them appear in the Bedrock Office UI so
--     Ed can navigate to each one. Vantaca codes left NULL — Ed should
--     fill these in once confirmed (the invoice number generator requires
--     them).
--
-- Apply AFTER 001-004. Idempotent.
-- ============================================================================

-- (1) Replace the unique constraint with a partial unique index. -----------
ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS invoices_management_company_id_invoice_number_key;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoice_number_active
  ON invoices(management_company_id, invoice_number)
  WHERE status <> 'void';

-- Add a void_reason column for capturing WHY a draft was voided.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ;

-- (2) Seed remaining Bedrock communities. ---------------------------------
-- vantaca_code left NULL pending Ed's confirmation. UI flags as "needs setup".
-- Placeholder UUIDs so re-running this migration is idempotent.
INSERT INTO communities (id, management_company_id, name, legal_name, county, state, notes)
VALUES
  ('a0000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'Lakes of Pine Forest', 'Lakes of Pine Forest Homeowners Association, Inc.', 'Harris', 'TX', 'Seeded 2026-05-09; vantaca_code + contract not yet captured'),
  ('a0000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'Canyon Gate at Cinco Ranch', 'Canyon Gate at Cinco Ranch Homeowners Association', 'Fort Bend', 'TX', 'Seeded 2026-05-09; vantaca_code + contract not yet captured'),
  ('a0000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001', 'Eaglewood', 'Eaglewood Homeowners Association', NULL, 'TX', 'Seeded 2026-05-09; vantaca_code + contract not yet captured'),
  ('a0000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000001', 'Quail Ridge', 'Quail Ridge Homeowners Association', NULL, 'TX', 'Seeded 2026-05-09; vantaca_code + contract not yet captured'),
  ('a0000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001', 'Still Creek Ranch', 'Still Creek Ranch Homeowners Association', NULL, 'TX', 'Seeded 2026-05-09; vantaca_code + contract not yet captured'),
  ('a0000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000001', 'August Meadows', 'August Meadows Homeowners Association', NULL, 'TX', 'Seeded 2026-05-09; vantaca_code + contract not yet captured')
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      legal_name = EXCLUDED.legal_name,
      county = EXCLUDED.county,
      state = EXCLUDED.state,
      notes = EXCLUDED.notes;

-- ============================================================================
-- Verification:
--   SELECT name, vantaca_code FROM communities ORDER BY name;
--     -> 7 rows; only Waterview Estates has a vantaca_code (WV)
--   SELECT indexname FROM pg_indexes
--     WHERE tablename = 'invoices' AND indexname LIKE 'uniq_invoice%';
--     -> uniq_invoice_number_active
-- ============================================================================
