// ============================================================================
// tests/test_replay_vendor_parity.js  (Issue #14)
// ----------------------------------------------------------------------------
// The DJ replay was predicted to stop at an exception, but intake CREATED the
// vendor (its standing rule: an AP clerk sets the vendor up from the invoice).
// The dry run now calls intake's own vendor step (resolveInvoiceVendor) in a
// no-write mode and reports "CREATES NEW VENDOR" plus in-run reuse. Kept
// separate from W-9 tax policy. In-memory fakes only.
// ============================================================================
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
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
  console.log('Replay dry-run vendor parity (Issue #14)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + e.message); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
