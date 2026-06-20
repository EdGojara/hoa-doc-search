// ============================================================================
// scripts/populate_quail_ridge_prepaids.js
// ----------------------------------------------------------------------------
// Book Quail Ridge's owner prepaid credits (GL 2400 "Prepaid Owner Assessments")
// into the AR subledger as unapplied ar_payments, so the 2400 control account
// ties to a subledger (the tie-out check). Source: PrepaidHomeowners.xls (5/31
// snapshot) + the June GL detail's account-2400 activity.
//
// Only CURRENT-owner prepaids can be booked (ar_payments requires a property).
// Credits belonging to FORMER owners (Vantaca "***" accounts on placeholder
// "Filler Way" lots not in our roster) are a refunds-payable liability, NOT a
// homeowner prepayment — they're reported here for a refund/escheatment
// decision, not booked. Joe Lukose's $707.19 is the big one.
//
// Idempotent: marks rows with source_reference='prepaid_2400' (which the AR
// rebuild preserves) and clears its own rows before re-inserting.
// --apply to write; dry-run otherwise.
// ============================================================================
require('dotenv').config();
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const CID = 'a0000000-0000-4000-8000-000000000005';
const PREPAID_FILE = 'C:/Users/edget/Downloads/PrepaidHomeowners.xls';
const JUNE_GL = 'C:/Users/edget/Downloads/GLTrialBalance (1).xls';
const MARKER = 'prepaid_2400';
const D = (d) => Math.round(d * 100);
const num = (v) => { let t = String(v || '').trim(); if (t === '-' || t === '') return 0; const neg = /^-/.test(t) || /^\(.*\)$/.test(t); t = t.replace(/[^0-9.]/g, ''); const n = parseFloat(t) || 0; return neg ? -n : n; };
const normAddr = (a) => (a || '').toLowerCase().replace(/[:]/g, '').replace(/\s+/g, ' ').trim();
const addrOf = (desc) => { const a = desc.indexOf(' - '); const b = desc.indexOf(':'); let cut = desc.length; if (a >= 0) cut = Math.min(cut, a); if (b >= 0) cut = Math.min(cut, b); return desc.slice(0, cut).trim(); };

(async () => {
  const props = [];
  let pf = 0;
  while (true) { const { data } = await s.from('properties').select('id, street_address, vantaca_account_id').eq('community_id', CID).range(pf, pf + 999); props.push(...data); if (data.length < 1000) break; pf += 1000; }
  const byAcct = new Map(props.filter((p) => p.vantaca_account_id).map((p) => [String(p.vantaca_account_id), p]));
  const byAddr = new Map(props.map((p) => [normAddr(p.street_address), p]));

  // per property: { prop, cents, who }
  const current = new Map();
  const former = [];
  const addPrepaid = (p, cents, who) => { if (!current.has(p.id)) current.set(p.id, { prop: p, cents: 0, who }); current.get(p.id).cents += cents; };

  // 1) 5/31 snapshot
  const aoa = XLSX.utils.sheet_to_json(XLSX.readFile(PREPAID_FILE).Sheets['PrepaidHomeowners'], { header: 1, defval: null, raw: false });
  for (const r of aoa) {
    const acctRaw = String((r && r[0]) || '').trim();
    const m = acctRaw.match(/^\**\s*(\d{8})/);
    if (!m) continue;
    const acct = m[1], prior = acctRaw.includes('***');
    const owner = String(r[3] || '').trim(), addr = String(r[1] || '').trim(), amt = D(num(r[4]));
    if (amt === 0) continue;
    const p = byAcct.get(acct);
    if (p && !prior) addPrepaid(p, amt, owner);
    else former.push({ acct, owner, addr, cents: amt });
  }

  // 2) June 2400 activity (additional current-owner prepayments, by address)
  const jwb = XLSX.readFile(JUNE_GL);
  const jaoa = XLSX.utils.sheet_to_json(jwb.Sheets[jwb.SheetNames[0]], { header: 1, defval: null, raw: false });
  let in24 = false;
  for (const r of jaoa) {
    const mm = String((r && r[0]) || '').trim().match(/^(\d{4})\s*-\s*(.+)/);
    if (mm) { in24 = (mm[1] === '2400'); continue; }
    if (!in24 || !/\d{2}\/\d{2}\/\d{4}/.test(String((r && r[1]) || ''))) continue;
    const cr = num(r[10]); if (cr <= 0) continue; // credit = prepaid added
    const p = byAddr.get(normAddr(addrOf(String(r[3] || ''))));
    if (p) addPrepaid(p, D(cr), 'June prepayment');
    else former.push({ acct: '(june)', owner: String(r[3] || '').trim(), addr: addrOf(String(r[3] || '')), cents: D(cr) });
  }

  const currentTotal = [...current.values()].reduce((a, c) => a + c.cents, 0);
  const formerTotal = former.reduce((a, c) => a + c.cents, 0);
  const f = (c) => '$' + (c / 100).toFixed(2);
  console.log('CURRENT-owner prepaids (bookable):');
  for (const c of current.values()) console.log(`  ${c.prop.street_address.padEnd(26)} ${f(c.cents).padStart(10)}  ${c.who}`);
  console.log(`  subtotal ${f(currentTotal)}\n`);
  console.log('FORMER-owner credits (refund liability — NOT booked, needs decision):');
  for (const c of former) console.log(`  ${c.acct.padEnd(11)} ${(c.owner || '').padEnd(26).slice(0, 26)} ${f(c.cents).padStart(10)}  ${c.addr}`);
  console.log(`  subtotal ${f(formerTotal)}\n`);

  // GL 2400 control
  const { data: tb } = await s.from('v_trial_balance').select('total_debits_cents, total_credits_cents').eq('community_id', CID).eq('account_number', '2400').maybeSingle();
  const gl2400 = Number(tb.total_credits_cents) - Number(tb.total_debits_cents);
  console.log(`GL 2400 control: ${f(gl2400)}  =  current ${f(currentTotal)} + former ${f(formerTotal)} = ${f(currentTotal + formerTotal)}  ${Math.abs(gl2400 - (currentTotal + formerTotal)) < 2 ? '✓' : 'Δ ' + f(gl2400 - currentTotal - formerTotal)}`);
  console.log(`After booking current-owner prepaids, 2400 tie-out will show subledger ${f(currentTotal)} vs GL ${f(gl2400)} — remaining ${f(gl2400 - currentTotal)} is the former-owner refund liability.`);

  if (!APPLY) { console.log('\nDRY RUN — pass --apply to book the current-owner prepaids.'); return; }
  const { data: je } = await s.from('journal_entries').select('id').eq('community_id', CID).eq('reference', 'JE-2026-OPEN').maybeSingle();
  await s.from('ar_payments').delete().eq('community_id', CID).eq('source_reference', MARKER);
  const rows = [...current.values()].map((c) => ({
    community_id: CID, property_id: c.prop.id, payment_date: '2026-06-20',
    amount_cents: c.cents, unapplied_balance_cents: c.cents,
    source: 'vantaca_migration', source_reference: MARKER, status: 'received',
    notes: `Owner prepaid assessment credit (ties to GL 2400) — ${c.who}`,
    posting_journal_entry_id: je ? je.id : null,
  }));
  if (rows.length) { const { error } = await s.from('ar_payments').insert(rows); if (error) { console.error('insert failed:', error.message); process.exit(1); } }
  console.log(`\nBooked ${rows.length} current-owner prepaid credits (${f(currentTotal)}). Former-owner refunds (${f(formerTotal)}) await your decision.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
