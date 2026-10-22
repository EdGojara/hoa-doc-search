// tests/test_graph_push.js  (Issue #29) — TrustEd Push Email: Graph change notifications wake a
// mailbox's existing pipeline. Covers the registry, the webhook (handshake, clientState, 202
// before work), coalescing, subscription lifecycle (create / renew / recreate / dedupe / restart /
// retry / lifecycle events), low-frequency recovery, the retained graph_ingest hardening (fail
// closed, same-mailbox single flight, no backlog filing), and one integration crossing push ->
// the real ingestMailbox. Graph, Supabase and the classifier are stubbed; no network, no production.
const assert = require('assert');
const path = require('path');
const fs = require('fs');

for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY']) process.env[k] = process.env[k] || (k === 'SUPABASE_URL' ? 'http://localhost:1' : 'test-key');
const tests = []; const check = (n, fn) => tests.push([n, fn]);
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// ---- stubs for the real graph_ingest (installed before it loads) ----
const calls = { classify: 0, fileMessage: 0, graphFetch: 0, graphUrls: [], otherTables: [] };
let seenResult = { data: [], error: null };
stub('@supabase/supabase-js', { createClient: () => ({ from(t) {
  const q = { select() { return q; }, in() { return Promise.resolve(t === 'email_messages' ? seenResult : { data: [], error: null }); },
    eq() { return q; }, insert() { calls.otherTables.push(t); return Promise.resolve({ error: null }); }, update() { calls.otherTables.push(t); return q; },
    delete() { calls.otherTables.push(t); return q; }, then(r) { return Promise.resolve({ data: [], error: null }).then(r); } };
  return q;
} }) });
const MAILBOXES = ['info@bedrocktx.com', 'claire@bedrocktx.com', 'emma@bedrocktx.com', 'amandaalbright@bedrocktx.com', 'paige@bedrocktx.com', 'phoebe@bedrocktx.com'];
stub('../lib/email/graph_send', { getToken: async () => 'token', isConfigured: () => true, AMANDA_MAILBOX: 'amandaalbright@bedrocktx.com', TEAM_INGEST_MAILBOXES: MAILBOXES });
stub('../lib/email/triage', { classifyAndExtract: async () => { calls.classify += 1; return {}; }, resolveEntities: async () => ({}) });
stub('../lib/email/graph_move', { getInboxId: async () => 'INBOX', fileMessage: async () => { calls.fileMessage += 1; return { moved: true }; } });
const PAGE = [1, 2, 3].map((i) => ({ id: `g${i}`, internetMessageId: `<m${i}@x>`, parentFolderId: 'INBOX', receivedDateTime: '2026-10-04T19:00:00Z' }));
let fetchGate = null;
global.fetch = async (url) => { calls.graphFetch += 1; calls.graphUrls.push(String(url)); if (fetchGate) await fetchGate; return { ok: true, json: async () => ({ value: PAGE }) }; };
const allSeen = () => ({ data: PAGE.map((m) => ({ internet_message_id: m.internetMessageId, extracted: {} })), error: null });
const reset = () => Object.assign(calls, { classify: 0, fileMessage: 0, graphFetch: 0, graphUrls: [], otherTables: [] });

const { ingestMailbox } = require('../lib/email/graph_ingest');
const GP = require('../lib/email/graph_push');
const { createGraphPush, resolveRegistry, keyFor, clientStateFor, staleReason } = GP;
const router = require('../api/graph_push');

