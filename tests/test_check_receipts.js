#!/usr/bin/env node
// tests/test_check_receipts.js  (Ed 2026-10-12)
// Homeowner check scanning: reading, association + owner matching (never the payer name
// alone), duplicate prevention, deposit validation, the Vantaca-import guard and
// record-exactly-once. No real payment, deposit or GL entry is created.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const CR = require('../lib/payments/check_receipts');
const { namesAreEquivalent, normalizeAddress } = require('../lib/entity_resolution');

let passed = 0; let failed = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); } };
const H = { namesAreEquivalent, normalizeAddress };

// Minimal PostgREST stand-in: eq / in / neq / gte / lte on flat columns; joined-table
// filters (a.b) are ignored; rpc and inserts are scripted.
function fakeDb(seed = {}, rpc = {}) {
  const T = { homeowner_check_receipts: [], homeowner_transactions: [], ar_payments: [], journal_entries: [], community_account_roles: [], ...seed };
  const calls = { rpc: [], insert: [], update: [] };
  const from = (table) => {
    const st = { f: [], op: 'select', row: null, patch: null, single: false };
    const match = (r) => st.f.every(([k, op, v]) => (k.includes('.') ? true : op === 'eq' ? r[k] === v : op === 'in' ? v.includes(r[k]) : op === 'neq' ? r[k] !== v : op === 'gte' ? r[k] >= v : op === 'lte' ? r[k] <= v : true));
    const exec = () => {
      const rows = (T[table] = T[table] || []);
      if (st.op === 'insert') { const r = { id: `${table}-${rows.length + 1}`, ...st.row }; rows.push(r); calls.insert.push([table, r]); return { data: st.single ? r : [r], error: null }; }
      if (st.op === 'update') { const hit = rows.filter(match); hit.forEach((r) => Object.assign(r, st.patch)); calls.update.push([table, st.patch]); return { data: st.single ? hit[0] || null : hit, error: null }; }
      const hit = rows.filter(match); return { data: st.single ? hit[0] || null : hit, error: st.single && !hit[0] ? { message: 'no rows' } : null };
    };
    const q = {
      select() { return q; }, order() { return q; }, limit() { return q; }, is() { return q; }, or() { return q; },
      eq(k, v) { st.f.push([k, 'eq', v]); return q; }, in(k, v) { st.f.push([k, 'in', v]); return q; }, neq(k, v) { st.f.push([k, 'neq', v]); return q; },
      gte(k, v) { st.f.push([k, 'gte', v]); return q; }, lte(k, v) { st.f.push([k, 'lte', v]); return q; },
      insert(row) { st.op = 'insert'; st.row = row; return q; }, update(p) { st.op = 'update'; st.patch = p; return q; },
      single() { st.single = true; return q; }, maybeSingle() { st.single = true; return q; },
      then(res, rej) { return Promise.resolve(exec()).then(res, rej); },
    };
    return q;
  };
  return { from, T, calls, rpc: async (name, args) => { calls.rpc.push([name, args]); return rpc[name] ? rpc[name](args, T) : { data: null, error: { message: `no rpc ${name}` } }; } };
}

