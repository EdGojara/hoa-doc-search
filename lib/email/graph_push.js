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
// REGISTRY. The AI employee email desks (lib/team/roster.js email_desk: Amanda, Kat, Annie,
// Maggie, Miranda) and every ingest mailbox whose mail routing already gives to one of them
// (accounting@ -> Kat, violations@ -> Miranda) are always subscribed (Ed 2026-10-22), and so is
// the website Contact form's intake mailbox, welcome@ (Ed 2026-10-23).
// GRAPH_PUSH_MAILBOXES adds more (comma list).
//
// OWNER-ONLY MAILBOX: Tessa's (graph_send.TESSA_MAILBOX) is subscribed too (Ed 2026-10-31: her
// mail, including his owner-authorization replies, must wake her on arrival, not wait for a
// poll). Her mail is owner-only, so it NEVER goes through ingestMailbox / email_messages: an
// event on her mailbox runs pollTessaInbox, which writes only to the owner-gated ea_inbox, and
// her delta reconciliation counts a message as stored when its Graph id is in ea_inbox. She is
// not, and must not be, in TEAM_INGEST_MAILBOXES.
// Every entry must resolve to an underlying Graph mailbox identity already in
// graph_send.TEAM_INGEST_MAILBOXES; a known alias resolves to its identity
// (amanda@ -> AMANDA_MAILBOX, amandaalbright@), and anything else is refused.
// Several friendly addresses landing in one mailbox subscribe ONCE.
//
// PER MAILBOX: resource users/<identity>/mailFolders('inbox')/messages,
// changeType 'created' (Inbox only: our own filing moves and Sent Items never
// wake anyone). Callback /api/graph/mail/notify/<key>, lifecycle
// /api/graph/mail/lifecycle/<key>, where <key> is a short hash of the identity and
// a one-way fingerprint of the secret (no address or secret in a public URL).
// clientState is HMAC-SHA256(GRAPH_NOTIFY_CLIENT_STATE, identity), so a
// notification valid for one mailbox can never wake another.
//
// SUBSCRIPTION LIFECYCLE, no new table: Graph is the record. On boot and each
// recovery pass, per mailbox: list the app's subscriptions and take the ones on
// our callback prefix for this mailbox. One is REUSED only when its whole
// configuration matches the current registration (notificationUrl, resource,
// changeType 'created', and clientState / lifecycle URL when Graph returns
// them). Anything else of ours is STALE (a rotated secret, a changed resource
// or change type) and is deleted and replaced; extras from a deploy overlap are
// deleted. Other apps' subscriptions are never touched. The kept one is renewed
// under 36h of a 3-day lifetime; one is created only when none is reusable. Failures
// retry at 2 / 10 / 30 minutes, then wait for recovery. Lifecycle events:
// reauthorizationRequired -> renew; subscriptionRemoved -> recreate; missed ->
// catch-up ingest.
//
// RECOVERY (insurance, not operation; Ed 2026-10-22: no recurring mailbox polling). Every
// GRAPH_PUSH_RECOVERY_HOURS (default 6, minimum 1) re-ensures subscriptions only; no mail is
// read. A Graph DELTA reconciliation of each Inbox runs on boot (covers a deploy gap), on a
// 'missed' lifecycle event, after a subscription is recreated, after a failed notification
// ingest, and once a day. It lists what Graph changed since the stored deltaLink (cron_runs
// job graph_push_delta, summary.delta_link), and only when a new message is not in trustEd does
// it run the same ingestMailbox over that span. The deltaLink advances only after every new
// message is confirmed stored, so a failure is retried from the same point.
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
const JOB_DELTA = 'graph_push_delta';
const DELTA_EVERY_MS = 24 * 3600e3;            // the daily reconciliation
const DELTA_FIRST_LOOKBACK_MS = 26 * 3600e3;   // a first sync covers the last day, not the whole Inbox
const DELTA_MAX_PAGES = 100;
const DELTA_RECOVERY_MAX = 500;

