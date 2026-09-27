// ============================================================================
// lib/payments/payment_sandbox_provision.js  (Ed 2026-09-27)
// ----------------------------------------------------------------------------
// Provisions (or removes) the ONE Stripe payment-sandbox lot: Drama Creek lot
// DC-45-060, a demo community. Kept OUT of migration 469 on purpose: 469 is
// reusable payment infrastructure; this is demo data, and it can be removed and
// recreated without touching the payment schema.
//
// Safety:
//   * refuses unless the server's Stripe key is a TEST key (checked here, where
//     the key lives; the SQL additionally refuses unless this runner set the
//     per-transaction flag, so pasting it into an SQL editor does nothing);
//   * refuses unless the community is a demo and the lot is in it;
//   * one transaction; 'plan' / 'plan_remove' run everything and ROLL BACK;
//   * every row it creates has a fixed id listed in SANDBOX_ROWS, so exactly
//     those rows (and nothing else) are identified and removed;
//   * idempotent: re-running 'apply' adds nothing.
// Removal refuses while any payment, ledger row or journal entry exists for the
// demo community (test activity is kept, never silently deleted).
// Requires migration 469 (properties.payment_sandbox, community_account_roles).
// ============================================================================
const { stripeMode } = require('./stripe_mode');

const P = '5a0d0469-0000-4000-a000-';
const SANDBOX = {
  communityId: 'dc100000-0000-4000-a000-000000000000',   // Drama Creek Estates (is_demo)
  lotId: 'e09d3deb-57c7-4028-b366-4f79c9379708',         // DC-45-060
  trustedAccountNumber: '1002900060',                     // community account_code 1002 + 900060
  glCutover: '2026-09-01',
  ownerStart: '2026-09-27',
  email: 'payments-sandbox@bedrock.test',                 // demo address: all email to it is suppressed
  name: 'Payments Sandbox Owner',
  ids: {
    fund: P + '00000000f001',
    coa: { '1000': P + '00000000c100', '1090': P + '00000000c109', '1300': P + '00000000c130' },
    contact: P + '00000000c0de',
    ownership: P + '0000000000a1',
    portalUser: P + '0000000000b1',
    periods: Array.from({ length: 16 }, (_, i) => P + '0000000001' + String(i + 1).padStart(2, '0')),
  },
};
const MARK = 'payment-sandbox (lib/payments/payment_sandbox_provision.js)';
const RUN_FLAG = 'stripe_test_mode_verified';

// Every production row this script can create or change, for review and removal.
function sandboxRows() {
  const s = SANDBOX, rows = [];
  rows.push({ table: 'properties', key: s.lotId, change: `UPDATE payment_sandbox=true, trusted_account_number=${s.trustedAccountNumber} (only if null)` });
  rows.push({ table: 'communities', key: s.communityId, change: `UPDATE gl_cutover_date=${s.glCutover} (only if null)` });
  rows.push({ table: 'account_funds', key: s.ids.fund, change: 'INSERT OPR Operating (skipped if Drama Creek already has OPR)' });
  for (const [num, id] of Object.entries(s.ids.coa)) rows.push({ table: 'chart_of_accounts', key: id, change: `INSERT ${num}` });
  s.ids.periods.forEach((id, i) => rows.push({ table: 'accounting_periods', key: id, change: `INSERT ${periodStart(i)} open monthly` }));
  for (const role of ['operating_cash', 'stripe_clearing', 'homeowner_ar']) rows.push({ table: 'community_account_roles', key: `${s.communityId}/${role}`, change: 'INSERT (updated_by = payment-sandbox)' });
  rows.push({ table: 'contacts', key: s.ids.contact, change: `INSERT ${s.name} <${s.email}>` });
  rows.push({ table: 'property_ownerships', key: s.ids.ownership, change: `INSERT on the lot's current tenure, start ${s.ownerStart}` });
  rows.push({ table: 'portal_users', key: s.ids.portalUser, change: 'INSERT homeowner, active, demo management company' });
  rows.push({ table: 'portal_user_properties', key: `${s.ids.portalUser}/${s.lotId}`, change: 'INSERT' });
  return rows;
}
function periodStart(i) { const d = new Date(Date.UTC(2026, 8 + i, 1)); return d.toISOString().slice(0, 10); }

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;   // constants only; never request input

