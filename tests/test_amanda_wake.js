// tests/test_amanda_wake.js  (Issue #29 W1) — Amanda-only wake poll.
// Part A: the wake timer logic (injected ingest). Part B: the REAL ingestMailbox with Graph,
// Supabase, the classifier and the mail mover stubbed, proving: empty poll = 0 model calls,
// the already-processed lookup fails closed, the wake path never files backlog, and the
// per-mailbox single flight. Nothing touches a network or production.
const assert = require('assert');
const path = require('path');

// Dummy keys: transitive modules build clients at load time. Network is never reached (fetch is stubbed).
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY']) process.env[k] = process.env[k] || (k === 'SUPABASE_URL' ? 'http://localhost:1' : 'test-key');
const tests = []; const check = (n, fn) => tests.push([n, fn]);
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// ---- stubs for Part B (installed before graph_ingest loads) ----
const calls = { classify: 0, fileMessage: 0, graphFetch: 0, otherTables: [] };
let seenResult = { data: [], error: null };
stub('@supabase/supabase-js', { createClient: () => ({ from(t) {
  const q = { select() { return q; }, in() { return Promise.resolve(t === 'email_messages' ? seenResult : { data: [], error: null }); },
    eq() { return q; }, insert() { calls.otherTables.push(t); return Promise.resolve({ error: null }); }, update() { calls.otherTables.push(t); return q; },
    delete() { calls.otherTables.push(t); return q; }, then(r) { return Promise.resolve({ data: [], error: null }).then(r); } };
  return q;
} }) });
stub('../lib/email/graph_send', { getToken: async () => 'token', isConfigured: () => true, AMANDA_MAILBOX: 'amandaalbright@bedrocktx.com', TEAM_INGEST_MAILBOXES: [] });
stub('../lib/email/triage', { classifyAndExtract: async () => { calls.classify += 1; return {}; }, resolveEntities: async () => ({}) });
stub('../lib/email/graph_move', { getInboxId: async () => 'INBOX', fileMessage: async () => { calls.fileMessage += 1; return { moved: true }; } });

const PAGE = [1, 2, 3].map((i) => ({ id: `g${i}`, internetMessageId: `<m${i}@x>`, parentFolderId: 'INBOX', receivedDateTime: '2026-10-04T19:00:00Z' }));
let fetchGate = null;
global.fetch = async () => { calls.graphFetch += 1; if (fetchGate) await fetchGate; return { ok: true, json: async () => ({ value: PAGE }) }; };
const allSeen = () => ({ data: PAGE.map((m) => ({ internet_message_id: m.internetMessageId, extracted: {} })), error: null });

const { ingestMailbox } = require('../lib/email/graph_ingest');
const { createAmandaWake, windowStart, startAmandaWake, enabled, intervalMs } = require('../lib/email/amanda_wake');
const reset = () => Object.assign(calls, { classify: 0, fileMessage: 0, graphFetch: 0, otherTables: [] });

// ---- Part A: wake logic ----
function fakeSb() { const rows = []; return { rows, from(t) { return { insert: async (r) => { rows.push({ t, ...r }); return { error: null }; } }; } }; }
const quietLog = { log() {}, warn() {}, error() {}, lines: [] };

check('OFF by default: no env -> not enabled, no timer; AMANDA_WAKE=on enables; interval defaults 60s, floor 30s', () => {
  const saved = { w: process.env.AMANDA_WAKE, i: process.env.AMANDA_WAKE_INTERVAL_SEC };
  try {
    delete process.env.AMANDA_WAKE; delete process.env.AMANDA_WAKE_INTERVAL_SEC;
    assert.strictEqual(enabled(), false); assert.strictEqual(startAmandaWake(), null);
    process.env.AMANDA_WAKE = 'on'; assert.strictEqual(enabled(), true);
    assert.strictEqual(intervalMs(), 60000); process.env.AMANDA_WAKE_INTERVAL_SEC = '5'; assert.strictEqual(intervalMs(), 30000);
  } finally {
    if (saved.w === undefined) delete process.env.AMANDA_WAKE; else process.env.AMANDA_WAKE = saved.w;
    if (saved.i === undefined) delete process.env.AMANDA_WAKE_INTERVAL_SEC; else process.env.AMANDA_WAKE_INTERVAL_SEC = saved.i;
  }
});

