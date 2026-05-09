-- ============================================================================
-- 004_grants.sql
-- ----------------------------------------------------------------------------
-- Grant API-role access to the trustEd tables created in 001 and 002.
--
-- Why this is needed: Supabase doesn't auto-grant access to newly created
-- tables in the public schema for the API roles (service_role, authenticated,
-- anon). Without these grants, supabase-js requests through any of those keys
-- return "permission denied for table X" even though RLS policies are correct.
--
-- Scope:
--   - service_role: full access (bypasses RLS, used by server.js with the
--                   sb_secret_* key — current behavior).
--   - authenticated: CRUD subject to RLS (kicks in when P1+P2 land).
--   - anon: no access. Add later if any public-readable endpoint surfaces.
--
-- Idempotent: GRANT is additive, safe to re-run. Apply AFTER 001 + 002.
-- ============================================================================

-- Foundation tables (from 001).
-- (trusted_migrations is omitted: only exists if apply.js was used to apply
--  migrations; doesn't exist on the SQL-editor-paste path.)
GRANT ALL ON
  management_companies,
  communities,
  contracts,
  agent_runs,
  kill_switches
TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  management_companies,
  communities,
  contracts,
  agent_runs,
  kill_switches
TO authenticated;

-- Bedrock Billing tables (from 002)
GRANT ALL ON
  contract_fixed_items,
  contract_reimbursables,
  contract_owner_charges,
  invoices,
  invoice_line_items,
  invoice_events,
  vantaca_activity_imports
TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  contract_fixed_items,
  contract_reimbursables,
  contract_owner_charges,
  invoices,
  invoice_line_items,
  invoice_events,
  vantaca_activity_imports
TO authenticated;

-- Views (from 001 and 002)
GRANT SELECT ON v_active_contracts, v_contract_fee_schedule
  TO service_role, authenticated;

-- Sequences (for any SERIAL/IDENTITY columns - none currently, but defensive)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- Functions
GRANT EXECUTE ON FUNCTION trusted_set_updated_at() TO service_role, authenticated;

-- ============================================================================
-- Verification: run this after applying to confirm GRANTs landed.
--
--   SELECT grantee, table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE table_schema = 'public'
--     AND table_name IN ('communities', 'invoices', 'contracts')
--     AND grantee IN ('service_role', 'authenticated')
--   ORDER BY table_name, grantee, privilege_type;
--
-- Expect rows for service_role and authenticated on each table with
-- SELECT/INSERT/UPDATE/DELETE.
-- ============================================================================
