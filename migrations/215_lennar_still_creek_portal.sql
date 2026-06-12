-- ============================================================================
-- 215_lennar_still_creek_portal.sql
-- ----------------------------------------------------------------------------
-- Wire Lennar Homes into the builder portal for Still Creek Ranch.
--
-- Foundation already in place:
--   • communities row for Still Creek Ranch (id a0000000-0000-4000-8000-000000000006)
--     with builder_arc_active=TRUE, $150 fee, prefix='SCR' (set in migration 127)
--   • builder_companies row for Lennar (id 0eda1b79-0526-4e5d-8a4b-5488a0938ed1)
--     seeded ahead of intro call (in migration 127)
--   • builder_companies.active_community_ids already includes Still Creek
--     Ranch on the Lennar row (migration 137)
--
-- Gaps this migration closes:
--   1. Lennar.primary_contact_* columns are NULL — fill in Richelle Hearitige's
--      contact info now that the email from her arrived 2026-06-11.
--   2. No portal_user for Richelle yet — create her with role='builder' so the
--      builder portal magic-link flow recognizes her.
--   3. No portal_user_builders link — grant her access to the Lennar
--      builder_company so she can submit on its behalf.
--
-- Once this lands plus the BUILDER_LANDING_URLS uncomment in api/portal.js, a
-- magic link sent to richelle.hearitige@lennar.com will route her to
-- /builders/still-creek-lennar (the new submission page) on first login.
--
-- Record ownership (CLAUDE.md taxonomy): builder_companies fields,
-- portal_users(builder role), portal_user_builders are workpaper — Bedrock's
-- operating data, not transferable on a Still Creek termination. Built
-- submissions (builder_applications) are mixed and handled per-row at export
-- time (delivered approval letter belongs to the HOA; drafting belongs to
-- Bedrock).
-- ============================================================================

BEGIN;

-- 1) Update Lennar with Richelle's contact info ---------------------------
UPDATE builder_companies
SET
  primary_contact_name  = 'Richelle Hearitige',
  primary_contact_email = 'richelle.hearitige@lennar.com',
  primary_contact_phone = '281-874-8577',
  notes = COALESCE(notes, '')
    || E'\nPrimary contact added 2026-06-11 after first ARC submission '
    || E'(5503 Twilight Thicket Lane, Plan 4720_C4-R Walsh elevation) '
    || E'arrived via email. Working on the New Fairway Tier 5 master '
    || E'submittal — 125-page DEF library to be imported as master_plans.'
WHERE management_company_id = '00000000-0000-0000-0000-000000000001'
  AND LOWER(company_name) = LOWER('Lennar');


-- 2) Register Richelle as a portal_user with role='builder' ----------------
-- Idempotent via the management_company_id+email unique constraint.
INSERT INTO portal_users (
  management_company_id,
  email,
  full_name,
  role,
  status,
  invited_by,
  notes
)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'richelle.hearitige@lennar.com',
  'Richelle Hearitige',
  'builder',
  'active',
  'egojara@bedrocktx.com',
  'Lennar Homes purchasing coordinator at Still Creek Ranch. Provisioned 2026-06-11 after her first ARC submission (5503 Twilight Thicket Lane) came in via email. Linked to Lennar via portal_user_builders.'
)
ON CONFLICT (management_company_id, email) DO NOTHING;


-- 3) Link Richelle → Lennar via portal_user_builders -----------------------
-- Sub-SELECT on natural keys so this re-runs cleanly even if IDs shift in
-- a different environment (dev/staging). ON CONFLICT on the composite
-- primary key makes the INSERT itself idempotent.
INSERT INTO portal_user_builders (
  portal_user_id,
  builder_company_id,
  granted_at,
  granted_by,
  notes
)
SELECT
  pu.id,
  bc.id,
  NOW(),
  'egojara@bedrocktx.com',
  'Initial grant on Lennar/Still Creek portal launch 2026-06-11.'
FROM portal_users pu
CROSS JOIN builder_companies bc
WHERE pu.management_company_id = '00000000-0000-0000-0000-000000000001'
  AND pu.email = 'richelle.hearitige@lennar.com'
  AND bc.management_company_id = '00000000-0000-0000-0000-000000000001'
  AND LOWER(bc.company_name) = LOWER('Lennar')
ON CONFLICT (portal_user_id, builder_company_id) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- -- Lennar contact info populated:
-- SELECT company_name, primary_contact_name, primary_contact_email, primary_contact_phone
-- FROM builder_companies
-- WHERE LOWER(company_name) = LOWER('Lennar');
--
-- -- Richelle exists and is linked:
-- SELECT pu.email, pu.role, pu.status, bc.company_name, pub.granted_at
-- FROM portal_users pu
-- JOIN portal_user_builders pub ON pub.portal_user_id = pu.id AND pub.revoked_at IS NULL
-- JOIN builder_companies bc ON bc.id = pub.builder_company_id
-- WHERE pu.email = 'richelle.hearitige@lennar.com';