check('polls ONLY the Amanda mailbox identity, never the alias, with wake-safe options', async () => {
  const seen = []; const sb = fakeSb();
  const w = createAmandaWake({ ingestMailbox: async (mbx, o) => { seen.push([mbx, o]); return { scanned: 2, kept: 0, skipped: 2 }; }, isConfigured: () => true, supabase: sb, log: quietLog });
  await w.tick();
  assert.strictEqual(seen.length, 1); assert.strictEqual(seen[0][0], 'amandaalbright@bedrocktx.com');
  const o = seen[0][1];
  assert.strictEqual(o.fileBacklog, false, 'never files backlog'); assert.strictEqual(o.skipIfBusy, true); assert.strictEqual(o.max, 50); assert.strictEqual(o.light, false);
  assert.strictEqual(sb.rows.length, 0, 'an empty poll leaves no cron_runs row');
});

check('bounded overlapping lookback: first poll 30 min back; then 2 min behind the last good poll; never more than 30 min', () => {
  const T = Date.parse('2026-10-04T20:00:00Z');
  assert.strictEqual(windowStart(null, T), '2026-10-04T19:30:00.000Z');
  assert.strictEqual(windowStart(T - 60000, T), '2026-10-04T19:57:00.000Z');
  assert.strictEqual(windowStart(T - 3 * 3600e3, T), '2026-10-04T19:30:00.000Z');
});

check('new mail records amanda_wake in cron_runs; errors record ok:false and do not advance the window; busy records nothing', async () => {
  let t = Date.parse('2026-10-04T20:00:00Z'); const sb = fakeSb(); let next = { scanned: 1, kept: 1, skipped: 0 };
  const w = createAmandaWake({ ingestMailbox: async () => { if (next instanceof Error) throw next; return next; }, isConfigured: () => true, supabase: sb, now: () => t, log: quietLog });
  await w.tick();
  assert.strictEqual(sb.rows.length, 1); assert.strictEqual(sb.rows[0].job_name, 'amanda_wake'); assert.strictEqual(sb.rows[0].triggered_by, 'amanda_wake');
  assert.strictEqual(sb.rows[0].ok, true); assert.strictEqual(sb.rows[0].summary.kept, 1); assert.strictEqual(sb.rows[0].summary.mailbox, 'amandaalbright@bedrocktx.com');
  const okAt = w.state.lastOkAt; assert.strictEqual(okAt, t);
  t += 60000; next = new Error('dedupe_lookup_failed: boom'); await w.tick();
  assert.strictEqual(sb.rows.length, 2); assert.strictEqual(sb.rows[1].ok, false); assert.match(sb.rows[1].error, /dedupe_lookup_failed/);
  assert.strictEqual(w.state.lastOkAt, okAt, 'a failed poll does not move the window forward');
  t += 60000; next = { busy: true, scanned: 0, kept: 0 }; await w.tick();
  assert.strictEqual(sb.rows.length, 2, 'busy (Pull inbox running) records nothing'); assert.strictEqual(w.state.lastOkAt, okAt);
});

check('a tick never overlaps itself; Graph not configured does nothing', async () => {
  let release; const gate = new Promise((r) => { release = r; }); let n = 0;
  const w = createAmandaWake({ ingestMailbox: async () => { n += 1; await gate; return { kept: 0 }; }, isConfigured: () => true, supabase: fakeSb(), log: quietLog });
  const a = w.tick(); const b = await w.tick();
  assert.deepStrictEqual(b, { skipped: 'running' }); release(); await a; assert.strictEqual(n, 1);
  const off = createAmandaWake({ ingestMailbox: async () => { throw new Error('should not run'); }, isConfigured: () => false, supabase: fakeSb(), log: quietLog });
  assert.deepStrictEqual(await off.tick(), { skipped: 'graph_not_configured' });
});

check('hourly heartbeat line, quiet otherwise', async () => {
  let t = 0; const lines = []; const log = { log: (s) => lines.push(s), warn() {}, error() {} };
  const w = createAmandaWake({ ingestMailbox: async () => ({ kept: 0 }), isConfigured: () => true, supabase: fakeSb(), now: () => t, log });
  for (let i = 0; i < 59; i++) { t += 60000; await w.tick(); }
  assert.strictEqual(lines.length, 0, 'no per-minute log noise');
  t += 60000; await w.tick();
  assert.strictEqual(lines.length, 1); assert.match(lines[0], /heartbeat: 60 polls, 60 empty, 0 ingested/);
});

