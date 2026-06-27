// ============================================================================
// scripts/load_homeowner_ar.js
// ----------------------------------------------------------------------------
// Load a community's per-homeowner AR subledger from Vantaca "Homeowner
// Transaction History" exports into homeowner_transactions (+ one committed
// transaction_upload_batch), so the portal balance tile, owner statements,
// and resolveCurrentAR() show correct balances after cutover
// ([[project_portfolio_gl_migration]]).
//
//   node scripts/load_homeowner_ar.js --community=lpf \
//     --files="TransactionHistoryAssoc (2).xls,TransactionHistoryAssoc (4).xls" \
//     --label="Vantaca AR through 6/27/2026" [--apply]
//
// Reuses the existing canonical tables (migration 195) + the same view
// (v_homeowner_current_balance = SUM(amount_cents) of committed rows) that
// resolveCurrentAR reads — NOT a parallel store.
//
// Each owner block: a "Prior Balance" row (loaded as balance_brought_forward,
// amount = the shown balance) then charge/payment lines. amount_cents is
// SIGNED (+charge, -payment, -credit), so SUM(amount_cents) per owner = the
// current balance and reproduces Vantaca's running balance.
//
// TIE-OUT GATE: refuses to --apply unless the subledger total equals the GL
// AR net position (1300 Accounts Receivable + 2400 Prepaid Owners Assessments)
// to the penny, and every owner's summed amount equals their last running
// balance from the source.
// ----------------------------------------------------------------------------
require('dotenv').config();
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const APPLY = process.argv.includes('--apply');
const slug = arg('community');
const label = arg('label', 'Vantaca homeowner AR import');
const DIR = 'C:/Users/edget/Downloads/';
const files = (arg('files') || '').split(',').map((x) => x.trim()).filter(Boolean);
const D = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 });
const money = (v) => { let t = String(v == null ? '' : v).trim(); if (!t || t === '-') return 0; const neg = /^\(.*\)$/.test(t); t = t.replace(/[^0-9.]/g, ''); const n = Math.round((parseFloat(t) || 0) * 100); return neg ? -n : n; };

