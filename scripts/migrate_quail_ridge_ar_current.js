// ============================================================================
// scripts/migrate_quail_ridge_ar_current.js
// ----------------------------------------------------------------------------
// Rebuild Quail Ridge's per-homeowner AR subledger to CURRENT (replacing the
// 12/31/2025 opening-only load) so homeowner statements tie to the GL AR
// control account 1300 ($20,374.91) after 2026 activity.
//
// Source = two Vantaca exports Ed provided 2026-06-20:
//   - AR Aging.xls (12/31/2025)        -> per (property, category) opening balances
//   - GLTrialBalance.xls (account 1300) -> every 2026 charge + payment, per property
//
// Each AR line's description is "<address>: <category>" (or, for collection
// accounts, "<address> - <owner> Coll Status: <status>: <category>"). The
// address is the text before the first " - " or ":"; the charge category is the
// text after the last ":". Transaction TYPE distinguishes charges (Owner
// Charge), reductions (Owner Payment / Credit Distribution), and reversals
// (Void = a refunded payment, which pushes the balance back up).
//
// Method: build each property's outstanding charges (opening buckets + 2026
// charges), then apply its net payments in Texas Property Code 209.0063 order
// (assessments first, then interest/fees/fines; oldest first within a tier).
// balance_remaining per charge drives the statement + aging. Property totals
// are authoritative (they tie to the GL to the penny); the per-category split
// is reconstructed per statute (Vantaca's internal application order is not in
// the export).
//
// --apply to write; dry-run otherwise. Verifies the grand total ties first.
// ============================================================================
require('dotenv').config();
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const CID = 'a0000000-0000-4000-8000-000000000005';
const OPENING_FILE = 'C:/Users/edget/Downloads/AR Aging.xls';
// All 2026 GL detail files (each contributes its account-1300 transactions).
// Add each new month's export here so the subledger stays tied to the control.
const GL_FILES = ['C:/Users/edget/Downloads/GLTrialBalance.xls', 'C:/Users/edget/Downloads/GLTrialBalance (1).xls'];
// The GL AR control (1300) is read live from the trial balance at runtime so
// the subledger always reconciles to whatever the GL currently says.
let GL_AR_CONTROL = 0;

