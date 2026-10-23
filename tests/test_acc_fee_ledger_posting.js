#!/usr/bin/env node
// ============================================================================
// The homeowner-pays ACC fee posts to the homeowner LEDGER and the GL together
// (lib/acc/acc_fee_posting.js, Ed 2026-10-21), never as a native ar_charges
// row, and HOLDS anything uncertain. In-memory database; the real planner and
// poster with injected JE / ledger writers. Live (read-only, SUPABASE_URL):
// the planner's verdict on every Canyon Gate decision since the conversion.
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { planAccFee, postAccFee } = require('../lib/acc/acc_fee_posting');

let pass = 0; let fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); } };

function fakeDb(seed) {
  const db = JSON.parse(JSON.stringify(seed));
  const get = (r, k) => { const m = /^(\w+)->>(\w+)$/.exec(k); return m ? (r[m[1]] || {})[m[2]] : r[k]; };
  return {
    _db: db,
    from(t) {
      let rows = (db[t] || []).slice();
      const q = {
        select: () => q, order: () => q,
        eq: (k, v) => { rows = rows.filter((r) => String(get(r, k)) === String(v)); return q; },
        in: (k, vs) => { rows = rows.filter((r) => vs.includes(r[k])); return q; },
        gt: (k, v) => { rows = rows.filter((r) => r[k] > v); return q; },
        gte: (k, v) => { rows = rows.filter((r) => String(r[k]) >= String(v)); return q; },
        limit: (n) => { rows = rows.slice(0, n); return q; },
        maybeSingle: () => Promise.resolve({ data: rows[0] || null, error: null }),
        then: (res, rej) => Promise.resolve({ data: rows, error: null }).then(res, rej),
      };
      return q;
    },
  };
}
const C = 'cg', P = 'lot-1';
const world = (over = {}) => fakeDb({
  communities: [{ id: C, acc_fee_payer: 'homeowner', acc_fee_cents: 2500, gl_cutover_date: '2026-08-01', ...(over.community || {}) }],
  v_current_property_owners: over.owners || [{ property_id: P, tenure_id: 'ten-1', owner_name: 'Biasiolli Jr., Donald C.' }],
  homeowner_transactions: over.ledgerRaw || [],
  ar_charges: over.native || [],
  v_current_owner_ledger: over.ledger || [],
  homeowner_ledger_entries: over.history || [],
  ar_charge_types: [{ community_id: C, type_code: 'acc_fee', is_active: true, gl_receivable_account_id: 'a1300', gl_revenue_account_id: 'a2300', display_name: 'ACC Application Processing Fee' }],
  chart_of_accounts: [{ id: 'a1300', account_number: '1300', account_name: 'Accounts Receivable' }, { id: 'a2300', account_number: '2300', account_name: 'Accrued Liability' }],
});
const dec = (over = {}) => ({ id: 'd1', community_id: C, homeowner_name: 'Donald C. Biasiolli Jr.', homeowner_address: '19807 Big Canyon Dr.', reference_number: null, decided_at: '2026-08-26T15:00:00Z', ...over });
const resolveProperty = async (_s, _c, addr) => (/big canyon/i.test(addr) ? { id: P, street_address: '19807 Big Canyon Drive' } : null);
function writers({ ledgerFails = false } = {}) {
  const calls = { je: [], ledger: [], voided: [] };
  return { calls, deps: {
    resolveProperty,
    postJE: async (je) => { calls.je.push(je); return { entry: { id: `je${calls.je.length}` } }; },
    voidJE: async (v) => { calls.voided.push(v); return { reversal_entry: { id: 'rev1' } }; },
    postCharge: async (_s, o) => { if (ledgerFails) throw new Error('insert failed'); calls.ledger.push(o); return { chargeId: 'ht1' }; },
  } };
}

