// ============================================================================
// scripts/migrate_quail_ridge_ar_opening.js
// ----------------------------------------------------------------------------
// Load Quail Ridge's per-homeowner opening AR from Vantaca's 12/31/2025 AR Aging
// (AR Aging.xls) as ar_charges subledger detail — by property + category +
// aging bucket — tying to the GL AR control account (1300 = $14,559.99 already
// booked in JE-2026-OPEN). These are subledger records; they do NOT post new GL
// lines (AR is already in the opening entry). Matched by Vantaca account ID
// (stable across ownership changes). --apply to write; dry-run otherwise.
// ============================================================================
require('dotenv').config();
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const CID = 'a0000000-0000-4000-8000-000000000005';
const FILE = 'C:/Users/edget/Downloads/AR Aging.xls';

// Vantaca category label -> trustEd charge_type type_code.
const CAT_TO_TYPE = {
  'Annual Assessment': 'annual_assessment', 'Late Fees': 'late_fees',
  'DRV Certified Letter': 'drv_certified_letter', 'Certified Letter': 'certified_letter',
  'Legal Fees - Collections/DRV': 'legal_fees_collections', 'Legal Fee': 'legal_fee',
  'Balance Forward - Admin Fee': 'balance_forward_admin_fee', 'Balance Forward - Assessment': 'balance_forward_assessment',
  'Balance Forward - Fines': 'balance_forward_fines', 'Late Interest': 'late_interest',
  'Administrative Fee': 'administrative_fee', 'Bank Return': 'bank_return',
};
// Aging bucket columns -> representative due date (ages correctly as of 12/31/25).
const BUCKET_COLS = [[3, '2025-12-16'], [5, '2025-11-16'], [7, '2025-10-16'], [8, '2025-08-01']];
const D = (dollars) => Math.round(dollars * 100);
const num = (v) => { let str = String(v || '').trim(); const neg = /^\(.*\)$/.test(str); str = str.replace(/[^0-9.]/g, ''); const n = parseFloat(str) || 0; return neg ? -n : n; };
// due date = the bucket holding the largest piece of this line's balance.
const dueFor = (r) => { let best = '2025-08-01', max = -1; for (const [c, d] of BUCKET_COLS) { const a = Math.abs(num(r[c])); if (a > max) { max = a; best = d; } } return best; };

(async () => {
  // 1) Parse per (property, category, bucket).
  const aoa = XLSX.utils.sheet_to_json(XLSX.readFile(FILE).Sheets['AR Aging'], { header: 1, defval: null, raw: false });
  const items = [];
  let cur = null;
  for (const r of aoa) {
    const c0 = String((r && r[0]) || '').trim();
    const m = c0.match(/^(\d{8})\s*-\s*(.+)/);
    if (m) { cur = { acct: m[1], addr: m[2].trim() }; continue; }
    if (cur && CAT_TO_TYPE[c0]) {
      const bal = num(r[9]);               // NET balance for this category (credits already subtracted)
      if (bal !== 0) items.push({ acct: cur.acct, addr: cur.addr, category: c0, type_code: CAT_TO_TYPE[c0], amount: bal, due: dueFor(r) });
    }
  }
  const total = items.reduce((a, i) => a + i.amount, 0);
  console.log(`Parsed ${items.length} category lines · NET total $${total.toFixed(2)} (GL AR control: $14,559.99)`);

  // 2) Resolve properties (Vantaca acct id, fallback address) + charge types + opening JE.
  const props = [];
  let pf = 0;
  while (true) { const { data } = await s.from('properties').select('id, street_address, vantaca_account_id').eq('community_id', CID).range(pf, pf + 999); props.push(...data); if (data.length < 1000) break; pf += 1000; }
  const byAcct = new Map(props.filter((p) => p.vantaca_account_id).map((p) => [String(p.vantaca_account_id), p]));
  const byAddr = new Map(props.map((p) => [(p.street_address || '').toLowerCase().replace(/\s+/g, ' ').trim(), p]));
  const { data: cts } = await s.from('ar_charge_types').select('id, type_code, tx_priority_step').eq('community_id', CID);
  const ctByCode = Object.fromEntries(cts.map((c) => [c.type_code, c]));
  const { data: je } = await s.from('journal_entries').select('id').eq('community_id', CID).eq('reference', 'JE-2026-OPEN').maybeSingle();

  let matched = 0; const unmatchedAccts = new Set();
  const charges = [], credits = [];
  for (const it of items) {
    let p = byAcct.get(it.acct);
    if (!p) p = byAddr.get(it.addr.toLowerCase().replace(/\s+/g, ' ').trim());
    if (!p) { unmatchedAccts.add(it.acct + ' / ' + it.addr); continue; }
    matched++;
    const ct = ctByCode[it.type_code];
    if (it.amount > 0) {
      charges.push({
        community_id: CID, property_id: p.id, charge_type_id: ct.id,
        charge_date: it.due, due_date: it.due, description: `${it.category} (opening balance 12/31/2025)`,
        original_amount_cents: D(it.amount), balance_remaining_cents: D(it.amount),
        status: 'open', source_module: 'vantaca_migration', posting_journal_entry_id: je ? je.id : null,
      });
    } else {
      // Net credit (e.g. prepaid assessment) — booked as an unapplied account credit.
      credits.push({
        community_id: CID, property_id: p.id, payment_date: '2025-12-31',
        amount_cents: D(-it.amount), unapplied_balance_cents: D(-it.amount),
        source: 'vantaca_migration', status: 'received', notes: `Opening credit — ${it.category} (12/31/2025)`,
        posting_journal_entry_id: je ? je.id : null,
      });
    }
  }
  console.log(`Matched ${matched}/${items.length} lines · unmatched accounts: ${unmatchedAccts.size}`);
  if (unmatchedAccts.size) [...unmatchedAccts].slice(0, 10).forEach((u) => console.log('  UNMATCHED: ' + u));
  const net = (charges.reduce((a, r) => a + r.balance_remaining_cents, 0) - credits.reduce((a, r) => a + r.unapplied_balance_cents, 0)) / 100;
  console.log(`Subledger: ${charges.length} charges − ${credits.length} credits = NET $${net.toFixed(2)} vs GL AR $14,559.99 — ${Math.abs(net - 14559.99) < 0.01 ? 'TIES ✓' : 'DIFF $' + (14559.99 - net).toFixed(2)}`);

  if (!APPLY) { console.log('\nDRY RUN — pass --apply to write the subledger.'); return; }
  // idempotent: clear prior migration rows
  await s.from('ar_payments').delete().eq('community_id', CID).eq('source', 'vantaca_migration');
  await s.from('ar_charges').delete().eq('community_id', CID).eq('source_module', 'vantaca_migration');
  for (let i = 0; i < charges.length; i += 200) { const { error } = await s.from('ar_charges').insert(charges.slice(i, i + 200)); if (error) { console.error('charge insert failed:', error.message); process.exit(1); } }
  if (credits.length) { const { error } = await s.from('ar_payments').insert(credits); if (error) console.warn('credit insert failed:', error.message); }
  console.log(`\nINSERTED ${charges.length} opening charges + ${credits.length} credits. Homeowner statements now populated.`);
})();