const SECRET = 'x'.repeat(48);
const AMANDA = 'amandaalbright@bedrocktx.com';
const quiet = { log() {}, warn() {}, error() {} };
const tick = () => new Promise((r) => setImmediate(r));
function fakeSb() { const rows = []; return { rows, from() { return { insert: async (r) => { rows.push(r); return { error: null }; } }; } }; }
function fakeGraph(seed = []) {
  const g = { subs: seed.map((s) => ({ ...s })), created: [], renewed: [], removed: [], failCreate: 0, renew404: false, lists: 0,
    async list() { g.lists += 1; return g.subs.map((s) => ({ ...s })); },
    async create(body) { if (g.failCreate > 0) { g.failCreate -= 1; const e = new Error('Subscription validation request failed'); e.status = 400; throw e; } const s = { id: `sub${g.subs.length + g.created.length + 1}`, ...body }; g.subs.push(s); g.created.push(body); return { ...s }; },
    async renew(id, exp) { if (g.renew404) { const e = new Error('not found'); e.status = 404; g.subs = g.subs.filter((s) => s.id !== id); throw e; } g.renewed.push(id); const s = g.subs.find((x) => x.id === id); s.expirationDateTime = exp; return { ...s }; },
    async remove(id) { g.removed.push(id); g.subs = g.subs.filter((s) => s.id !== id); },
  };
  return g;
}
function push(over = {}) {
  const ing = { calls: [], gate: null };
  const sb = fakeSb(); const timers = [];
  const p = createGraphPush({ mailboxes: [AMANDA], secret: SECRET, baseUrl: 'https://app.bedrocktxai.com', log: quiet, supabase: sb,
    setTimeout: (fn, ms) => timers.push({ fn, ms }), now: () => Date.parse('2026-10-04T20:00:00Z'), recoveryMs: 6 * 3600e3,
    ingestMailbox: async (mbx, o) => { ing.calls.push([mbx, o]); if (ing.gate) await ing.gate; return { scanned: 1, kept: 0, skipped: 1 }; }, ...over });
  return { p, ing, sb, timers };
}
const note = (cs, extra = {}) => ({ value: [{ subscriptionId: 'sub1', changeType: 'created', clientState: cs, resource: 'Users/guid/Messages/abc', ...extra }] });
const goodCs = clientStateFor(SECRET, AMANDA);
const KEY = keyFor(AMANDA, SECRET);
const NOTIFY = `https://app.bedrocktxai.com/api/graph/mail/notify/${KEY}`;
const LIFE = `https://app.bedrocktxai.com/api/graph/mail/lifecycle/${KEY}`;
const RES = "users/amandaalbright@bedrocktx.com/mailFolders('inbox')/messages";
// A subscription exactly as we would have created it (what Graph returns for a current one).
const ourSub = (id, exp, over = {}) => ({ id, notificationUrl: NOTIFY, lifecycleNotificationUrl: LIFE, resource: RES, changeType: 'created', clientState: goodCs, expirationDateTime: exp, ...over });
function fakeRes() { const r = { code: null, type_: null, body: undefined, ended: false, status(c) { r.code = c; return r; }, type(t) { r.type_ = t; return r; }, send(b) { r.body = b; r.ended = true; return r; }, end() { r.ended = true; return r; } }; return r; }

// ---- registry ----
check('REGISTRY: alias resolves to the mailbox identity; several friendly addresses subscribe once; unknown or excluded addresses are refused', () => {
  const r = resolveRegistry('amanda@bedrocktx.com, AmandaAlbright@bedrocktx.com, info@bedrocktx.com, tessa@bedrocktx.com, amanda.fake@bedrocktx.com, ');
  assert.deepStrictEqual(r.mailboxes, [AMANDA, 'info@bedrocktx.com']);
  assert.deepStrictEqual(r.refused, ['tessa@bedrocktx.com', 'amanda.fake@bedrocktx.com']);
  assert.deepStrictEqual(resolveRegistry('').mailboxes, []);
});

check('PER-MAILBOX identity: Inbox-only created subscription on the identity, hashed callback key, HMAC clientState that differs per mailbox', () => {
  const p = createGraphPush({ mailboxes: [AMANDA, 'info@bedrocktx.com'], secret: SECRET, baseUrl: 'https://app.bedrocktxai.com', log: quiet, supabase: fakeSb() });
  const [a, i] = p.entries();
  assert.strictEqual(a.resource, "users/amandaalbright@bedrocktx.com/mailFolders('inbox')/messages");
  assert.strictEqual(a.notificationUrl, `https://app.bedrocktxai.com/api/graph/mail/notify/${KEY}`);
  assert.strictEqual(a.lifecycleNotificationUrl, `https://app.bedrocktxai.com/api/graph/mail/lifecycle/${KEY}`);
  assert.ok(!/amanda|@/.test(a.notificationUrl.split('/notify/')[1]), 'no address in the public URL');
  assert.match(a.clientState, /^[0-9a-f]{64}$/); assert.notStrictEqual(a.clientState, i.clientState);
});

// ---- webhook ----
check('HANDSHAKE: ?validationToken is echoed exactly as 200 text/plain and does no work', async () => {
  const res = fakeRes(); let touched = false;
  const saved = GP.getGraphPush; GP.getGraphPush = () => { touched = true; return null; };
  try { router.makeHandler('notify')({ query: { validationToken: 'Validation: Token+with spaces&x' }, params: { key: KEY }, body: {} }, res); }
  finally { GP.getGraphPush = saved; }
  assert.strictEqual(res.code, 200); assert.strictEqual(res.type_, 'text/plain'); assert.strictEqual(res.body, 'Validation: Token+with spaces&x');
  assert.strictEqual(touched, false, 'no push work on a handshake');
  const res2 = fakeRes(); router.makeHandler('lifecycle')({ query: { validationToken: 'abc' }, params: { key: KEY }, body: {} }, res2);
  assert.strictEqual(res2.body, 'abc');
});

