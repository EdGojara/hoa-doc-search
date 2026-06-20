-- ============================================================================
-- 233_bank_rec_grants.sql
-- ----------------------------------------------------------------------------
-- Migration 169 created the bank-reconciliation tables but never granted them
-- to service_role — so every server-side write (the API uses the service role
-- key) fails with "permission denied for table". Same scar as 168/172/175/231;
-- the feature was built but never exercised with data, so the gap went unseen
-- until the Quail Ridge bank-rec import (Ed 2026-06-20).
--
-- Defensive: only grants tables that actually exist, so it's safe to run on any
-- environment and idempotent.
-- ============================================================================
BEGIN;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bank_accounts',                 -- 169
    'bank_statement_imports',        -- 169
    'bank_statement_transactions',   -- 169
    'bank_reconciliations',          -- 169
    'bank_reconciliation_items'      -- 169
  ] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'public' AND table_name = t) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
      EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
      RAISE NOTICE 'granted: %', t;
    END IF;
  END LOOP;
END $$;

COMMIT;
