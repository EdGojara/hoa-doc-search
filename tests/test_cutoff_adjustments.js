#!/usr/bin/env node
// tests/test_cutoff_adjustments.js  (Ed 2026-10-13)
// Kat's cutoff corrections on Canyon Gate's five real items (invoice, service period,
// original AP entry and its lines as booked): accruals with reversals that mirror the
// original AP posting (no duplicate expense), deferrals with a draft prepaid schedule,
// GL 2100 Accrued Expenses proposed when missing, pass-through lines excluded, holds,
// and posting only what the owner ticked, with the schedule approved by the signed-in owner.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const assert = require('assert');
const C = require('../lib/accounting/cutoff_adjustments');
const R = require('../lib/accounting/monthly_runs');
const POSTING = require('../lib/accounting/posting');

let passed = 0; let failed = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); } };
const ACCOUNTS = [['1410', 'Prepaid Expenses', 'asset'], ['2000', 'Accounts Payable', 'liability'], ['2150', 'Clubhouse/Pool Rental Deposits', 'liability'], ['2300', 'Accrued Liability', 'liability'],
  ['5300', 'Pool Management Service', 'expense'], ['5445', 'Printing & Copying', 'expense'], ['5795', 'Pest Control', 'expense'], ['5800', 'Postage', 'expense']]
  .map(([account_number, account_name, account_type]) => ({ account_number, account_name, account_type, fund_code: 'OPR', is_active: true }));
const L = (n, type, d, c = 0) => ({ account_number: n, account_type: type, debit_cents: d, credit_cents: c });
const bill = (o) => ({ status: 'paid', ...o });
const BS = [{ id: 'cat-acc', name: 'Accrued liabilities', section: 'liability' }, { id: 'cat-ap', name: 'Accounts payable', section: 'liability' }];
// the approval-time read of the community's balance-sheet categories (lib/accounting/bs_categories)
const CATS_DB = () => [...BS, { id: 'cat-pre', name: 'Prepaid expenses', section: 'asset' }].map((c) => ({ ...c, community_id: 'cg', statement: 'balance_sheet', is_active: true }));
const AUG = {
  bs_categories: BS, period: { period_start: '2026-08-01', period_end: '2026-08-31' }, accounts: ACCOUNTS, already: new Set(), schedules_for: new Set(),
  late_bills: [bill({ id: 'b2608', vendor: 'Bedrock Association Management, LLC', invoice_number: '2608CG2', invoice_date: '2026-09-04', service_period_start: '2026-08-01', service_period_end: '2026-08-31', total_cents: 30788 }),
    bill({ id: 'b6061', vendor: 'CYPRESS CREEK MOSQUITO CONTROL, LLC', invoice_number: '6061', invoice_date: '2026-09-09', service_period_start: '2026-08-06', service_period_end: '2026-08-27', total_cents: 36048 })],
  prepaid_bills: [bill({ id: 'b10295', vendor: 'Aegis Aquatics, LLC', invoice_number: '10295', invoice_date: '2026-08-01', service_period_start: '2026-09-01', service_period_end: '2026-09-30', total_cents: 217925 })],
  invoices: {
    b2608: { source_storage_path: 'ap_invoices/2608CG2.pdf', original: { id: 'je317', reference: 'JE-2026-00317', posting_date: '2026-09-04', status: 'posted',
      lines: [L('2300', 'liability', 12500), L('5445', 'expense', 2950), L('5800', 'expense', 4838), L('2300', 'liability', 3500), L('2300', 'liability', 7000), L('2000', 'liability', 0, 30788)] } },
    b6061: { source_storage_path: 'ap_invoices/6061.pdf', original: { id: 'je318', reference: 'JE-2026-00318', posting_date: '2026-09-09', status: 'posted',
      lines: [L('5795', 'expense', 9012), L('5795', 'expense', 9012), L('5795', 'expense', 9012), L('5795', 'expense', 9012), L('2000', 'liability', 0, 36048)] } },
    b10295: { source_storage_path: 'ap_invoices/10295.pdf', original: { id: 'je185', reference: 'JE-2026-00185', posting_date: '2026-08-01', status: 'posted', lines: [L('5300', 'expense', 217925), L('2000', 'liability', 0, 217925)] } },
  },
};
const SEP = {
  period: { period_start: '2026-09-01', period_end: '2026-09-30' }, accounts: ACCOUNTS, already: new Set(), schedules_for: new Set(),
  late_bills: [bill({ id: 'b2609', vendor: 'Bedrock Association Management, LLC', invoice_number: '2609CG2', invoice_date: '2026-10-05', service_period_start: '2026-09-01', service_period_end: '2026-09-30', total_cents: 56172 })],
  prepaid_bills: [bill({ id: 'b10363', vendor: 'Aegis Aquatics, LLC', invoice_number: '10363', invoice_date: '2026-09-01', service_period_start: '2026-10-01', service_period_end: '2026-10-31', total_cents: 104616 })],
  invoices: {
    b2609: { source_storage_path: 'ap_invoices/2609CG2.pdf', original: { id: 'je404', reference: 'JE-2026-00404', posting_date: '2026-10-05', status: 'posted',
      lines: [L('5445', 'expense', 17300), L('2300', 'liability', 7000), L('2300', 'liability', 3500), L('5800', 'expense', 28372), L('2000', 'liability', 0, 56172)] } },
    // the re-coded bill: the live entry after the 9/3 void (JE-2026-00268 voided by JE-2026-00274; JE-2026-00275 posted)
    b10363: { source_storage_path: 'ap_invoices/10363.pdf', original: { id: 'je275', reference: 'JE-2026-00275', posting_date: '2026-09-01', status: 'posted', lines: [L('5300', 'expense', 104616), L('2000', 'liability', 0, 104616)] } },
  },
};
const balanced = (e) => e.lines.reduce((s, l) => s + l.debit_cents - l.credit_cents, 0) === 0;

