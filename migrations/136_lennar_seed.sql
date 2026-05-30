-- ============================================================================
-- 136_lennar_seed.sql
-- ----------------------------------------------------------------------------
-- Adds Lennar as a second builder at Bedrock alongside DRB Group (seeded
-- migration 127). Active at August Meadows + Still Creek Ranch — the only
-- two communities in the portfolio with new construction (the others have
-- governing docs + enforcement but no developer-tier ARC pipeline).
--
-- Lennar contact details (primary_contact_name / email / phone) are NOT
-- seeded here — Ed's intro call with Lennar is next week. Operator fills
-- these in via Community Profile (or a follow-up migration) after the call.
-- For now the row exists so the builder dropdown surfaces "Lennar" as a
-- selectable option.
--
-- Idempotent via the uniq_builder_companies_name_ci index from 080.
--
-- Apply after 135.
-- ============================================================================

BEGIN;

INSERT INTO builder_companies (
  management_company_id,
  company_name,
  legal_name,
  primary_email_domain,
  status,
  notes
)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Lennar',
  'Lennar Corporation',
  'lennar.com',
  'active',
  'Seeded 2026-05-29 ahead of intro call. Active at August Meadows + Still Creek Ranch. Primary contact info to be added after the call.'
)
ON CONFLICT (management_company_id, (LOWER(company_name))) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFICATION (run after applying)
-- ============================================================================
-- -- Both builders present + active:
-- SELECT company_name, primary_email_domain, status
-- FROM builder_companies
-- WHERE management_company_id = '00000000-0000-0000-0000-000000000001'
-- ORDER BY company_name;
--
-- -- Both new-construction communities active:
-- SELECT name, builder_arc_active, builder_arc_fee_cents
-- FROM communities
-- WHERE management_company_id = '00000000-0000-0000-0000-000000000001'
--   AND builder_arc_active = TRUE
-- ORDER BY name;