(async () => {
  console.log('a clean decision posts once, to the ledger and the GL');
  let w = writers();
  let r = await postAccFee(world(), dec(), { deps: w.deps });
  const je = w.calls.je[0]; const led = w.calls.ledger[0];
  check('posted: one JE + one ledger line, nothing native', r.posted && w.calls.je.length === 1 && w.calls.ledger.length === 1);
  check('JE: Dr 1300 / Cr 2300 $25, dated the decision, sourced to the decision, balanced',
    je.lines[0].account_id === 'a1300' && je.lines[0].debit_cents === 2500 && je.lines[1].account_id === 'a2300' && je.lines[1].credit_cents === 2500
    && je.posting_date === '2026-08-26' && je.source_module === 'acc_fee' && je.source_reference === 'd1');
  check('ledger line: current owner tenure, $25, category other, carries decision + JE ids',
    led.tenureId === 'ten-1' && led.amountCents === 2500 && led.chargeCategory === 'other' && led.raw.acc_decision_id === 'd1' && led.raw.journal_entry_id === 'je1');
  check('poster source never creates a native ar_charges row', !/from\('ar_charges'\)\.insert|createCharge/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'acc', 'acc_fee_posting.js'), 'utf8')));

  console.log('idempotent');
  w = writers();
  r = await postAccFee(world({ ledgerRaw: [{ id: 'ht0', community_id: C, raw_row_jsonb: { acc_decision_id: 'd1', journal_entry_id: 'je0' } }] }), dec(), { deps: w.deps });
  check('a decision already on the ledger returns the existing posting, writes nothing', r.posted && r.already && r.homeowner_transaction_id === 'ht0' && !w.calls.je.length && !w.calls.ledger.length);

  console.log('holds: never posted');
  const held = async (name, wd, d, rx) => {
    const ww = writers(); const x = await postAccFee(wd, d, { deps: ww.deps });
    check(name, x.held && !x.posted && !ww.calls.je.length && !ww.calls.ledger.length && x.holds.some((h) => rx.test(h)), JSON.stringify(x.holds));
  };
  await held('address does not resolve (20023 BlackCanyon)', world(), dec({ homeowner_address: '20023 BlackCanyon Drive' }), /does not resolve/);
  await held('applicant is not the owner of record (Grand Canyon Gate / Chelsea Canyon)', world({ owners: [{ property_id: P, tenure_id: 'ten-1', owner_name: 'Michael G. Coury' }] }), dec({ homeowner_name: 'Kevin and Nicole Jenkins' }), /not the owner of record/);
  await held('an ARC fee already on the ledger (conversion opening balance)', world({ ledger: [{ id: 'o1', property_id: P, transaction_date: '2026-07-31', description: 'Opening balance 2026-07-31 (ARC Fee)', amount_cents: 2500 }] }), dec(), /already on this owner's ledger/);
  await held('an ARC fee in the prior-system history (Vantaca, April)', world({ history: [{ property_id: P, source: 'vantaca_history', entry_date: '2026-04-10', description: 'ARC Fee', charge_cents: 2500 }] }), dec(), /prior system/);
  await held('decision before the 8/1 conversion', world(), dec({ decided_at: '2026-07-20T12:00:00Z' }), /before the 2026-08-01 conversion/);
  await held('two current owner periods', world({ owners: [{ property_id: P, tenure_id: 't1', owner_name: 'A B' }, { property_id: P, tenure_id: 't2', owner_name: 'Biasiolli Jr., Donald C.' }] }), dec(), /more than one current owner/);
  await held('a native charge from the retired path already exists', world({ native: [{ id: 'nat1', community_id: C, source_module: 'acc_decision', source_reference: 'd1' }] }), dec(), /retired path/);
  const nf = await planAccFee(world({ community: { acc_fee_payer: 'association' } }), dec(), { deps: { resolveProperty } });
  check('an association-pays community never bills the homeowner', nf.holds.length === 1 && /does not bill/.test(nf.holds[0]));

  console.log('names: people and entities');
  for (const [app, owner, ok] of [['Kevin and Glynn Thoms', 'Glynn Thoms', true], ['HTX Premier Properties LLC / Tom Nguyen', 'LLC., HTX Premier Properties', true], ['Marissa Laygo', 'Raul Laygo', false], ['Donald C. Biasiolli Jr.', 'Biasiolli Jr., Donald C.', true]]) {
    const p = await planAccFee(world({ owners: [{ property_id: P, tenure_id: 'ten-1', owner_name: owner }] }), dec({ homeowner_name: app }), { deps: { resolveProperty } });
    check(`"${app}" vs owner "${owner}": ${ok ? 'match' : 'hold'}`, ok === !p.holds.some((h) => /owner of record/.test(h)));
  }

  console.log('the GL and the ledger never disagree');
  w = writers({ ledgerFails: true });
  let threw = false; try { await postAccFee(world(), dec(), { deps: w.deps }); } catch (_) { threw = true; }
  check('a failed ledger write reverses the JE and surfaces the error', threw && w.calls.voided.length === 1 && w.calls.voided[0].journal_entry_id === 'je1');

  console.log('finalize uses the ledger path');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const fin = srv.slice(srv.indexOf("Homeowner-pays ACC fee (Ed 2026-07-25"), srv.indexOf("Homeowner-pays ACC fee (Ed 2026-07-25") + 3000);
  check('ACC finalize calls postAccFee and no longer calls createCharge', /postAccFee\(/.test(fin) && !/createCharge/.test(fin));

  if (process.env.SUPABASE_URL) {
    console.log('live (read-only): planner verdicts for Canyon Gate decisions since the conversion');
    const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const { data, error } = await sb.from('acc_decisions').select('id, community_id, homeowner_name, homeowner_address, reference_number, decided_at, status')
      .eq('community_id', 'a0000000-0000-4000-8000-000000000003').eq('status', 'decided').gte('decided_at', '2026-08-01');
    if (error) throw error;
    const verdict = {};
    for (const d of data) { const p = await planAccFee(sb, d); verdict[String(d.homeowner_address).split(',')[0]] = p.already_posted ? 'posted' : p.holds.length ? 'hold' : 'ready'; }
    console.log('      ', JSON.stringify(verdict));
    check('Clear Canyon + Big Canyon ready; Grand Canyon Gate, Black Canyon, Chelsea Canyon held; nothing posted',
      verdict['6235 Clear Canyon Dr'] === 'ready' && verdict['19807 Big Canyon Dr.'] === 'ready'
      && verdict['6411 Grand Canyon Gate Drive'] === 'hold' && verdict['20023 BlackCanyon Drive'] === 'hold' && verdict['20223 Chelsea Canyon Ct.'] === 'hold');
  }
})().catch((e) => { fail++; console.log(`  ✗ threw: ${e.stack}`); })
  .finally(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); });
