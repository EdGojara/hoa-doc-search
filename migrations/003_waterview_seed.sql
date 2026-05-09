-- ============================================================================
-- 003_waterview_seed.sql
-- ----------------------------------------------------------------------------
-- Seeds Waterview Estates as the first community + its current management
-- contract + the Jan 2025 fee schedule, drawn directly from the executed
-- contract PDF and the Jan 2025 fee schedule supplement.
--
-- Deterministic UUIDs are used throughout so this seed is idempotent —
-- re-running it updates rather than duplicates.
--
-- Apply AFTER 002_bedrock_billing.sql.
--
-- IMPORTANT — Two contract hygiene issues to flag, neither blocking:
--   1. Contract signatory is Jacey Jetton (no longer involved at Bedrock).
--      Notices clause directs to him at the old Mason Rd Richmond address.
--      Bedrock now operates from Sugar Land. Worth a re-paper or notices
--      amendment when Waterview's board cycle allows.
--   2. The active rate card here is the Jan 2025 schedule. The historical
--      invoices we audited (Jan 2026, Aug 2025) bill certified letters at
--      $25 — the OLD 2017 rate. After this seed lands, drafted activity
--      invoices for Waterview will pull $50 (assessment certified demand)
--      and $35 (deed restriction certified demand) from this rate card.
--      Recovering past under-billings is a separate operational decision.
-- ============================================================================