// Through EXPRESS itself (in-process, no socket): catches routing/mount defects the direct
// handler calls cannot. Production scar 2026-10-04: exporting a helper as router.handle replaced
// Express's dispatch method, every /api/graph request hung, and the direct-call tests passed.
function viaExpress(method, url, { body, contentType = 'application/json' } = {}) {
  const express = require('express'); const http = require('http'); const net = require('net');
  const app = express();
  app.use((req, res, next) => express.json()(req, res, next));
  app.use('/api/graph', require('../api/graph_push'));
  app.use((req, res) => res.status(404).end('nf'));
  return new Promise((resolve) => {
    const req = new http.IncomingMessage(new net.Socket());
    req.method = method; req.url = url; req.headers = { host: 'app.bedrocktxai.com', 'content-type': contentType };
    const payload = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    req.headers['content-length'] = String(Buffer.byteLength(payload));
    if (payload) req.push(payload); req.push(null);
    const res = new http.ServerResponse(req); const chunks = [];
    res.write = (c) => { if (c) chunks.push(Buffer.from(c)); return true; };
    res.end = (c) => { if (c && typeof c !== 'function') chunks.push(Buffer.from(c)); resolve({ status: res.statusCode, type: String(res.getHeader('content-type') || ''), body: Buffer.concat(chunks).toString() }); return res; };
    setTimeout(() => resolve({ status: 'HUNG' }), 2000);
    app(req, res);
  });
}

check('THROUGH EXPRESS: the real mount answers the handshake and a notification, and leaves other paths alone (no hang)', async () => {
  const h = await viaExpress('POST', `/api/graph/mail/notify/${KEY}?validationToken=${encodeURIComponent('Validation: Token+x y&z')}`, { contentType: 'text/plain' });
  assert.strictEqual(h.status, 200, 'handshake answered'); assert.match(h.type, /^text\/plain/); assert.strictEqual(h.body, 'Validation: Token+x y&z');
  const l = await viaExpress('POST', `/api/graph/mail/lifecycle/${KEY}?validationToken=abc`, { contentType: 'text/plain' });
  assert.strictEqual(l.status, 200); assert.strictEqual(l.body, 'abc');
  const n = await viaExpress('POST', `/api/graph/mail/notify/${KEY}`, { body: note('bad') });
  assert.strictEqual(n.status, 202, 'notification acknowledged');
  const other = await viaExpress('GET', '/api/graph/mail/notify/' + KEY);
  assert.strictEqual(other.status, 404, 'non-route falls through instead of hanging');
});

check('FAST ACK: the webhook answers 202 before any ingest starts; with push off it is a 202 no-op', async () => {
  const { p, ing } = push(); let release; ing.gate = new Promise((r) => { release = r; });
  const saved = GP.getGraphPush; GP.getGraphPush = () => p;
  try {
    const res = fakeRes();
    router.makeHandler('notify')({ query: {}, params: { key: KEY }, body: note(goodCs) }, res);
    assert.strictEqual(res.code, 202); assert.strictEqual(res.ended, true); assert.strictEqual(ing.calls.length, 0, 'nothing ran inside the request');
    await tick(); assert.strictEqual(ing.calls.length, 1, 'ingest started after the response'); release();
    GP.getGraphPush = () => null;
    const off = fakeRes(); router.makeHandler('notify')({ query: {}, params: { key: KEY }, body: note(goodCs) }, off);
    assert.strictEqual(off.code, 202);
  } finally { GP.getGraphPush = saved; }
});

check('BAD clientState / wrong mailbox / unknown key / non-created / empty body: no ingest, no model, no Graph call', async () => {
  const { p, ing } = push();
  const otherCs = clientStateFor(SECRET, 'info@bedrocktx.com');
  for (const [key, body] of [[KEY, note('nope')], [KEY, note(otherCs)], [KEY, note(undefined)], ['deadbeefdeadbeef', note(goodCs)], [KEY, note(goodCs, { changeType: 'updated' })], [KEY, {}], [KEY, null]]) {
    p.handleNotifications(key, body);
  }
  p.handleLifecycle(KEY, { value: [{ lifecycleEvent: 'missed', clientState: 'nope' }] });
  await tick(); assert.strictEqual(ing.calls.length, 0);
  const noSecret = createGraphPush({ mailboxes: [AMANDA], secret: null, log: quiet, supabase: fakeSb(), ingestMailbox: async () => { throw new Error('must not run'); } });
  assert.deepStrictEqual(noSecret.handleNotifications(KEY, note(goodCs)), { accepted: 0, rejected: 1 });
});

check('ONE valid notification -> ONE bounded ingest of the right identity: last hour, max 50, light off, never files backlog', async () => {
  const { p, ing } = push();
  assert.deepStrictEqual(p.handleNotifications(KEY, note(goodCs)), { accepted: 1, rejected: 0 });
  await tick();
  assert.strictEqual(ing.calls.length, 1);
  const [mbx, o] = ing.calls[0];
  assert.strictEqual(mbx, AMANDA); assert.strictEqual(o.fileBacklog, false); assert.strictEqual(o.max, 50); assert.strictEqual(o.light, false);
  assert.strictEqual(o.sinceISO, '2026-10-04T19:00:00.000Z');
});