function preflightSql() {
  const s = SANDBOX;
  return `DO $$
DECLARE n int;
BEGIN
  IF coalesce(current_setting('trusted.payment_sandbox_run', true), '') <> ${q(RUN_FLAG)} THEN
    RAISE EXCEPTION 'payment sandbox SQL runs only through payment_sandbox_provision.js after a Stripe test-mode check';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'properties' AND column_name = 'payment_sandbox') THEN
    RAISE EXCEPTION 'migration 469 is not applied (properties.payment_sandbox missing)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM communities WHERE id = ${q(s.communityId)} AND is_demo) THEN
    RAISE EXCEPTION 'refused: community ${s.communityId} is missing or not a demo community';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM properties WHERE id = ${q(s.lotId)} AND community_id = ${q(s.communityId)}) THEN
    RAISE EXCEPTION 'refused: sandbox lot ${s.lotId} is not in the demo community';
  END IF;
  SELECT count(*) INTO n FROM properties WHERE payment_sandbox AND id <> ${q(s.lotId)};
  IF n > 0 THEN RAISE EXCEPTION 'refused: another lot is already the payment sandbox'; END IF;
END $$;`;
}

function applySql() {
  const s = SANDBOX, c = q(s.communityId), lot = q(s.lotId);
  const periods = s.ids.periods.map((id, i) => {
    const st = periodStart(i); const d = new Date(st + 'T00:00:00Z');
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    return `(${q(id)}, ${d.getUTCFullYear()}, ${d.getUTCMonth() + 1}, ${q(st)}, ${q(end)})`;
  }).join(',\n    ');
  return `
UPDATE properties SET payment_sandbox = true, trusted_account_number = coalesce(trusted_account_number, ${q(s.trustedAccountNumber)})
 WHERE id = ${lot} AND (NOT payment_sandbox OR trusted_account_number IS NULL);
UPDATE communities SET gl_cutover_date = ${q(s.glCutover)} WHERE id = ${c} AND gl_cutover_date IS NULL;

INSERT INTO account_funds (id, community_id, fund_code, fund_name, fund_type, display_order, is_active, notes)
SELECT ${q(s.ids.fund)}, ${c}, 'OPR', 'Operating', 'operating', 1, true, ${q(MARK)}
 WHERE NOT EXISTS (SELECT 1 FROM account_funds WHERE community_id = ${c} AND fund_code = 'OPR');

INSERT INTO chart_of_accounts (id, community_id, fund_id, account_number, account_name, account_type, account_subtype, normal_balance, is_summary, is_active, description)
SELECT v.id, ${c}, (SELECT id FROM account_funds WHERE community_id = ${c} AND fund_code = 'OPR'), v.num, v.name, 'asset', 'current_asset', 'debit', false, true, ${q(MARK)}
  FROM (VALUES (${q(s.ids.coa['1000'])}::uuid, '1000', 'Operating Cash Account'),
               (${q(s.ids.coa['1090'])}::uuid, '1090', 'Cash in Transit - Stripe Clearing'),
               (${q(s.ids.coa['1300'])}::uuid, '1300', 'Accounts Receivable')) AS v(id, num, name)
 WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts x WHERE x.community_id = ${c} AND x.account_number = v.num);

INSERT INTO accounting_periods (id, community_id, fiscal_year, period_number, period_type, period_start, period_end, status, notes)
SELECT v.id::uuid, ${c}, v.fy, v.pn, 'monthly', v.ps::date, v.pe::date, 'open', ${q(MARK)}
  FROM (VALUES
    ${periods}) AS v(id, fy, pn, ps, pe)
 WHERE NOT EXISTS (SELECT 1 FROM accounting_periods x WHERE x.community_id = ${c} AND x.fiscal_year = v.fy AND x.period_number = v.pn);

INSERT INTO community_account_roles (community_id, role, account_id, updated_by)
SELECT ${c}, r.role, a.id, 'payment-sandbox'
  FROM (VALUES ('operating_cash', '1000'), ('stripe_clearing', '1090'), ('homeowner_ar', '1300')) AS r(role, num)
  JOIN chart_of_accounts a ON a.community_id = ${c} AND a.account_number = r.num
ON CONFLICT (community_id, role) DO NOTHING;

INSERT INTO contacts (id, full_name, primary_email, notes) VALUES (${q(s.ids.contact)}, ${q(s.name)}, ${q(s.email)}, ${q(MARK)})
ON CONFLICT (id) DO NOTHING;
INSERT INTO property_ownerships (id, property_id, contact_id, start_date, is_primary, source, notes)
SELECT ${q(s.ids.ownership)}, ${lot}, ${q(s.ids.contact)}, ${q(s.ownerStart)}, true, 'manual', ${q(MARK)}
 WHERE NOT EXISTS (SELECT 1 FROM property_ownerships WHERE id = ${q(s.ids.ownership)});
INSERT INTO portal_users (id, management_company_id, email, full_name, role, status, contact_id, notes)
SELECT ${q(s.ids.portalUser)}, management_company_id, ${q(s.email)}, ${q(s.name)}, 'homeowner', 'active', ${q(s.ids.contact)},
       ${q(MARK + '. Email is demo-suppressed; staff copy a magic link from portal admin.')}
  FROM communities WHERE id = ${c}
ON CONFLICT DO NOTHING;
INSERT INTO portal_user_properties (portal_user_id, property_id, granted_by, notes)
SELECT ${q(s.ids.portalUser)}, ${lot}, 'payment-sandbox', ${q(MARK)}
 WHERE EXISTS (SELECT 1 FROM portal_users WHERE id = ${q(s.ids.portalUser)})
   AND NOT EXISTS (SELECT 1 FROM portal_user_properties WHERE portal_user_id = ${q(s.ids.portalUser)} AND property_id = ${lot});

DO $$ BEGIN
  IF (SELECT tenure_id FROM property_ownerships WHERE id = ${q(s.ids.ownership)}) IS NULL THEN
    RAISE EXCEPTION 'sandbox owner did not land on a current owner tenure for the lot';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM portal_user_properties WHERE portal_user_id = ${q(s.ids.portalUser)} AND property_id = ${lot}) THEN
    RAISE EXCEPTION 'sandbox portal login not created (is ${s.email} already used by another portal user?)';
  END IF;
END $$;`;
}