const masterSecret = () => { const s = String(process.env.GRAPH_NOTIFY_CLIENT_STATE || ''); return s.length >= 32 && s.length <= 128 ? s : null; };
// The callback key also carries a one-way fingerprint of the secret, so rotating
// GRAPH_NOTIFY_CLIENT_STATE changes our notificationUrl. That makes a subscription
// created under the old secret detectably stale even if Graph's list omits its
// clientState. The key reveals neither the address nor the secret.
const secretTag = (secret) => (secret ? crypto.createHmac('sha256', secret).update('graph-push-key-v1').digest('hex').slice(0, 16) : 'nosecret');
const keyFor = (identity, secret) => crypto.createHash('sha256').update(String(identity).toLowerCase() + '\n' + secretTag(secret)).digest('hex').slice(0, 16);
const clientStateFor = (secret, identity) => crypto.createHmac('sha256', secret).update(String(identity).toLowerCase()).digest('hex');
function recoveryMs() { const h = parseFloat(process.env.GRAPH_PUSH_RECOVERY_HOURS); return Math.max(1, Number.isFinite(h) ? h : 6) * 3600e3; }
function baseUrl() { return String(process.env.GRAPH_NOTIFY_BASE_URL || require('../brand').tech.appUrl).replace(/\/+$/, ''); }
// Graph treats the user segment and path names case-insensitively; compare the whole resource that way.
const sameResource = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
// Why an existing subscription on our callback is not reusable, or null when it is. Fields Graph
// omits from a list response (clientState, lifecycleNotificationUrl) cannot disqualify; a rotated
// secret is still caught because it changes our notificationUrl (secretTag in the key).
function staleReason(s, m) {
  if (s.notificationUrl !== m.notificationUrl) return 'notification_url';
  if (!sameResource(s.resource, m.resource)) return 'resource';
  const types = String(s.changeType || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).sort().join(',');
  if (types !== 'created') return 'change_type';
  if (s.clientState != null && s.clientState !== m.clientState) return 'client_state';
  if (s.lifecycleNotificationUrl != null && s.lifecycleNotificationUrl !== m.lifecycleNotificationUrl) return 'lifecycle_url';
  return null;
}
const isCurrent = (s, m) => staleReason(s, m) === null;
function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// Friendly address -> underlying Graph identity. Only aliases verified in graph_send are listed.
function knownAliases(gs) { return { 'amanda@bedrocktx.com': gs.AMANDA_MAILBOX }; }

// Resolve GRAPH_PUSH_MAILBOXES into allowed, de-duplicated mailbox identities.
// The desks' mailboxes plus every ingest mailbox that existing routing (persona.js) gives to a
// desk agent. Derived, not listed: a desk or routing change carries over by itself.
function deskMailboxes(gs = require('./graph_send')) {
  const desks = new Set(require('../team/roster').deskAgents().map((m) => m.persona));
  const { personaForMessage } = require('./persona');
  return (gs.TEAM_INGEST_MAILBOXES || []).filter((mbx) => {
    try { return desks.has(personaForMessage({ mailbox: mbx, direction: 'inbound', subject: '', sender_email: 'someone@example.com', classification: 'other', extracted: {} })); }
    catch (_) { return false; }
  });
}

// Intake mailboxes that feed a desk through their own workflow: welcome@ (website inquiries).
function intakeMailboxes(gs = require('./graph_send')) {
  const allowed = new Set((gs.TEAM_INGEST_MAILBOXES || []).map((m) => String(m).toLowerCase()));
  return [require('./website_inquiry').INTAKE_MAILBOX].filter((m) => allowed.has(String(m).toLowerCase()));
}

function resolveRegistry(raw, gs = require('./graph_send'), { includeDesks = false } = {}) {
  const allowed = new Map((gs.TEAM_INGEST_MAILBOXES || []).map((m) => [String(m).toLowerCase(), m]));
  const aliases = knownAliases(gs);
  const mailboxes = []; const refused = []; const seen = new Set();
  const entries = [...(includeDesks ? [...deskMailboxes(gs), ...intakeMailboxes(gs)] : []), ...String(raw || '').split(',')].map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  for (const entry of entries) {
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
    // One page of an Inbox delta (full URL: the first-sync URL, a nextLink or a deltaLink).
    async delta(url) {
      const token = await require('./graph_send').getToken();
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'odata.maxpagesize=50' } });
      if (!r.ok) { const e = new Error(`Graph delta failed (${r.status}): ${(await r.text().catch(() => '')).slice(0, 200)}`); e.status = r.status; throw e; }
      return r.json();
    },
    async list() { const out = []; let url = G; while (url) { const j = await call('GET', url); out.push(...(j.value || [])); url = j['@odata.nextLink'] || null; } return out; },
    create: (body) => call('POST', G, body),
    renew: (id, expirationDateTime) => call('PATCH', `${G}/${encodeURIComponent(id)}`, { expirationDateTime }),
    remove: (id) => call('DELETE', `${G}/${encodeURIComponent(id)}`),
  };
}

