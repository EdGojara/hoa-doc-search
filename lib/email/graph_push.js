// lib/email/graph_push.js  (Issue #29, TrustEd Push Email, 2026-10-04)
// ----------------------------------------------------------------------------
// Agents sleep by default and wake on an event. For email, the event is a
// Microsoft Graph change notification:
//
//   new mail in a configured mailbox's Inbox -> Graph POSTs
//   /api/graph/mail/notify/<key> -> clientState checked before any work -> 202
//   at once -> one bounded ingest of THAT mailbox, queued off the request ->
//   the existing pipeline and that mailbox's existing persona/workflow routing
//   (Amanda: the shared request contract, same objective timeline, pending
//   draft) -> asleep again.
//
// This file only DELIVERS THE EVENT. It owns no brain, no message store and no
// routing: after ingestMailbox, every mailbox behaves exactly as Pull inbox
// makes it behave today (info@ keeps its intake routing, Amanda keeps hers).
//
// REGISTRY. GRAPH_PUSH_MAILBOXES lists the mailboxes to subscribe (comma list).
// Every entry must resolve to an underlying Graph mailbox identity already in
// graph_send.TEAM_INGEST_MAILBOXES; a known alias resolves to its identity
// (amanda@ -> AMANDA_MAILBOX, amandaalbright@), and anything else is refused.
// Several friendly addresses landing in one mailbox subscribe ONCE.
//
// PER MAILBOX: resource users/<identity>/mailFolders('inbox')/messages,
// changeType 'created' (Inbox only: our own filing moves and Sent Items never
// wake anyone). Callback /api/graph/mail/notify/<key>, lifecycle
// /api/graph/mail/lifecycle/<key>, where <key> is a short hash of the identity
// (no address in a public URL). clientState is HMAC-SHA256(GRAPH_NOTIFY_CLIENT_STATE,
// identity), so a notification valid for one mailbox can never wake another.
//
// SUBSCRIPTION LIFECYCLE, no new table: Graph is the record. On boot and each
// recovery pass, per mailbox: list the app's subscriptions, keep the one whose
// notificationUrl is ours (delete extras a deploy overlap made), renew it when
// under 36h of a 3-day lifetime, create one only when none exists. Failures
// retry at 2 / 10 / 30 minutes, then wait for recovery. Lifecycle events:
// reauthorizationRequired -> renew; subscriptionRemoved -> recreate; missed ->
// catch-up ingest.
//
// RECOVERY (insurance, not operation): every GRAPH_PUSH_RECOVERY_HOURS (default
// 6, minimum 1) re-ensure subscriptions and run one catch-up ingest per mailbox
// over that window. Empty catch-up = Graph list + one Supabase lookup, no model.
//
// SAFETY shared with Pull inbox lives in ingestMailbox: same-mailbox single
// flight, fail closed on the already-processed lookup, fileBacklog:false so an
// event never becomes a filing sweep. Notification bursts collapse into at most
// one queued run per mailbox; a re-run over handled mail costs nothing.
//
// OFF unless GRAPH_PUSH=on, GRAPH_NOTIFY_CLIENT_STATE is 32-128 chars, and
// GRAPH_PUSH_MAILBOXES names at least one allowed mailbox.
// ----------------------------------------------------------------------------
const crypto = require('crypto');

const NOTIFY_PATH = '/api/graph/mail/notify/';
const LIFECYCLE_PATH = '/api/graph/mail/lifecycle/';
const SUB_LIFETIME_MS = 3 * 24 * 3600e3;     // well under Graph's 10,080-minute cap for mail
const RENEW_WITHIN_MS = 36 * 3600e3;
const NOTIFY_WINDOW_MS = 60 * 60e3;          // an event reads the last hour of that mailbox
const RETRY_MS = [2 * 60e3, 10 * 60e3, 30 * 60e3];
const JOB_INGEST = 'graph_push';
const JOB_SUB = 'graph_push_subscription';