(async () => {
  console.log('Cutoff corrections (Canyon Gate August and September 2026)');
  const aug = C.buildProposals(AUG); const sep = C.buildProposals(SEP);

  await t('GL 2100 Accrued Expenses is proposed once (the chart has none; 2300 is the pass-through clearing account), nothing else in the chart changes', () => {
    assert.deepStrictEqual(aug.additions.map((a) => [a.id, a.account_number, a.account_name, a.account_type, a.fund_code]), [['account:2100', '2100', 'Accrued Expenses', 'liability', 'OPR']]);
    assert.match(aug.additions[0].text, /No existing account, balance or mapping changes/);
    assert.deepStrictEqual(aug.additions[0].bs_category, { id: 'cat-acc', name: 'Accrued liabilities', role: 'accrued' }, 'mapped where 2300 presents');
    assert.strictEqual(C.buildProposals({ ...AUG, accounts: [...ACCOUNTS, { account_number: '2100', account_name: 'Accrued Expenses', account_type: 'liability', fund_code: 'OPR', is_active: true }] }).additions.length, 0, 'not proposed once it exists');
  });

  await t('Bedrock #2608CG2: only the expense lines ($77.88) are accrued 8/31 and reversed 9/1; the $230.00 of pass-through fees in 2300 are excluded', () => {
    const it = aug.items.find((i) => i.id === 'accrue:b2608');
    const [acc, rev] = it.entries;
    assert.strictEqual(it.amount_cents, 7788);
    assert.deepStrictEqual(acc.lines.map((l) => [l.account_number, l.debit_cents, l.credit_cents]), [['5445', 2950, 0], ['5800', 4838, 0], ['2100', 0, 7788]]);
    assert.strictEqual(acc.posting_date, '2026-08-31'); assert.strictEqual(rev.posting_date, '2026-09-01');
    assert.deepStrictEqual(rev.lines.map((l) => [l.account_number, l.debit_cents, l.credit_cents]), [['2100', 7788, 0], ['5445', 0, 2950], ['5800', 0, 4838]]);
    assert.ok(balanced(acc) && balanced(rev));
    assert.deepStrictEqual(it.evidence.excluded_lines.map((x) => [x.account_number, x.cents]), [['2300', 12500], ['2300', 3500], ['2300', 7000]]);
    assert.strictEqual(it.verification.reversal_mirrors_accrual, true);
    assert.deepStrictEqual(it.effects, { '2026-08': 7788, '2026-09': -7788 });
  });

  await t('no duplicate expense: for each accrual, the original month nets to zero for the moved lines and the service month carries it once', () => {
    for (const it of [...aug.items, ...sep.items].filter((i) => i.kind === 'accrual')) {
      const o = (it.id.includes('b2609') ? SEP : AUG).invoices[it.evidence.invoice_id].original;
      const [acc, rev] = it.entries;
      for (const x of C.expenseByAccount(o.lines)) {
        const inOrigMonth = x.cents - rev.lines.filter((l) => l.account_number === x.account_number).reduce((s, l) => s + l.credit_cents - l.debit_cents, 0);
        const inSvcMonth = acc.lines.filter((l) => l.account_number === x.account_number).reduce((s, l) => s + l.debit_cents - l.credit_cents, 0);
        assert.strictEqual(inOrigMonth, 0, `${it.label} ${x.account_number} original month`);
        assert.strictEqual(inSvcMonth, x.cents, `${it.label} ${x.account_number} service month`);
      }
      assert.strictEqual(rev.posting_date.slice(0, 7), o.posting_date.slice(0, 7), 'the reversal sits in the month of the original AP posting');
    }
  });

  await t('Cypress #6061: $360.48 to 5795 accrued 8/31, reversed 9/1; Bedrock #2609CG2: $456.72 accrued 9/30, reversed 10/1', () => {
    const c = aug.items.find((i) => i.id === 'accrue:b6061');
    assert.deepStrictEqual(c.entries[0].lines.map((l) => [l.account_number, l.debit_cents, l.credit_cents]), [['5795', 36048, 0], ['2100', 0, 36048]]);
    const b = sep.items.find((i) => i.id === 'accrue:b2609');
    assert.strictEqual(b.amount_cents, 45672); assert.strictEqual(b.entries[0].posting_date, '2026-09-30'); assert.strictEqual(b.entries[1].posting_date, '2026-10-01');
    assert.deepStrictEqual(b.effects, { '2026-09': 45672, '2026-10': -45672 });
  });

  await t('Aegis #10295 and #10363: deferred to 1410 at month end, one-month draft prepaid schedules for September and October', () => {
    const a = aug.items.find((i) => i.id === 'defer:b10295');
    assert.deepStrictEqual(a.entries[0].lines.map((l) => [l.account_number, l.debit_cents, l.credit_cents]), [['1410', 217925, 0], ['5300', 0, 217925]]);
    assert.strictEqual(a.entries[0].posting_date, '2026-08-31');
    assert.deepStrictEqual([a.schedule.balance_account_number, a.schedule.recognition_account_number, a.schedule.start_month, a.schedule.term_months, a.schedule.months], ['1410', '5300', '2026-09-01', 1, [{ month: '2026-09-01', cents: 217925 }]]);
    assert.deepStrictEqual(a.effects, { '2026-08': -217925, '2026-09': 217925 });
    const s = sep.items.find((i) => i.id === 'defer:b10363');
    assert.strictEqual(s.amount_cents, 104616); assert.deepStrictEqual(s.effects, { '2026-09': -104616, '2026-10': 104616 });
  });

  await t('expected statement effects: August expense -$1,740.89, September +$1,151.45, October +$589.44', () => {
    const tot = {};
    for (const r of [aug, sep]) for (const [m, v] of Object.entries(r.effects)) tot[m] = (tot[m] || 0) + v;
    assert.deepStrictEqual(tot, { '2026-08': -174089, '2026-09': 115145, '2026-10': 58944 });
  });

  await t('holds: an unbooked bill, a bill already corrected, a split-account prepaid, a missing service period', () => {
    const h = C.buildProposals({ ...AUG, already: new Set(['cutoff:b6061:accrue']), invoices: { ...AUG.invoices, b2608: { original: null }, b10295: { ...AUG.invoices.b10295, original: { ...AUG.invoices.b10295.original, lines: [L('5300', 'expense', 100000), L('5310', 'expense', 117925), L('2000', 'liability', 0, 217925)] } } } });
    assert.ok(h.holds.some((x) => /not booked yet/.test(x.text)) && h.holds.some((x) => x.already && /already accrued/.test(x.text)));
    // a ONE-month split is no longer a hold (reversing pair, next test); a multi-month split still is
    assert.deepStrictEqual(h.items.map((i) => i.id), ['defer:b10295']);
    const mm = C.buildProposals({ ...AUG, late_bills: [], prepaid_bills: [{ ...AUG.prepaid_bills[0], service_period_end: '2026-11-30' }], invoices: { ...AUG.invoices, b10295: { ...AUG.invoices.b10295, original: { ...AUG.invoices.b10295.original, lines: [L('5300', 'expense', 100000), L('5310', 'expense', 117925), L('2000', 'liability', 0, 217925)] } } } });
    assert.ok(mm.holds.some((x) => /split across accounts over 3 months/.test(x.text)) && mm.items.length === 0);
    const m = C.buildProposals({ ...AUG, late_bills: [], prepaid_bills: [{ ...AUG.prepaid_bills[0], service_period_end: null }] });
    assert.ok(m.holds.some((x) => /service period is incomplete/.test(x.text)));
  });

  await t('approval: only the authenticated owner; only ticked proposals post; account first, reversal linked to its accrual, schedule approved by the signed-in owner then recognized', async () => {
    await assert.rejects(R.approveAndPost({ from() { throw new Error('db'); } }, { run_id: 'r', approval: { channel: 'chat', email: 'egojara@bedrocktx.com', user_id: 'u' }, include: [] }), (e) => e.code === 'approval_required');
    // in-memory books
    const db = { account_funds: [{ id: 'f-opr', fund_code: 'OPR', community_id: 'cg' }], chart_of_accounts: ACCOUNTS.map((a, i) => ({ id: `a${i}`, community_id: 'cg', account_number: a.account_number, fund_id: 'f-opr' })), journal_entries: [], recognition_schedules: [], recognition_postings: [], report_categories: CATS_DB() };
    const calls = [];
    const q = (table) => { const st = { table, filters: [], op: 'select', row: null };
      const api = { select() { return api; }, eq(k, v) { st.filters.push((r) => r[k] === v); return api; }, in(k, v) { st.filters.push((r) => v.includes(r[k])); return api; }, is(k, v) { st.filters.push((r) => (r[k] ?? null) === v); return api; }, limit() { return api; }, order() { return api; },
        insert(row) { st.op = 'insert'; st.row = row; return api; }, update(row) { st.op = 'update'; st.row = row; return api; },
        single() { st.one = true; return api; },
        then(res, rej) { try {
          let out;
          if (st.op === 'insert') { const r = { id: `${table}-${db[table].length + 1}`, ...st.row }; db[table].push(r); calls.push(['insert', table, { ...r }]); out = st.one ? r : [r]; }
          else if (st.op === 'update') { const rs = db[table].filter((r) => st.filters.every((f) => f(r))); rs.forEach((r) => Object.assign(r, st.row)); calls.push(['update', table, st.row]); out = rs; }
          else { const rs = db[table].filter((r) => st.filters.every((f) => f(r))); out = st.one ? rs[0] : rs; }
          return Promise.resolve({ data: out, error: null }).then(res, rej);
        } catch (e) { return Promise.reject(e).then(res, rej); } } };
      return api; };
    const sb = { from: q, rpc: async (n, a) => { calls.push(['rpc', n, a]); if (n === 'set_account_report_category') return { data: {}, error: null }; db.recognition_postings.push({ schedule_id: a.p_schedule_id, period_month: a.p_period_month, kind: 'recognition', reversed_by_posting_id: null }); return { data: 'posting-1', error: null }; } };
    const orig = POSTING.postJournalEntry;
    POSTING.postJournalEntry = async (o) => { const e = { id: `je-${db.journal_entries.length + 1}`, reference: `JE-T-${db.journal_entries.length + 1}`, ...o }; db.journal_entries.push(e); calls.push(['je', o]); return { entry: e }; };
    try {
      const run = { id: 'run-aug', community_id: 'cg', preview: aug };
      const res = await C.postApproved(sb, run, { include: ['account:2100', 'accrue:b2608', 'defer:b10295'], approver: 'egojara@bedrocktx.com (authenticated in-app approval)', approval: { channel: 'in_app', user_id: 'u-ed', email: 'egojara@bedrocktx.com' }, actor: 'Kat Reed (AI accounting manager); approved by egojara@bedrocktx.com (authenticated in-app approval)' });
      const jes = calls.filter((c) => c[0] === 'je').map((c) => c[1]);
      assert.deepStrictEqual(jes.map((j) => j.source_reference), ['cutoff:b2608:accrue', 'cutoff:b2608:reverse', 'cutoff:b10295:defer'], 'Cypress #6061 was not ticked, so it did not post');
      assert.strictEqual(calls.findIndex((c) => c[0] === 'insert' && c[1] === 'chart_of_accounts') < calls.findIndex((c) => c[0] === 'je'), true, 'the account exists before the first accrual');
      assert.strictEqual(jes[1].reverses_je_id, db.journal_entries[0].id, 'the reversal is linked to its accrual');
      assert.ok(jes.every((j) => j.posted_by_user_id === 'u-ed' && /Approved in-app by egojara@bedrocktx\.com \(authenticated in-app approval\)/.test(j.notes)));
      const ins = calls.find((c) => c[0] === 'insert' && c[1] === 'recognition_schedules')[2];
      assert.strictEqual(ins.status, 'draft', 'the schedule is created as draft');
      const upd = calls.find((c) => c[0] === 'update' && c[1] === 'recognition_schedules')[2];
      assert.deepStrictEqual([upd.status, upd.approved_by], ['active', 'egojara@bedrocktx.com (authenticated in-app approval)'], 'then approved by the signed-in owner (the database requires the approver)');
      assert.ok(calls.some((c) => c[0] === 'rpc' && c[2].p_period_month === '2026-09-01'), 'September recognized through post_recognition_period');
      const map = calls.find((c) => c[0] === 'rpc' && c[1] === 'set_account_report_category');
      assert.ok(map && map[2].p_category_id === 'cat-acc' && map[2].p_statement === 'balance_sheet' && /authenticated in-app approval/.test(map[2].p_actor), '2100 mapped to Accrued liabilities by the approver');
      assert.deepStrictEqual(res.not_approved, ['accrue:b6061']);
      // idempotent: approving again posts nothing new
      const before = db.journal_entries.length;
      db.journal_entries.forEach((e) => { e.community_id = 'cg'; });
      await C.postApproved(sb, run, { include: ['accrue:b2608'], approver: 'x', approval: { channel: 'in_app', user_id: 'u-ed', email: 'e' }, actor: 'k' });
      assert.strictEqual(db.journal_entries.length, before, 'already-posted entries are not posted twice');
    } finally { POSTING.postJournalEntry = orig; }
  });

  // A second community's chart (LOPF shape): no Prepaid Expenses account (only 1400 Prepaid
  // Insurance) and a landscape bill split across two expense accounts, billed in September
  // for October. Same engine, no community branch: the account is proposed and the split
  // one-month bill defers with a reversing pair.
  const LOPF_ACCTS = [['1400', 'Prepaid Insurance', 'asset'], ['2000', 'Accounts Payable', 'liability'], ['2100', 'Accrued Expenses', 'liability'], ['5200', 'Landscape Operating & Management', 'expense'], ['5205', 'Landscaping Maintenance (Lakes - MUD)', 'expense'], ['5300', 'Pool Management', 'expense']]
    .map(([account_number, account_name, account_type]) => ({ account_number, account_name, account_type, fund_code: 'OPR', is_active: true }));
  const LSEP = { bs_categories: [{ id: 'cat-pre', name: 'Prepaid expenses', section: 'asset' }], period: { period_start: '2026-09-01', period_end: '2026-09-30' }, accounts: LOPF_ACCTS, already: new Set(), schedules_for: new Set(), late_bills: [],
    prepaid_bills: [bill({ id: 'b34037', vendor: 'High Tech Lawn Services LLC', invoice_number: '34037', invoice_date: '2026-09-24', service_period_start: '2026-10-01', service_period_end: '2026-10-31', total_cents: 620879 }),
      bill({ id: 'b51405', vendor: 'LONE STAR POOL MANAGEMENT', invoice_number: '51405', invoice_date: '2026-09-15', service_period_start: '2026-10-01', service_period_end: '2026-10-31', total_cents: 124488 })],
    invoices: { b34037: { original: { id: 'je233', reference: 'JE-2026-00233', posting_date: '2026-09-24', status: 'posted', lines: [L('5200', 'expense', 510854), L('5205', 'expense', 110025), L('2000', 'liability', 0, 620879)] } },
      b51405: { original: { id: 'je218', reference: 'JE-2026-00218', posting_date: '2026-09-15', status: 'posted', lines: [L('5300', 'expense', 124488), L('2000', 'liability', 0, 124488)] } } } };
  const lsep = C.buildProposals(LSEP);
  await t('no Prepaid Expenses account: GL 1410 is proposed (never 1400 Prepaid Insurance), mapped to the prepaid category on approval', () => {
    assert.deepStrictEqual(lsep.additions.map((a) => [a.account_number, a.account_name, a.account_type, a.normal_balance, a.bs_category && a.bs_category.id]), [['1410', 'Prepaid Expenses', 'asset', 'debit', 'cat-pre']]);
    assert.ok(lsep.holds.length === 0, JSON.stringify(lsep.holds));
  });
  await t('split one-month bill (High Tech #34037, 5200 + 5205): deferral at 9/30 and an account-by-account reversal on 10/1; balanced; effects Sep -6,208.79 / Oct +6,208.79', () => {
    const d = lsep.items.find((i) => i.id === 'defer:b34037');
    assert.ok(d && d.entries.length === 2 && d.entries.every(balanced) && !d.schedule);
    assert.deepStrictEqual(d.entries.map((e) => [e.posting_date, e.source_reference]), [['2026-09-30', 'cutoff:b34037:defer'], ['2026-10-01', 'cutoff:b34037:reverse-defer']]);
    assert.deepStrictEqual(d.entries[0].lines.map((l) => [l.account_number, l.debit_cents, l.credit_cents]), [['1410', 620879, 0], ['5200', 0, 510854], ['5205', 0, 110025]]);
    assert.ok(d.verification.reversal_mirrors_deferral && d.entries[1].reverses === 'deferral');
    assert.deepStrictEqual(d.effects, { '2026-09': -620879, '2026-10': 620879 });
  });
  await t('single-account one-month bill (Lone Star #51405) keeps the existing prepaid schedule path, now on the proposed 1410', () => {
    const d = lsep.items.find((i) => i.id === 'defer:b51405');
    assert.ok(d && d.schedule && d.schedule.balance_account_number === '1410' && d.schedule.recognition_account_number === '5300' && d.entries.length === 1);
    assert.deepStrictEqual(lsep.effects, { '2026-09': -745367, '2026-10': 745367 }, 'total October services booked in September: $7,453.67');
  });
  await t('posting the split deferral: account first, reversal linked to the deferral, idempotent on re-approval', async () => {
    const db = { account_funds: [{ id: 'f-opr', fund_code: 'OPR', community_id: 'lopf' }], chart_of_accounts: LOPF_ACCTS.map((a, i) => ({ id: `l${i}`, community_id: 'lopf', account_number: a.account_number, fund_id: 'f-opr' })), journal_entries: [], report_categories: [] };   // LOPF: no balance-sheet categories at all
    const q = (table) => { const st = { filters: [], op: 'select' }; const api = { select() { return api; }, eq(k, v) { st.filters.push((r) => r[k] === v); return api; }, in(k, v) { st.filters.push((r) => v.includes(r[k])); return api; }, limit() { return api; },
      insert(row) { st.op = 'insert'; st.row = row; return api; }, single() { st.one = true; return api; },
      then(res, rej) { let out; if (st.op === 'insert') { const r = { id: `${table}-${db[table].length + 1}`, ...st.row }; db[table].push(r); out = st.one ? r : [r]; } else { const rs = (db[table] || []).filter((r) => st.filters.every((f) => f(r))); out = st.one ? rs[0] : rs; } return Promise.resolve({ data: out, error: null }).then(res, rej); } }; return api; };
    const maps = []; const sb = { from: q, rpc: async (n, a) => { if (n === 'set_account_report_category') maps.push(a); return { data: {}, error: null }; } };
    const orig = POSTING.postJournalEntry; const jes = [];
    POSTING.postJournalEntry = async (o) => { const e = { id: `je-${db.journal_entries.length + 1}`, reference: `JE-L-${db.journal_entries.length + 1}`, community_id: 'lopf', ...o }; db.journal_entries.push(e); jes.push(o); return { entry: e }; };
    try {
      const run = { id: 'run-lsep', community_id: 'lopf', preview: lsep };
      await C.postApproved(sb, run, { include: ['account:1410', 'defer:b34037'], approver: 'owner (in-app)', approval: { channel: 'in_app', user_id: 'u', email: 'e' }, actor: 'Kat' });
      assert.ok(db.chart_of_accounts.some((a) => a.account_number === '1410'), '1410 added before the entries');
      const pre = db.report_categories.find((c) => c.name === 'Prepaids');
      assert.ok(pre && pre.section === 'asset' && pre.statement === 'balance_sheet' && pre.community_id === 'lopf', 'a community with no categories gets the standard Prepaids category on approval');
      const a1410 = db.chart_of_accounts.find((a) => a.account_number === '1410');
      assert.deepStrictEqual(maps.map((m) => [m.p_account_ids[0], m.p_category_id, m.p_statement, m.p_actor]), [[a1410.id, pre.id, 'balance_sheet', 'owner (in-app)']], '1410 mapped to Prepaids by the in-app approver');
      assert.deepStrictEqual(jes.map((j) => j.source_reference), ['cutoff:b34037:defer', 'cutoff:b34037:reverse-defer']);
      assert.strictEqual(jes[1].reverses_je_id, db.journal_entries[0].id, 'the reversal is linked to its deferral');
      const n = db.journal_entries.length;
      await C.postApproved(sb, run, { include: ['defer:b34037'], approver: 'x', approval: { channel: 'in_app', user_id: 'u', email: 'e' }, actor: 'k' });
      assert.strictEqual(db.journal_entries.length, n, 'approving again posts nothing new');
    } finally { POSTING.postJournalEntry = orig; }
  });

  // Line-level service months (Lake Pro #263225 shape): September treatments and an October fee
  // on one bill booked 10/1. Only the September lines accrue; the October fee stays in October.
  await t('line service months: dates and service-period month names are read; a stray word is not', () => {
    assert.strictEqual(C.lineServiceMonth('Monthly Lake Management Fee - October', '2026-10-01'), '2026-10');
    assert.strictEqual(C.lineServiceMonth('Komeen Liquid(gal) - Treatment - 9-22-26 - Lake 1', '2026-10-01'), '2026-09');
    assert.strictEqual(C.lineServiceMonth('LIFEGUARD SERVICES FOR THE MONTH OF - SEPTEMBER 2026', '2026-08-15'), '2026-09');
    assert.strictEqual(C.lineServiceMonth('Fee - January', '2026-12-15'), '2027-01');
    assert.strictEqual(C.lineServiceMonth('Charges may vary', '2026-10-01'), null);
    assert.strictEqual(C.lineServiceMonth('Invoice 302 008 234 842', '2026-10-01'), null);
  });
  await t('a late bill accrues only its lines for the period: Lake Pro $1,406.11 to 5140 accrued 9/30, reversed 10/1; the $873.75 October fee is left in October and named', () => {
    const LP = { period: { period_start: '2026-09-01', period_end: '2026-09-30' }, accounts: [...ACCOUNTS, { account_number: '5130', account_name: 'Lake Management', account_type: 'expense', fund_code: 'OPR', is_active: true }, { account_number: '5140', account_name: 'Lake Service', account_type: 'expense', fund_code: 'OPR', is_active: true }],
      already: new Set(), schedules_for: new Set(), prepaid_bills: [],
      late_bills: [bill({ id: 'b263225', vendor: 'Lake Pro, Inc.', invoice_number: '263225', invoice_date: '2026-10-01', service_period_start: '2026-09-22', service_period_end: '2026-09-29', total_cents: 227986 })],
      invoices: { b263225: { original: { id: 'je283', reference: 'JE-2026-00283', posting_date: '2026-10-01', status: 'posted', lines: [
        { ...L('5130', 'expense', 87375), memo: 'Monthly Lake Management Fee - October' }, { ...L('5140', 'expense', 14298), memo: 'Komeen Liquid(gal) - Treatment - 9-22-26 - Lake 1 (1)' },
        { ...L('5140', 'expense', 101313), memo: 'Treatments - 9-29-26 - Lake 1' }, { ...L('5140', 'expense', 25000), memo: 'Extra Visit - 9-29-26' }, L('2000', 'liability', 0, 227986)] } } } };
    const r = C.buildProposals(LP); const a = r.items.find((i) => i.id === 'accrue:b263225');
    assert.ok(a && a.amount_cents === 140611 && a.entries.every(balanced), JSON.stringify(a && a.amount_cents));
    assert.deepStrictEqual(a.entries[0].lines.filter((l) => l.debit_cents).map((l) => [l.account_number, l.debit_cents]), [['5140', 140611]]);
    assert.deepStrictEqual(a.evidence.other_month_lines.map((x) => [x.account_number, x.cents, x.month]), [['5130', 87375, '2026-10']]);
    assert.ok(/Left in 2026-10 because the line names another month/.test(a.verification.text));
  });
  await t('a bill whose lines name no month keeps the whole-bill accrual (Canyon Gate cases unchanged)', () => {
    assert.strictEqual(aug.items.find((i) => i.id === 'accrue:b6061').amount_cents, 36048);
  });
  // Double reversal (LOPF NRG #113 016 455 245 shape): removed at the cutover and voided again.
  await t('an entry reversed twice with no re-post is restored once, dated the second reversal, only in that month; idempotent', () => {
    const second = { id: 'rev252', reference: 'JE-2026-00252', posting_date: '2026-09-29', lines: [L('5110', 'expense', 0, 28283), L('5110', 'expense', 104, 0), L('5110', 'expense', 0, 15893), L('2000', 'liability', 44072, 0)] };
    const facts = { ...SEP, late_bills: [], prepaid_bills: [], double_reversals: [{ original: { id: 'je229', reference: 'JE-2026-00229', posting_date: '2026-07-13' }, first: { id: 'n229', reference: 'CONV-LPF-CUTOVER-NEUT-JE-2026-00229', posting_date: '2026-07-13' }, second, invoice_number: '113 016 455 245', vendor: 'NRG Business' }] };
    const r = C.buildProposals(facts); const c = r.items.find((i) => i.kind === 'correction');
    assert.ok(c && c.entries.length === 1 && balanced(c.entries[0]) && c.entries[0].posting_date === '2026-09-29' && c.entries[0].source_reference === 'correction:double-reversal:rev252');
    assert.strictEqual(c.amount_cents, 44072, 'the net expense restored, $440.72');
    assert.deepStrictEqual(c.effects, { '2026-09': 44072 });
    assert.ok(c.entries[0].lines.find((l) => l.account_number === '2000').credit_cents === 44072, 'payable restored too');
    assert.strictEqual(C.buildProposals({ ...facts, period: { period_start: '2026-08-01', period_end: '2026-08-31' } }).items.filter((i) => i.kind === 'correction').length, 0, 'not proposed in another month');
    assert.ok(C.buildProposals({ ...facts, already: new Set(['correction:double-reversal:rev252']) }).holds.some((h) => h.already), 'already corrected: not proposed again');
  });

  await t('reachable: Financial dashboard button and Accounting link open /app/financial/cutoff; the page approves only through the owner-gated route', () => {
    const fs = require('fs'); const path = require('path'); const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
    assert.ok(/app\.get\('\/app\/financial\/cutoff'.*cutoff\.html/.test(read('server.js')));
    const fin = read('public/app/financial.html');
    assert.ok(/href="\/app\/financial\/cutoff" id="fn-cutoff"[^>]*>Cutoff Corrections</.test(fin) && /\['Cutoff corrections', '\/app\/financial\/cutoff', true\]/.test(fin));
    const page = read('public/app/cutoff.html');
    assert.ok(/\/api\/accounting-runs\/cutoff\/overview/.test(page) && /process: 'cutoff_adjustment'/.test(page) && /\/approve', \{ include: include \}/.test(page) && /viewer_is_owner/.test(page));
    const api = read('api/accounting_runs.js');
    assert.ok(/router\.get\('\/cutoff\/overview'/.test(api) && /run\/:id\/approve'[\s\S]{0,300}requireOwner/.test(api));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
