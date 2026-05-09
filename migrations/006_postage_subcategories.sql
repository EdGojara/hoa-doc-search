-- ============================================================================
-- 006_postage_subcategories.sql
-- ----------------------------------------------------------------------------
-- Add postage subcategories to Waterview's rate card so invoice line items
-- distinguish by purpose (DRV notices vs annual meeting vs annual billing
-- vs nomination forms vs one-off). Same $0.78/unit rate as the generic
-- postage line; the subcategory makes the invoice + future support
-- document readable without staff or boards having to dig.
--
-- The existing generic 'postage' category stays in place as a catch-all
-- so any imported activity that doesn't have a matched subcategory still
-- bills correctly.
--
-- Apply AFTER 003. Idempotent.
-- ============================================================================

INSERT INTO contract_reimbursables (
  contract_id, category, description, billing_method, unit_price, vantaca_source, sort_order, notes
) VALUES
  ('b0000000-0000-4000-8000-000000000001'::uuid,
   'postage_drv_notices',
   'Postage — DRV notices (first / second)',
   'per_unit',
   0.78,
   'drv_notice_count',
   11,
   'Postage for first and second courtesy notices on deed restriction violations'),

  ('b0000000-0000-4000-8000-000000000001'::uuid,
   'postage_annual_meeting',
   'Postage — Annual meeting notices',
   'per_unit',
   0.78,
   NULL,
   12,
   'Annual meeting notice mailing postage'),

  ('b0000000-0000-4000-8000-000000000001'::uuid,
   'postage_annual_billing',
   'Postage — Annual billing / statements',
   'per_unit',
   0.78,
   NULL,
   13,
   'Annual statement mailing postage'),

  ('b0000000-0000-4000-8000-000000000001'::uuid,
   'postage_nomination',
   'Postage — Nomination forms',
   'per_unit',
   0.78,
   NULL,
   14,
   'Board nomination form mailing postage'),

  ('b0000000-0000-4000-8000-000000000001'::uuid,
   'postage_other',
   'Postage — Other / one-off',
   'per_unit',
   0.78,
   NULL,
   15,
   'Catch-all for non-routine mailings; staff types description on the line')
ON CONFLICT (contract_id, category) DO UPDATE
  SET description = EXCLUDED.description,
      billing_method = EXCLUDED.billing_method,
      unit_price = EXCLUDED.unit_price,
      vantaca_source = EXCLUDED.vantaca_source,
      sort_order = EXCLUDED.sort_order,
      notes = EXCLUDED.notes;

-- Verify with:
--   SELECT category, description, unit_price FROM contract_reimbursables
--   WHERE contract_id = 'b0000000-0000-4000-8000-000000000001'
--     AND category LIKE 'postage%'
--   ORDER BY sort_order;
-- Expect: postage, postage_drv_notices, postage_annual_meeting,
--   postage_annual_billing, postage_nomination, postage_other (6 rows)
