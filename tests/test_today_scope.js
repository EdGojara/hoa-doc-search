#!/usr/bin/env node
// ============================================================================
// tests/test_today_scope.js  (Issue #6 re-review, 2026-09-29)
// ----------------------------------------------------------------------------
// Drives the real GET /api/today handler with a stubbed Supabase:
//   - a supplied but malformed community_id → 400 (never a silent widening);
//   - no community_id → 200 portfolio view;
//   - a valid community_id → 200 with inbox, calls and imports all scoped.
// Offline and deterministic.
// ============================================================================
require('./_support/no_prod_network'); // unit test: loopback only, no production keys (Issue #27 follow-up)
const Module = require('module');
const calls = [];
const chain = () => { const q = { select: () => q, in: () => q, gte: () => q, order: () => q, limit: () => q, not: () => q, eq: (c, v) => { calls.push([c, v]); return q; }, then: (r) => Promise.resolve({ data: [], error: null }).then(r) }; return q; };
const orig = Module._load;
Module._load = function (req, ...rest) {
  if (req === '@supabase/supabase-js') return { createClient: () => ({ from: () => chain() }) };
  if (req.endsWith('demo/demo_guard')) return { demoCommunityIds: async () => [] };
  return orig.call(this, req, ...rest);
};
process.env.SUPABASE_URL = 'http://x'; process.env.SUPABASE_KEY = 'x';
const router = require('../api/today.js');
const handler = router.stack.find((l) => l.route && l.route.path === '/').route.stack[0].handle;
const run = (q) => new Promise((resolve) => { const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, body: b }); } }; handler({ query: q }, res); });
(async () => {
  const bad = await run({ community_id: 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz' });
  const none = await run({});
  calls.length = 0;
  const good = await run({ community_id: '11111111-2222-4333-8444-555555555555' });
  const scopedEq = calls.filter(([c]) => c === 'community_id').length;
  console.log('test_today_scope: bad', bad.code, bad.body.error, '| none', none.code, '| good', good.code, 'community_id eq filters:', scopedEq);
  if (bad.code !== 400 || none.code !== 200 || good.code !== 200 || scopedEq !== 3) process.exit(1);
})();
