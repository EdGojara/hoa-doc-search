// ============================================================================
// tests/test_exception_suggested_vendor.js  (Issue #14)
// ----------------------------------------------------------------------------
// Sweetie Pies: intake CREATED the vendor, then the bill stopped as a Payables
// exception (no printed invoice date), but the exception's suggested_vendor_id
// was empty, so a person had to find the vendor by name to promote it. Every
// hold after vendor resolution now carries the vendor it resolved or created,
// and every caller links it. A REUSED exception is never modified (the already
// recovered Sweetie Pies record stays as it is). In-memory fakes only.
// ============================================================================
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const tests = []; const check = (n, fn) => tests.push([n, fn]);
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

function memDb(rows) {
  const writes = [];
  return { writes, from(t) {
    const f = []; let op = null; let payload = null;
    const q = {
      select() { return q; }, eq(c, v) { f.push((r) => r[c] === v); return q; }, is(c, v) { f.push((r) => (r[c] ?? null) === v); return q; },
      insert(p) { op = 'insert'; payload = { id: `E${rows.length + 1}`, ...p }; rows.push(payload); writes.push({ t, op, payload }); return q; },
      update(p) { op = 'update'; writes.push({ t, op, payload: p }); return q; },
      limit() { return Promise.resolve({ data: rows.filter((r) => f.every((p) => p(r))), error: null }); },
      single() { return Promise.resolve({ data: payload, error: null }); },
    };
    return q;
  } };
}
function withDb(db, modPath, fn) {
  const sbPath = require.resolve('@supabase/supabase-js'); const mp = require.resolve(modPath);
  const saved = [require.cache[sbPath], require.cache[mp]];
  require.cache[sbPath] = { id: sbPath, filename: sbPath, loaded: true, exports: { createClient: () => db } };
  delete require.cache[mp];
  return Promise.resolve().then(() => fn(require(modPath))).finally(() => {
    if (saved[0]) require.cache[sbPath] = saved[0]; else delete require.cache[sbPath];
    if (saved[1]) require.cache[mp] = saved[1]; else delete require.cache[mp];
  });
}

check('new-vendor exception: recordException stores the suggested vendor', async () => {
  const rows = []; const db = memDb(rows);
  await withDb(db, '../lib/ap/intake_exceptions', async ({ recordException }) => {
    const r = await recordException({ emailMessageId: 'm917', sourceRef: 'email:g917', reason: 'no invoice date', sha256: 'zoo', communityId: 'WV', suggestedVendorId: 'v-zoo' });
    assert.ok(r.ok);
  });
  assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].suggested_vendor_id, 'v-zoo');
});
check('reused exception: returned as-is and NOT modified (no backfill of an existing record)', async () => {
  const rows = [{ id: 'E-old', intake_source_ref: 'email:g917', file_sha256: 'zoo', community_id: 'WV', status: 'pending', suggested_vendor_id: null }];
  const db = memDb(rows);
  await withDb(db, '../lib/ap/intake_exceptions', async ({ recordException }) => {
    const r = await recordException({ emailMessageId: 'm921', sourceRef: 'email:g921', reason: 'no invoice date', sha256: 'zoo', communityId: 'WV', suggestedVendorId: 'v-zoo' });
    assert.strictEqual(r.id, 'E-old'); assert.ok(r.existing);
  });
  assert.strictEqual(db.writes.length, 0, 'no insert, no update');
  assert.strictEqual(rows[0].suggested_vendor_id, null, 'the existing record is untouched');
});
check('shared intake path passes the created vendor to the exception', async () => {
  const { intakeBillEmail } = require('../lib/ap/email_bill_intake');
  const calls = [];
  const db = { from() { const q = { select() { return q; }, eq() { return q; }, update() { return q; }, then(res) { return Promise.resolve({ data: null, error: null }).then(res); } }; return q; } };
  await intakeBillEmail({ id: 'm917', graph_id: 'g917', mailbox: 'emma@x', subject: 'petting zoo inv', body_full: 'please process', community_id: 'WV', extracted: {} },
    { atts: [{ name: 'zoo.pdf', contentType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') }] }, {
      supabase: db,
      autoIntake: async () => ({ outcome: 'needs_review', reason: 'no invoice date', extracted: { total_cents: 62500 }, storage_path: 's', sha256: 'zoo', suggested_vendor_id: 'v-zoo' }),
      recordException: async (a) => { calls.push(a); return { ok: true, id: 'E1' }; },
      fetchBillAttachments: async () => [],
    });
  assert.strictEqual(calls.length, 1, 'the exception was recorded from the reader result');
  assert.strictEqual(calls[0].suggestedVendorId, 'v-zoo');
});
check('autoIntake: every hold after vendor resolution carries suggested_vendor_id', () => {
  const s = src('lib/ap/intake.js');
  assert.ok(/const suggested_vendor_id = \(v\.vendor && v\.vendor\.id\) \|\| null;/.test(s));
  const after = s.slice(s.indexOf('const suggested_vendor_id ='), s.indexOf('module.exports'));
  const holds = after.split('\n').filter((l) => /return \{.*outcome: 'needs_review'/.test(l));
  assert.ok(holds.length >= 3, `holds found: ${holds.length}`);
  for (const h of holds) assert.ok(/suggested_vendor_id/.test(h), h.slice(0, 120));
  assert.ok(/return \{ \.\.\.commit, extracted, storage_path: storagePath, sha256, suggested_vendor_id \}/.test(s), 'the commit passthrough (no total / no date) carries it');
});
check('every recordException caller of an intake result passes the vendor', () => {
  assert.ok(/suggestedVendorId: \(o && o\.suggested_vendor_id\) \|\| null/.test(src('lib/email/graph_ingest.js')));
  assert.ok(/suggestedVendorId: \(o && o\.suggested_vendor_id\) \|\| null/.test(src('lib/ap/email_bill_intake.js')));
  assert.ok(/suggestedVendorId: out\.suggested_vendor_id \|\| null/.test(src('api/email_triage.js')));
  assert.ok(/suggestedVendorId: result\.suggested_vendor_id \|\| null/.test(src('api/ap.js')));
});

(async () => {
  let pass = 0, fail = 0;
  console.log('Exception links the vendor intake resolved or created (Issue #14)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + e.message); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