check('COALESCING: a burst of duplicate notifications during a run adds at most ONE follow-up run; later events run again', async () => {
  const { p, ing } = push(); let release; ing.gate = new Promise((r) => { release = r; });
  p.handleNotifications(KEY, note(goodCs)); await tick();
  for (let i = 0; i < 5; i++) p.handleNotifications(KEY, { value: [note(goodCs).value[0], note(goodCs).value[0]] });
  assert.strictEqual(ing.calls.length, 1, 'still one run in flight');
  ing.gate = null; release(); await p.requestIngest(AMANDA, 'probe');
  assert.strictEqual(ing.calls.length, 2, 'eleven duplicates became one follow-up run');
  p.handleNotifications(KEY, note(goodCs)); await tick(); await tick();
  assert.strictEqual(ing.calls.length, 3);
});

// ---- subscription lifecycle ----
check('BOOT with no subscription creates exactly one, with the right body; RESTART keeps it (no duplicate)', async () => {
  const g = fakeGraph(); const a = push({ graph: g });
  const r1 = await a.p.ensureSubscription(AMANDA);
  assert.strictEqual(r1.action, 'created'); assert.strictEqual(g.created.length, 1);
  const b = g.created[0];
  assert.strictEqual(b.changeType, 'created'); assert.strictEqual(b.resource, "users/amandaalbright@bedrocktx.com/mailFolders('inbox')/messages");
  assert.strictEqual(b.clientState, goodCs); assert.ok(b.notificationUrl.endsWith('/api/graph/mail/notify/' + KEY)); assert.ok(b.lifecycleNotificationUrl.endsWith('/api/graph/mail/lifecycle/' + KEY));
  assert.strictEqual(b.expirationDateTime, '2026-10-07T20:00:00.000Z', '3 days, under the 10,080-minute cap');
  assert.strictEqual(a.sb.rows[0].job_name, 'graph_push_subscription'); assert.strictEqual(a.sb.rows[0].summary.action, 'created');
  const restarted = push({ graph: g });
  const r2 = await restarted.p.ensureSubscription(AMANDA);
  assert.strictEqual(r2.action, 'kept'); assert.strictEqual(g.created.length, 1, 'restart does not create another');
  assert.strictEqual(restarted.sb.rows.length, 0, 'a kept subscription writes no row');
  const both = await Promise.all([restarted.p.ensureSubscription(AMANDA), restarted.p.ensureSubscription(AMANDA)]);
  assert.strictEqual(both[0], both[1], 'concurrent ensures share one run');
});

check('RENEW near expiry; DEDUPE extras from a deploy overlap (keep latest); RECREATE when renewal 404s; other apps\' subscriptions untouched', async () => {
  const g = fakeGraph([
    ourSub('old', '2026-10-05T01:00:00Z'),
    ourSub('older', '2026-10-04T22:00:00Z'),
    { id: 'foreign', notificationUrl: 'https://elsewhere.example/hook', expirationDateTime: '2026-10-04T21:00:00Z' }]);
  const a = push({ graph: g });
  const r = await a.p.ensureSubscription(AMANDA);
  assert.deepStrictEqual(g.removed, ['older']); assert.deepStrictEqual(g.renewed, ['old']); assert.strictEqual(r.action, 'renewed');
  assert.ok(g.subs.some((s) => s.id === 'foreign'), 'never touches a subscription that is not ours');
  assert.deepStrictEqual(a.sb.rows.map((x) => x.summary.action), ['deleted_duplicate', 'renewed']);
  g.renew404 = true; g.subs.find((s) => s.id === 'old').expirationDateTime = '2026-10-04T21:00:00Z';
  const r2 = await a.p.ensureSubscription(AMANDA);
  assert.strictEqual(r2.action, 'created', 'renewal 404 -> recreate');
});

check('SECRET ROTATION recreates instead of keeping: old-secret subscription is deleted as stale and a new one carries the new clientState and URL', async () => {
  const OLD = 'o'.repeat(48);
  const oldKey = keyFor(AMANDA, OLD);
  const oldSub = { id: 'pre', notificationUrl: `https://app.bedrocktxai.com/api/graph/mail/notify/${oldKey}`, lifecycleNotificationUrl: `https://app.bedrocktxai.com/api/graph/mail/lifecycle/${oldKey}`,
    resource: RES, changeType: 'created', clientState: clientStateFor(OLD, AMANDA), expirationDateTime: '2026-10-07T00:00:00Z' };
  assert.notStrictEqual(oldKey, KEY, 'rotating the secret changes the callback key');
  const g = fakeGraph([oldSub]); const a = push({ graph: g });     // running with the NEW secret
  const r = await a.p.ensureSubscription(AMANDA);
  assert.deepStrictEqual(g.removed, ['pre'], 'the old-secret subscription is not kept'); assert.strictEqual(r.action, 'created');
  assert.strictEqual(g.created[0].clientState, goodCs); assert.strictEqual(g.created[0].notificationUrl, NOTIFY);
  assert.deepStrictEqual(a.sb.rows.map((x) => [x.summary.action, x.summary.reason]), [['deleted_stale', 'notification_url'], ['created', undefined]]);
  // Even if Graph's list hides clientState, the URL fingerprint still catches the rotation.
  const g2 = fakeGraph([{ ...oldSub, id: 'pre2', clientState: null }]); const b = push({ graph: g2 });
  await b.p.ensureSubscription(AMANDA);
  assert.deepStrictEqual(g2.removed, ['pre2']); assert.strictEqual(g2.created.length, 1);
  // And a notification still signed with the OLD clientState is rejected (no ingest).
  b.p.handleNotifications(KEY, note(clientStateFor(OLD, AMANDA))); await tick(); assert.strictEqual(b.ing.calls.length, 0);
});