-- Waterview Estates community ----------------------------------------------
INSERT INTO communities (
  id,
  management_company_id,
  name,
  legal_name,
  vantaca_code,
  county,
  state,
  total_lots,
  notes
)
VALUES (
  'a0000000-0000-4000-8000-000000000001'::uuid,
  '00000000-0000-0000-0000-000000000001'::uuid,
  'Waterview Estates',
  'Waterview Estates Owners Association, Inc',
  'WV',
  'Fort Bend',
  'TX',
  NULL,                                         -- TODO: confirm platted lot count for $3/lot annual statement billing
  'Management start date Jan 1, 2025 per Exhibit A. Contract auto-renewed from 2017 original.'
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      legal_name = EXCLUDED.legal_name,
      vantaca_code = EXCLUDED.vantaca_code,
      county = EXCLUDED.county,
      state = EXCLUDED.state,
      notes = EXCLUDED.notes;

-- Waterview management contract v1 (the Jan 2025 fee schedule) -------------
INSERT INTO contracts (
  id,
  community_id,
  version,
  effective_date,
  end_date,
  signed_date,
  signatories,
  notice_address,
  escalator_kind,
  escalator_pct,
  payment_terms,
  status,
  notes
)
VALUES (
  'b0000000-0000-4000-8000-000000000001'::uuid,
  'a0000000-0000-4000-8000-000000000001'::uuid,
  1,
  '2025-01-01',
  NULL,                                         -- auto-renewing per Article IV
  '2017-10-12',                                 -- original execution; Exhibit A updated 2025-01
  '{"association": "Alexis Geissler, President", "managing_agent_at_signing": "Jacey Jetton, President — NO LONGER WITH BEDROCK"}'::jsonb,
  '9711 S. Mason Rd. Suite 125 (#359), Richmond, TX 77407 — STALE; current Sugar Land address not yet papered',
  'max_cpi_or_pct',
  5.00,
  'Monthly in advance per Article V; deducted from Association operating account',
  'active',
  'See contract Article V escalator clause — max(CPI%, 5%) annual increase effective Jan 1 with Board approval. Confirm whether 2026 took the bump.'
)
ON CONFLICT (id) DO UPDATE
  SET version = EXCLUDED.version,
      effective_date = EXCLUDED.effective_date,
      signed_date = EXCLUDED.signed_date,
      signatories = EXCLUDED.signatories,
      notice_address = EXCLUDED.notice_address,
      escalator_kind = EXCLUDED.escalator_kind,
      escalator_pct = EXCLUDED.escalator_pct,
      payment_terms = EXCLUDED.payment_terms,
      status = EXCLUDED.status,
      notes = EXCLUDED.notes;

-- ============================================================================
-- Fixed monthly items (Exhibit A — Agreement Terms / Fixed Monthly Fee)
-- ============================================================================
-- Use a CTE-style upsert keyed on (contract_id, description) for idempotency.
-- We don't have a unique constraint on that pair so we delete-and-reinsert
-- only the fixed items for this contract — safe because items are
-- contract-scoped.
DELETE FROM contract_fixed_items
  WHERE contract_id = 'b0000000-0000-4000-8000-000000000001'::uuid;

INSERT INTO contract_fixed_items (contract_id, description, monthly_amount, sort_order, notes) VALUES
  ('b0000000-0000-4000-8000-000000000001'::uuid, 'Monthly Management Fee',                 4102.00, 10, NULL),
  ('b0000000-0000-4000-8000-000000000001'::uuid, 'Website Maintenance Fee',                 150.00, 20, 'Website and homeowner/board Portals'),
  ('b0000000-0000-4000-8000-000000000001'::uuid, 'Monthly On-site Staff (3 Days a Week)',  2460.00, 30, 'Includes taxes and 10% administrative fee per fee schedule');

-- ============================================================================
-- Reimbursable supplies and services (billed to Association as-used)
-- ============================================================================
INSERT INTO contract_reimbursables (
  contract_id, category, description, billing_method, unit_price, vantaca_source, sort_order, notes
) VALUES
  ('b0000000-0000-4000-8000-000000000001'::uuid,
   'postage',
   'Postage',
   'per_unit',
   0.78,
   'postage_count',
   10,
   'Contract reads "At cost"; $0.78/unit is the operative blended rate currently invoiced'),

  ('b0000000-0000-4000-8000-000000000001'::uuid,
   'bw_copies',
   'B&W Copies',
   'per_unit',
   0.15,
   'bw_copy_count',
   20,
   'Excludes annual statements and annual meeting notices'),

  ('b0000000-0000-4000-8000-000000000001'::uuid,
   'color_copies',
   'Color Copies',
   'per_unit',
   0.25,
   'color_copy_count',
   30,
   'Excludes annual statements and annual meeting notices'),

  ('b0000000-0000-4000-8000-000000000001'::uuid,
   'annual_statement_mailing',
   'Annual Statement Billing & Annual Meeting Notice Mailings',
   'per_lot_plus_postage',
   3.00,
   'platted_lot_count',
   40,
   'Triggered annually; needs total_lots filled in on community record'),

  ('b0000000-0000-4000-8000-000000000001'::uuid,
   'work_outside_management',
   'Work conducted outside of normal management functions',
   'hourly',
   75.00,
   'extra_work_hours',
   50,
   'Per-hour, billed as-incurred'),

  ('b0000000-0000-4000-8000-000000000001'::uuid,
   'event_staffing',
   'Staffing community events (per person/hour)',
   'hourly',
   30.00,
   'event_staffing_hours',
   60,
   'Aug 2025 example: "Back To School Bash - Staffing (Celina 5pm-7pm)" 2 hrs @ $30'),

  ('b0000000-0000-4000-8000-000000000001'::uuid,
   'event_admin_fee',
   'Community event admin fee (per event)',
   'per_unit',
   100.00,
   'event_count',
   70,
   'Pairs with event_staffing; $100 per community event'),

  ('b0000000-0000-4000-8000-000000000001'::uuid,
   'out_of_pocket',
   'Reimbursement for out-of-pocket expenses on behalf of Association',
   'at_cost',
   NULL,
   NULL,
   80,
   'Pure passthrough; line item entered manually with substantiating receipt'),

  ('b0000000-0000-4000-8000-000000000001'::uuid,
   'insurance_claim_admin',
   'Insurance claim administrative charge',
   'hourly',
   150.00,
   NULL,
   90,
   'Article III: $150/hour OR 4% of claim, whichever is greater. System should prompt for higher of the two when claim exists.')
ON CONFLICT (contract_id, category) DO UPDATE
  SET description = EXCLUDED.description,
      billing_method = EXCLUDED.billing_method,
      unit_price = EXCLUDED.unit_price,
      vantaca_source = EXCLUDED.vantaca_source,
      sort_order = EXCLUDED.sort_order,
      notes = EXCLUDED.notes;

-- ============================================================================
-- Owner-collectible charges
-- (Billed to Association; Association collects from Owner where legal.)
-- ============================================================================
INSERT INTO contract_owner_charges (
  contract_id, category, description, fee_amount, sort_order, notes
) VALUES
  ('b0000000-0000-4000-8000-000000000001'::uuid,
   'mediation_court_per_hour',
   'Mediation / Court Appearances',
   150.00,
   10,
   'Per hour; qty = hours'),

  ('b0000000-0000-4000-8000-000000000001'::uuid,
   'assessment_late_reminder',
   'Assessment Collection Late Reminder Notices',
   25.00,
   20,
   NULL),

  ('b0000000-0000-4000-8000-000000000001'::uuid,
   'assessment_certified_demand_letter',
   'Assessment Collection Certified Demand Letter',
   50.00,
   30,
   '⚠ Historical invoices billed this at $25 (old 2017 rate); $50 is the current Jan 2025 rate'),

  ('b0000000-0000-4000-8000-000000000001'::uuid,
   'deed_restriction_certified_demand_letter',
   'Deed Restriction Certified Demand Letter',
   35.00,
   40,
   '⚠ Historical invoices billed this at $25 (old 2017 rate); $35 is the current Jan 2025 rate'),

  ('b0000000-0000-4000-8000-000000000001'::uuid,
   'insufficient_check_charge',
   'Insufficient Check Charge',
   35.00,
   50,
   '⚠ Historical invoices billed this at $25 (old 2017 rate); $35 is the current Jan 2025 rate'),

  ('b0000000-0000-4000-8000-000000000001'::uuid,
   'accounts_to_attorney',
   'Accounts sent to Attorneys for Legal Action',
   50.00,
   60,
   NULL),

  ('b0000000-0000-4000-8000-000000000001'::uuid,
   'payment_plan_fee',
   'Payment Plan Fee',
   35.00,
   70,
   NULL),

  ('b0000000-0000-4000-8000-000000000001'::uuid,
   'arc_application_fee',
   'ARC Application Processing Fee',
   25.00,
   80,
   NULL)
ON CONFLICT (contract_id, category) DO UPDATE
  SET description = EXCLUDED.description,
      fee_amount = EXCLUDED.fee_amount,
      sort_order = EXCLUDED.sort_order,
      notes = EXCLUDED.notes;

-- ============================================================================
-- Sanity checks. Run these after applying.
-- ============================================================================
-- SELECT name, vantaca_code FROM communities;
--   -> Waterview Estates | WV
-- SELECT version, effective_date, escalator_kind, escalator_pct
--   FROM contracts WHERE community_id = 'a0000000-0000-4000-8000-000000000001';
--   -> 1 | 2025-01-01 | max_cpi_or_pct | 5.00
-- SELECT description, monthly_amount FROM contract_fixed_items
--   WHERE contract_id = 'b0000000-0000-4000-8000-000000000001' ORDER BY sort_order;
--   -> 3 rows summing to $6,712 (matches Oct 2025 fixed invoice)
-- SELECT category, fee_amount FROM contract_owner_charges
--   WHERE contract_id = 'b0000000-0000-4000-8000-000000000001'
--   ORDER BY sort_order;
--   -> 8 rows with $50 / $35 / $35 for the three "leaked" categories
-- SELECT * FROM v_contract_fee_schedule
--   WHERE contract_id = 'b0000000-0000-4000-8000-000000000001'
--   ORDER BY section, sort_order;
--   -> 20 rows total (3 fixed + 9 reimbursable + 8 owner_charge)
-- ============================================================================