function removeSql() {
  const s = SANDBOX, c = q(s.communityId), lot = q(s.lotId);
  const periodIds = s.ids.periods.map(q).join(', ');
  const coaIds = Object.values(s.ids.coa).map(q).join(', ');
  return `
DO $$
DECLARE np int; nh int; nj int;
BEGIN
  SELECT count(*) INTO np FROM payments WHERE community_id = ${c};
  SELECT count(*) INTO nh FROM homeowner_transactions WHERE property_id = ${lot} OR contact_id = ${q(s.ids.contact)};
  SELECT count(*) INTO nj FROM journal_entries WHERE community_id = ${c};
  IF np + nh + nj > 0 THEN
    RAISE EXCEPTION 'refused: sandbox has test activity (% payments, % ledger rows, % journal entries); it is kept, not deleted', np, nh, nj;
  END IF;
END $$;
-- The open ownership can only be removed on the sanctioned transfer path.
SELECT set_config('trusted.ownership_transfer', 'on', true);
DELETE FROM portal_user_properties WHERE portal_user_id = ${q(s.ids.portalUser)};
DELETE FROM portal_users WHERE id = ${q(s.ids.portalUser)};
DELETE FROM property_ownerships WHERE id = ${q(s.ids.ownership)};
DELETE FROM contacts WHERE id = ${q(s.ids.contact)};
SELECT set_config('trusted.ownership_transfer', '', true);
DELETE FROM community_account_roles WHERE community_id = ${c} AND updated_by = 'payment-sandbox';
DELETE FROM accounting_periods WHERE id IN (${periodIds});
DELETE FROM chart_of_accounts WHERE id IN (${coaIds});
DELETE FROM account_funds WHERE id = ${q(s.ids.fund)};
UPDATE communities SET gl_cutover_date = NULL WHERE id = ${c} AND gl_cutover_date = ${q(s.glCutover)};
UPDATE properties SET payment_sandbox = false,
       trusted_account_number = CASE WHEN trusted_account_number = ${q(s.trustedAccountNumber)} THEN NULL ELSE trusted_account_number END
 WHERE id = ${lot};`;
}

