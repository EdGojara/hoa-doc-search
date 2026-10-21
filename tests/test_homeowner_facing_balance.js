#!/usr/bin/env node
// ============================================================================
// Every homeowner-facing financial view shows THE homeowner balance
// (lib/ar/owner_balance.js, Ed 2026-10-21): the homeowner portal (balance page,
// summary tile, transaction list), the payment amount, Homeowner 360, Claire
// and Kat's context, the assessment statement and collections notices.
// Before this they read the ledger alone and left native fees (certified-letter
// fees) out; Claire and Kat read an all-tenure view keyed by property.
// Source guard always runs; the live check (read-only) runs with SUPABASE_URL.
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

let pass = 0; let fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); } };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

console.log('source guard: homeowner-facing readers use the one balance');
for (const f of ['lib/ar/resolve_current_ar.js', 'api/homeowner_360.js', 'api/portal.js', 'lib/payments/payment_identity.js',
  'lib/payments/check_receipts.js', 'lib/claire/caller_context.js', 'api/email_triage.js', 'lib/statements/assessment_statement.js', 'lib/collections/notices.js']) {
  const s = read(f);
  check(`${f} reads lib/ar/owner_balance`, /owner_balance/.test(s));
  check(`${f} no longer reads a ledger-only balance view or the old staff helpers`,
    !/from\('v_current_owner_balance'\)|from\('v_homeowner_current_balance'\)\s*\n?\s*\.select\('balance_cents, (as_of|most_recent_txn_date)'\)\.eq\('property_id'|currentOwnerBalance\(|_openChargesFromTransactions/.test(s));
}

(async () => {
  if (!process.env.SUPABASE_URL) { console.log('live check skipped (no SUPABASE_URL)'); return; }
  console.log('live (read-only): the accounts with native fees, credits and plain balances');
  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { ownerBalances } = require('../lib/ar/owner_balance');
  const { resolveCurrentAR } = require('../lib/ar/resolve_current_ar');
  const { resolvePaymentIdentity } = require('../lib/payments/payment_identity');
  const { buildStatementData } = require('../lib/statements/assessment_statement');
  const { eligibleAccounts } = require('../lib/collections/notices');
  const { _test: { assemble } } = require('../api/homeowner_360');
  const { data: comms, error } = await sb.from('communities').select('id, name').eq('management_status', 'active');
  if (error) throw error;
  for (const c of comms) {
    const bal = await ownerBalances(sb, c.id);
    const pids = Object.keys(bal);
    if (!pids.length) continue;
    const pick = (f) => pids.filter(f).slice(0, 4);
    const sample = [...new Set([...pick((p) => bal[p].native_open_cents > 0), ...pick((p) => bal[p].credit_cents > 0), ...pick((p) => bal[p].net_due_cents > 0)])];
    const why = [];
    for (const p of sample) {
      const B = bal[p].net_due_cents;
      const ar = await resolveCurrentAR(sb, { propertyId: p });
      const idr = await resolvePaymentIdentity(sb, p);
      const st = await buildStatementData(sb, p);
      const last = st.activity.length ? st.activity[st.activity.length - 1].total_cents : st.balance_cents;
      const { data: o } = await sb.from('v_current_property_owners').select('owner_contact_id').eq('property_id', p).maybeSingle();
      const h = o && o.owner_contact_id ? await assemble(o.owner_contact_id) : null;
      const h360 = h ? h.ar.balance_cents : null;
      const hOwnsOne = h && (h.properties || []).length === 1;
      const vals = { portal: ar ? ar.balance_cents : null, payment: idr.ok ? idr.identity.balance_cents : 'n/a', statement: st.balance_cents, statement_last_line: last, h360: hOwnsOne ? h360 : 'multi-lot' };
      const good = vals.portal === B && (vals.payment === 'n/a' || vals.payment === B) && vals.statement === B && (st.activity.length < 300 ? last === B : true) && (vals.h360 === 'multi-lot' || vals.h360 === B);
      if (!good) why.push(`${p.slice(0, 8)} net ${B} ${JSON.stringify(vals)}`);
    }
    check(`${c.name}: portal, payment amount, statement (and its last line), Homeowner 360 = THE balance (${sample.length} accounts)`, !why.length, why.join(' | '));
    const el = await eligibleAccounts(sb, c.id).catch((e) => ({ community_blocked: e.message, accounts: [] }));
    if (el.community_blocked) console.log(`      notices: not configured (${String(el.community_blocked).slice(0, 70)})`);
    else check(`${c.name}: collections-notice candidates carry THE balance (${el.accounts.length})`, el.accounts.every((a) => a.balance_cents === bal[a.property_id].net_due_cents));
  }
})().catch((e) => { fail++; console.log(`  ✗ live check threw: ${e.stack}`); })
  .finally(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); });