check('STALE CONFIG on our exact callback (clientState, resource, changeType, lifecycle URL) is deleted and recreated; a matching one with fields Graph omits is kept (no churn)', async () => {
  const cases = [['client_state', { clientState: 'stale-client-state' }], ['resource', { resource: "users/amandaalbright@bedrocktx.com/messages" }],
    ['change_type', { changeType: 'created,updated' }], ['lifecycle_url', { lifecycleNotificationUrl: 'https://app.bedrocktxai.com/api/graph/mail/lifecycle/0000000000000000' }]];
  for (const [reason, over] of cases) {
    const s = ourSub('x', '2026-10-07T00:00:00Z', over);
    assert.strictEqual(staleReason(s, push().p.entries()[0]), reason, reason);
    const g = fakeGraph([s]); const a = push({ graph: g });
    const r = await a.p.ensureSubscription(AMANDA);
    assert.deepStrictEqual(g.removed, ['x'], reason); assert.strictEqual(r.action, 'created', reason);
    assert.strictEqual(a.sb.rows[0].summary.reason, reason);
  }
  // Graph omitting clientState / lifecycle URL, or returning the resource in another case, is still current.
  const g = fakeGraph([ourSub('ok', '2026-10-07T00:00:00Z', { clientState: null, lifecycleNotificationUrl: undefined, resource: RES.toUpperCase(), changeType: 'Created' })]);
  const a = push({ graph: g }); const r = await a.p.ensureSubscription(AMANDA);
  assert.strictEqual(r.action, 'kept'); assert.deepStrictEqual(g.removed, []); assert.strictEqual(g.created.length, 0);
  // Stale for ANOTHER mailbox of ours, and other apps' subscriptions, are left alone by this mailbox's pass.
  const infoKey = keyFor('info@bedrocktx.com', SECRET);
  const g3 = fakeGraph([ourSub('mine', '2026-10-07T00:00:00Z'),
    { id: 'info', notificationUrl: `https://app.bedrocktxai.com/api/graph/mail/notify/${infoKey}`, resource: "users/info@bedrocktx.com/mailFolders('inbox')/messages", changeType: 'created', expirationDateTime: '2026-10-07T00:00:00Z' },
    { id: 'foreign', notificationUrl: 'https://elsewhere.example/hook', resource: RES, changeType: 'updated', expirationDateTime: '2026-10-07T00:00:00Z' }]);
  await push({ graph: g3 }).p.ensureSubscription(AMANDA);
  assert.deepStrictEqual(g3.removed, [], 'nothing outside this mailbox registration is touched');
});

check('CREATE FAILURE retries at 2 / 10 / 30 minutes, then waits for recovery; each failure is recorded', async () => {
  const g = fakeGraph(); g.failCreate = 10; const a = push({ graph: g });
  await a.p.ensureSubscription(AMANDA);
  assert.strictEqual(a.timers.length, 1); assert.strictEqual(a.timers[0].ms, 2 * 60e3);
  await a.timers[0].fn(); await tick(); assert.strictEqual(a.timers[1].ms, 10 * 60e3);
  await a.timers[1].fn(); await tick(); assert.strictEqual(a.timers[2].ms, 30 * 60e3);
  await a.timers[2].fn(); await tick(); assert.strictEqual(a.timers.length, 3, 'after the third retry it waits for the recovery pass');
  assert.ok(a.sb.rows.every((x) => x.ok === false && x.summary.action === 'ensure_failed')); assert.strictEqual(a.sb.rows.length, 4);
  g.failCreate = 0; const ok = await a.p.ensureSubscription(AMANDA); assert.strictEqual(ok.action, 'created');
});

// Delta reconciliation harness: Graph delta pages by URL prefix, a stored deltaLink, and the set of
// message ids already in trustEd.
function deltaPush(over = {}) {
  const g = fakeGraph([ourSub('s1', '2026-10-07T00:00:00Z')]);
  g.deltaUrls = []; g.deltaPages = over.pages || [{ value: [], '@odata.deltaLink': 'https://graph/delta?token=next' }]; g.deltaFail = over.deltaFail || null;
  g.delta = async (url) => { g.deltaUrls.push(url); if (g.deltaFail) { const f = g.deltaFail; g.deltaFail = null; const e = new Error('delta ' + f); e.status = f; throw e; } return g.deltaPages.shift() || { value: [], '@odata.deltaLink': 'https://graph/delta?token=next' }; };
  const stored = new Set(over.stored || []);
  const storeOnIngest = over.storeOnIngest || [];
  const a = push({ graph: g, ingestMailbox: async (mbx, o) => { a.ing.calls.push([mbx, o]); for (const id of storeOnIngest) stored.add(id); return { scanned: 1, kept: storeOnIngest.length }; }, loadDeltaLink: async () => (over.link === undefined ? null : over.link), storedIds: async (ids) => new Set(ids.filter((i) => stored.has(i))), ...(over.push || {}) });
  return { ...a, g, stored };
}
const msg = (id, at, from = 'resident@example.com', extra = {}) => ({ id: 'g-' + id, internetMessageId: id, receivedDateTime: at, from: { emailAddress: { address: from } }, ...extra });