// What exists now, keyed like sandboxRows().
async function stateReport(client) {
  const s = SANDBOX, c = s.communityId;
  const one = async (sql, p) => (await client.query(sql, p)).rows;
  const lot = (await one('SELECT payment_sandbox, trusted_account_number FROM properties WHERE id = $1', [s.lotId]))[0] || null;
  const comm = (await one('SELECT gl_cutover_date::text AS gl_cutover_date, stripe_connected_account_id FROM communities WHERE id = $1', [c]))[0] || null;
  const has = async (table, id) => (await one(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).length === 1;
  return {
    lot, community: comm,
    fund: await has('account_funds', s.ids.fund),
    coa: Object.fromEntries(await Promise.all(Object.entries(s.ids.coa).map(async ([n, id]) => [n, await has('chart_of_accounts', id)]))),
    periods: (await one('SELECT count(*)::int AS n FROM accounting_periods WHERE id = ANY($1::uuid[])', [s.ids.periods]))[0].n,
    roles: (await one(`SELECT role FROM community_account_roles WHERE community_id = $1 AND updated_by = 'payment-sandbox' ORDER BY role`, [c])).map((r) => r.role),
    contact: await has('contacts', s.ids.contact),
    ownership: (await one('SELECT tenure_id FROM property_ownerships WHERE id = $1', [s.ids.ownership]))[0] || null,
    portal_user: await has('portal_users', s.ids.portalUser),
    portal_access: (await one('SELECT 1 FROM portal_user_properties WHERE portal_user_id = $1 AND property_id = $2', [s.ids.portalUser, s.lotId])).length === 1,
  };
}

// action: 'plan' | 'apply' | 'plan_remove' | 'remove'. client: a connected pg Client.
async function runPaymentSandbox(client, { action, key = process.env.STRIPE_SECRET_KEY }) {
  if (!['plan', 'apply', 'plan_remove', 'remove'].includes(action)) throw new Error(`unknown action ${action}`);
  const mode = stripeMode(key);
  if (mode !== 'test') { const e = new Error(`refused: Stripe is ${mode}; the payment sandbox runs only with a Stripe TEST key`); e.code = 'NOT_TEST_MODE'; throw e; }
  const commit = action === 'apply' || action === 'remove';
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('trusted.payment_sandbox_run', $1, true)`, [RUN_FLAG]);
    await client.query(preflightSql());
    const before = await stateReport(client);
    await client.query(action.endsWith('remove') ? removeSql() : applySql());
    const after = await stateReport(client);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return { action, committed: commit, stripe_mode: mode, rows: sandboxRows(), before, after };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already aborted */ }
    throw e;
  }
}

module.exports = { runPaymentSandbox, sandboxRows, SANDBOX, _sql: { preflightSql, applySql, removeSql } };
