#!/usr/bin/env node
// tests/test_collection_notices.js  (Ed 2026-10-12)
// Certified collections notices: consistent dates (never the Vantaca 2025-deadline error),
// eligibility and every restriction (payment plan, bankruptcy, legal, prior notice,
// recent payment), a statement that ties to the ledger and the notice, the fee rules
// (Bedrock's rate vs the homeowner-recoverable amount; nothing charged for a draft;
// exactly once on mailing) and the mailing controls. No real notice, mailing or charge.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const N = require('../lib/collections/notices');

let passed = 0; let failed = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); } };
const MIG = fs.readFileSync(path.join(__dirname, '..', 'migrations', '515_collection_notices.sql'), 'utf8');

// The seeded template, read from the migration (so the test checks what ships).
function seededTemplate() {
  const block = MIG.slice(MIG.indexOf('jsonb_build_array(', MIG.indexOf('INSERT INTO collection_notice_templates')));
  const paras = []; const re = /'((?:[^']|'')*)'/g; let m;
  const parasBlock = block.slice(0, block.indexOf('),\n  jsonb_build_array(') > 0 ? block.indexOf('),\n  jsonb_build_array(') : block.indexOf('),\r\n  jsonb_build_array('));
  while ((m = re.exec(parasBlock))) paras.push(m[1].replace(/''/g, "'"));
  const els = []; const re2 = /jsonb_build_object\('label', '((?:[^']|'')*)', 'pattern', '((?:[^']|'')*)'\)/g;
  while ((m = re2.exec(MIG))) els.push({ label: m[1].replace(/''/g, "'"), pattern: m[2].replace(/''/g, "'") });
  return { id: 'tpl', version: 1, status: 'approved', subject_line: 'PAST DUE ASSESSMENTS', paragraphs: paras, required_elements: els, cure_days: 45, include_office_copy: true, min_balance_cents: 0, recent_payment_days: 10 };
}
const COMM = { id: 'qr', name: 'Quail Ridge', hoa_legal_name: 'Quail Ridge Homeowners Association, Inc' };

(async () => {
  console.log('Collections notices');
  const T = seededTemplate();

  await t('the seeded template is the current letter with merge fields, and its required elements parse', () => {
    assert.ok(T.paragraphs.length >= 7, `paragraphs ${T.paragraphs.length}`);
    assert.ok(T.paragraphs.some((p) => /Servicemembers Civil Relief Act/.test(p)) && T.paragraphs.some((p) => /209\.007/.test(p)));
    assert.ok(T.required_elements.length >= 7);
    assert.match(MIG, /status\s+text NOT NULL DEFAULT 'draft'/, 'seeded templates start as drafts (owner approves the wording)');
  });

  await t('dates: the deadline is the notice date + the cure period (at least 45); the Vantaca 2025-deadline error is caught', () => {
    const d = N.noticeDates('2026-10-05', 30);
    assert.deepStrictEqual(d, { notice_date: '2026-10-05', cure_days: 45, deadline_date: '2026-11-19' }, '30 is raised to the statutory 45');
    assert.deepStrictEqual(N.dateErrors({ ...d }, { today: '2026-10-05' }), []);
    const vantaca = N.dateErrors({ notice_date: '2026-10-05', deadline_date: '2025-10-16', cure_days: 45 }, { today: '2026-10-05' });
    assert.ok(vantaca.some((e) => /not the notice date \+ 45/.test(e)) && vantaca.some((e) => /not after the notice date/.test(e)) && vantaca.some((e) => /inconsistent with notice year/.test(e)));
    assert.ok(N.dateErrors({ ...d, mailed_date: '2026-10-06' }, { today: '2026-10-05' }).some((e) => /re-date and reprint/.test(e)));
    assert.ok(N.dateErrors({ ...d }, { today: '2026-10-07' }).some((e) => /in the past/.test(e)));
    assert.strictEqual(N.numberWords(45), 'forty-five'); assert.strictEqual(N.numberWords(60), 'sixty');
  });

  await t("fees: Bedrock's contract rate and the homeowner-recoverable amount are separate; off, unset, unmapped or above the contract means no homeowner fee", () => {
    const ct = { gl_revenue_account_id: 'acct-2300' };
    const on = N.feeConfig({ certified_collection_fee_cents: 2500, collection_fee_autopost: true }, ct, { category: 'assessment_certified_demand', cents: 5000 });
    assert.strictEqual(on.homeowner_fee_cents, 2500); assert.strictEqual(on.bedrock_fee_cents, 5000); assert.strictEqual(on.differs, true);
    assert.strictEqual(N.feeConfig({ certified_collection_fee_cents: 2500, collection_fee_autopost: false }, ct, null).homeowner_fee_cents, 0);
    assert.strictEqual(N.feeConfig({ certified_collection_fee_cents: 0, collection_fee_autopost: true }, ct, null).homeowner_fee_cents, 0);
    assert.strictEqual(N.feeConfig({ certified_collection_fee_cents: 2500, collection_fee_autopost: true }, null, null).homeowner_fee_cents, 0);
    const wrong = N.feeConfig({ certified_collection_fee_cents: 2500, collection_fee_autopost: true }, { gl_revenue_account_id: 'x', credit_account_number: '4036' }, null);
    assert.strictEqual(wrong.homeowner_fee_cents, 0); assert.ok(wrong.why_not.some((w) => /not the 2300 clearing account/.test(w)));
    const exp = { number: '5830', name: 'Billings/Collections Expense' };
    assert.deepStrictEqual(N.apCoding({ bedrockCents: 5000, recoveredCents: 5000, expenseAccount: exp }).lines.map((l) => [l.account, l.cents]), [['2300', 5000]], 'fully recovered: 2300 nets to zero');
    assert.deepStrictEqual(N.apCoding({ bedrockCents: 5000, recoveredCents: 2500, expenseAccount: exp }).lines.map((l) => [l.account, l.cents]), [['2300', 2500], ['5830', 2500]], 'partly recovered: the rest is association expense');
    assert.deepStrictEqual(N.apCoding({ bedrockCents: 5000, recoveredCents: 0, expenseAccount: exp }).lines.map((l) => [l.account, l.cents]), [['5830', 5000]], 'fee off: all association expense, nothing left in 2300');
    const over = N.feeConfig({ certified_collection_fee_cents: 6000, collection_fee_autopost: true }, ct, { cents: 5000 });
    assert.strictEqual(over.homeowner_fee_cents, 0); assert.ok(over.why_not.some((w) => /exceeds the management-agreement rate/.test(w)));
  });

  const acct = (o = {}) => ({ tenure_id: 't1', balance_cents: 41453, open_charges: [{ category: 'assessment', due_date: '2026-01-01', balance_cents: 26000 }], mailing_ok: true, legal_status: { state: 'current', effective_at: '2026-10-01T15:00:00Z' }, ...o });
  const ctx = { policy: { certified_209_notice_days: 45, grace_period_days: 30 }, template: T, today: '2026-10-05' };
  await t('eligibility: a delinquent assessment past the policy trigger is eligible; every restriction holds the account', () => {
    const ok = N.evaluateAccount(acct(), ctx);
    assert.strictEqual(ok.eligible, true, ok.holds.join('; ')); assert.strictEqual(ok.oldest_assessment_due, '2026-01-01');
    const cases = [
      [{ active_payment_plan: true }, /payment plan/], [{ bankruptcy_open: true }, /Bankruptcy/], [{ collection_status: 'with_attorney' }, /attorney/],
      [{ enforcement_state: 'in_bankruptcy' }, /Bankruptcy/], [{ open_notice: { status: 'approved' } }, /already in progress/],
      [{ last_mailed: { mailed_date: '2026-09-01', deadline_date: '2026-10-16' } }, /cure period/], [{ recent_payment: { date: '2026-10-01', cents: 5000 } }, /Recent payment/],
      [{ open_charges: [{ category: 'late_fee', due_date: '2026-01-01', balance_cents: 1000 }] }, /fees only/], [{ open_charges: [{ category: 'assessment', due_date: '2026-09-01', balance_cents: 26000 }] }, /days past due/],
      [{ tenure_id: null }, /tenure/], [{ mailing_ok: false }, /mailing address/],
      [{ attorney_activity: { date: '2026-10-03', description: 'Opening balance 2026-07-31 (Legal Fees - Collections/DRV)' } }, /collections counsel/],
    ];
    for (const [o, re] of cases) { const r = N.evaluateAccount(acct(o), ctx); assert.strictEqual(r.eligible, false, JSON.stringify(o)); assert.ok(r.holds.some((h) => re.test(h)), `${JSON.stringify(o)} -> ${r.holds.join('; ')}`); }
  });

  await t('legal status: silence is never "not with counsel"; a stale confirmation, attorney fees or an attorney invoice after the confirmation hold the account', () => {
    const hold = (o, re) => { const r = N.evaluateAccount(acct(o), ctx); assert.strictEqual(r.eligible, false, JSON.stringify(o)); assert.ok(r.holds.some((h) => re.test(h)), r.holds.join('; ')); };
    hold({ legal_status: null }, /Legal status not confirmed/);
    hold({ legal_status: { state: 'current', effective_at: '2026-06-01' } }, /re-confirm/);
    hold({ legal_status: { state: 'at_legal', effective_at: '2026-10-01' }, enforcement_state: 'at_legal' }, /At legal/);
    hold({ legal_status: { state: 'in_collections', effective_at: '2026-10-01' }, enforcement_state: 'in_collections' }, /collections agent or counsel/);
    hold({ attorney_activity: { date: '2026-10-03', description: 'Legal Fees - Collections / 283101' } }, /confirm it is not with collections counsel/);
    hold({ attorney_invoice: { date: '2026-10-02' } }, /attorney invoice/);
    const cleared = N.evaluateAccount(acct({ attorney_activity: { date: '2026-07-31', description: 'Opening balance (Legal Fees - Collections/DRV)' }, attorney_invoice: { date: '2026-08-15' } }), ctx);
    assert.strictEqual(cleared.eligible, true, 'a confirmation made after the attorney activity clears it: ' + cleared.holds.join('; '));
  });

  await t('prior notices: a prior-system collections letter inside its cure period holds; an older one does not', () => {
    const inCure = N.evaluateAccount(acct({ prior_letter: { date: '2026-10-05', source: 'Vantaca history' } }), ctx);
    assert.ok(inCure.holds.some((h) => /still within its cure period/.test(h)));
    assert.strictEqual(N.evaluateAccount(acct({ prior_letter: { date: '2026-06-01', source: 'Vantaca history' } }), ctx).eligible, true);
  });

  await t('approval attestation: counsel list checked and named, Vantaca letters checked through a recent date', () => {
    assert.strictEqual(N.attestationErrors(null, { today: '2026-10-12' }).length, 4);
    assert.deepStrictEqual(N.attestationErrors({ counsel_list_checked: true, counsel_list_source: 'Daughtry & Farfan status report 10/10/2026', vantaca_letters_checked: true, vantaca_checked_through: '2026-10-12' }, { today: '2026-10-12' }), []);
    assert.ok(N.attestationErrors({ counsel_list_checked: true, counsel_list_source: 'x', vantaca_letters_checked: true, vantaca_checked_through: '2026-09-01' }, { today: '2026-10-12' }).some((e) => /within the last 3 days/.test(e)));
  });

  await t('converted accounts: an opening balance is dated by the prior-system assessment it carried; with no history it is held, never guessed', () => {
    const h = [{ date: '2025-01-01', amount_cents: 26000 }, { date: '2026-01-01', amount_cents: 26000 }];
    assert.strictEqual(N.originalDueDate(26000, h), '2026-01-01', 'the open $260 is the newest assessment');
    assert.strictEqual(N.originalDueDate(40000, h), '2025-01-01', 'more than one assessment open: the older one is the oldest due');
    assert.strictEqual(N.originalDueDate(26000, []), null);
    assert.strictEqual(N.originalDueDate(680100, [{ date: '2026-01-01', amount_cents: 142500 }]), '2026-01-01', 'history runs out: the oldest charge found is a safe lower bound');
    const conv = (od) => acct({ open_charges: [{ category: 'assessment', due_date: '2026-07-31', balance_cents: 26000, opening_balance: true, original_due_date: od }] });
    const dated = N.evaluateAccount(conv('2026-01-01'), ctx);
    assert.strictEqual(dated.eligible, true, dated.holds.join('; ')); assert.strictEqual(dated.oldest_assessment_due, '2026-01-01'); assert.match(dated.due_date_basis, /prior-system/);
    const unknown = N.evaluateAccount(conv(null), ctx);
    assert.strictEqual(unknown.eligible, false); assert.ok(unknown.holds.some((x) => /original due date is not on file/.test(x)));
  });

  const rows = [
    { id: 'a', transaction_date: '2025-04-30', description: 'Certified Letter Initial Balance', amount_cents: 2260 },
    { id: 'b', transaction_date: '2025-04-30', description: 'Late Interest Initial Balance', amount_cents: 240 },
    { id: 'c', transaction_date: '2026-01-01', description: 'Annual Assessment', amount_cents: 26000 },
    { id: 'd', transaction_date: '2026-02-01', description: 'Late Fees', amount_cents: 1000 },
    { id: 'e', transaction_date: '2026-03-15', description: 'Payment', amount_cents: -5000 },
  ];
  await t('statement: running totals are computed from the ledger, older rows collapse into one prior balance, the fee line ties notice = statement', () => {
    const s = N.statementLines(rows, { windowStart: '2025-06-01', feeCents: 2500, noticeDate: '2026-10-05' });
    assert.strictEqual(s.prior_balance_cents, 2500);
    assert.deepStrictEqual(s.lines.map((l) => l.total_cents), [28500, 29500, 24500, 27000]);
    assert.strictEqual(s.lines[3].pending_until_mailed, true); assert.strictEqual(s.lines[3].date, '2026-10-05');
    assert.strictEqual(s.ending_cents, 24500 + 2500);
  });

  const snapshotFor = (fee = 2500) => {
    const st = N.statementLines(rows, { windowStart: '2025-01-01', feeCents: fee, noticeDate: '2026-10-05' });
    return { association: { name: COMM.hoa_legal_name }, mgmt: { name: 'Bedrock Association Management LLC', line1: '12808 W Airport Blvd STE 253', city: 'Sugar Land, TX 77478', phone: '832-588-2485' },
      remit: { name: COMM.hoa_legal_name, block: `${COMM.hoa_legal_name}\nc/o Bedrock Association Management LLC\n12808 W Airport Blvd STE 253\nSugar Land, TX 77478` },
      account_number: '10311612', addressee: { name: 'Ramiro Ruiz', street: '527 Meadow Knoll Drive', cityline: 'Stafford, TX 77477' }, property_label: '10311612 - 527 Meadow Knoll Drive',
      ledger_balance_cents: 24500, ledger_sum_cents: 24500, fee_cents: fee, amount_due_cents: 24500 + fee, scanline: '0000 000101 0000000010311612 RUIZ0000 027000 1', ...st };
  };
  const notice = (o = {}) => ({ id: 'n1', notice_date: '2026-10-05', deadline_date: '2026-11-19', cure_days: 45, ledger_balance_cents: 24500, fee_cents: 2500, amount_due_cents: 27000, ...o });

  await t('validation: the seeded letter passes for a consistent notice; a missing element, a broken date or a statement that does not tie is refused', () => {
    assert.deepStrictEqual(N.validateNotice({ template: T, snapshot: snapshotFor(), notice: notice(), community: COMM, today: '2026-10-05' }), []);
    const noPlan = { ...T, paragraphs: T.paragraphs.map((p) => p.replace(/payment plan/g, 'arrangement')) };
    assert.ok(N.validateNotice({ template: noPlan, snapshot: snapshotFor(), notice: notice(), community: COMM, today: '2026-10-05' }).some((e) => /Payment plan availability/.test(e)));
    assert.ok(N.validateNotice({ template: T, snapshot: snapshotFor(), notice: notice({ deadline_date: '2025-10-16' }), community: COMM, today: '2026-10-05' }).length > 0);
    assert.ok(N.validateNotice({ template: T, snapshot: snapshotFor(0), notice: notice(), community: COMM, today: '2026-10-05' }).some((e) => /Statement total/.test(e)));
    assert.ok(N.validateNotice({ template: { ...T, paragraphs: [...T.paragraphs, 'Call {{unknown_field}}'] }, snapshot: snapshotFor(), notice: notice(), community: COMM, today: '2026-10-05' }).some((e) => /Unfilled/.test(e)));
  });

  await t('packet: letter, itemized statement with coupon and office copy; the deadline printed is the computed one', () => {
    const html = N.renderNoticeHTML({ template: T, snapshot: snapshotFor(), notice: notice(), community: COMM });
    assert.ok(html.includes('BY: November 19, 2026') && !html.includes('2025-10-16') && !html.includes('10/16/2025'));
    assert.ok(html.includes('Amount Due: $270.00') && html.includes('PAY THIS AMOUNT: <strong>$270.00'));
    assert.ok(html.includes('ACCOUNT STATEMENT') && html.includes('-- Prior Balance --') && html.includes('Certified Letter - Delinquency Certified Letter'));
    assert.strictEqual((html.match(/OFFICE COPY/g) || []).length, 1); assert.ok(!/\{\{\w+\}\}/.test(html));
    assert.ok(html.includes('forty-five (45) days'));
    assert.strictEqual((N.renderNoticeHTML({ template: { ...T, include_office_copy: false }, snapshot: snapshotFor(), notice: notice(), community: COMM }).match(/OFFICE COPY/g) || []).length, 0);
  });

  // ---- mailing + fee, against an in-memory store --------------------------------------
  function fakeDb(seed) {
    const Tb = { journal_entries: [], homeowner_transactions: [], transaction_upload_batches: [], billing_pending_items: [], ar_account_collections: [], ...seed };
    const val = (r, k) => (k.includes('->>') ? ((r[k.split('->>')[0]] || {})[k.split('->>')[1]]) : r[k]);
    const from = (table) => {
      const st = { f: [], op: 'select', row: null, patch: null, single: false };
      const match = (r) => st.f.every(([k, op, v]) => (k.includes('.') && !k.includes('->>') ? true : op === 'eq' ? val(r, k) === v : op === 'in' ? v.includes(val(r, k)) : op === 'neq' ? val(r, k) !== v : op === 'is' ? val(r, k) == null : op === 'ilike' ? new RegExp('^' + String(v).replace(/%/g, '.*') + '$', 'i').test(String(val(r, k) || '')) : true));
      const exec = () => {
        const rows = (Tb[table] = Tb[table] || []);
        if (st.op === 'insert') {
          if (table === 'billing_pending_items' && rows.some((x) => x.source === st.row.source && x.source_ref === st.row.source_ref)) return { data: null, error: { code: '23505', message: 'dup' } };
          const r = { id: `${table}-${rows.length + 1}`, ...st.row }; rows.push(r); return { data: st.single ? r : [r], error: null };
        }
        if (st.op === 'upsert') { rows.push(st.row); return { data: null, error: null }; }
        if (st.op === 'update') { const hit = rows.filter(match); hit.forEach((r) => Object.assign(r, st.patch)); return { data: st.single ? hit[0] || null : hit, error: null }; }
        const hit = rows.filter(match); return { data: st.single ? hit[0] || null : hit, error: st.single && !hit[0] ? { message: `no ${table} row` } : null };
      };
      const q = { select() { return q; }, order() { return q; }, limit() { return q; },
        eq(k, v) { st.f.push([k, 'eq', v]); return q; }, in(k, v) { st.f.push([k, 'in', v]); return q; }, neq(k, v) { st.f.push([k, 'neq', v]); return q; }, is(k) { st.f.push([k, 'is', null]); return q; },
        ilike(k, v) { st.f.push([k, 'ilike', v]); return q; },
        insert(row) { st.op = 'insert'; st.row = row; return q; }, update(p) { st.op = 'update'; st.patch = p; return q; }, upsert(row) { st.op = 'upsert'; st.row = row; return q; },
        single() { st.single = true; return q; }, maybeSingle() { st.single = true; return q; }, then(res, rej) { return Promise.resolve(exec()).then(res, rej); } };
      return q;
    };
    return { from, T: Tb };
  }
  const seed = (n) => ({
    collection_notices: [{ id: 'n1', batch_id: 'b1', community_id: 'qr', property_id: 'p1', tenure_id: 't1', status: 'printed', owner_name: 'Ramiro Ruiz', bedrock_fee_cents: 5000, statement_snapshot: { property_address: '527 Meadow Knoll Drive' }, ...notice(), ...n }],
    collection_notice_batches: [{ id: 'b1', status: 'printed' }],
    communities: [{ id: 'qr', name: 'Quail Ridge', certified_collection_fee_cents: 2500, collection_fee_autopost: true, management_company_id: 'mc' }],
    collection_notice_templates: [{ ...T, community_id: 'qr' }], community_billing_policies: [{ community_id: 'qr', certified_209_notice_days: 45, grace_period_days: 30, effective_end_date: null }],
    ar_charge_types: [{ community_id: 'qr', type_code: 'certified_collection', gl_revenue_account_id: 'acct-2300' }], contracts: [{ id: 'k1', community_id: 'qr', status: 'active' }],
    contract_owner_charges: [{ contract_id: 'k1', category: 'assessment_certified_demand', fee_amount: 50 }],
    community_account_roles: [{ community_id: 'qr', role: 'homeowner_ar', chart_of_accounts: { id: 'acct-1300', fund_id: 'f' } }], chart_of_accounts: [{ id: 'acct-2300', fund_id: 'f', account_number: '2300', community_id: 'qr', account_type: 'liability', is_active: true }, { id: 'acct-5830', fund_id: 'f', account_number: '5830', account_name: 'Billings/Collections Expense', community_id: 'qr', account_type: 'expense', is_active: true }],
    ownership_tenures: [{ id: 't1', vantaca_account_id: '10311612' }], properties: [{ id: 'p1', trusted_account_number: '1005000001' }], property_ownerships: [{ tenure_id: 't1', contact_id: 'ct1' }],
  });
  const TRK = '9407111899223197428490';

  await t('mailing: a valid USPS number, the notice date and the regular-mail copy are required; the fee posts once and Bedrock billing stages once', async () => {
    const db = fakeDb(seed());
    const posted = [];
    const post = async (o) => { posted.push(o); const je = { id: `je${posted.length}`, reference: `JE-${posted.length}`, community_id: o.community_id, source_reference: o.source_reference, status: 'posted' }; db.T.journal_entries.push(je); return { entry: je }; };
    await assert.rejects(N.recordMailing(db, 'n1', { trackingNumber: '123', mailedDate: '2026-10-05', regularMailConfirmed: true, actor: 's', post }), /20- or 22-digit/);
    await assert.rejects(N.recordMailing(db, 'n1', { trackingNumber: TRK, mailedDate: '2026-10-06', regularMailConfirmed: true, actor: 's', post }), (e) => e.code === 'date_mismatch');
    await assert.rejects(N.recordMailing(db, 'n1', { trackingNumber: TRK, mailedDate: '2026-10-05', regularMailConfirmed: false, actor: 's', post }), /regular-mail copy/);
    assert.strictEqual(posted.length, 0, 'nothing posted on a refused mailing');
    const r = await N.recordMailing(db, 'n1', { trackingNumber: TRK, mailedDate: '2026-10-05', regularMailConfirmed: true, actor: 'staff', post });
    assert.strictEqual(r.status, 'mailed'); assert.strictEqual(r.fee.status, 'posted'); assert.strictEqual(r.billing.status, 'staged');
    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0].source_reference, 'collnotice:n1'); assert.strictEqual(posted[0].posting_date, '2026-10-05'); assert.strictEqual(posted[0].source_module, 'certified_letter_fee');
    assert.deepStrictEqual(posted[0].lines.map((l) => [l.account_id, l.debit_cents, l.credit_cents]), [['acct-1300', 2500, 0], ['acct-2300', 0, 2500]]);
    const fee = db.T.homeowner_transactions.filter((x) => x.raw_row_jsonb && x.raw_row_jsonb.source === 'collection_notice_fee');
    assert.strictEqual(fee.length, 1); assert.strictEqual(fee[0].tenure_id, 't1'); assert.strictEqual(fee[0].transaction_date, '2026-10-05'); assert.strictEqual(fee[0].amount_cents, 2500);
    assert.strictEqual(db.T.transaction_upload_batches[0].status, 'committed');
    assert.strictEqual(db.T.billing_pending_items.length, 1); assert.strictEqual(db.T.billing_pending_items[0].amount, 50, "Bedrock's $50 contract rate, separate from the $25 homeowner fee");
    assert.match(db.T.billing_pending_items[0].note, /Dr 2300 \$25\.00 \/ Dr 5830 Billings\/Collections Expense \$25\.00 \/ Cr AP Bedrock \$50\.00/, 'the AP line is coded: recovered part to 2300, the rest to association expense');
    const again = await N.recordMailing(db, 'n1', { trackingNumber: TRK, mailedDate: '2026-10-05', regularMailConfirmed: true, actor: 'staff', post });
    assert.strictEqual(again.status, 'already_mailed'); assert.strictEqual(posted.length, 1, 'no second fee'); assert.strictEqual(db.T.homeowner_transactions.length, 1);
    assert.strictEqual((await N.stageBedrockFee(db, db.T.collection_notices[0], { actor: 's' })).status, 'already_staged');
  });

  await t('mailing: a notice that carried no fee charges nothing; only a printed notice can be mailed', async () => {
    const db = fakeDb(seed({ fee_cents: 0, amount_due_cents: 24500 }));
    const r = await N.recordMailing(db, 'n1', { trackingNumber: TRK, mailedDate: '2026-10-05', regularMailConfirmed: true, actor: 's', post: async () => { throw new Error('must not post'); } });
    assert.strictEqual(r.fee.status, 'no_fee'); assert.strictEqual(db.T.homeowner_transactions.length, 0);
    const db2 = fakeDb(seed({ status: 'draft' }));
    await assert.rejects(N.recordMailing(db2, 'n1', { trackingNumber: TRK, mailedDate: '2026-10-05', regularMailConfirmed: true, actor: 's', post: async () => { throw new Error('x'); } }), /print the approved batch first/);
  });

  await t('approval: only a verified batch, only by a person, only with an owner-approved template', async () => {
    const base = { collection_notice_batches: [{ id: 'b1', status: 'prepared', template_id: 'tpl', community_id: 'qr' }], collection_notice_templates: [{ ...T, status: 'draft' }] };
    await assert.rejects(N.approveBatch(fakeDb(base), 'b1', { actor: 'staff' }), /only a verified batch/);
    const v = { ...base, collection_notice_batches: [{ id: 'b1', status: 'verified', template_id: 'tpl', community_id: 'qr' }] };
    await assert.rejects(N.approveBatch(fakeDb(v), 'b1', { actor: 'Amanda (AI)' }), (e) => e.code === 'forbidden');
    await assert.rejects(N.approveBatch(fakeDb(v), 'b1', { actor: 'staff' }), (e) => e.code === 'attestation_required');
    const att = { counsel_list_checked: true, counsel_list_source: 'D&F status report', vantaca_letters_checked: true, vantaca_checked_through: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }) };
    await assert.rejects(N.approveBatch(fakeDb(v), 'b1', { actor: 'staff', attestation: att }), (e) => e.code === 'template_not_approved');
  });

  await t('controls: preparing and verifying never charge; the database backs one open notice per account, one fee, one GL entry, one billing item', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'collections', 'notices.js'), 'utf8');
    const prep = src.slice(src.indexOf('async function prepareBatch'), src.indexOf('// 7) Approval'));
    assert.ok(!/postNoticeFee|stageBedrockFee|postJournalEntry|post\(/.test(prep), 'preparation and verification only read and draft');
    const mail = src.slice(src.indexOf('async function recordMailing'), src.indexOf('async function postNoticeFee'));
    assert.ok(/postNoticeFee\(/.test(mail), 'the fee is posted from the mailing step');
    for (const k of ['uq_collection_notice_open', 'uq_collection_notice_tracking', 'uq_homeowner_txn_collection_notice_fee', 'uq_journal_entries_collection_notice', 'uq_billing_pending_collection_notice', 'collection_fee_autopost boolean NOT NULL DEFAULT false', 'CHECK (cure_days >= 45)', 'mailed_date = notice_date', 'amount_due_cents = ledger_balance_cents + fee_cents']) assert.ok(MIG.includes(k), k);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