check('LIFECYCLE events: reauthorizationRequired renews, subscriptionRemoved recreates then delta-reconciles, missed runs a delta reconciliation (no time-window re-read); bad clientState ignored', async () => {
  const a = deltaPush();
  a.p.handleLifecycle(KEY, { value: [{ lifecycleEvent: 'reauthorizationRequired', clientState: goodCs }] }); await tick(); await tick();
  assert.deepStrictEqual(a.g.renewed, ['s1'], 'renewed even though not near expiry');
  a.g.subs = [];
  a.p.handleLifecycle(KEY, { value: [{ lifecycleEvent: 'subscriptionRemoved', clientState: goodCs }] }); for (let i = 0; i < 6; i++) await tick();
  assert.strictEqual(a.g.created.length, 1);
  assert.ok(a.g.deltaUrls.length >= 1, 'the gap after removal is reconciled by delta');
  const before = a.g.deltaUrls.length;
  a.p.handleLifecycle(KEY, { value: [{ lifecycleEvent: 'missed', clientState: goodCs }] }); for (let i = 0; i < 4; i++) await tick();
  assert.strictEqual(a.g.deltaUrls.length, before + 1, 'missed -> one delta reconciliation');
  assert.strictEqual(a.ing.calls.length, 0, 'nothing new in the delta: no mailbox read at all');
  a.p.handleLifecycle(KEY, { value: [{ lifecycleEvent: 'missed', clientState: 'nope' }] }); await tick();
  assert.strictEqual(a.g.deltaUrls.length, before + 1, 'bad clientState ignored');
});

// ---- recovery ----
check('RECOVERY: the 6-hour pass only checks subscriptions (no mail read); delta runs on boot and once a day; an empty delta records its deltaLink and ingests nothing', async () => {
  const saved = process.env.GRAPH_PUSH_RECOVERY_HOURS;
  try {
    delete process.env.GRAPH_PUSH_RECOVERY_HOURS; assert.strictEqual(GP.recoveryMs(), 6 * 3600e3);
    process.env.GRAPH_PUSH_RECOVERY_HOURS = '0.01'; assert.strictEqual(GP.recoveryMs(), 3600e3, 'never faster than hourly');
  } finally { if (saved === undefined) delete process.env.GRAPH_PUSH_RECOVERY_HOURS; else process.env.GRAPH_PUSH_RECOVERY_HOURS = saved; }
  let t = Date.parse('2026-10-04T20:00:00Z');
  const a = deltaPush({ push: { now: () => t } });
  await a.p.recover('boot');
  assert.strictEqual(a.g.deltaUrls.length, 1, 'boot reconciles (covers a deploy gap)');
  assert.match(a.g.deltaUrls[0], /\/users\/amandaalbright%40bedrocktx\.com\/mailFolders\('inbox'\)\/messages\/delta\?\$select=id,internetMessageId,receivedDateTime,from&changeType=created&\$filter=receivedDateTime ge 2026-10-03T18:00:00\.000Z$/, 'first sync: Inbox only, created only, the last 26 hours');
  assert.strictEqual(a.ing.calls.length, 0);
  const rows = a.sb.rows.filter((r) => r.job_name === GP.JOB_DELTA);
  assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].ok, true); assert.strictEqual(rows[0].summary.delta_link, 'https://graph/delta?token=next'); assert.strictEqual(rows[0].summary.mailbox, AMANDA);
  t += 6 * 3600e3; await a.p.recover('recovery');
  assert.strictEqual(a.g.deltaUrls.length, 1, 'six hours later: subscriptions checked, no delta, no mail read');
  assert.strictEqual(a.ing.calls.length, 0);
  t += 18 * 3600e3; await a.p.recover('recovery');
  assert.strictEqual(a.g.deltaUrls.length, 2, 'a day after the last reconciliation: the daily delta runs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'graph_push.js'), 'utf8');
  assert.ok(!/AMANDA_WAKE|INTERVAL_SEC/.test(src), 'no short-interval polling knob');
  assert.ok(!/requestIngest\(m, reason, recovery/.test(src), 'the recovery pass no longer re-reads a time window');
});

