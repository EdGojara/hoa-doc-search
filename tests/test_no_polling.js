// tests/test_no_polling.js — activity-driven, not polling (Ed 2026-11-01).
//   * the scheduler, with EVERY job enabled, registers neither the manual-only email job (unless
//     auto-ingest is on) nor a stale-inspection timer; legitimate business jobs remain;
//   * no Claire timer; an idle visit is expired when it is next touched; speak and handoff refuse a
//     session that is not active; a new visit closes out abandoned ones; the live socket closing ends
//     its log row;
//   * abandoned drives close when the Active Drives list is read, with the same rule as before.
const assert = require('assert');
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) process.env[k] = process.env[k] || 'test-key';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const code = (f) => read(f).replace(/^\s*\/\/.*$/gm, '');
const tests = []; const check = (n, fn) => tests.push([n, fn]);

function jobsWith(env) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const realSetInterval = global.setInterval; const realSetTimeout = global.setTimeout;
  global.setInterval = () => ({ unref() {} }); global.setTimeout = () => ({ unref() {} });
  try {
    delete require.cache[require.resolve('../lib/scheduler')];
    const s = require('../lib/scheduler').startScheduler({ logger: { log() {}, warn() {}, error() {} } });
    return (s && s.jobs || []).map((j) => j.name);
  } finally {
    global.setInterval = realSetInterval; global.setTimeout = realSetTimeout;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const BASE = { SUPABASE_URL: 'http://localhost:1', SUPABASE_KEY: 'test', SCHEDULER_DISABLED: undefined, SCHEDULER_ENABLED: 'all' };

check('with every job enabled, no manual-only email job and no stale-inspection timer is registered', () => {
  const jobs = jobsWith({ ...BASE, EMAIL_INGEST_AUTO: undefined });
  assert.ok(jobs.length > 5, 'scheduler started: ' + jobs.join(','));
  assert.ok(!jobs.includes('email_ingest_incremental'), 'email_ingest_incremental registered');
  assert.ok(!jobs.includes('stale_inspection_close'), 'stale_inspection_close registered');
  for (const keep of ['positive_pay_watch', 'inspection_closeout_flag', 'inspection_closeout_reminder', 'cure_lapse', 'kat_monthly_accounting']) assert.ok(jobs.includes(keep), keep + ' must remain');
});

check('auto-ingest, when someone turns it on, still registers the email job (no behavior lost)', () => {
  assert.ok(jobsWith({ ...BASE, EMAIL_INGEST_AUTO: 'true' }).includes('email_ingest_incremental'));
});

check('Claire: no timer; idle expiry happens on access; speak and handoff refuse an inactive session', () => {
  assert.ok(!/setInterval\([^)]*expireIdleSessions/.test(code('server.js')), 'the 2-minute sweep is back');
  const c = read('api/claire.js');
  const load = c.slice(c.indexOf('async function loadOwnedSession'), c.indexOf('async function nextSeq'));
  assert.ok(/IDLE_EXPIRE_SECONDS \* 1000/.test(load) && /status: 'expired'/.test(load) && /s\.status = 'expired'/.test(load), 'loadOwnedSession must expire an idle visit');
  for (const route of ["'/session/:id/speak'", "'/session/:id/handoff'"]) {
    const body = c.slice(c.indexOf(route), c.indexOf('router.post(', c.indexOf(route) + 10));
    assert.ok(/ctx\.session\.status !== 'active'\) return res\.status\(409\)/.test(body), route + ' must refuse an inactive session');
  }
  const start = c.slice(c.indexOf("'/session/start'"), c.indexOf('router.post(', c.indexOf("'/session/start'") + 10));
  assert.ok(/expireIdleSessions\(\)/.test(start), 'a new visit closes out abandoned ones');
  const live = read('lib/voice/claire_live_ws.js');
  assert.ok(/ws\.on\('close', \(\) => \{ session\.close\(\); endLog\('socket_closed'\); \}\)/.test(live), 'the live call ends its log row when the socket closes');
});

check('inspections: abandoned drives close when Active Drives is read, with the same 4-hour rule', () => {
  const a = read('api/inspections.js');
  const route = a.slice(a.indexOf("router.get('/inspections/active'"), a.indexOf('router.', a.indexOf("router.get('/inspections/active'") + 10));
  assert.ok(/closeStaleInspections\(supabase\)/.test(route));
  const lib = code('lib/inspections/stale_close.js');
  assert.ok(/INSPECTION_STALE_HOURS \|\| 4/.test(lib) && /\.eq\('status', 'in_progress'\)/.test(lib) && /status: 'captured'/.test(lib));
  assert.ok(!/setInterval|setTimeout/.test(lib));
});

check('a real stale close-out: closes only drives with no ping past the limit, never a live one', async () => {
  const { closeStaleInspections } = require('../lib/inspections/stale_close');
  const updated = []; let orFilter = null;
  const q = { select() { return q; }, eq() { return q; }, or(f) { orFilter = f; return q; }, limit: async () => ({ data: [{ id: 'old', started_at: '2026-10-31T08:00:00Z', last_ping_at: '2026-10-31T09:00:00Z' }], error: null }) };
  const sb = { from() { return { select: q.select, eq: q.eq, or: q.or, limit: q.limit, update(p) { const u = { eq(k, v) { if (k === 'id') updated.push([v, p]); return u; } }; return u; } }; } };
  const out = await closeStaleInspections(sb, { staleHours: 4, log: { warn() {} } });
  assert.deepStrictEqual(out.closed, 1);
  assert.ok(/last_ping_at\.lt\./.test(orFilter), 'only drives whose last ping is older than the limit');
  assert.strictEqual(updated[0][1].ended_at, '2026-10-31T09:00:00Z');
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n    ' + e.message); } }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
