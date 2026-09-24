#!/usr/bin/env node
// ============================================================================
// LOPF 8/1/2026 interest posting (Ed 2026-09-24).
//
// Rule: 10% annual simple interest / 12 on UNPAID ASSESSMENT PRINCIPAL only
// (never on prior interest, late fees, collection/legal, fines, other). Base =
// each owner tenure's assessment-category balance in the committed 7/31
// conversion batch (the ledger immediately before 8/1). Rounded per charge.
//
// Writes, only with --commit --confirm=34285:
//   * one homeowner_transactions activity batch (draft -> committed last) with
//     one 'interest' charge row per tenure: explicit tenure_id, property_id,
//     vantaca/trusted account, dated 2026-08-01; principal rows untouched;
//   * one GL entry LPF-INT-2026-08 via postJournalEntry: Dr 1300 one line per
//     property, Cr 4030 total, operating fund (accounts' home fund).
// Refuses a second run (batch label or JE reference already present). Nothing is
// ever deleted: a failure after the draft batch marks it 'reverted' with the
// reason; corrections are reversals.
//
//   node scripts/lopf/post_interest_2026_08.js                 # dry run (default)
//   node scripts/lopf/post_interest_2026_08.js --commit --confirm=34285
// ============================================================================
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const L = 'a0000000-0000-4000-8000-000000000002';
const CONV_BATCH = 'acb233a7-e5df-48a5-abc4-ff562712d0c7';
const POST_DATE = '2026-08-01';
const REF = 'LPF-INT-2026-08';
const LABEL = 'LOPF interest 8/1/2026 (10% APR on assessment principal)';
const APPROVED = { owners: 45, base_cents: 4114682, interest_cents: 34285 };
const $ = (c) => (Number(c) / 100).toFixed(2);