check('DELTA: a message push never delivered is ingested from its own time, and the deltaLink advances only once it is stored; own mail and removals are ignored', async () => {
  const a = deltaPush({ link: 'https://graph/delta?token=prev', stored: ['<old@x>'], storeOnIngest: ['<new@x>', '<new2@x>'], pages: [
    { value: [msg('<old@x>', '2026-10-04T18:00:00Z'), msg('<new@x>', '2026-10-04T19:10:00Z'), msg('<mine@x>', '2026-10-04T19:20:00Z', AMANDA), { id: 'gone', '@removed': { reason: 'deleted' } }], '@odata.nextLink': 'https://graph/delta?page=2' },
    { value: [msg('<new2@x>', '2026-10-04T19:30:00Z')], '@odata.deltaLink': 'https://graph/delta?token=after' },
  ] });
  const r = await a.p.reconcile(AMANDA, 'missed');
  assert.strictEqual(a.ing.calls.length, 1, 'one recovery ingest for the two missing messages');
  assert.strictEqual(a.ing.calls[0][1].sinceISO, '2026-10-04T19:05:00.000Z', 'from the oldest missing message, less 5 minutes');
  assert.deepStrictEqual(a.g.deltaUrls, ['https://graph/delta?token=prev', 'https://graph/delta?page=2'], 'continues from the stored deltaLink');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.changes, 3, 'own mail and removals ignored');
  const rows = a.sb.rows.filter((x) => x.job_name === GP.JOB_DELTA);
  assert.strictEqual(rows[rows.length - 1].summary.delta_link, 'https://graph/delta?token=after');
});

check('DELTA: when the recovery ingest does not store the message, the deltaLink does NOT advance; it retries at 2 minutes and then succeeds', async () => {
  const a = deltaPush({ link: 'https://graph/delta?token=prev', pages: [{ value: [msg('<lost@x>', '2026-10-04T19:10:00Z')], '@odata.deltaLink': 'https://graph/delta?token=after' }] });
  const r = await a.p.reconcile(AMANDA, 'daily');
  assert.strictEqual(r.ok, false); assert.match(r.error, /1 new message\(s\) still not in trustEd/);
  assert.strictEqual(a.ing.calls.length, 1); assert.strictEqual(a.ing.calls[0][1].sinceISO, '2026-10-04T19:05:00.000Z', 'reads from the missed message, not a fixed window');
  assert.strictEqual(a.ing.calls[0][1].max, 500); assert.strictEqual(a.ing.calls[0][1].fileBacklog, false);
  const fail = a.sb.rows.filter((x) => x.job_name === GP.JOB_DELTA);
  assert.strictEqual(fail.length, 1); assert.strictEqual(fail[0].ok, false); assert.ok(!fail[0].summary.delta_link, 'no deltaLink saved on failure');
  assert.strictEqual(a.timers[a.timers.length - 1].ms, 2 * 60e3);
  a.g.deltaPages = [{ value: [msg('<lost@x>', '2026-10-04T19:10:00Z')], '@odata.deltaLink': 'https://graph/delta?token=after' }];
  a.stored.add('<lost@x>');
  await a.timers[a.timers.length - 1].fn(); for (let i = 0; i < 4; i++) await tick();
  const ok = a.sb.rows.filter((x) => x.job_name === GP.JOB_DELTA && x.ok);
  assert.strictEqual(ok.length, 1); assert.strictEqual(ok[0].summary.delta_link, 'https://graph/delta?token=after');
});

check('DELTA: an expired sync state (410) starts over from the last day; a refused first-sync filter (400) falls back to the whole (zero-inbox) Inbox', async () => {
  const a = deltaPush({ link: 'https://graph/delta?token=old', deltaFail: 410 });
  const r = await a.p.reconcile(AMANDA, 'daily');
  assert.strictEqual(r.ok, true); assert.strictEqual(a.g.deltaUrls.length, 2); assert.match(a.g.deltaUrls[1], /receivedDateTime ge /);
  assert.strictEqual(a.sb.rows.filter((x) => x.job_name === GP.JOB_DELTA)[0].summary.restarted, true);
  const b = deltaPush({ deltaFail: 400 });
  const r2 = await b.p.reconcile(AMANDA, 'boot');
  assert.strictEqual(r2.ok, true); assert.ok(!/\$filter/.test(b.g.deltaUrls[1]), 'second try without the filter');
});

check('INGEST FAILURE on a notification schedules a delta reconciliation in 2 minutes (the message is not lost)', async () => {
  const a = deltaPush({ push: { ingestMailbox: async () => { throw new Error('graph 503'); } } });
  a.p.handleNotifications(KEY, note(goodCs)); for (let i = 0; i < 4; i++) await tick();
  const t = a.timers.find((x) => x.ms === 2 * 60e3); assert.ok(t, 'retry scheduled');
  await t.fn(); for (let i = 0; i < 4; i++) await tick();
  assert.strictEqual(a.g.deltaUrls.length, 1, 'the retry is a delta reconciliation');
});

