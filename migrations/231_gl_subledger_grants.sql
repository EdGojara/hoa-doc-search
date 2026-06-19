-- ============================================================================
-- 231_gl_subledger_grants.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-19: the GL foundation (170), AR subledger (172), banks (173), and
-- AP subledger (175) tables were created but never granted to service_role —
-- so every API read/write hits `permission denied (42501)` and the whole
-- accounting layer is dead. This is the exact CLAUDE.md scar: "new tables
-- without service_role GRANTs are silently unwritable."
--
-- Defensive: grants only the tables that actually exist, so this is safe to run
-- even if some of 170/172/173/175 weren't applied in this environment. Idempotent.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  t text;
  tbls text[] := ARRAY[
    -- GL foundation (170)
    'account_funds', 'chart_of_accounts', 'accounting_periods',
    'journal_entries', 'journal_entry_lines',
    -- AR subledger (172)
    'ar_charge_types', 'community_billing_policies', 'ar_charges',
    'ar_payments', 'ar_payment_applications',
    -- banks (173)
    'banks',
    -- AP subledger (175)
    'ap_invoices', 'ap_invoice_lines', 'ap_invoice_approvals',
    'ap_payments', 'ap_payment_applications'
  ];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
      EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
      RAISE NOTICE 'granted: %', t;
    ELSE
      RAISE NOTICE 'skipped (missing): %', t;
    END IF;
  END LOOP;
END $$;

COMMIT;