// Tessa's handler, shaped like an ingest summary. A read failure throws, so push retries by delta.
async function ownerInboxIngest(_mbx, { max = 25 } = {}) {
  const out = await require('../ea/tessa_inbox').pollTessaInbox({ max: Math.min(50, max), mode: 'tessa' });
  if (out && out.error) throw new Error('tessa inbox: ' + out.error);
  return { ...out, kept: (out && out.drafted) || 0 };
}

function createGraphPush(deps = {}) {
  const graph = deps.graph || realGraph();
  const ingest = deps.ingestMailbox || ((mbx, o) => require('./graph_ingest').ingestMailbox(mbx, o));
  const ownerIngest = deps.ownerIngest || ownerInboxIngest;
  const secret = deps.secret !== undefined ? deps.secret : masterSecret();
  const base = deps.baseUrl || baseUrl();
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const schedule = deps.setTimeout || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });

  const db = () => deps.supabase || (() => { try { return require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY); } catch (_) { return null; } })();
  async function record(job, ok, summary, error) {
    const sb = db();
    if (!sb) return;
    try {
      const t = new Date(now()).toISOString();
      const { error: e } = await sb.from('cron_runs').insert({ job_name: job, started_at: t, finished_at: t, ok, summary, error: error || null, triggered_by: 'graph_push' });
      if (e) log.warn('[graph_push] cron_runs insert failed:', e.message);
    } catch (e) { log.warn('[graph_push] cron_runs insert threw:', e.message); }
  }

  // One entry per underlying mailbox identity.
  const byKey = new Map();
  const team = new Set((deps.mailboxes || []).map((x) => String(x).toLowerCase()));
  const entries = [...(deps.mailboxes || []).map((mailbox) => ({ mailbox, owner: false })),
    ...(deps.ownerMailboxes || []).filter((x) => x && !team.has(String(x).toLowerCase())).map((mailbox) => ({ mailbox, owner: true }))];
  for (const { mailbox, owner } of entries) {
    const key = keyFor(mailbox, secret);
    if (byKey.has(key)) continue;
    byKey.set(key, {
      key, mailbox, owner,
      resource: `users/${mailbox}/mailFolders('inbox')/messages`,
      notificationUrl: base + NOTIFY_PATH + key,
      lifecycleNotificationUrl: base + LIFECYCLE_PATH + key,
      clientState: secret ? clientStateFor(secret, mailbox) : null,
      sub: { id: null, expiresAt: null, retry: 0 }, ensuring: null,
      run: { running: false, pending: false, last: null },
      delta: { running: null, lastAt: null, retry: 0 },
    });
  }

  // ---- subscription lifecycle (single flight per mailbox) ----
  function ensureSubscription(m, opts = {}) {
    if (!m.ensuring) m.ensuring = ensureOnce(m, opts).finally(() => { m.ensuring = null; });
    return m.ensuring;
  }
  async function ensureOnce(m, { forceRenew = false } = {}) {
    const hadSub = !!m.sub.id || m.sub.retry > 0;   // a previous subscription, or failed attempts: a possible gap
    try {
      // Ours for this mailbox: our callback prefix AND (our exact URL, or this mailbox's resource,
      // e.g. a subscription made under a rotated secret). Anything else is never touched.
      const ours = (await graph.list()).filter((s) => String(s.notificationUrl || '').startsWith(base + NOTIFY_PATH)
        && (s.notificationUrl === m.notificationUrl || sameResource(s.resource, m.resource)));
      // Reusable only when its whole effective configuration matches this registration.
      const reusable = ours.filter((s) => isCurrent(s, m));
      reusable.sort((a, b) => Date.parse(b.expirationDateTime || 0) - Date.parse(a.expirationDateTime || 0));
      const [keep, ...extra] = reusable;
      const stale = ours.filter((s) => !isCurrent(s, m));
      for (const [s, action] of [...stale.map((s) => [s, 'deleted_stale']), ...extra.map((s) => [s, 'deleted_duplicate'])]) {
        try { await graph.remove(s.id); await record(JOB_SUB, true, { mailbox: m.mailbox, action, id: s.id, reason: action === 'deleted_stale' ? staleReason(s, m) : undefined }); }
        catch (e) { log.warn(`[graph_push] ${m.mailbox} ${action} subscription delete failed:`, e.message); }
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
      if (action === 'created' && hadSub) reconcile(m, 'resubscribed').catch(() => {});
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
      const s = await (m.owner ? ownerIngest : ingest)(m.mailbox, { sinceISO, light: false, onlyLinked: false, max: 50, fileBacklog: false });
      if (s && s.kept > 0) { log.log(`[graph_push] ${reason}: ${s.kept} new message(s) in ${m.mailbox}`); await record(JOB_INGEST, true, { reason, mailbox: m.mailbox, since: sinceISO, ...s }); }
      return s;
    } catch (e) {
      log.error(`[graph_push] ${m.mailbox} ${reason} ingest failed (nothing processed past the failure; delta reconciliation in 2 min):`, e.message);
      await record(JOB_INGEST, false, { reason, mailbox: m.mailbox, since: sinceISO }, String(e.message).slice(0, 500));
      schedule(() => { reconcile(m, 'ingest_failed').catch(() => {}); }, RETRY_MS[0]);
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
      else if (n.lifecycleEvent === 'subscriptionRemoved') ensureSubscription(m).then(() => reconcile(m, 'subscription_removed')).catch(() => {});
      else if (n.lifecycleEvent === 'missed') reconcile(m, 'missed').catch(() => {});
    }
    if (rejected) log.warn(`[graph_push] ignored ${rejected} lifecycle notification(s) for ${m.mailbox} (bad clientState)`);
    return { accepted, rejected };
  }

  // ---- delta reconciliation: what Graph changed in the Inbox since the stored deltaLink ----
  function firstDeltaUrl(m, filtered = true) {
    const sel = '$select=id,internetMessageId,receivedDateTime,from&changeType=created';
    const since = new Date(now() - DELTA_FIRST_LOOKBACK_MS).toISOString();
    return `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m.mailbox)}/mailFolders('inbox')/messages/delta?${sel}${filtered ? `&$filter=receivedDateTime ge ${since}` : ''}`;
  }
  async function loadDeltaLink(m) {
    if (deps.loadDeltaLink) return deps.loadDeltaLink(m.mailbox);
    const sb = db(); if (!sb) throw new Error('no database');
    const { data, error } = await sb.from('cron_runs').select('summary').eq('job_name', JOB_DELTA).eq('ok', true)
      .eq('summary->>mailbox', m.mailbox).order('started_at', { ascending: false }).limit(1);
    if (error) throw new Error('delta state lookup failed: ' + error.message);
    return (data && data[0] && data[0].summary && data[0].summary.delta_link) || null;
  }
  // Message ids already processed (same rule as ingest: a light backfill placeholder is not done).
  async function storedIds(ids, m) {
    if (m && m.owner) return ownerStoredIds(ids);
    if (deps.storedIds) return deps.storedIds(ids);
    const sb = db(); if (!sb) throw new Error('no database');
    const done = new Set();
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await sb.from('email_messages').select('internet_message_id, extracted').in('internet_message_id', ids.slice(i, i + 100));
      if (error) throw new Error('stored-message lookup failed: ' + error.message);
      for (const r of data || []) if (!(r.extracted && r.extracted.backfill === true)) done.add(r.internet_message_id);
    }
    return done;
  }
  // Tessa's mail is stored in ea_inbox by Graph id (it has no email_messages row, by design).
  async function ownerStoredIds(ids) {
    if (deps.ownerStoredIds) return deps.ownerStoredIds(ids);
    const sb = db(); if (!sb) throw new Error('no database');
    const done = new Set();
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await sb.from('ea_inbox').select('graph_id').in('graph_id', ids.slice(i, i + 100));
      if (error) throw new Error('stored-message lookup failed: ' + error.message);
      for (const r of data || []) done.add(r.graph_id);
    }
    return done;
  }
  async function readDelta(m, url) {
    const added = []; let deltaLink = null; let pages = 0;
    while (url) {
      if (++pages > DELTA_MAX_PAGES) throw new Error(`delta exceeded ${DELTA_MAX_PAGES} pages`);
      const j = await graph.delta(url);
      for (const v of j.value || []) {
        const from = String((v.from && v.from.emailAddress && v.from.emailAddress.address) || '').toLowerCase();
        if (!v['@removed'] && v.internetMessageId && from !== String(m.mailbox).toLowerCase()) added.push(v);
      }
      deltaLink = j['@odata.deltaLink'] || deltaLink;
      url = j['@odata.nextLink'] || null;
    }
    if (!deltaLink) throw new Error('delta returned no deltaLink');
    return { added, deltaLink };
  }
  function reconcile(m, reason) {
    if (!m.delta.running) m.delta.running = reconcileOnce(m, reason).finally(() => { m.delta.running = null; });
    return m.delta.running;
  }
  async function reconcileOnce(m, reason) {
    try {
      const stored = await loadDeltaLink(m);
      let read; let restarted = false;
      try { read = await readDelta(m, stored || firstDeltaUrl(m)); }
      catch (e) {
        if (stored && [404, 410].includes(e.status)) { restarted = true; read = await readDelta(m, firstDeltaUrl(m)); }   // sync state expired: start over from the last day
        else if (!stored && e.status === 400) { restarted = true; read = await readDelta(m, firstDeltaUrl(m, false)); }   // filter refused: the Inbox is small (zero-inbox)
        else throw e;
      }
      const idOf = (v) => (m.owner ? v.id : v.internetMessageId);
      const ids = read.added.map(idOf);
      const done = ids.length ? await storedIds(ids, m) : new Set();
      const missing = read.added.filter((v) => !done.has(idOf(v)));
      let recovered = 0;
      if (missing.length) {
        const oldest = Math.min(...missing.map((v) => Date.parse(v.receivedDateTime)).filter(Number.isFinite));
        const sinceISO = new Date((Number.isFinite(oldest) ? oldest : now() - DELTA_FIRST_LOOKBACK_MS) - 5 * 60e3).toISOString();
        const s = await (m.owner ? ownerIngest : ingest)(m.mailbox, { sinceISO, light: false, onlyLinked: false, max: DELTA_RECOVERY_MAX, fileBacklog: false });
        recovered = (s && s.kept) || 0;
        const after = await storedIds(missing.map(idOf), m);
        const still = missing.filter((v) => !after.has(idOf(v))).length;
        if (still) throw new Error(`${still} new message(s) still not in trustEd after the recovery ingest`);
        log.warn(`[graph_push] ${m.mailbox} delta (${reason}) found ${missing.length} message(s) push had not delivered; recovered ${recovered}`);
      }
      m.delta.lastAt = now(); m.delta.retry = 0;
      await record(JOB_DELTA, true, { mailbox: m.mailbox, reason, delta_link: read.deltaLink, changes: read.added.length, missing: missing.length, recovered, restarted });
      return { ok: true, changes: read.added.length, missing: missing.length, recovered };
    } catch (e) {
      const wait = RETRY_MS[m.delta.retry] || null; m.delta.retry += 1;
      log.error(`[graph_push] ${m.mailbox} delta (${reason}) failed${wait ? `; retrying in ${wait / 60e3} min` : '; next try at the next recovery pass'}:`, e.message);
      await record(JOB_DELTA, false, { mailbox: m.mailbox, reason, retry_in_min: wait ? wait / 60e3 : null }, String(e.message).slice(0, 500));
      if (wait) schedule(() => { reconcile(m, 'retry').catch(() => {}); }, wait);
      return { ok: false, error: e.message };
    }
  }

  // Recovery: re-ensure each subscription (no mail read); delta-reconcile on boot and once a day.
  async function recover(reason = 'recovery') {
    // Amanda controlled send rides this pass (no timer of its own): finish or escalate any
    // automatic-reply receipt a crash or deploy left open. One DB query when none are open.
    if (!deps.skipAutoReplySweep) {
      try { await require('../amanda/auto_reply').getAutoReply().sweep(); }
      catch (e) { log.warn('[graph_push] amanda auto-reply sweep failed:', e.message); }
    }
    const out = [];
    for (const m of byKey.values()) {
      await ensureSubscription(m);
      if (reason === 'boot') out.push(reconcile(m, 'boot'));
      else if (!m.delta.lastAt || now() - m.delta.lastAt >= DELTA_EVERY_MS) out.push(reconcile(m, 'daily'));
    }
    return Promise.all(out);
  }

  return { handleNotifications, handleLifecycle, recover, ensureSubscription: (mbx, o) => ensureSubscription(entryFor(mbx), o),
    requestIngest: (mbx, r, w) => requestIngest(entryFor(mbx), r, w), reconcile: (mbx, r) => reconcile(entryFor(mbx), r || 'manual'), entries: () => [...byKey.values()], keyFor: (mbx) => keyFor(mbx, secret) };
  function entryFor(mbx) { const m = byKey.get(keyFor(mbx, secret)); if (!m) throw new Error('mailbox not registered: ' + mbx); return m; }
}