const masterSecret = () => { const s = String(process.env.GRAPH_NOTIFY_CLIENT_STATE || ''); return s.length >= 32 && s.length <= 128 ? s : null; };
const keyFor = (identity) => crypto.createHash('sha256').update(String(identity).toLowerCase()).digest('hex').slice(0, 16);
const clientStateFor = (secret, identity) => crypto.createHmac('sha256', secret).update(String(identity).toLowerCase()).digest('hex');
function recoveryMs() { const h = parseFloat(process.env.GRAPH_PUSH_RECOVERY_HOURS); return Math.max(1, Number.isFinite(h) ? h : 6) * 3600e3; }
function baseUrl() { return String(process.env.GRAPH_NOTIFY_BASE_URL || require('../brand').tech.appUrl).replace(/\/+$/, ''); }
function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// Friendly address -> underlying Graph identity. Only aliases verified in graph_send are listed.
function knownAliases(gs) { return { 'amanda@bedrocktx.com': gs.AMANDA_MAILBOX }; }

// Resolve GRAPH_PUSH_MAILBOXES into allowed, de-duplicated mailbox identities.
function resolveRegistry(raw, gs = require('./graph_send')) {
  const allowed = new Map((gs.TEAM_INGEST_MAILBOXES || []).map((m) => [String(m).toLowerCase(), m]));
  const aliases = knownAliases(gs);
  const mailboxes = []; const refused = []; const seen = new Set();
  for (const entry of String(raw || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const identity = String(aliases[entry] || entry).toLowerCase();
    if (!allowed.has(identity)) { refused.push(entry); continue; }
    if (seen.has(identity)) continue;
    seen.add(identity); mailboxes.push(allowed.get(identity));
  }
  return { mailboxes, refused };
}

function realGraph() {
  const G = 'https://graph.microsoft.com/v1.0/subscriptions';
  async function call(method, url, body) {
    const token = await require('./graph_send').getToken();
    const r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) { const e = new Error(`Graph ${method} subscriptions failed (${r.status}): ${(await r.text().catch(() => '')).slice(0, 200)}`); e.status = r.status; throw e; }
    return r.status === 204 ? null : r.json();
  }
  return {
    async list() { const out = []; let url = G; while (url) { const j = await call('GET', url); out.push(...(j.value || [])); url = j['@odata.nextLink'] || null; } return out; },
    create: (body) => call('POST', G, body),
    renew: (id, expirationDateTime) => call('PATCH', `${G}/${encodeURIComponent(id)}`, { expirationDateTime }),
    remove: (id) => call('DELETE', `${G}/${encodeURIComponent(id)}`),
  };
}

