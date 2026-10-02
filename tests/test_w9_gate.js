// ============================================================================
// tests/test_w9_gate.js  (Issue #14, Ed 2026-10-01): no W-9, no approval or payment
// ----------------------------------------------------------------------------
// The DJ bill created a vendor with no W-9 and a payable; the only thing
// standing between it and a check was an `on_hold` label that approval ignores.
// The gate now refuses, on the SERVER, every approval (manager key, admin
// release) and every payment (check run, mark-paid, POST /payments, early
// prepay) for a non-exempt vendor with w9_on_file = false. Exempt only by data
// already on the vendor (is_mud), never by name. No override exists.
// Plus: the replay dry run now predicts vendor CREATION exactly as intake does.
// In-memory fakes only; nothing touches the network or a database.
// ============================================================================
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { w9Status, assertW9Cleared } = require('../lib/ap/w9_gate');
const tests = []; const check = (n, fn) => tests.push([n, fn]);
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// A tiny in-memory PostgREST: from(t).select().eq().in().neq().order().limit()
// .maybeSingle()/.single()/then; insert/update recorded in `writes`.
function memDb(tables, { failOn } = {}) {
  const writes = [];
  const api = { writes, from(t) {
    const f = []; let lim = 1e9; let op = null; let payload = null;
    const rows = () => (tables[t] || []).filter((r) => f.every((p) => p(r))).slice(0, lim);
    const q = {
      select() { return q; }, eq(c, v) { f.push((r) => r[c] === v); return q; }, neq(c, v) { f.push((r) => r[c] !== v); return q; },
      in(c, vs) { f.push((r) => vs.includes(r[c])); return q; }, is(c, v) { f.push((r) => (r[c] ?? null) === v); return q; },
      order() { return q; }, limit(n) { lim = n; return q; }, range() { return q; },
      insert(p) { op = 'insert'; payload = p; writes.push({ t, op, payload }); return q; },
      update(p) { op = 'update'; payload = p; writes.push({ t, op, payload }); return q; },
      maybeSingle() { return Promise.resolve(failOn === t ? { data: null, error: { message: 'boom' } } : { data: rows()[0] || null, error: null }); },
      single() { return Promise.resolve(failOn === t ? { data: null, error: { message: 'boom' } } : { data: op === 'insert' ? { id: 'new-1', ...payload } : (rows()[0] ? { ...rows()[0], ...(payload || {}) } : null), error: null }); },
      then(res, rej) { return Promise.resolve(failOn === t ? { data: null, error: { message: 'boom' } } : { data: rows(), error: null }).then(res, rej); },
    };
    return q;
  } };
  return api;
}
// Load a module with @supabase/supabase-js stubbed to return `db`.
function withDb(db, modPath, fn) {
  const sbPath = require.resolve('@supabase/supabase-js'); const mp = require.resolve(modPath);
  const saved = [require.cache[sbPath], require.cache[mp]];
  require.cache[sbPath] = { id: sbPath, filename: sbPath, loaded: true, exports: { createClient: () => db } };
  delete require.cache[mp];
  const restore = () => { if (saved[0]) require.cache[sbPath] = saved[0]; else delete require.cache[sbPath]; if (saved[1]) require.cache[mp] = saved[1]; else delete require.cache[mp]; };
  return Promise.resolve().then(() => fn(require(modPath))).finally(restore);
}

const DJ_VENDOR = { id: 'v-dj', name: 'DJ (individual)', w9_on_file: false, is_mud: false };
const W9_VENDOR = { id: 'v-ok', name: 'Lawn Co', w9_on_file: true, is_mud: false };
const MUD_VENDOR = { id: 'v-mud', name: 'FORT BEND COUNTY M.U.D. No. 143', w9_on_file: false, is_mud: true };
const COUNTY_NO_FLAG = { id: 'v-cty', name: 'Fort Bend County', w9_on_file: false, is_mud: false };
const INV = (id, vendor_id, extra = {}) => ({ id, vendor_id, community_id: 'c1', status: 'awaiting_approval', total_cents: 30000, amount_paid_cents: 0, posting_journal_entry_id: 'je1', invoice_date: '2026-09-17', ...extra });

// ---------------------------------------------------------------- the rule
check('rule: W-9 on file -> allowed', () => assert.ok(w9Status(W9_VENDOR).ok));
check('rule: no W-9 -> blocked, with the vendor named', () => { const s = w9Status(DJ_VENDOR); assert.ok(!s.ok && /DJ \(individual\) has no W-9 on file/.test(s.reason)); });
check('rule: MUD (is_mud on the vendor record) is exempt as a government district', () => { const s = w9Status(MUD_VENDOR); assert.ok(s.ok && /government/.test(s.exempt)); });
check('rule: a government-sounding NAME is not an exemption (no name guessing)', () => assert.ok(!w9Status(COUNTY_NO_FLAG).ok));
check('rule: no vendor at all -> blocked', () => assert.ok(!w9Status(null).ok));