let _instance = null; let _timer = null;
function config() {
  const on = String(process.env.GRAPH_PUSH || '').toLowerCase() === 'on';
  const { mailboxes, refused } = resolveRegistry(process.env.GRAPH_PUSH_MAILBOXES, undefined, { includeDesks: true });
  return { on, secretOk: !!masterSecret(), mailboxes, ownerMailboxes: ownerMailboxes(), refused };
}
// Tessa's mailbox, when set and NOT an ingest mailbox (her mail must never reach email_messages).
function ownerMailboxes(gs = require('./graph_send')) {
  const t = gs.TESSA_MAILBOX; if (!t) return [];
  const team = new Set((gs.TEAM_INGEST_MAILBOXES || []).map((x) => String(x).toLowerCase()));
  return team.has(String(t).toLowerCase()) ? [] : [t];
}
// The routes always exist; with push off (or before start) every request is a 202 no-op.
const getGraphPush = () => _instance;
function startGraphPush() {
  const c = config();
  if (c.refused.length) console.warn('[graph_push] refused GRAPH_PUSH_MAILBOXES entries (not an ingest mailbox identity or known alias):', c.refused.join(', '));
  if (!c.on || !c.secretOk || !c.mailboxes.length) { console.log('[graph_push] off (needs GRAPH_PUSH=on and GRAPH_NOTIFY_CLIENT_STATE 32-128 chars)'); return null; }
  if (!require('./graph_send').isConfigured()) { console.log('[graph_push] off: Graph not configured'); return null; }
  if (_timer) return _timer;
  _instance = createGraphPush({ mailboxes: c.mailboxes, ownerMailboxes: c.ownerMailboxes });
  console.log(`[graph_push] on for ${[...c.mailboxes, ...c.ownerMailboxes.map((x) => x + ' (owner-only, Tessa)')].join(', ')}; subscription check every ${recoveryMs() / 3600e3}h; delta reconciliation on boot and daily`);
  // A few seconds after listen, so Graph's validation call on create reaches a live route.
  const t = setTimeout(() => { _instance.recover('boot').catch((e) => console.error('[graph_push] boot recovery threw:', e.message)); }, 5000);
  if (t.unref) t.unref();
  _timer = setInterval(() => { _instance.recover('recovery').catch((e) => console.error('[graph_push] recovery threw:', e.message)); }, recoveryMs());
  if (_timer.unref) _timer.unref();
  return _timer;
}

module.exports = { createGraphPush, getGraphPush, startGraphPush, resolveRegistry, deskMailboxes, intakeMailboxes, ownerMailboxes, config, keyFor, clientStateFor, staleReason, safeEqual, recoveryMs,
  NOTIFY_PATH, LIFECYCLE_PATH, SUB_LIFETIME_MS, RENEW_WITHIN_MS, NOTIFY_WINDOW_MS, JOB_INGEST, JOB_SUB, JOB_DELTA, DELTA_EVERY_MS };