function createGraphPush(deps = {}) {
  const graph = deps.graph || realGraph();
  const ingest = deps.ingestMailbox || ((mbx, o) => require('./graph_ingest').ingestMailbox(mbx, o));
  const secret = deps.secret !== undefined ? deps.secret : masterSecret();
  const base = deps.baseUrl || baseUrl();
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const schedule = deps.setTimeout || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });
  const recovery = deps.recoveryMs || recoveryMs();

  async function record(job, ok, summary, error) {
    const sb = deps.supabase || (() => { try { return require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY); } catch (_) { return null; } })();
    if (!sb) return;
    try {
      const t = new Date(now()).toISOString();
      const { error: e } = await sb.from('cron_runs').insert({ job_name: job, started_at: t, finished_at: t, ok, summary, error: error || null, triggered_by: 'graph_push' });
      if (e) log.warn('[graph_push] cron_runs insert failed:', e.message);
    } catch (e) { log.warn('[graph_push] cron_runs insert threw:', e.message); }
  }

  // One entry per underlying mailbox identity.
  const byKey = new Map();
  for (const mailbox of deps.mailboxes || []) {
    const key = keyFor(mailbox);
    byKey.set(key, {
      key, mailbox,
      resource: `users/${mailbox}/mailFolders('inbox')/messages`,
      notificationUrl: base + NOTIFY_PATH + key,
      lifecycleNotificationUrl: base + LIFECYCLE_PATH + key,
      clientState: secret ? clientStateFor(secret, mailbox) : null,
      sub: { id: null, expiresAt: null, retry: 0 }, ensuring: null,
      run: { running: false, pending: false, last: null },
    });
  }

  // ---- subscription lifecycle (single flight per mailbox) ----
  function ensureSubscription(m, opts = {}) {
    if (!m.ensuring) m.ensuring = ensureOnce(m, opts).finally(() => { m.ensuring = null; });
    return m.ensuring;
  }
  async function ensureOnce(m, { forceRenew = false } = {}) {
    try {
      const mine = (await graph.list()).filter((s) => s.notificationUrl === m.notificationUrl);
      mine.sort((a, b) => Date.parse(b.expirationDateTime || 0) - Date.parse(a.expirationDateTime || 0));
      const [keep, ...extra] = mine;
      for (const s of extra) {
        try { await graph.remove(s.id); await record(JOB_SUB, true, { mailbox: m.mailbox, action: 'deleted_duplicate', id: s.id }); }
        catch (e) { log.warn(`[graph_push] ${m.mailbox} duplicate subscription delete failed:`, e.message); }
      }
      let sub = keep || null; let action = 'kept';
      if (sub && (forceRenew || Date.parse(sub.expirationDateTime) - now() < RENEW_WITHIN_MS)) {
        try { sub = { ...sub, ...((await graph.renew(sub.id, new Date(now() + SUB_LIFETIME_MS).toISOString())) || {}) }; action = 'renewed'; }
        catch (e) { if (e.status === 404) sub = null; else throw e; }
      }
      if (!sub) {
        sub = await graph.create({ changeType: 'created', notificationUrl: m.notificationUrl, lifecycleNotificationUrl: m.lifecycleNotificationUrl,
          resource: m.resource, expirationDateTime: new Date(now() + SUB_LIFETIME_MS).toISOString(), clientState: m.clientState });
        action = 'created';
      }
      Object.assign(m.sub, { id: sub.id, expiresAt: sub.expirationDateTime, retry: 0 });
      if (action !== 'kept') {
        log.log(`[graph_push] ${m.mailbox} subscription ${action}: ${sub.id} until ${sub.expirationDateTime}`);
        await record(JOB_SUB, true, { mailbox: m.mailbox, action, id: sub.id, expires: sub.expirationDateTime, resource: m.resource });
      }
      return { ok: true, action, id: sub.id };
    } catch (e) {
      const wait = RETRY_MS[m.sub.retry] || null; m.sub.retry += 1;
      log.error(`[graph_push] ${m.mailbox} subscription ensure failed${wait ? `; retrying in ${wait / 60e3} min` : '; next try at recovery'}:`, e.message);
      await record(JOB_SUB, false, { mailbox: m.mailbox, action: 'ensure_failed', retry_in_min: wait ? wait / 60e3 : null }, String(e.message).slice(0, 500));
      if (wait) schedule(() => { ensureSubscription(m).catch(() => {}); }, wait);
      return { ok: false, error: e.message };
    }
  }

  // ---- ingest: off the HTTP request, coalesced per mailbox, bounded ----
  function requestIngest(m, reason, windowMs = NOTIFY_WINDOW_MS) {
    if (m.run.running) { m.run.pending = true; return m.run.last; }
    m.run.running = true;
    m.run.last = (async () => {
      try {
        do { m.run.pending = false; await ingestOnce(m, reason, windowMs); reason = 'coalesced'; } while (m.run.pending);
      } finally { m.run.running = false; }
    })();
    return m.run.last;
  }
  async function ingestOnce(m, reason, windowMs) {
    const sinceISO = new Date(now() - windowMs).toISOString();
    try {
      const s = await ingest(m.mailbox, { sinceISO, light: false, onlyLinked: false, max: 50, fileBacklog: false });
      if (s && s.kept > 0) { log.log(`[graph_push] ${reason}: ${s.kept} new message(s) in ${m.mailbox}`); await record(JOB_INGEST, true, { reason, mailbox: m.mailbox, since: sinceISO, ...s }); }
      return s;
    } catch (e) {
      log.error(`[graph_push] ${m.mailbox} ${reason} ingest failed (nothing processed past the failure):`, e.message);
      await record(JOB_INGEST, false, { reason, mailbox: m.mailbox, since: sinceISO }, String(e.message).slice(0, 500));
      return null;
    }
  }

  // ---- inbound: validate first, work later. Invalid input is a cheap no-op. ----
  function handleNotifications(key, body) {
    const m = byKey.get(String(key || ''));
    const items = (body && Array.isArray(body.value)) ? body.value : [];
    if (!m || !m.clientState) return { accepted: 0, rejected: items.length };
    let accepted = 0, rejected = 0;
    for (const n of items) {
      if (!safeEqual(n && n.clientState, m.clientState) || (n.changeType && n.changeType !== 'created')) { rejected += 1; continue; }
      accepted += 1;
    }
    if (rejected) log.warn(`[graph_push] ignored ${rejected} notification(s) for ${m.mailbox} (bad clientState or change type)`);
    if (accepted) requestIngest(m, 'notification');
    return { accepted, rejected };
  }
  function handleLifecycle(key, body) {
    const m = byKey.get(String(key || ''));
    const items = (body && Array.isArray(body.value)) ? body.value : [];
    if (!m || !m.clientState) return { accepted: 0, rejected: items.length };
    let accepted = 0, rejected = 0;
    for (const n of items) {
      if (!safeEqual(n && n.clientState, m.clientState)) { rejected += 1; continue; }
      accepted += 1;
      if (n.lifecycleEvent === 'reauthorizationRequired') ensureSubscription(m, { forceRenew: true }).catch(() => {});
      else if (n.lifecycleEvent === 'subscriptionRemoved') ensureSubscription(m).catch(() => {});
      else if (n.lifecycleEvent === 'missed') requestIngest(m, 'missed', recovery + 3600e3);
    }
    if (rejected) log.warn(`[graph_push] ignored ${rejected} lifecycle notification(s) for ${m.mailbox} (bad clientState)`);
    return { accepted, rejected };
  }

  // Recovery: re-ensure each subscription, then one catch-up per mailbox over the recovery window.
  async function recover(reason = 'recovery') {
    const out = [];
    for (const m of byKey.values()) {
      await ensureSubscription(m);
      out.push(requestIngest(m, reason, recovery + 3600e3));
    }
    return Promise.all(out);
  }

  return { handleNotifications, handleLifecycle, recover, ensureSubscription: (mbx, o) => ensureSubscription(entryFor(mbx), o),
    requestIngest: (mbx, r, w) => requestIngest(entryFor(mbx), r, w), entries: () => [...byKey.values()], keyFor };
  function entryFor(mbx) { const m = byKey.get(keyFor(mbx)); if (!m) throw new Error('mailbox not registered: ' + mbx); return m; }
}