async function all(table, sel, f) {
  const out = [];
  for (let i = 0; ; i += 1000) {
    let q = supabase.from(table).select(sel).order('id').range(i, i + 999);
    q = f(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function buildPlan() {
  const { data: conv, error: ce } = await supabase.from('transaction_upload_batches').select('id, status').eq('id', CONV_BATCH).single();
  if (ce) throw ce;
  if (conv.status !== 'committed') throw new Error('conversion batch is not committed');
  const rows = await all('homeowner_transactions', 'id, tenure_id, property_id, vantaca_account_id, contact_id, trusted_account_number, charge_category, amount_cents, transaction_date',
    (q) => q.eq('source_batch_id', CONV_BATCH));
  const conv731 = rows.reduce((a, r) => a + Number(r.amount_cents), 0);
  if (conv731 !== 5848342) throw new Error(`conversion batch nets ${$(conv731)}, expected 58483.42`);

  const byTenure = {};
  for (const r of rows) {
    if (r.charge_category !== 'assessment') continue;
    if (!r.tenure_id) throw new Error(`assessment row ${r.id} has no tenure`);
    const t = byTenure[r.tenure_id] = byTenure[r.tenure_id] || { tenure_id: r.tenure_id, principal: 0, property_id: r.property_id, acct: r.vantaca_account_id, contact_id: r.contact_id, trusted: r.trusted_account_number };
    t.principal += Number(r.amount_cents);
  }
  const tenureIds = Object.keys(byTenure);
  const { data: ten, error: te } = await supabase.from('ownership_tenures')
    .select('id, property_id, kind, start_date, end_date, vantaca_account_id').in('id', tenureIds);
  if (te) throw te;
  const { data: props, error: pe } = await supabase.from('properties')
    .select('id, street_address, vantaca_account_id, trusted_account_number').in('id', ten.map((t) => t.property_id));
  if (pe) throw pe;
  const pById = Object.fromEntries(props.map((p) => [p.id, p]));

  const items = [];
  for (const t of ten) {
    const b = byTenure[t.id];
    if (b.principal <= 0) continue;
    // The tenure must have held the principal ON the interest date.
    if (t.kind !== 'owner' || (t.start_date && t.start_date > POST_DATE) || (t.end_date && t.end_date < POST_DATE)) {
      throw new Error(`tenure ${t.id} was not the owner on ${POST_DATE}`);
    }
    const p = pById[t.property_id];
    const interest = Math.round(b.principal * 0.10 / 12);
    items.push({
      tenure_id: t.id, property_id: t.property_id, address: p.street_address,
      vantaca_account_id: t.vantaca_account_id || p.vantaca_account_id, trusted_account_number: p.trusted_account_number,
      contact_id: b.contact_id, principal_cents: b.principal, interest_cents: interest,
      description: `Interest 8/1/2026: 10%/12 on assessment principal $${$(b.principal)} = $${$(interest)}`,
    });
  }
  items.sort((a, b) => a.address.localeCompare(b.address));
  const base = items.reduce((a, i) => a + i.principal_cents, 0);
  const interest = items.reduce((a, i) => a + i.interest_cents, 0);
  if (items.length !== APPROVED.owners || base !== APPROVED.base_cents || interest !== APPROVED.interest_cents) {
    throw new Error(`plan differs from the approved schedule: ${items.length} owners, base ${$(base)}, interest ${$(interest)}`);
  }
  if (items.some((i) => !i.vantaca_account_id)) throw new Error('an item has no account reference');

  const { data: coa, error: ae } = await supabase.from('chart_of_accounts').select('id, account_number, fund_id, is_active').eq('community_id', L).in('account_number', ['1300', '4030']);
  if (ae) throw ae;
  const a1300 = coa.find((a) => a.account_number === '1300'); const a4030 = coa.find((a) => a.account_number === '4030');
  if (!a1300 || !a4030) throw new Error('1300/4030 missing');
  if (a1300.fund_id !== a4030.fund_id) throw new Error('1300 and 4030 are in different funds');
  const { data: fund } = await supabase.from('account_funds').select('*').eq('id', a1300.fund_id).maybeSingle();

  const lines = items.map((i) => ({ account_id: a1300.id, debit_cents: i.interest_cents, credit_cents: 0, property_id: i.property_id,
    memo: `Interest 8/1/2026 tenure ${i.tenure_id} (acct ${i.vantaca_account_id}) on assessment principal ${$(i.principal_cents)}` }));
  lines.push({ account_id: a4030.id, debit_cents: 0, credit_cents: interest, memo: 'LOPF interest 8/1/2026: 10%/12 on assessment principal (45 owners)' });

  return { items, base, interest, lines, a1300, a4030, fund };
}

async function preflight() {
  const { data: b, error: be } = await supabase.from('transaction_upload_batches').select('id, status').eq('community_id', L).eq('period_label', LABEL);
  if (be) throw be;
  const { data: j, error: je } = await supabase.from('journal_entries').select('id, status').eq('community_id', L).eq('reference', REF);
  if (je) throw je;
  const { data: period, error: pe } = await supabase.from('accounting_periods').select('id, status, fiscal_year, period_number, period_start, period_end')
    .eq('community_id', L).lte('period_start', POST_DATE).gte('period_end', POST_DATE).maybeSingle();
  if (pe) throw pe;
  const { data: comm } = await supabase.from('communities').select('gl_cutover_date, management_company_id').eq('id', L).single();
  return { existingBatches: b || [], existingJes: j || [], period, comm };
}

async function glBalanceThrough(accountId, date) {
  const rows = await all('journal_entry_lines', 'id, debit_cents, credit_cents, journal_entries!inner(posting_date, status, community_id)',
    (q) => q.eq('account_id', accountId).lte('journal_entries.posting_date', date).eq('journal_entries.status', 'posted'));
  return rows.reduce((a, r) => a + r.debit_cents - r.credit_cents, 0);
}

(async () => {
  const commit = process.argv.includes('--commit');
  const confirm = (process.argv.find((a) => a.startsWith('--confirm=')) || '').split('=')[1];
  const plan = await buildPlan();
  const pf = await preflight();

  console.log(`=== LOPF 8/1/2026 interest ${commit ? 'POSTING' : 'DRY RUN (nothing written)'} ===`);
  console.log(`owners ${plan.items.length} | assessment principal base $${$(plan.base)} | interest $${$(plan.interest)} | rate 10%/12 | date ${POST_DATE}`);
  console.log('\nSUBLEDGER (homeowner_transactions, one activity batch):');
  console.log(`  batch: "${LABEL}", format manual, as_of ${POST_DATE}, draft until the GL entry posts, then committed`);
  for (const i of plan.items) {
    console.log(`  ${i.address.padEnd(30)} tenure ${i.tenure_id.slice(0, 8)} acct ${String(i.vantaca_account_id).padEnd(8)} principal ${$(i.principal_cents).padStart(9)}  interest ${$(i.interest_cents).padStart(6)}  cat=interest date=${POST_DATE}`);
  }
  console.log(`  rows ${plan.items.length}, total $${$(plan.interest)}`);
  console.log(`\nGL (postJournalEntry): ${REF} dated ${POST_DATE}, source assessment_billing, fund ${plan.fund ? plan.fund.fund_code || plan.fund.name : plan.a1300.fund_id}`);
  console.log(`  Dr 1300 Accounts Receivable: ${plan.lines.length - 1} lines (one per property), total $${$(plan.lines.filter((l) => l.debit_cents).reduce((a, l) => a + l.debit_cents, 0))}`);
  console.log(`  Cr 4030 Admin/Late/Interest Fee Income: 1 line, $${$(plan.lines[plan.lines.length - 1].credit_cents)}`);

  const ar0 = await glBalanceThrough(plan.a1300.id, POST_DATE);
  const inc0 = -(await glBalanceThrough(plan.a4030.id, POST_DATE));
  const ht = await all('homeowner_transactions', 'id, amount_cents, source_batch_id, transaction_date', (q) => q.eq('community_id', L));
  const { data: bs } = await supabase.from('transaction_upload_batches').select('id, status').eq('community_id', L);
  const committed = new Set(bs.filter((b) => b.status === 'committed').map((b) => b.id));
  const led731 = ht.filter((r) => committed.has(r.source_batch_id) && r.transaction_date <= '2026-07-31').reduce((a, r) => a + Number(r.amount_cents), 0);
  const ledAll = ht.filter((r) => committed.has(r.source_batch_id)).reduce((a, r) => a + Number(r.amount_cents), 0);

  console.log('\nTIE-OUT:');
  const drTotal = plan.lines.filter((l) => l.debit_cents).reduce((a, l) => a + l.debit_cents, 0);
  const crTotal = plan.lines.filter((l) => l.credit_cents).reduce((a, l) => a + l.credit_cents, 0);
  console.log(`  subledger $${$(plan.interest)} = GL Dr 1300 $${$(drTotal)} = GL Cr 4030 $${$(crTotal)}: ${plan.interest === drTotal && drTotal === crTotal ? 'TIES' : 'DOES NOT TIE'}`);
  console.log(`  homeowner ledger AS OF 7/31: $${$(led731)} before -> $${$(led731)} after (unchanged; control = 58,483.42)`);
  console.log(`  homeowner ledger, all committed: $${$(ledAll)} -> $${$(ledAll + plan.interest)}`);
  console.log(`  GL 1300 AR through 8/1: $${$(ar0)} -> $${$(ar0 + plan.interest)} | GL 4030 income through 8/1: $${$(inc0)} -> $${$(inc0 + plan.interest)}`);
  console.log(`  7/31 trial balance: unchanged (entry dated ${POST_DATE}; cutover ${pf.comm.gl_cutover_date})`);
  console.log('\nPREFLIGHT:');
  console.log(`  existing batch "${LABEL}": ${pf.existingBatches.length} | existing JE ${REF}: ${pf.existingJes.length}`);
  console.log(`  accounting period for ${POST_DATE}: ${pf.period ? `${pf.period.fiscal_year}-${pf.period.period_number} status ${pf.period.status}` : 'NONE'}`);
  const blocked = pf.existingBatches.length || pf.existingJes.length || !pf.period || !['open', 'reopened'].includes(pf.period.status) || plan.interest !== drTotal || drTotal !== crTotal || led731 !== 5848342;
  console.log(`  ready to post: ${blocked ? 'NO' : 'yes'}`);
  if (!commit) return;

  if (blocked) throw new Error('preflight failed; nothing written');
  if (confirm !== String(APPROVED.interest_cents)) throw new Error('--confirm must equal the approved interest total in cents (34285)');

  // 1) draft batch (invisible to every reader until committed)
  const { data: batch, error: be } = await supabase.from('transaction_upload_batches').insert({
    management_company_id: pf.comm.management_company_id, community_id: L, period_label: LABEL, as_of_date: POST_DATE,
    source_format: 'manual', row_count: plan.items.length, account_count: plan.items.length,
    total_charges_cents: plan.interest, total_payments_cents: 0, status: 'draft',
    min_transaction_date: POST_DATE, max_transaction_date: POST_DATE,
    notes: `Interest on assessment principal only; GL ${REF}. Approved by Ed 2026-09-24.`,
  }).select('id').single();
  if (be) throw be;
  const fail = async (why) => {
    await supabase.from('transaction_upload_batches').update({ status: 'reverted', reverted_at: new Date().toISOString(), reverted_reason: `posting failed: ${why}`.slice(0, 500) }).eq('id', batch.id);
    throw new Error(`posting failed, draft batch ${batch.id} marked reverted: ${why}`);
  };
  // 2) 45 interest rows, explicit tenure
  const { error: ie } = await supabase.from('homeowner_transactions').insert(plan.items.map((i, n) => ({
    source_batch_id: batch.id, source_row_index: n + 1, community_id: L, vantaca_account_id: i.vantaca_account_id,
    trusted_account_number: i.trusted_account_number || null, property_id: i.property_id, contact_id: i.contact_id || null,
    tenure_id: i.tenure_id, transaction_date: POST_DATE, description: i.description, txn_type: 'charge',
    charge_category: 'interest', amount_cents: i.interest_cents,
  })));
  if (ie) await fail(ie.message);
  const inserted = await all('homeowner_transactions', 'id, amount_cents, tenure_id', (q) => q.eq('source_batch_id', batch.id));
  if (inserted.length !== plan.items.length || inserted.reduce((a, r) => a + Number(r.amount_cents), 0) !== plan.interest || inserted.some((r) => !r.tenure_id)) {
    await fail('inserted rows do not match the plan');
  }
  // 3) GL through the guarded poster
  const { postJournalEntry } = require('../../lib/accounting/posting');
  let je;
  try {
    je = await postJournalEntry({ community_id: L, posting_date: POST_DATE, reference: REF, description: `LOPF interest 8/1/2026: 10%/12 on assessment principal (${plan.items.length} owners)`,
      source_module: 'assessment_billing', source_reference: batch.id, lines: plan.lines, notes: 'Subledger: homeowner_transactions batch ' + batch.id });
  } catch (e) { await fail(e.message); }
  if (je.entry.total_debits_cents !== plan.interest) console.warn('[interest] JE total differs from subledger (interfund bridge?)', je.entry.total_debits_cents);
  // 4) commit the batch last
  const { error: ue } = await supabase.from('transaction_upload_batches').update({ status: 'committed', committed_at: new Date().toISOString() }).eq('id', batch.id);
  if (ue) throw new Error(`GL ${REF} posted but batch ${batch.id} could not be committed: ${ue.message} -- commit it manually`);
  console.log(`\nPOSTED: batch ${batch.id} (${plan.items.length} rows, $${$(plan.interest)}), GL ${REF} ${je.entry.id}`);
})().catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; });
