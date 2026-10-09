#!/usr/bin/env node
// ============================================================================
// scripts/propose_balance_sheet_mapping.js  (Ed 2026-10-09, month-end close PR C)
// ----------------------------------------------------------------------------
// PROPOSES balance-sheet categories for a community's asset / liability / equity
// accounts from DURABLE ROLES ONLY, never from account names:
//   - bank_accounts.gl_account_number: an operating bank account's GL account is
//     "Cash & cash equivalents"; a reserve / capital-improvement / special-
//     assessment bank account's is "Reserve & investment accounts";
//   - recognition_schedules.balance_account_number: a prepaid_expense schedule's
//     balance account is "Prepaids"; a deferred_revenue schedule's is "Deferred
//     assessments";
//   - chart_of_accounts.account_type = 'equity': "Fund balance".
// Everything else stays Unmapped for a person to assign.
//
// Proposals are written as approval_status = 'proposed'. They do NOT group the
// balance sheet until a person approves them (Accounting > Financial statements
// > Balance-sheet mapping). An account that already has a balance-sheet mapping
// (proposed or approved) is never touched.
//
// DRY RUN by default (prints what it would do). Writing needs migration 505 and
// Ed's go-ahead:
//   node scripts/propose_balance_sheet_mapping.js --community <uuid>
//   node scripts/propose_balance_sheet_mapping.js --community <uuid> --apply --actor "Ed Gojara"
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const CATS = {
  cash: { section: 'asset', name: 'Cash & cash equivalents', display_order: 10 },
  reserve: { section: 'asset', name: 'Reserve & investment accounts', display_order: 20 },
  prepaid: { section: 'asset', name: 'Prepaids', display_order: 40 },
  deferred: { section: 'liability', name: 'Deferred assessments', display_order: 20 },
  fund_balance: { section: 'equity', name: 'Fund balance', display_order: 10 },
};
const BANK_ROLE = { operating: 'cash', reserve: 'reserve', capital_improvement: 'reserve', special_assessment: 'reserve' };
const RECOG_ROLE = { prepaid_expense: 'prepaid', deferred_revenue: 'deferred' };

// Pure: accounts + role sources -> proposals [{ account, role, basis }] and conflicts.
function proposeFromRoles({ accounts, banks, schedules, existing }) {
  const byNumber = new Map(accounts.map((a) => [String(a.account_number), a]));
  const roles = new Map();   // account_id -> [{ role, basis }]
  const add = (a, role, basis) => { if (!a) return; if (!roles.has(a.id)) roles.set(a.id, []); roles.get(a.id).push({ role, basis }); };
  for (const b of banks) if (b.is_active !== false && b.gl_account_number && BANK_ROLE[b.account_type]) add(byNumber.get(String(b.gl_account_number)), BANK_ROLE[b.account_type], `bank account ${b.account_nickname || ''}${b.account_last4 ? ' ••' + b.account_last4 : ''} (${b.account_type})`.trim());
  for (const s of schedules) if (s.balance_account_number && RECOG_ROLE[s.schedule_type]) add(byNumber.get(String(s.balance_account_number)), RECOG_ROLE[s.schedule_type], `${s.schedule_type.replace('_', ' ')} schedule`);
  for (const a of accounts) if (a.account_type === 'equity') add(a, 'fund_balance', 'account type equity');
  const proposals = [], conflicts = [], skipped = [];
  for (const a of accounts) {
    const rs = roles.get(a.id); if (!rs) continue;
    if (existing.has(a.id)) { skipped.push({ account: a, why: 'already has a balance-sheet mapping' }); continue; }
    const distinct = [...new Set(rs.map((r) => r.role))];
    if (distinct.length > 1) { conflicts.push({ account: a, roles: rs }); continue; }   // two roles disagree: a person decides
    const cat = CATS[distinct[0]];
    if (cat.section !== a.account_type) { conflicts.push({ account: a, roles: rs, why: `role says ${cat.section}, account is ${a.account_type}` }); continue; }
    proposals.push({ account: a, role: distinct[0], basis: [...new Set(rs.map((r) => r.basis))].join('; ') });
  }
  return { proposals, conflicts, skipped };
}

async function main() {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
  const cid = arg('--community'); const apply = process.argv.includes('--apply'); const actor = arg('--actor');
  if (!cid) { console.error('usage: --community <uuid> [--apply --actor "Name"]'); process.exit(2); }
  if (apply && !actor) { console.error('--apply needs --actor (who is proposing)'); process.exit(2); }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const must = (r, w) => { if (r.error) throw new Error(`${w}: ${r.error.message}`); return r.data || []; };
  const accounts = must(await sb.from('chart_of_accounts').select('id, account_number, account_name, account_type').eq('community_id', cid).in('account_type', ['asset', 'liability', 'equity']).order('account_number').limit(5000), 'chart_of_accounts');
  const banks = must(await sb.from('bank_accounts').select('account_nickname, account_last4, account_type, gl_account_number, is_active').eq('community_id', cid).limit(200), 'bank_accounts');
  const schedules = must(await sb.from('recognition_schedules').select('schedule_type, balance_account_number').eq('community_id', cid).limit(2000), 'recognition_schedules');
  const maps = must(await sb.from('account_report_map').select('account_id, approval_status').eq('community_id', cid).eq('statement', 'balance_sheet').limit(5000), 'account_report_map (needs migration 505)');
  const { proposals, conflicts, skipped } = proposeFromRoles({ accounts, banks, schedules, existing: new Set(maps.map((m) => m.account_id)) });
  const unmappedAfter = accounts.length - maps.length - proposals.length;
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${accounts.length} balance-sheet accounts; ${maps.length} already mapped; ${proposals.length} to propose; ${conflicts.length} conflicting; ${unmappedAfter} left for a person.`);
  for (const p of proposals) console.log(`  propose ${p.account.account_number} ${p.account.account_name} -> ${CATS[p.role].name}   [${p.basis}]`);
  for (const c of conflicts) console.log(`  CONFLICT ${c.account.account_number} ${c.account.account_name}: ${c.why || c.roles.map((r) => `${r.role} (${r.basis})`).join(' vs ')}`);
  for (const s of skipped) console.log(`  skip ${s.account.account_number}: ${s.why}`);
  if (!apply || !proposals.length) return;

  const cats = must(await sb.from('report_categories').select('id, section, name, parent_category_id').eq('community_id', cid).eq('statement', 'balance_sheet').limit(2000), 'report_categories');
  const catId = {};
  for (const role of new Set(proposals.map((p) => p.role))) {
    const c = CATS[role];
    const hit = cats.find((x) => !x.parent_category_id && x.section === c.section && x.name.toLowerCase() === c.name.toLowerCase());
    if (hit) { catId[role] = hit.id; continue; }
    const ins = must(await sb.from('report_categories').insert({ community_id: cid, statement: 'balance_sheet', section: c.section, name: c.name, display_order: c.display_order, updated_by: actor }).select('id'), 'report_categories insert');
    catId[role] = ins[0].id;
  }
  const rows = proposals.map((p) => ({ community_id: cid, account_id: p.account.id, statement: 'balance_sheet', category_id: catId[p.role], approval_status: 'proposed', updated_by: actor }));
  const out = must(await sb.from('account_report_map').insert(rows).select('account_id'), 'account_report_map insert');
  console.log(`proposed ${out.length} mapping(s). Nothing groups the balance sheet until a person approves them.`);
}

module.exports = { proposeFromRoles, CATS };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