(async () => {
  console.log('Check receipts');

  await t('reading: the written amount governs; disagreement, missing number and unsigned are flagged; the bank account is never kept', () => {
    const x = CR.normalizeCheckExtraction({ check_number: '1042', micr_check_number: '001042', check_date: '2026-10-09', amount_numeric: '414.53', amount_written_value: 414.53, micr_routing: '111000025', micr_account: '000123456789', payer_name: 'Ramiro Ruiz', signed: true });
    assert.strictEqual(x.amount_cents, 41453); assert.strictEqual(x.account_last4, '6789'); assert.ok(x.micr_fingerprint && x.micr_fingerprint.length === 64);
    assert.ok(!JSON.stringify(x).includes('123456789'), 'full account number is not in the result');
    assert.deepStrictEqual(x.issues, []);
    const bad = CR.normalizeCheckExtraction({ amount_numeric: '41.45', amount_written_value: 414.5, signed: false, check_date: 'Oct 9' });
    assert.strictEqual(bad.amount_cents, 41450, 'written amount wins');
    for (const i of ['amounts_disagree', 'no_check_number', 'no_date', 'unsigned']) assert.ok(bad.issues.includes(i), i);
    assert.strictEqual(bad.micr_fingerprint, null);
  });

  await t('payee line: a check made out to another association is detected', () => {
    const comms = [{ id: 'qr', name: 'Quail Ridge', hoa_legal_name: 'Quail Ridge Homeowners Association, Inc' }, { id: 'cg', name: 'Canyon Gate at Cinco Ranch', hoa_legal_name: 'Canyon Gate at Cinco Ranch Owners Association' }];
    assert.strictEqual(CR.payeeCommunity('Quail Ridge HOA', comms).community_id, 'qr');
    assert.strictEqual(CR.payeeCommunity('Canyon Gate Cinco Ranch', comms).community_id, 'cg');
    assert.strictEqual(CR.payeeCommunity(null, comms), null);
  });

  const cand = (o) => ({ property_id: o.id, tenure_id: o.tenure === undefined ? `t-${o.id}` : o.tenure, street_address: o.street, owner_names: o.owners || [], mailing_street: o.mailing || null, trusted_account_number: o.acct || null, vantaca_account_ids: o.vantaca || [], balance_cents: o.bal || 0, micr_history: !!o.micr });
  await t('matching: the payer name alone never matches; it is held for staff', () => {
    const s = CR.scoreCandidates({ payer_name: 'Ramiro Ruiz', amount_cents: 41453 }, [cand({ id: 'p1', street: '527 Meadow Knoll Drive', owners: ['Ramiro Ruiz'] })], H);
    assert.strictEqual(s[0].confidence, 'low');
    assert.strictEqual(CR.decideMatch(s).status, 'exception');
  });
  await t('matching: account number written on the check + owner name = high-confidence proposal', () => {
    const s = CR.scoreCandidates({ payer_name: 'Ramiro Ruiz', written_account_number: '10311612', amount_cents: 41453 }, [cand({ id: 'p1', street: '527 Meadow Knoll Drive', owners: ['Ramiro Ruiz'], vantaca: ['10311612'], bal: 41453 }), cand({ id: 'p2', street: '1 Other St', owners: ['Maria Ruiz'] })], H);
    const d = CR.decideMatch(s);
    assert.strictEqual(d.status, 'matched'); assert.strictEqual(d.property_id, 'p1'); assert.strictEqual(d.confidence, 'high');
    assert.ok(d.evidence.some((e) => e.signal === 'account_number') && d.evidence.some((e) => e.signal === 'payer_name'));
  });
  await t('matching: two equally supported accounts are ambiguous and held; an account with no current owner tenure is held', () => {
    const two = CR.scoreCandidates({ payer_name: 'J Smith', payer_address: '10 Elm Street', amount_cents: 100 }, [cand({ id: 'a', street: '10 Elm Street', owners: ['John Smith'] }), cand({ id: 'b', street: '12 Oak Street', owners: ['Jane Smith'], mailing: '10 Elm Street' })], H);
    assert.strictEqual(CR.decideMatch(two).status, 'exception');
    const noT = CR.scoreCandidates({ written_account_number: '555', payer_name: 'Ann Lee' }, [cand({ id: 'c', street: '5 Pine', owners: ['Ann Lee'], acct: '555', tenure: null })], H);
    assert.match(CR.decideMatch(noT).reason, /no current owner account/);
  });
  await t('matching: the same bank account paying this account before is strong evidence', () => {
    const s = CR.scoreCandidates({ payer_name: 'R Ruiz' }, [cand({ id: 'p1', street: '527 Meadow Knoll Drive', owners: ['Ramiro Ruiz'], micr: true })], H);
    assert.strictEqual(CR.decideMatch(s).status, 'matched');
  });

  await t('duplicates: same image / same MICR / same number+amount block; a ledger or hand-entered payment holds for a reason', () => {
    const f = CR.classifyDuplicates({ check: { account_last4: '6789' }, sameImage: [{ id: 'r1', status: 'recorded' }], sameMicr: [{ id: 'r2', status: 'deposited' }],
      sameNumber: [{ id: 'r3', status: 'recorded', check_number: '1042', amount_cents: 41453, account_last4: '6789' }, { id: 'r4', status: 'recorded', check_number: '1042', amount_cents: 41453, account_last4: '1111' }],
      ledger: [{ id: 'h1', amount_cents: -41453, transaction_date: '2026-10-08', description: 'Payment', raw_row_jsonb: null }], manual: [{ id: 'm1', amount_cents: 41453, payment_date: '2026-10-07' }] });
    assert.deepStrictEqual(f.filter((x) => x.severity === 'blocking').map((x) => x.kind), ['same_image', 'same_check', 'same_number_amount'], 'a different bank account with the same check number is not the same check');
    assert.deepStrictEqual(f.filter((x) => x.severity === 'possible').map((x) => x.kind), ['ledger_payment', 'manual_payment']);
    assert.match(f.find((x) => x.kind === 'ledger_payment').detail, /imported from Vantaca/);
  });

  await t('deposit: one association, recorded checks only, received on or before the deposit date, bank total must equal the checks', () => {
    const r = (o) => ({ id: o.id, community_id: o.c || 'c1', status: o.s || 'recorded', check_number: o.n || '1', amount_cents: o.a || 1000, received_date: o.d || '2026-10-10', deposit_id: o.dep || null });
    assert.ok(CR.validateDeposit({ receipts: [r({ id: 1 }), r({ id: 2, a: 2500 })], depositDate: '2026-10-11', bankReference: 'RDC-7781', bankTotalCents: 3500 }).ok);
    const v = CR.validateDeposit({ receipts: [r({ id: 1, s: 'matched' }), r({ id: 2, c: 'c2' }), r({ id: 3, d: '2026-10-12' }), r({ id: 4, dep: 'x' })], depositDate: '2026-10-11', bankReference: '', bankTotalCents: 1 });
    assert.ok(!v.ok);
    for (const m of [/not recorded/, /one association/, /after the deposit date/, /already on a deposit/, /confirmation/, /does not equal/]) assert.ok(v.errors.some((e) => m.test(e)), String(m));
  });

  await t('Vantaca import guard: a payment row that is a recorded check is skipped once; other rows load', () => {
    const rows = [{ source_row_index: 2, vantaca_account_id: 'A1', amount_cents: -41453, transaction_date: '2026-10-14' }, { source_row_index: 3, vantaca_account_id: 'A1', amount_cents: -41453, transaction_date: '2026-10-15' },
      { source_row_index: 4, vantaca_account_id: 'A1', amount_cents: 2500, transaction_date: '2026-10-15' }, { source_row_index: 5, vantaca_account_id: 'A2', amount_cents: -100, transaction_date: '2026-10-15' }];
    const skip = CR.recordedCheckRowsToSkip(rows, [{ id: 'rc1', property_id: 'P1', amount_cents: 41453, received_date: '2026-10-10' }], { A1: 'P1', A2: 'P2' });
    assert.deepStrictEqual([...skip.keys()], [2], 'one recorded check absorbs one row only');
    assert.strictEqual(CR.recordedCheckRowsToSkip(rows, [{ id: 'rc1', property_id: 'P1', amount_cents: 41453, received_date: '2026-08-01' }], { A1: 'P1' }).size, 0, 'outside the window it is not the same payment');
  });

  const receipt = (o = {}) => ({ id: 'rc1', community_id: 'c1', status: 'matched', check_number: '1042', amount_cents: 41453, check_date: '2026-10-09', received_date: '2026-10-10', property_id: 'p1', tenure_id: 't1', payer_name: 'Ramiro Ruiz', front_sha256: 'abc', ...o });
  const roles = [{ role: 'undeposited_funds', community_id: 'c1', chart_of_accounts: { id: 'acct-1020', account_number: '1020', fund_id: 'f' } }, { role: 'homeowner_ar', community_id: 'c1', chart_of_accounts: { id: 'acct-1300', account_number: '1300', fund_id: 'f' } }];
  const rpcs = {
    post_check_receipt_payment: () => ({ data: { already_posted: false, batch_id: 'b1', applied_cents: 41453, unapplied_cents: 0 }, error: null }),
    check_receipt_commit_posting: (a, T) => { const r = T.homeowner_check_receipts.find((x) => x.id === a.p_receipt_id); r.status = 'recorded'; r.journal_entry_id = a.p_journal_entry_id; return { data: { already_committed: false }, error: null }; },
  };

  await t('recording: Dr Undeposited Funds / Cr AR dated the received date, keyed to the receipt; a second call posts nothing', async () => {
    const db = fakeDb({ homeowner_check_receipts: [receipt()], community_account_roles: roles }, rpcs);
    const posted = [];
    const post = async (o) => { posted.push(o); db.T.journal_entries.push({ id: 'je1', reference: 'JE-1', community_id: o.community_id, source_reference: o.source_reference, status: 'posted' }); return { entry: { id: 'je1', reference: 'JE-1' } }; };
    const r1 = await CR.recordReceipt(db, 'rc1', { actor: 'staff', post });
    assert.strictEqual(r1.status, 'recorded'); assert.strictEqual(posted.length, 1);
    const je = posted[0];
    assert.strictEqual(je.source_reference, 'checkrcpt:rc1'); assert.strictEqual(je.posting_date, '2026-10-10'); assert.strictEqual(je.source_module, 'payment_intake');
    assert.deepStrictEqual(je.lines.map((l) => [l.account_id, l.debit_cents, l.credit_cents]), [['acct-1020', 41453, 0], ['acct-1300', 0, 41453]]);
    const r2 = await CR.recordReceipt(db, 'rc1', { actor: 'staff', post });
    assert.strictEqual(r2.status, 'already_recorded'); assert.strictEqual(posted.length, 1, 'no second entry');
  });

  await t('recording: an exception is never posted; a possible duplicate needs a written reason', async () => {
    const db = fakeDb({ homeowner_check_receipts: [receipt({ status: 'exception' })], community_account_roles: roles }, rpcs);
    await assert.rejects(CR.recordReceipt(db, 'rc1', { actor: 's', post: async () => { throw new Error('must not post'); } }), /confirm the account first/);
    const db2 = fakeDb({ homeowner_check_receipts: [receipt()], community_account_roles: roles, ar_payments: [{ id: 'm1', property_id: 'p1', amount_cents: 41453, payment_date: '2026-10-09', status: 'applied' }] }, rpcs);
    await assert.rejects(CR.recordReceipt(db2, 'rc1', { actor: 's', post: async () => { throw new Error('must not post'); } }), (e) => e.code === 'possible_duplicate');
    assert.strictEqual(db2.calls.rpc.length, 0, 'nothing reached the ledger');
  });

  await t('one payment path: the old Record payment form and the ar_engine payment writer are retired; the account screen links to Check Receipts', () => {
    const gl = fs.readFileSync(path.join(__dirname, '..', 'api', 'gl.js'), 'utf8');
    const route = gl.slice(gl.indexOf("router.post('/:communityId/owners/:propertyId/payment'"), gl.indexOf("router.post('/:communityId/owners/:propertyId/payment'") + 400);
    assert.ok(/status\(410\)/.test(route) && !/recordHomeownerPayment\(/.test(route), 'the old endpoint posts nothing');
    const ar = fs.readFileSync(path.join(__dirname, '..', 'api', 'ar.js'), 'utf8');
    assert.ok(/router\.post\('\/payments', \(req, res\) => res\.status\(410\)/.test(ar) && !/await recordPayment\(/.test(ar), 'POST /api/ar/payments posts nothing');
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'accounting.html'), 'utf8');
    for (const gone of ['payForm', 'pay_amount', 'window.recordPayment', 'payToggle']) assert.ok(!html.includes(gone), `${gone} removed`);
    assert.ok(/showView\('checkscan'\)/.test(html) && /window\.showView = function/.test(html), 'Record a check opens Check Receipts');
  });

  await t('controls: scanning never posts; the migration keeps the duplicate keys and the received date', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'payments', 'check_receipts.js'), 'utf8');
    const intake = src.slice(src.indexOf('async function intakeCheck'), src.indexOf('// 5) Staff confirmation'));
    assert.ok(!/postJournalEntry|post_check_receipt_payment|\.rpc\(/.test(intake), 'intake reads and matches only');
    const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations', '514_homeowner_check_receipts.sql'), 'utf8');
    for (const k of ['uq_check_receipt_front_image', 'uq_check_receipt_micr', 'uq_homeowner_txn_check_receipt', 'uq_journal_entries_check_refs', "'undeposited_funds'", 'received_date', 'is post-dated']) assert.ok(mig.includes(k), k);
    assert.ok(!/micr_account\s+text/.test(mig) && /account_last4/.test(mig), 'the full bank account number has no column');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
