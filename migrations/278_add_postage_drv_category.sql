-- ============================================================================
-- 278_add_postage_drv_category.sql  (Ed 2026-07-10)
-- ----------------------------------------------------------------------------
-- Add a "Postage — DRV notices" reimbursable to every contract that lacks one,
-- and bring ALL first-class postage lines to the CURRENT USPS rate.
--
-- DRV (violation-letter) postage should be its OWN billable category, separate
-- from generic "Postage (otherwise not listed elsewhere)". It also has to exist
-- for the activity report's ⚡ Populate to work: that maps first-class letters
-- to category 'postage_drv_notices', so a community without the line can't
-- auto-fill its violation postage.
--
-- Rate = $0.82, the current USPS First-Class Mail single-piece letter (1 oz)
-- price effective July 12, 2026 (up from $0.78). per_unit, prepopulated on
-- activity invoices (qty 0 until the letters-sent count fills it). Communities
-- mailing metered/presort at a lower rate can edit it on their rate card.
-- ============================================================================
BEGIN;

INSERT INTO contract_reimbursables
  (contract_id, category, description, billing_method, unit_price, sort_order, default_on_invoice)
SELECT c.id, 'postage_drv_notices', 'Postage — DRV notices (first / second)', 'per_unit', 0.82, 15, true
  FROM contracts c
 WHERE NOT EXISTS (
   SELECT 1 FROM contract_reimbursables r
    WHERE r.contract_id = c.id AND r.category = 'postage_drv_notices'
 );

-- Bring existing first-class postage lines still at the old $0.78 rate up to the
-- current $0.82 (all postage_* per_unit reimbursables). at_cost postage lines
-- (no unit price) are left alone — they bill at actual cost.
UPDATE contract_reimbursables
   SET unit_price = 0.82
 WHERE billing_method = 'per_unit'
   AND unit_price = 0.78
   AND category LIKE 'postage%';

-- New communities inherit the DRV postage line via the Contract Defaults blob.
UPDATE bedrock_contract_defaults
   SET default_reimbursables = COALESCE(default_reimbursables, '[]'::jsonb) || jsonb_build_array(
         jsonb_build_object(
           'category',        'postage_drv_notices',
           'description',     'Postage — DRV notices (first / second)',
           'billing_method',  'per_unit',
           'unit_price',      0.82,
           'default_on_invoice', true
         )
       ),
       updated_at = now()
 WHERE id = 1
   AND NOT (
     COALESCE(default_reimbursables, '[]'::jsonb) @> '[{"category":"postage_drv_notices"}]'::jsonb
   );

COMMIT;