let _instance = null; let _timer = null;
function config() {
  const on = String(process.env.GRAPH_PUSH || '').toLowerCase() === 'on';
  const { mailboxes, refused } = resolveRegistry(process.env.GRAPH_PUSH_MAILBOXES);
  return { on, secretOk: !!masterSecret(), mailboxes, refused };
}
// The routes always exist; with push off (or before start) every request is a 202 no-op.
const getGraphPush = () => _instance;
function startGraphPush() {
  const c = config();
  if (c.refused.length) console.warn('[graph_push] refused GRAPH_PUSH_MAILBOXES entries (not an ingest mailbox identity or known alias):', c.refused.join(', '));
  if (!c.on || !c.secretOk || !c.mailboxes.length) { console.log('[graph_push] off (needs GRAPH_PUSH=on, GRAPH_NOTIFY_CLIENT_STATE 32-128 chars, GRAPH_PUSH_MAILBOXES)'); return null; }
  if (!require('./graph_send').isConfigured()) { console.log('[graph_push] off: Graph not configured'); return null; }
  if (_timer) return _timer;
  _instance = createGraphPush({ mailboxes: c.mailboxes });
  console.log(`[graph_push] on for ${c.mailboxes.join(', ')}; recovery every ${recoveryMs() / 3600e3}h`);
  // A few seconds after listen, so Graph's validation call on create reaches a live route.
  const t = setTimeout(() => { _instance.recover('boot').catch((e) => console.error('[graph_push] boot recovery threw:', e.message)); }, 5000);
  if (t.unref) t.unref();
  _timer = setInterval(() => { _instance.recover('recovery').catch((e) => console.error('[graph_push] recovery threw:', e.message)); }, recoveryMs());
  if (_timer.unref) _timer.unref();
  return _timer;
}

module.exports = { createGraphPush, getGraphPush, startGraphPush, resolveRegistry, config, keyFor, clientStateFor, safeEqual, recoveryMs,
  NOTIFY_PATH, LIFECYCLE_PATH, SUB_LIFETIME_MS, RENEW_WITHIN_MS, NOTIFY_WINDOW_MS, JOB_INGEST, JOB_SUB };