// Parse one Vantaca Homeowner Transaction History .xls into per-owner rows.
function parseFile(path) {
  const wb = XLSX.readFile(path);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null, raw: false });
  const owners = []; let cur = null;
  for (const r of rows) {
    if (!r) continue;
    const c0 = String(r[0] || '').trim();
    const hm = c0.match(/^(\d{4,})\s*-\s*(.+)$/);
    if (hm) { cur = { acct: hm[1], label: hm[2].trim(), txns: [] }; owners.push(cur); continue; }
    const date = String(r[1] || '').trim();
    if (!cur || !/^\d{1,2}\/\d{1,2}\/\d{4}/.test(date)) continue;
    const [mm, dd, yy] = date.split('/').map(Number);
    const iso = `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    const desc = String(r[2] || '').trim();
    const charge = money(r[3]), payment = money(r[4]), bal = money(r[5]);
    const isPrior = /prior balance/i.test(desc);
    // amount: prior balance carries the shown balance; otherwise charge + payment
    // (payment already negative when parenthesized).
    const amount = isPrior ? bal : (charge + payment);
    let type = 'adjustment';
    if (isPrior) type = 'balance_brought_forward';
    else if (charge > 0 && payment === 0) type = 'charge';
    else if (payment < 0 && charge === 0) type = 'payment';
    else if (amount < 0) type = 'credit';
    else type = 'charge';
    cur.txns.push({ iso, desc, amount, running: bal, type });
  }
  return owners;
}

(async () => {
  if (!slug) { console.error('need --community=<slug>'); process.exit(1); }
  if (!files.length) { console.error('need --files=<a.xls,b.xls>'); process.exit(1); }
  const { data: comm, error: cErr } = await s.from('communities').select('id, name, management_company_id').eq('slug', slug).maybeSingle();
  if (cErr || !comm) { console.error('community lookup failed:', cErr ? cErr.message : 'not found'); process.exit(1); }
  if (!comm.management_company_id) { console.error('community has no management_company_id'); process.exit(1); }
  const CID = comm.id;
  console.log(`\n=== ${comm.name} (${slug}) — homeowner AR subledger load ===\n`);

  // Parse all files; one owner block per (file, account). Merge by account so an
  // owner split across files accumulates (current owners appear once).
  const byAcct = {};
  for (const f of files) {
    const owners = parseFile(DIR + f);
    for (const o of owners) {
      if (!byAcct[o.acct]) byAcct[o.acct] = { acct: o.acct, label: o.label, txns: [] };
      byAcct[o.acct].txns.push(...o.txns);
    }
  }
  const owners = Object.values(byAcct);
  // Sort each owner's txns by date for stable row order + correct running check.
  for (const o of owners) o.txns.sort((a, b) => a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0);

  // Per-owner: summed amount must equal the last running balance shown.
  let runMismatch = [];
  let subtotal = 0;
  for (const o of owners) {
    const sum = o.txns.reduce((a, t) => a + t.amount, 0);
    const lastRun = o.txns.length ? o.txns[o.txns.length - 1].running : 0;
    o.endBal = sum;
    subtotal += sum;
    if (sum !== lastRun) runMismatch.push(`${o.acct}: sum ${D(sum)} ≠ running ${D(lastRun)}`);
  }

  // Map vantaca_account_id -> property_id / contact_id.
  const { data: props } = await s.from('properties').select('id, vantaca_account_id').eq('community_id', CID);
  const propByV = Object.fromEntries((props || []).filter((p) => p.vantaca_account_id).map((p) => [String(p.vantaca_account_id), p.id]));
  const { data: contacts } = await s.from('contacts').select('id, vantaca_account_id').eq('community_id', CID);
  const contactByV = Object.fromEntries((contacts || []).filter((c) => c.vantaca_account_id).map((c) => [String(c.vantaca_account_id), c.id]));
  let matched = 0, unmatched = [];
  for (const o of owners) { o.property_id = propByV[o.acct] || null; o.contact_id = contactByV[o.acct] || null; if (o.property_id) matched++; else unmatched.push(o.acct); }

  // GL AR net position (control) to tie against.
  const { data: tb } = await s.from('v_trial_balance').select('account_number, balance_cents').eq('community_id', CID);
  const tbm = Object.fromEntries((tb || []).map((r) => [r.account_number, Number(r.balance_cents)]));
  const glAR = (tbm['1300'] || 0), glPrepaid = (tbm['2400'] || 0);
  const glNet = glAR + glPrepaid;

  const totalTxns = owners.reduce((a, o) => a + o.txns.length, 0);
  console.log(`Files: ${files.length} | owners: ${owners.length} | transactions: ${totalTxns}`);
  console.log(`Mapped to a property: ${matched} | unmatched (sold/inactive, property_id null): ${unmatched.length}`);
  console.log(`Per-owner sum = running balance: ${runMismatch.length === 0 ? 'ALL TIE ✓' : runMismatch.length + ' MISMATCH ✗'}`);
  runMismatch.slice(0, 8).forEach((m) => console.log('   ' + m));
  console.log(`\nSubledger total: ${D(subtotal)}`);
  console.log(`GL AR net (1300 ${D(glAR)} + 2400 ${D(glPrepaid)}): ${D(glNet)}`);
  const tie = subtotal === glNet;
  console.log(`TIE-OUT: ${tie ? 'subledger = GL AR net to the penny ✓' : 'OFF BY ' + D(subtotal - glNet) + ' ✗'}`);

  const clean = tie && runMismatch.length === 0;
  console.log(`\nRESULT: ${clean ? 'CLEAN ✓' : 'NOT CLEAN ✗'}`);
  if (!APPLY) { console.log('\nDRY RUN — pass --apply to write the committed batch + transactions.'); return; }
  if (!clean) { console.error('\nRefusing to --apply: not clean.'); process.exit(1); }

  // ---- WRITE ---------------------------------------------------------------
  // Idempotent: drop any prior batch from this loader for this community+label.
  const { data: oldBatches } = await s.from('transaction_upload_batches').select('id').eq('community_id', CID).eq('source_filename', files.join(' + '));
  if (oldBatches && oldBatches.length) {
    await s.from('homeowner_transactions').delete().in('source_batch_id', oldBatches.map((b) => b.id));
    await s.from('transaction_upload_batches').delete().in('id', oldBatches.map((b) => b.id));
    console.log(`Cleared ${oldBatches.length} prior batch(es).`);
  }
  const maxDate = owners.flatMap((o) => o.txns.map((t) => t.iso)).reduce((m, d) => d > m ? d : m, '0000-00-00');
  const charges = owners.reduce((a, o) => a + o.txns.filter((t) => t.amount > 0).reduce((x, t) => x + t.amount, 0), 0);
  const payments = owners.reduce((a, o) => a + o.txns.filter((t) => t.amount < 0).reduce((x, t) => x + t.amount, 0), 0);
  const { data: batch, error: bErr } = await s.from('transaction_upload_batches').insert({
    community_id: CID, management_company_id: comm.management_company_id,
    period_label: label, as_of_date: maxDate, source_format: 'manual',
    source_filename: files.join(' + '), row_count: totalTxns, account_count: owners.length,
    total_charges_cents: charges, total_payments_cents: payments, status: 'committed',
    notes: 'Backfill from Vantaca Homeowner Transaction History via scripts/load_homeowner_ar.js',
  }).select('id').single();
  if (bErr || !batch) { console.error('batch insert failed:', bErr ? bErr.message : 'no row'); process.exit(1); }

  const rows = [];
  let idx = 0;
  for (const o of owners) for (const t of o.txns) {
    rows.push({
      source_batch_id: batch.id, source_row_index: idx++, community_id: CID,
      vantaca_account_id: o.acct, property_id: o.property_id, contact_id: o.contact_id,
      transaction_date: t.iso, description: t.desc || t.type, txn_type: t.type,
      amount_cents: t.amount, running_balance_cents: t.running,
    });
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await s.from('homeowner_transactions').insert(rows.slice(i, i + 500));
    if (error) { console.error(`transaction insert failed at ${i}:`, error.message); process.exit(1); }
  }
  console.log(`Inserted ${rows.length} transactions across ${owners.length} owners.`);

  // Verify via the live view that resolveCurrentAR reads.
  const { data: vb } = await s.from('v_homeowner_current_balance').select('balance_cents').eq('community_id', CID);
  const liveTotal = (vb || []).reduce((a, r) => a + Number(r.balance_cents), 0);
  console.log(`\nLive v_homeowner_current_balance total: ${D(liveTotal)}  ${liveTotal === glNet ? '= GL AR net ✓' : 'Δ ' + D(liveTotal - glNet) + ' ✗'}`);
  console.log(`\nDONE. ${comm.name} homeowner AR subledger loaded.`);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