// ---- integration: push -> the real ingestMailbox ----
check('INTEGRATION: a valid notification drives the REAL ingestMailbox for the identity mailbox; already-handled mail = 0 model calls, no filing', async () => {
  reset(); seenResult = allSeen();
  const sb = fakeSb();
  const p = createGraphPush({ mailboxes: [AMANDA], secret: SECRET, baseUrl: 'https://app.bedrocktxai.com', log: quiet, supabase: sb, now: () => Date.parse('2026-10-04T20:00:00Z') });
  p.handleNotifications(KEY, note(goodCs)); p.handleNotifications(KEY, note(goodCs));
  await p.requestIngest(AMANDA, 'probe');
  assert.ok(calls.graphUrls.length >= 1 && calls.graphUrls.every((u) => u.includes('/users/amandaalbright%40bedrocktx.com/messages')), 'reads the identity, never the alias');
  assert.ok(calls.graphUrls[0].includes('receivedDateTime ge 2026-10-04T19:00:00.000Z'));
  assert.strictEqual(calls.classify, 0, 'duplicate/empty event: no model call'); assert.strictEqual(calls.fileMessage, 0, 'no backlog filing');
  assert.strictEqual(sb.rows.length, 0);
  reset(); seenResult = { data: null, error: { message: 'statement timeout' } };
  await p.requestIngest(AMANDA, 'notification');
  assert.strictEqual(calls.classify, 0, 'fail closed through the push path'); assert.strictEqual(sb.rows.length, 1);
  assert.strictEqual(sb.rows[0].job_name, 'graph_push'); assert.strictEqual(sb.rows[0].ok, false); assert.match(sb.rows[0].error, /dedupe_lookup_failed/);
  seenResult = allSeen();
});

// ---- retained graph_ingest hardening (from superseded PR #42) ----
check('INGEST: already-processed mail -> 0 model calls, 0 writes; fileBacklog:false files nothing while Pull keeps its housekeeping', async () => {
  reset(); seenResult = allSeen();
  const s = await ingestMailbox(AMANDA, { sinceISO: 'x', max: 50, fileBacklog: false });
  assert.strictEqual(s.kept, 0); assert.strictEqual(s.skipped, 3); assert.strictEqual(calls.classify, 0); assert.strictEqual(calls.fileMessage, 0); assert.deepStrictEqual(calls.otherTables, []);
  reset(); seenResult = allSeen();
  await ingestMailbox(AMANDA, { sinceISO: 'x', max: 50 });
  assert.strictEqual(calls.fileMessage, 3, 'Pull inbox unchanged'); assert.strictEqual(calls.classify, 0);
});

check('INGEST FAIL CLOSED: a failed already-processed lookup aborts with 0 model calls and 0 downstream processing', async () => {
  reset(); seenResult = { data: null, error: { message: 'canceling statement due to statement timeout' } };
  await assert.rejects(() => ingestMailbox(AMANDA, { sinceISO: 'x', max: 50 }), (e) => e.code === 'dedupe_lookup_failed');
  assert.strictEqual(calls.classify, 0); assert.strictEqual(calls.fileMessage, 0); assert.deepStrictEqual(calls.otherTables, []);
  seenResult = allSeen();
});

check('INGEST SINGLE FLIGHT per mailbox: a push-triggered ingest and Pull inbox never overlap; skipIfBusy skips; other mailboxes proceed', async () => {
  reset(); seenResult = allSeen();
  let release; fetchGate = new Promise((r) => { release = r; });
  const pull = ingestMailbox('AmandaAlbright@bedrocktx.com', { sinceISO: 'x', max: 50 });
  await tick();
  const skipper = await ingestMailbox(AMANDA, { sinceISO: 'x', max: 50, skipIfBusy: true });
  assert.strictEqual(skipper.busy, true);
  const before = calls.graphFetch;
  const pushed = ingestMailbox(AMANDA, { sinceISO: 'x', max: 50, fileBacklog: false });
  const other = ingestMailbox('info@bedrocktx.com', { sinceISO: 'x', max: 50 });
  await tick();
  assert.strictEqual(calls.graphFetch, before + 1, 'only info@ started; the Amanda run is queued behind the pull');
  release(); fetchGate = null; await Promise.all([pull, pushed, other]);
  assert.strictEqual(calls.graphFetch, before + 2, 'the queued run went after the pull finished');
});

check('WIRING: public path covers only the two callback shapes; router mounted; push started after listen; no send path; no polling wake', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(server.includes("/^\\/api\\/graph\\/mail\\/(notify|lifecycle)\\/[0-9a-f]{16}$/"), 'narrow public-path entry');
  assert.match(server, /app\.use\('\/api\/graph', require\('\.\/api\/graph_push'\)\)/);
  assert.match(server, /require\('\.\/lib\/email\/graph_push'\)\.startGraphPush\(\)/);
  assert.ok(!/amanda_wake/.test(server), 'the rejected polling wake is not wired');
  for (const f of ['lib/email/graph_push.js', 'api/graph_push.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/sendMail|sendEmail|resend|graph_send'\)\.send/i.test(src), `${f}: no send path`);
  }
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
