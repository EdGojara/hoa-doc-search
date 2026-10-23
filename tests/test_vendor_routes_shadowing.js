'use strict';
// ============================================================================
// tests/test_vendor_routes_shadowing.js  (Ed 2026-10-20) — "Couldn't load RFPs: Vendor not found"
// ----------------------------------------------------------------------------
// GET /api/vendors/:vendorId (2026-05-09) was registered before GET /rfps (2026-06-03),
// /benchmarks and /spend, so Express answered "/api/vendors/rfps" as the vendor with id
// "rfps": 404 "Vendor not found". The RFP panel, the RFP benchmark lookup and the Vendor
// Spend report were all affected. Runs the REAL router (Supabase faked) and pins: those
// routes reach their own handlers; a uuid still reaches vendor detail / update.
//   node tests/test_vendor_routes_shadowing.js
// ============================================================================
const assert = require('node:assert/strict');
const http = require('http');
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY']) process.env[k] = process.env[k] || (k === 'SUPABASE_URL' ? 'http://localhost:1' : 'test-key');
let pass = 0, fail = 0; const pending = [];
const check = (name, fn) => pending.push(async () => { try { await fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '\n     ', e.message); } });
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const VENDOR = { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', name: 'iTech Monitoring, Inc.' };
const tablesRead = [];
function query(table) {
  const st = { single: false, filters: {} };
  const q = new Proxy({}, { get(_, k) {
    if (k === 'then') return (res, rej) => { tablesRead.push(table);
      let data = [];
      if (table === 'vendors') data = st.filters.id === VENDOR.id ? [VENDOR] : [];
      if (table === 'bid_requests') data = [{ id: '9857e2cc-766b-450a-815a-c574e7572643', title: 'Security Camera System 2026', status: 'evaluating' }];
      return Promise.resolve({ data: st.single ? data[0] || null : data, error: st.single && !data[0] ? { message: 'no rows' } : null, count: data.length }).then(res, rej); };
    if (k === 'single' || k === 'maybeSingle') return () => { st.single = true; return q; };
    if (k === 'eq') return (c, v) => { st.filters[c] = v; return q; };
    return () => q;
  } });
  return q;
}
const realSB = require('@supabase/supabase-js');
stub('@supabase/supabase-js', { ...realSB, createClient: () => ({ from: (t) => query(t), storage: { from: () => ({ download: async () => ({ data: null, error: { message: 'x' } }) }) }, rpc: () => query('rpc') }) });

const express = require('express');
const app = express(); app.use('/api/vendors', require('../api/vendors').router);
let base;
const get = async (p) => { const r = await fetch(base + p); let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, j }; };

console.log('Vendor routes are not shadowed by /:vendorId');
check('GET /api/vendors/rfps reaches the RFP list (not "Vendor not found")', async () => {
  tablesRead.length = 0;
  const r = await get('/api/vendors/rfps');
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.ok(Array.isArray(r.j.rfps)); assert.equal(r.j.rfps[0].status, 'evaluating');
  assert.ok(tablesRead.includes('bid_requests') && !tablesRead.includes('vendors'));
});
check('GET /api/vendors/benchmarks and /spend reach their own handlers, never the vendor lookup', async () => {
  for (const p of ['/api/vendors/benchmarks?service_category=security', '/api/vendors/spend?year=2026']) {
    tablesRead.length = 0;
    const r = await get(p);
    assert.notEqual(r.j && r.j.error, 'Vendor not found', p);
    assert.ok(!tablesRead.includes('vendors') || p.includes('spend'), `${p} read ${tablesRead.join(',')}`);
  }
});
check('GET /api/vendors/<uuid> still returns vendor detail; an unknown uuid is still "Vendor not found"', async () => {
  const ok = await get(`/api/vendors/${VENDOR.id}`);
  assert.equal(ok.status, 200, JSON.stringify(ok.j));
  const missing = await get('/api/vendors/00000000-0000-4000-8000-000000000000');
  assert.equal(missing.status, 404); assert.equal(missing.j.error, 'Vendor not found');
});
check('a non-uuid segment that is no route falls through to a plain 404, not a vendor lookup', async () => {
  tablesRead.length = 0;
  const r = await get('/api/vendors/not-a-route');
  assert.equal(r.status, 404); assert.ok(!tablesRead.includes('vendors'));
});

(async () => {
  const server = http.createServer(app); await new Promise((r) => server.listen(0, r)); base = 'http://127.0.0.1:' + server.address().port;
  for (const t of pending) await t();
  server.closeAllConnections(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
})();