check('assertW9Cleared: blocks with code, plain explanation, and the blocked bills', async () => {
  const db = memDb({ ap_invoices: [INV('i-dj', 'v-dj'), INV('i-ok', 'v-ok')], vendors: [DJ_VENDOR, W9_VENDOR] });
  await assert.rejects(assertW9Cleared(db, ['i-dj', 'i-ok']), (e) => e.code === 'w9_required' && /W-9 required: DJ \(individual\) has no W-9 on file/.test(e.detail) && /cannot be bypassed/.test(e.detail) && e.blocked.length === 1 && e.blocked[0].invoice_id === 'i-dj');
  await assertW9Cleared(db, ['i-ok']);
});
check('assertW9Cleared: fails CLOSED on a query error (never reads as "cleared")', async () => {
  await assert.rejects(assertW9Cleared(memDb({}, { failOn: 'ap_invoices' }), ['i-dj']), (e) => e.code === 'w9_check_failed');
  await assert.rejects(assertW9Cleared(memDb({ ap_invoices: [INV('i-dj', 'v-dj')] }, { failOn: 'vendors' }), ['i-dj']), (e) => e.code === 'w9_check_failed');
});

// ---------------------------------------------------------------- approval paths
check('approveInvoice (admin release): no-W-9 bill is refused and NOTHING is written', async () => {
  const db = memDb({ ap_invoices: [INV('i-dj', 'v-dj')], vendors: [DJ_VENDOR] });
  await withDb(db, '../lib/accounting/ap_engine', async ({ approveInvoice }) => {
    await assert.rejects(approveInvoice({ invoice_id: 'i-dj', user_id: 'u', action: 'released_for_payment' }), (e) => e.code === 'w9_required');
  });
  assert.strictEqual(db.writes.length, 0, JSON.stringify(db.writes));
});
check('approveInvoice: an on_hold no-W-9 bill is refused too (on_hold is not the control)', async () => {
  const db = memDb({ ap_invoices: [INV('i-dj', 'v-dj', { status: 'on_hold' })], vendors: [DJ_VENDOR] });
  await withDb(db, '../lib/accounting/ap_engine', async ({ approveInvoice }) => {
    await assert.rejects(approveInvoice({ invoice_id: 'i-dj', user_id: 'u' }), (e) => e.code === 'w9_required');
  });
  assert.strictEqual(db.writes.length, 0);
});
check('approveInvoice: W-9 on file -> approves (gate passes)', async () => {
  const db = memDb({ ap_invoices: [INV('i-ok', 'v-ok')], vendors: [W9_VENDOR] });
  await withDb(db, '../lib/accounting/ap_engine', async ({ approveInvoice }) => { await approveInvoice({ invoice_id: 'i-ok', user_id: 'u' }); });
  assert.ok(db.writes.some((w) => w.t === 'ap_invoices' && w.op === 'update' && w.payload.status === 'approved'));
});
check('approveInvoice: MUD exempt -> approves', async () => {
  const db = memDb({ ap_invoices: [INV('i-mud', 'v-mud')], vendors: [MUD_VENDOR] });
  await withDb(db, '../lib/accounting/ap_engine', async ({ approveInvoice }) => { await approveInvoice({ invoice_id: 'i-mud', user_id: 'u' }); });
  assert.ok(db.writes.some((w) => w.payload && w.payload.status === 'approved'));
});
check('history: an ALREADY approved/paid no-W-9 bill is returned as-is, never mutated or re-gated', async () => {
  for (const status of ['approved', 'paid', 'partially_paid']) {
    const db = memDb({ ap_invoices: [INV('i-old', 'v-dj', { status })], vendors: [DJ_VENDOR] });
    await withDb(db, '../lib/accounting/ap_engine', async ({ approveInvoice }) => { const r = await approveInvoice({ invoice_id: 'i-old' }); assert.ok(r.already); });
    assert.strictEqual(db.writes.length, 0, status);
  }
});
check('manager key (API, key 1): the W-9 check runs BEFORE the approval is recorded', () => {
  const s = src('api/ap.js');
  const key1 = s.slice(s.indexOf('// ---- Key 1: manager ----'), s.indexOf('// ---- Key 2: admin release ----'));
  const gate = key1.indexOf("assertW9Cleared(supabase, [id])"); const ins = key1.indexOf("action: 'approved'");
  assert.ok(gate > 0 && ins > gate, `gate@${gate} insert@${ins}`);
  // a manager REJECTION is not blocked (saying no needs no W-9)
  assert.ok(key1.indexOf("action: 'rejected'") < gate);
});

