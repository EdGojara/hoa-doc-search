-- ============================================================================
-- 406_interfund_adopt_a_school.sql  (Ed 2026-09-04)
-- ----------------------------------------------------------------------------
-- Reserve and Adopt-a-School have no bank account of their own; their cash is
-- commingled in Operating's checking. When an entry crosses funds (an
-- Adopt-a-School expense paid from Operating cash), each fund must still balance
-- on its own — bridged with interfund Due To / Due From lines by the posting
-- engine (lib/accounting/interfund.js).
--
-- Operating <-> Reserve interfund accounts already exist (1800/1805/2800/2805),
-- but there are none for Operating <-> Adopt-a-School. This creates a clean,
-- correctly fund-tagged pair for every community that has an Adopt-a-School fund:
--
--   On Operating:  1810  Due from Adopt a School to Operating   (asset)
--                  2810  Due to Adopt a School from Operating   (liability)
--   On Adopt-a-Sch: 1815  Due from Operating to Adopt a School   (asset)
--                  2815  Due to Operating from Adopt a School   (liability)
--
-- Idempotent (WHERE NOT EXISTS on account_number + community). chart_of_accounts
-- already carries the service_role/authenticated grants; no new grants needed.
-- ============================================================================
BEGIN;

-- Operating-fund side (1810 asset, 2810 liability), for each community that has
-- both an Operating and an Adopt-a-School fund.
INSERT INTO chart_of_accounts
  (community_id, fund_id, account_number, account_name, account_type, account_subtype, normal_balance, is_summary, is_active, vantaca_account_number)
SELECT opr.community_id, opr.id, v.num, v.name, v.atype, v.asub, v.nbal, false, true, v.num
FROM account_funds opr
JOIN account_funds ado
  ON ado.community_id = opr.community_id AND ado.fund_code = 'ADO' AND ado.is_active
CROSS JOIN (VALUES
  ('1810', 'Due from Adopt a School to Operating', 'asset',     'current_asset',     'debit'),
  ('2810', 'Due to Adopt a School from Operating', 'liability', 'current_liability', 'credit')
) AS v(num, name, atype, asub, nbal)
WHERE opr.fund_code = 'OPR' AND opr.is_active
  AND NOT EXISTS (
    SELECT 1 FROM chart_of_accounts c
    WHERE c.community_id = opr.community_id AND c.account_number = v.num
  );

-- Adopt-a-School-fund side (1815 asset, 2815 liability).
INSERT INTO chart_of_accounts
  (community_id, fund_id, account_number, account_name, account_type, account_subtype, normal_balance, is_summary, is_active, vantaca_account_number)
SELECT ado.community_id, ado.id, v.num, v.name, v.atype, v.asub, v.nbal, false, true, v.num
FROM account_funds ado
CROSS JOIN (VALUES
  ('1815', 'Due from Operating to Adopt a School', 'asset',     'current_asset',     'debit'),
  ('2815', 'Due to Operating from Adopt a School', 'liability', 'current_liability', 'credit')
) AS v(num, name, atype, asub, nbal)
WHERE ado.fund_code = 'ADO' AND ado.is_active
  AND NOT EXISTS (
    SELECT 1 FROM chart_of_accounts c
    WHERE c.community_id = ado.community_id AND c.account_number = v.num
  );

COMMIT;