// ---- Part B: the real ingestMailbox ----
check('EMPTY POLL through the real ingest: all mail already processed -> 0 model calls, 0 writes, and the wake path files no backlog', async () => {
  reset(); seenResult = allSeen();
  const s = await ingestMailbox('amandaalbright@bedrocktx.com', { sinceISO: '2026-10-04T19:30:00Z', max: 50, fileBacklog: false, skipIfBusy: true });
  assert.strictEqual(s.kept, 0); assert.strictEqual(s.skipped, 3);
  assert.strictEqual(calls.classify, 0, 'no model call on an empty poll'); assert.strictEqual(calls.fileMessage, 0, 'no backlog filing from the wake path');
  assert.deepStrictEqual(calls.otherTables, []);
  reset(); seenResult = allSeen();
  await ingestMailbox('amandaalbright@bedrocktx.com', { sinceISO: '2026-10-04T19:30:00Z', max: 50 });
  assert.strictEqual(calls.fileMessage, 3, 'Pull inbox keeps its backlog housekeeping'); assert.strictEqual(calls.classify, 0);
});

check('FAIL CLOSED: the already-processed lookup errors -> the run aborts with 0 model calls and 0 downstream processing', async () => {
  reset(); seenResult = { data: null, error: { message: 'canceling statement due to statement timeout' } };
  await assert.rejects(() => ingestMailbox('amandaalbright@bedrocktx.com', { sinceISO: '2026-10-04T19:30:00Z', max: 50, fileBacklog: false }), (e) => e.code === 'dedupe_lookup_failed');
  assert.strictEqual(calls.classify, 0); assert.strictEqual(calls.fileMessage, 0); assert.deepStrictEqual(calls.otherTables, []);
  seenResult = allSeen();
});

check('SINGLE FLIGHT per mailbox: the wake skips while Pull inbox ingests; a second Pull waits its turn; other mailboxes are not blocked', async () => {
  reset(); seenResult = allSeen();
  let release; fetchGate = new Promise((r) => { release = r; });
  const pull = ingestMailbox('AmandaAlbright@bedrocktx.com', { sinceISO: 'x', max: 50 });
  await new Promise((r) => setImmediate(r));
  const wake = await ingestMailbox('amandaalbright@bedrocktx.com', { sinceISO: 'x', max: 50, skipIfBusy: true });
  assert.strictEqual(wake.busy, true, 'the wake tick skips instead of racing the pull');
  const fetchesBefore = calls.graphFetch;
  const pull2 = ingestMailbox('amandaalbright@bedrocktx.com', { sinceISO: 'x', max: 50 });
  const other = ingestMailbox('claire@bedrocktx.com', { sinceISO: 'x', max: 50 });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls.graphFetch, fetchesBefore + 1, 'only the other mailbox started; the second Amanda pull is queued');
  release(); fetchGate = null;
  await Promise.all([pull, pull2, other]);
  assert.strictEqual(calls.graphFetch, fetchesBefore + 2, 'the queued pull ran after the first finished');
  const after = await ingestMailbox('amandaalbright@bedrocktx.com', { sinceISO: 'x', max: 50, skipIfBusy: true });
  assert.ok(!after.busy, 'lock released after the runs');
});

check('wiring: server starts the wake after listen; the wake never sends and is not on any other mailbox', () => {
  const fs = require('fs');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /require\('\.\/lib\/email\/amanda_wake'\)\.startAmandaWake\(\)/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'amanda_wake.js'), 'utf8');
  assert.ok(!/graph_send'\)\.send|sendMail|sendEmail|resend/i.test(src), 'no send path');
  assert.ok(!/TEAM_INGEST_MAILBOXES|CLAIRE_MAILBOX|EMMA_MAILBOX/.test(src), 'Amanda only');
  assert.ok(!/EMAIL_INGEST_AUTO/.test(src.replace(/\/\/.*$/gm, '')), 'independent of portfolio auto-ingest');
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests.filter(([n]) => !process.env.ONLY || n.includes(process.env.ONLY))) {
    try { await fn(); pass += 1; console.log('  ✓ ' + n); }
    catch (e) { fail += 1; console.log('  ✗ ' + n + '\n    ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n    ')); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
