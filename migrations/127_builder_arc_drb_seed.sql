-- ============================================================================
-- 127_builder_arc_drb_seed.sql
-- ----------------------------------------------------------------------------
-- Activate Builder ARC for August Meadows + Still Creek Ranch, seed DRB Group
-- as the first builder_company, register Karla Rutan as the DRB-side reviewer,
-- and link her to DRB Group via portal_user_builders.
--
-- Inputs gathered 2026-05-29:
--   - DRB Group, primary email domain drbgroup.com
--   - Primary contact: Karla Rutan <krutan@drbgroup.com>
--   - Per-community fee: $150 (=15000 cents). Industry standard is $250-500
--     but this is what Bedrock agreed to with the developer for both
--     communities. Documented on the row notes so it's not lost.
--   - SLA defaults (5 business days regular / 2 business days fast-track)
--     held from the migration 080 defaults pending Ed's call with DRB this
--     morning.
--   - Design guidelines URLs NOT YET captured. Will be set per-community in
--     a follow-up after Ed confirms the canonical URLs with DRB.
--
-- Sequence:
--   1. Extend portal_users.role CHECK to include 'builder' (was missing — the
--      original migration 078 only accounted for board_member / homeowner /
--      staff / admin / franchisee, none of which fit an external developer's
--      coordinator).
--   2. Flip builder_arc_active=TRUE on both communities + set fee.
--   3. Insert DRB Group into builder_companies (idempotent via the
--      uniq_builder_companies_name_ci index).
--   4. Insert Karla Rutan into portal_users (idempotent via the
--      management_company_id+email unique constraint).
--   5. Link Karla → DRB Group via portal_user_builders (idempotent via the
--      composite primary key).
--
-- Record ownership (CLAUDE.md): builder_companies + portal_user_builders +
-- portal_users(builder role) are 'workpaper' — Bedrock's operating data, not
-- transferable to the HOA on a termination. The submissions themselves
-- (builder_applications) are 'mixed' — the delivered approval letter belongs
-- to the HOA, the underlying drafting belongs to Bedrock. Tagged here so
-- the export tool can filter correctly.
-- ============================================================================

BEGIN;

-- 1) Extend portal_users.role to include 'builder' --------------------------
-- The original CHECK didn't anticipate external builder coordinators. Drop
-- the auto-named constraint, re-add with the expanded allowlist. Idempotent
-- via DROP IF EXISTS.
ALTER TABLE portal_users
  DROP CONSTRAINT IF EXISTS portal_users_role_check;
ALTER TABLE portal_users
  ADD CONSTRAINT portal_users_role_check
  CHECK (role IN ('board_member', 'homeowner', 'staff', 'admin', 'franchisee', 'builder'));


-- 2) Activate Builder ARC on the two developer communities -----------------
-- August Meadows is projected at 100/yr scaling to 400+; Still Creek Ranch is
-- the smaller but earlier-stage community. Both go live with the same fee +
-- SLA. Notes column captures the fee-negotiation context so a future operator
-- doesn't quietly raise it without history.
UPDATE communities
SET
  builder_arc_active = TRUE,
  builder_arc_fee_cents = 15000,                  -- $150.00
  builder_arc_sla_business_days = 5,              -- regular review
  builder_arc_fast_track_business_days = 2,       -- repeat plans
  -- builder_arc_design_guidelines_url left NULL — to be set after DRB confirms
  builder_arc_reference_prefix = COALESCE(builder_arc_reference_prefix, 'AM')
WHERE name ILIKE 'August Meadows%'
  AND management_company_id = '00000000-0000-0000-0000-000000000001';

UPDATE communities
SET
  builder_arc_active = TRUE,
  builder_arc_fee_cents = 15000,                  -- $150.00
  builder_arc_sla_business_days = 5,
  builder_arc_fast_track_business_days = 2,
  builder_arc_reference_prefix = COALESCE(builder_arc_reference_prefix, 'SCR')
WHERE name ILIKE 'Still Creek Ranch%'
  AND management_company_id = '00000000-0000-0000-0000-000000000001';


-- 3) Seed DRB Group as a builder_company -----------------------------------
-- Idempotent via the case-insensitive unique index (migration 080 line 71).
INSERT INTO builder_companies (
  management_company_id,
  company_name,
  legal_name,
  primary_email_domain,
  primary_contact_name,
  primary_contact_email,
  status,
  notes
)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'DRB Group',
  'D.R. Horton, Inc. — DRB Group division',
  'drbgroup.com',
  'Karla Rutan',
  'krutan@drbgroup.com',
  'active',
  'Seeded 2026-05-29 ahead of intro call. Builds at both August Meadows and Still Creek Ranch. Fee negotiated at $150/submission (below industry $250-500 range).'
)
ON CONFLICT (management_company_id, (LOWER(company_name))) DO NOTHING;


-- 4) Register Karla Rutan as a portal_user with role='builder' -------------
-- Idempotent via UNIQUE (management_company_id, email) from migration 078.
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
  'krutan@drbgroup.com',
  'Karla Rutan',
  'builder',
  'active',
  'egojara@bedrocktx.com',
  'DRB Group purchasing coordinator. Primary reviewer for August Meadows + Still Creek Ranch builder ARC submissions. Linked to DRB Group via portal_user_builders.'
)
ON CONFLICT (management_company_id, email) DO NOTHING;


-- 5) Link Karla → DRB Group via portal_user_builders -----------------------
-- Use a sub-SELECT to grab both IDs by their natural keys; safe under
-- re-runs because we look them up fresh each time. ON CONFLICT on the
-- composite primary key makes the INSERT itself idempotent.
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
  'Initial grant on builder portal launch 2026-05-29.'
FROM portal_users pu
CROSS JOIN builder_companies bc
WHERE pu.management_company_id = '00000000-0000-0000-0000-000000000001'
  AND pu.email = 'krutan@drbgroup.com'
  AND bc.management_company_id = '00000000-0000-0000-0000-000000000001'
  AND LOWER(bc.company_name) = LOWER('DRB Group')
ON CONFLICT (portal_user_id, builder_company_id) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFICATION QUERIES (run these in Supabase SQL editor after applying)
-- ============================================================================
-- -- Communities are active with $150 fee:
-- SELECT name, builder_arc_active, builder_arc_fee_cents, builder_arc_sla_business_days,
--        builder_arc_fast_track_business_days, builder_arc_reference_prefix
-- FROM communities
-- WHERE name ILIKE 'August Meadows%' OR name ILIKE 'Still Creek Ranch%';
--
-- -- DRB Group exists:
-- SELECT id, company_name, primary_contact_name, primary_contact_email, status
-- FROM builder_companies
-- WHERE LOWER(company_name) = LOWER('DRB Group');
--
-- -- Karla exists and is linked:
-- SELECT pu.email, pu.role, pu.status, bc.company_name, pub.granted_at
-- FROM portal_users pu
-- JOIN portal_user_builders pub ON pub.portal_user_id = pu.id AND pub.revoked_at IS NULL
-- JOIN builder_companies bc ON bc.id = pub.builder_company_id
-- WHERE pu.email = 'krutan@drbgroup.com';