// ---------------------------------------------------------------- payment paths
const PAY = (method, ids = ['i-dj']) => ({ community_id: 'c1', vendor_id: 'v-dj', amount_cents: 30000 * ids.length, payment_date: '2026-10-02', payment_method: method, applications: ids.map((id) => ({ invoice_id: id, applied_cents: 30000 })) });
for (const method of ['check', 'ach', 'credit_card', 'wire', 'cash', 'other']) {
  check(`recordPayment (${method}): no-W-9 bill is refused before anything is written`, async () => {
    const db = memDb({ ap_invoices: [INV('i-dj', 'v-dj', { status: 'approved' })], vendors: [DJ_VENDOR] });
    await withDb(db, '../lib/accounting/ap_engine', async ({ recordPayment }) => {
      await assert.rejects(recordPayment(PAY(method)), (e) => e.code === 'w9_required');
    });
    assert.strictEqual(db.writes.length, 0, JSON.stringify(db.writes));
  });
}
check('recordPayment: one blocked bill in a multi-bill payment blocks the whole payment', async () => {
  const db = memDb({ ap_invoices: [INV('i-dj', 'v-dj', { status: 'approved' }), INV('i-ok', 'v-ok', { status: 'approved' })], vendors: [DJ_VENDOR, W9_VENDOR] });
  await withDb(db, '../lib/accounting/ap_engine', async ({ recordPayment }) => {
    await assert.rejects(recordPayment({ ...PAY('check', ['i-ok', 'i-dj']), vendor_id: 'v-ok' }), (e) => e.code === 'w9_required' && e.blocked.length === 1);
  });
  assert.strictEqual(db.writes.length, 0);
});
check('payment paths all route through recordPayment (mark-paid, POST /payments, check run, early prepay)', () => {
  const ap = src('api/ap.js');
  assert.ok(/router\.post\('\/invoices\/:id\/mark-paid'[\s\S]{0,1600}await recordPayment\(/.test(ap));
  assert.ok(/router\.post\('\/payments'[\s\S]{0,200}await recordPayment\(/.test(ap));
  assert.ok(/await recordPayment\(\{ community_id, vendor_id, amount_cents, payment_date, payment_method: 'check'/.test(src('lib/accounting/check_run.js')));
  const eng = src('lib/accounting/ap_engine.js');
  assert.ok(eng.indexOf("assertW9Cleared(supabase, applications.map") < eng.indexOf('payInvoiceEarlyAsPrepaid(supabase, {'), 'gate runs before the early-prepay branch');
});
check('check run: listed with "W-9 required" and not selectable; run creation refused on the server', async () => {
  const db = memDb({ ap_invoices: [
    { ...INV('i-dj', 'v-dj', { status: 'approved' }), vendors: { ...DJ_VENDOR }, ap_invoice_lines: [] },
    { ...INV('i-ok', 'v-ok', { status: 'approved' }), vendors: { ...W9_VENDOR }, ap_invoice_lines: [] },
  ] });
  await withDb(db, '../lib/accounting/check_run', async ({ listPayableInvoices }) => {
    const list = await listPayableInvoices({ community_id: 'c1' });
    const dj = list.find((i) => i.id === 'i-dj'); const ok = list.find((i) => i.id === 'i-ok');
    assert.ok(dj.w9_blocked && /no W-9/.test(dj.w9_reason)); assert.strictEqual(ok.w9_blocked, false);
  });
  const cr = src('lib/accounting/check_run.js');
  assert.ok(cr.indexOf("assertW9Cleared(supabase, valid.map((i) => i.id))") > cr.indexOf("no_payable_invoices_selected"));
  const ui = src('public/accounting.html');
  assert.ok(/i\.w9_blocked \? `<input type="checkbox" disabled/.test(ui) && /W-9 required<\/span>/.test(ui));
});
check('API: every gated route answers 409 with the plain explanation (approve, mark-paid, /payments, check run)', () => {
  const ap = src('api/ap.js');
  assert.strictEqual((ap.match(/if \(err\.code === 'w9_required'\) return res\.status\(409\)\.json\(\{ error: err\.detail, detail: err\.detail/g) || []).length, 3);
  assert.ok(/if \(err\.code === 'w9_required'\) return res\.status\(409\)/.test(src('api/checks.js')));
  assert.ok(/throw new Error\(j\.detail\|\|j\.error\|\|'release failed'\)/.test(src('public/ed.html')), 'Ed\'s release page shows the explanation');
  assert.ok(/need a W-9 on file first/.test(src('public/ed.html')), 'bulk release says how many need a W-9');
});
check('no override exists (none is approved yet): the gate module has no bypass flag', () => {
  const g = src('lib/ap/w9_gate.js');
  assert.ok(!/override|bypass\s*[:=]|force\s*[:=]|skipW9|allowNoW9/i.test(g.replace(/\/\/.*$/gm, '')));
});

// ---------------------------------------------------------------- dry-run vendor parity
check('ensureVendorForInvoice dryRun: an unknown vendor is reported as would_create and NOTHING is inserted', async () => {
  const db = memDb({ vendors: [W9_VENDOR] });
  await withDb(db, '../lib/ap/vendor_master', async ({ ensureVendorForInvoice }) => {
    const r = await ensureVendorForInvoice({ extracted: { vendor_name: 'Happy Hooves Petting Zoo' }, dryRun: true });
    assert.ok(r.would_create && r.would_create.name === 'Happy Hooves Petting Zoo' && r.would_create.w9_on_file === false && r.would_create.auto_pay_ach === false);
    assert.ok(/NEW VENDOR/.test(r.would_create.notes));
  });
  assert.strictEqual(db.writes.length, 0);
});
check('ensureVendorForInvoice dryRun: an existing vendor matches with no remit backfill write', async () => {
  const db = memDb({ vendors: [{ ...DJ_VENDOR, management_company_id: require('../lib/company').BEDROCK_MGMT_CO_ID, is_active: true }] });
  await withDb(db, '../lib/ap/vendor_master', async ({ ensureVendorForInvoice }) => {
    const r = await ensureVendorForInvoice({ extracted: { vendor_name: 'DJ (individual)', remit_address: '1 Main St, Houston, TX 77001' }, dryRun: true });
    assert.strictEqual(r.vendor.id, 'v-dj');
  });
  assert.strictEqual(db.writes.length, 0);
});
check('ensureVendorForInvoice without dryRun still CREATES (intake behavior unchanged)', async () => {
  const db = memDb({ vendors: [] });
  await withDb(db, '../lib/ap/vendor_master', async ({ ensureVendorForInvoice }) => {
    const r = await ensureVendorForInvoice({ extracted: { vendor_name: 'Happy Hooves Petting Zoo' } });
    assert.ok(r.created);
  });
  assert.ok(db.writes.some((w) => w.t === 'vendors' && w.op === 'insert'));
});
check('intake and the dry run share ONE vendor-resolution function', () => {
  const i = src('lib/ap/intake.js');
  assert.ok(/const v = await resolveInvoiceVendor\(\{ extracted, vendorIdHint, directives \}\);/.test(i));
  assert.strictEqual((i.match(/ensureVendorForInvoice\(\{ extracted/g) || []).length, 1, 'only resolveInvoiceVendor calls ensureVendorForInvoice');
  const s = src('scripts/ap_replay_emails.js');
  assert.ok(/resolveInvoiceVendor\(\{ extracted: x, vendorIdHint: m\.resolved_vendor_id \|\| null, directives, dryRun: true \}\)/.test(s));
});
const { predictOutcome } = require('../lib/ap/replay_emails');
const NEW_ZOO = { name: 'Happy Hooves Petting Zoo' };
check('prediction (petting-zoo shape, no printed date): CREATES the vendor, THEN stops as an exception (no payable)', () => {
  const p = predictOutcome({ missing: ['no printed invoice date'], wouldCreateVendor: NEW_ZOO });
  assert.ok(/^CREATES NEW VENDOR "Happy Hooves Petting Zoo" \(w9_on_file=false, no autopay, flagged NEW\), then Payables exception \(no printed invoice date\)$/.test(p), p);
});
check('prediction (DJ shape, dated): CREATES the vendor, then a payable awaiting approval flagged new vendor', () => {
  const p = predictOutcome({ dup: { verdict: 'unique', matches: [] }, wouldCreateVendor: { name: 'DJ (individual)' } });
  assert.ok(/^CREATES NEW VENDOR "DJ \(individual\)".*then payable, awaiting approval, needs review \(new vendor\)$/.test(p), p);
});
check('prediction: the second forward of the same file is blocked as a same-file duplicate of the first in-run payable', () => {
  assert.ok(/^BLOCKED as a duplicate of the payable email 003c522b creates in this run \(same file\)$/.test(predictOutcome({ dup: { verdict: 'unique', matches: [] }, runPayable: '003c522b-e34b' })));
});
check('prediction: the second forward of a dateless file reuses the first in-run exception (and the vendor it created)', () => {
  assert.ok(/reuses the exception email 003c522b creates in this run, no new card/.test(predictOutcome({ missing: ['no printed invoice date'], exceptionReuse: 'the exception email 003c522b creates in this run' })));
  assert.ok(/opts\.runVendors\.has\(key\)/.test(src('scripts/ap_replay_emails.js')), 'in-run vendor reuse');
});

(async () => {
  let pass = 0, fail = 0;
  console.log('W-9 gate + dry-run vendor parity (Issue #14)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + e.message); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