const D = (d) => Math.round(d * 100);
const num = (v) => { let t = String(v || '').trim(); if (t === '-' || t === '') return 0; const neg = /^-/.test(t) || /^\(.*\)$/.test(t); t = t.replace(/[^0-9.]/g, ''); const n = parseFloat(t) || 0; return neg ? -n : n; };
const normAddr = (a) => (a || '').toLowerCase().replace(/[:]/g, '').replace(/\s+/g, ' ').trim();
// address = text before the first ' - ' or ':'
const addrOf = (desc) => { const a = desc.indexOf(' - '); const b = desc.indexOf(':'); let cut = desc.length; if (a >= 0) cut = Math.min(cut, a); if (b >= 0) cut = Math.min(cut, b); return desc.slice(0, cut).trim(); };
// category = text after the last ':'
const catOf = (desc) => { const i = desc.lastIndexOf(':'); return (i >= 0 ? desc.slice(i + 1) : desc).trim(); };
const mdyToIso = (mdy) => { const m = mdy.match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[1]}-${m[2]}` : null; };

// Vantaca category label (opening OR GL) -> trustEd charge_type type_code.
function catToType(cat) {
  if (/^Annual Assessment/i.test(cat)) return 'annual_assessment';
  if (/^Balance Forward - Assessment/i.test(cat)) return 'balance_forward_assessment';
  if (/^Late Interest/i.test(cat)) return 'late_interest';
  if (/^Late Fees/i.test(cat)) return 'late_fees';
  if (/^DRV Certified Letter/i.test(cat)) return 'drv_certified_letter';
  if (/^Certified Letter/i.test(cat)) return 'certified_letter';
  if (/^Legal Fees - Collections/i.test(cat)) return 'legal_fees_collections';
  if (/^Legal Fee/i.test(cat)) return 'legal_fee';
  if (/^Balance Forward - Fines/i.test(cat)) return 'balance_forward_fines';
  if (/^Balance Forward - Admin/i.test(cat)) return 'balance_forward_admin_fee';
  if (/^Administrative Fee/i.test(cat)) return 'administrative_fee';
  if (/^Bank Return/i.test(cat)) return 'bank_return';
  if (/^Fines/i.test(cat)) return 'fines';
  return null;
}

(async () => {
  // ---- properties + charge types --------------------------------------------
  const props = [];
  let pf = 0;
  while (true) { const { data } = await s.from('properties').select('id, street_address, vantaca_account_id').eq('community_id', CID).range(pf, pf + 999); props.push(...data); if (data.length < 1000) break; pf += 1000; }
  const byAcct = new Map(props.filter((p) => p.vantaca_account_id).map((p) => [String(p.vantaca_account_id), p]));
  const byAddr = new Map(props.map((p) => [normAddr(p.street_address), p]));
  const resolveByAddr = (addr) => byAddr.get(normAddr(addr));

  const { data: cts } = await s.from('ar_charge_types').select('id, type_code, tx_priority_step').eq('community_id', CID);
  const ctByCode = Object.fromEntries(cts.map((c) => [c.type_code, c]));
  const { data: je } = await s.from('journal_entries').select('id').eq('community_id', CID).eq('reference', 'JE-2026-OPEN').maybeSingle();

  // per property: { charges:[{type_code, due, amount}], creditPool:cents }
  const acct = new Map(); // propId -> {prop, charges, pool}
  const bucket = (p) => { if (!acct.has(p.id)) acct.set(p.id, { prop: p, charges: [], pool: 0 }); return acct.get(p.id); };
  const unknownCats = new Set();
  let unmatched = 0;

  // ---- 1) opening balances (12/31/2025), per (property, category) -----------
  const openAoa = XLSX.utils.sheet_to_json(XLSX.readFile(OPENING_FILE).Sheets['AR Aging'], { header: 1, defval: null, raw: false });
  const OPEN_CATS = new Set(['Annual Assessment', 'Late Fees', 'DRV Certified Letter', 'Certified Letter', 'Legal Fees - Collections/DRV', 'Legal Fee', 'Balance Forward - Admin Fee', 'Balance Forward - Assessment', 'Balance Forward - Fines', 'Late Interest', 'Administrative Fee', 'Bank Return']);
  const OPEN_BUCKETS = [[3, '2025-12-16'], [5, '2025-11-16'], [7, '2025-10-16'], [8, '2025-08-01']];
  const openDue = (r) => { let best = '2025-08-01', max = -1; for (const [c, d] of OPEN_BUCKETS) { const a = Math.abs(num(r[c])); if (a > max) { max = a; best = d; } } return best; };
  let curOpen = null;
  for (const r of openAoa) {
    const c0 = String((r && r[0]) || '').trim();
    const m = c0.match(/^(\d{8})\s*-\s*(.+)/);
    if (m) { curOpen = { acct: m[1], addr: m[2].trim() }; continue; }
    if (curOpen && OPEN_CATS.has(c0)) {
      const amt = num(r[9]);
      if (amt === 0) continue;
      const p = byAcct.get(curOpen.acct) || resolveByAddr(curOpen.addr);
      if (!p) { unmatched++; continue; }
      const b = bucket(p);
      if (amt > 0) b.charges.push({ type_code: catToType(c0) || 'other', due: openDue(r), amount_cents: D(amt) });
      else b.pool += D(-amt); // prepaid credit
      if (!catToType(c0)) unknownCats.add(c0);
    }
  }

  // ---- 2) 2026 activity from each GL detail file (account 1300) --------------
  for (const file of GL_FILES) {
    const wb = XLSX.readFile(file);
    const glAoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null, raw: false });
    let inAR = false;
    for (const r of glAoa) {
      const c0 = String((r && r[0]) || '').trim();
      const m = c0.match(/^(\d{4})\s*-\s*(.+)/);
      if (m) { inAR = (m[1] === '1300'); continue; }
      if (!inAR) continue;
      const date = String((r && r[1]) || '').trim();
      if (!/\d{2}\/\d{2}\/\d{4}/.test(date)) continue;
      const desc = String((r && r[3]) || '').trim();
      const type = String((r && r[12]) || '').trim();
      const dr = num(r[8]), cr = num(r[10]);
      const p = resolveByAddr(addrOf(desc));
      if (!p) { unmatched++; continue; }
      const b = bucket(p);
      if (type === 'Owner Charge') {
        const tc = catToType(catOf(desc));
        if (!tc) unknownCats.add(catOf(desc));
        b.charges.push({ type_code: tc || 'other', due: mdyToIso(date), amount_cents: D(dr) });
      } else if (type === 'Void') {
        b.pool -= D(dr); // refunded payment pushes balance back up
      } else {
        b.pool += D(cr); // Owner Payment / Credit Distribution
      }
    }
  }

  // Read the live GL AR control (1300) so the subledger reconciles to the GL.
  const { data: tbAr } = await s.from('v_trial_balance').select('total_debits_cents, total_credits_cents, account_number').eq('community_id', CID).eq('account_number', '1300').maybeSingle();
  GL_AR_CONTROL = (Number(tbAr.total_debits_cents) - Number(tbAr.total_credits_cents)) / 100;

  // ---- 3) apply payments per 209.0063 (priority asc, then oldest first) ------
  const prio = (tc) => (ctByCode[tc] ? ctByCode[tc].tx_priority_step : 99);
  const chargeRows = [], creditRows = [];
  let grand = 0;
  for (const { prop, charges, pool } of acct.values()) {
    charges.sort((a, b) => (prio(a.type_code) - prio(b.type_code)) || a.due.localeCompare(b.due));
    let left = pool;
    for (const ch of charges) {
      const applied = Math.min(ch.amount_cents, Math.max(0, left));
      ch.remaining = ch.amount_cents - applied;
      left -= applied;
    }
    for (const ch of charges) {
      if (ch.remaining <= 0) continue;
      const ct = ctByCode[ch.type_code];
      chargeRows.push({
        community_id: CID, property_id: prop.id, charge_type_id: ct ? ct.id : null,
        charge_date: ch.due, due_date: ch.due,
        description: `${ch.type_code.replace(/_/g, ' ')} (balance as of 6/20/2026)`,
        original_amount_cents: ch.amount_cents, balance_remaining_cents: ch.remaining,
        status: 'open', // any remaining balance is 'open' (no 'partial' in ar_charges CHECK)
        source_module: 'vantaca_migration', posting_journal_entry_id: je ? je.id : null,
      });
      grand += ch.remaining;
    }
    if (left > 0) { // unapplied credit
      creditRows.push({
        community_id: CID, property_id: prop.id, payment_date: '2026-06-20',
        amount_cents: left, unapplied_balance_cents: left,
        source: 'vantaca_migration', status: 'received', notes: 'Unapplied account credit (as of 6/20/2026)',
        posting_journal_entry_id: je ? je.id : null,
      });
      grand -= left;
    }
  }

  console.log(`Properties with activity: ${acct.size} | charges: ${chargeRows.length} | credits: ${creditRows.length} | unmatched lines: ${unmatched}`);
  if (unknownCats.size) console.log('UNKNOWN categories (mapped to other):', [...unknownCats].join(' | '));
  console.log(`Net current AR: $${(grand / 100).toFixed(2)} vs GL control $${GL_AR_CONTROL.toFixed(2)} — ${Math.abs(grand / 100 - GL_AR_CONTROL) < 0.02 ? 'TIES ✓' : 'DIFF $' + (GL_AR_CONTROL - grand / 100).toFixed(2)}`);

  if (chargeRows.some((c) => !c.charge_type_id)) { console.error('Refusing: some charges have no charge_type_id (unknown category).'); process.exit(1); }
  if (Math.abs(grand / 100 - GL_AR_CONTROL) >= 0.02) { console.error('Refusing: subledger does not tie to GL control.'); process.exit(1); }
  if (!APPLY) { console.log('\nDRY RUN — pass --apply to rebuild the subledger.'); return; }

  // ---- 4) replace prior migration rows --------------------------------------
  await s.from('ar_payments').delete().eq('community_id', CID).eq('source', 'vantaca_migration');
  await s.from('ar_charges').delete().eq('community_id', CID).eq('source_module', 'vantaca_migration');
  for (let i = 0; i < chargeRows.length; i += 200) { const { error } = await s.from('ar_charges').insert(chargeRows.slice(i, i + 200)); if (error) { console.error('charge insert failed:', error.message); process.exit(1); } }
  if (creditRows.length) { const { error } = await s.from('ar_payments').insert(creditRows); if (error) console.warn('credit insert failed:', error.message); }
  console.log(`\nREBUILT: ${chargeRows.length} charges + ${creditRows.length} credits. Homeowner statements now current and tie to GL.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
