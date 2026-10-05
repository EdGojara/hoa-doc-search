// lib/amanda/auto_reply.js  (Issue #29, Amanda controlled send, 2026-10-04)
// ----------------------------------------------------------------------------
// event -> objective -> AUTHORITY -> EXECUTION -> VERIFICATION -> AUDIT -> ESCALATION -> sleep
//
// The model wrote Amanda's reply (shared request contract). This module decides
// whether it may go out (lib/amanda/reply_policy.js), sends it ONCE as a
// same-thread reply from Amanda's mailbox, proves it reached Sent Items, records
// the receipt and timeline, and escalates to a person when anything is unsure.
//
// RECEIPT: outbound_email_drafts row, draft_kind 'amanda_auto_reply',
// source_email_ref 'email:<inbound internet_message_id>' (unique across every
// status, migration 490). The INSERT is the claim; a duplicate claim stops.
//
// STATES: claimed -> draft_created -> draft_ready -> send_requested -> sent,
// or unverified / failed (human review). send_requested is written BEFORE Graph
// /send: from then on /send may have been accepted, so recovery only VERIFIES and
// never sends again, whatever crashed or timed out.
//
// LEASE: every transition is a compare-and-set on (id, status, lease_token). A
// worker that loses the race stops. Takeover only after lease_expires_at.
//
// OWNERSHIP MARKER: the reply draft carries a TrustEd single-value extended
// property (MAPI named property, not recipient-visible) holding the receipt key,
// set in the createReply request itself and confirmed (or PATCHed) right after.
// Recovery adopts a draft ONLY by that marker. Drafts found merely by conversation
// and time are evidence, never proof: recovery does not adopt or delete them, it
// escalates. This module never deletes a draft.
//
// RECOVERY runs inline, from in-process verification follow-ups, from a boot
// sweep, and from the 6-hour Graph push recovery pass. No new polling timer; an
// idle system makes no Graph or model calls here.
// ----------------------------------------------------------------------------
const crypto = require('crypto');
const policy = require('./reply_policy');

const KIND = 'amanda_auto_reply';
const MARKER_PROP = 'String {7c1d5e3a-2b4f-4c8e-9a6d-3f5b8e1c2d4a} Name TrustEdReceiptKey';
const LEASE_MS = 2 * 60e3;
const MAX_ATTEMPTS = 3;
const VERIFY_DELAYS = [30e3, 120e3, 600e3, 3600e3];
const OPEN = ['claimed', 'draft_created', 'draft_ready', 'send_requested', 'unverified'];
const PRE_SEND = ['claimed', 'draft_created', 'draft_ready'];

const keyFor = (internetMessageId) => `email:${internetMessageId}`;
const markerHtml = (key) => `data-trusted-receipt="${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}"`;

// ---- real Microsoft Graph operations (injected in tests) ----
function realGraph() {
  const { getToken } = require('../email/graph_send');
  const { graphSendError } = require('../email/graph_errors');
  const U = (mbx) => `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mbx)}`;
  async function call(method, url, body, step) {
    const token = await getToken();
    const r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'IdType="ImmutableId"' }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 404) return { status: 404, json: null };
    if (!r.ok && r.status !== 202) throw graphSendError(step || method, r.status, await r.text().catch(() => ''));
    const t = await r.text().catch(() => '');
    return { status: r.status, json: t ? JSON.parse(t) : null };
  }
  const flt = (s) => encodeURIComponent(s);
  return {
    async messageMeta(mbx, id) {
      const r = await call('GET', `${U(mbx)}/messages/${encodeURIComponent(id)}?$select=internetMessageHeaders,toRecipients,ccRecipients,conversationId`, null, 'read message');
      if (!r.json) return null;
      const addrs = (l) => (l || []).map((x) => x.emailAddress && x.emailAddress.address).filter(Boolean);
      return { headers: r.json.internetMessageHeaders || [], to: addrs(r.json.toRecipients), cc: addrs(r.json.ccRecipients), conversationId: r.json.conversationId };
    },
    // The inbound message by its STABLE internetMessageId, returned as an IMMUTABLE id (survives
    // ingest filing / rule moves within the mailbox). Never a draft, never our own sent copy.
    async findByInternetMessageId(mbx, imid) {
      const f = `internetMessageId eq '${String(imid).replace(/'/g, "''")}'`;
      const r = await call('GET', `${U(mbx)}/messages?$filter=${flt(f)}&$select=id,isDraft,parentFolderId&$top=5`, null, 'find source message');
      const sent = ((r.json && r.json.value) || []).filter((m) => !m.isDraft);
      return sent.length ? sent[0].id : null;
    },
    async createReply(mbx, sourceId, key) {
      const r = await call('POST', `${U(mbx)}/messages/${encodeURIComponent(sourceId)}/createReply`,
        { message: { singleValueExtendedProperties: [{ id: MARKER_PROP, value: key }] } }, 'createReply');
      return r.json ? { id: r.json.id, internetMessageId: r.json.internetMessageId || null, conversationId: r.json.conversationId || null } : null;
    },
    async getMessage(mbx, id) {
      const r = await call('GET', `${U(mbx)}/messages/${encodeURIComponent(id)}?$select=id,isDraft,parentFolderId,internetMessageId,conversationId,sentDateTime,createdDateTime,body&$expand=singleValueExtendedProperties($filter=id eq '${MARKER_PROP}')`, null, 'read draft');
      if (!r.json) return null;
      const ep = (r.json.singleValueExtendedProperties || [])[0];
      return { id: r.json.id, isDraft: r.json.isDraft, parentFolderId: r.json.parentFolderId, internetMessageId: r.json.internetMessageId || null,
        conversationId: r.json.conversationId, sentDateTime: r.json.sentDateTime, body: (r.json.body && r.json.body.content) || '', marker: ep ? ep.value : null };
    },
    async setMarker(mbx, id, key) { await call('PATCH', `${U(mbx)}/messages/${encodeURIComponent(id)}`, { singleValueExtendedProperties: [{ id: MARKER_PROP, value: key }] }, 'mark draft'); },
    async findOwnedDrafts(mbx, key) {
      const f = `singleValueExtendedProperties/Any(ep: ep/id eq '${MARKER_PROP}' and ep/value eq '${String(key).replace(/'/g, "''")}')`;
      const r = await call('GET', `${U(mbx)}/mailFolders/drafts/messages?$filter=${flt(f)}&$select=id,createdDateTime`, null, 'find owned drafts');
      return ((r.json && r.json.value) || []).map((m) => ({ id: m.id, createdDateTime: m.createdDateTime }));
    },
    async findConversationDrafts(mbx, conversationId) {
      const r = await call('GET', `${U(mbx)}/mailFolders/drafts/messages?$filter=${flt(`conversationId eq '${String(conversationId).replace(/'/g, "''")}'`)}&$select=id,createdDateTime`, null, 'find conversation drafts');
      return ((r.json && r.json.value) || []).map((m) => ({ id: m.id, createdDateTime: m.createdDateTime }));
    },
    async patchBody(mbx, id, html) { await call('PATCH', `${U(mbx)}/messages/${encodeURIComponent(id)}`, { body: { contentType: 'HTML', content: html } }, 'patch reply'); },
    async listAttachments(mbx, id) { const r = await call('GET', `${U(mbx)}/messages/${encodeURIComponent(id)}/attachments?$select=name,contentId`, null, 'list attachments'); return ((r.json && r.json.value) || []).map((a) => ({ name: a.name, contentId: a.contentId })); },
    async addAttachment(mbx, id, a) { await call('POST', `${U(mbx)}/messages/${encodeURIComponent(id)}/attachments`, a, 'attach'); },
    async send(mbx, id) { const r = await call('POST', `${U(mbx)}/messages/${encodeURIComponent(id)}/send`, null, 'send reply'); return { status: r.status }; },
    async sentItemsId(mbx) { const r = await call('GET', `${U(mbx)}/mailFolders/sentitems?$select=id`, null, 'sent items'); return r.json && r.json.id; },
  };
}

class LeaseLost extends Error { constructor(m) { super(m || 'lease_lost'); this.code = 'lease_lost'; } }

function createAutoReply(deps = {}) {
  const db = deps.supabase || require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const graph = deps.graph || realGraph();
  const mailbox = deps.mailbox || require('../email/graph_send').AMANDA_MAILBOX;
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const schedule = deps.setTimeout || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });
  const env = deps.env || process.env;
  const buildEmail = deps.buildEmail || ((text, commName) => require('../email/amanda_signature').buildAmandaEmail(text, commName, ''));
  const iso = (ms) => new Date(ms).toISOString();
  const token = () => crypto.randomUUID();

  async function cron(ok, summary, error) {
    try { const t = iso(now()); const { error: e } = await db.from('cron_runs').insert({ job_name: 'amanda_auto_reply', started_at: t, finished_at: t, ok, summary, error: error || null, triggered_by: 'amanda_auto_reply' }); if (e) log.warn('[amanda_auto_reply] cron_runs insert failed:', e.message); }
    catch (e) { log.warn('[amanda_auto_reply] cron_runs insert threw:', e.message); }
  }

  // ---- AUTHORITY (before the inbound row is written; stored on the draft) ----
  async function decide({ email, draft, contract, classification }) {
    const base = { env, mailbox: email && email.mailbox, amandaMailbox: mailbox, email, classification, draft, contract };
    if (!policy.worthChecking({ env, mailbox: base.mailbox, amandaMailbox: mailbox, email })) {
      return policy.decideAmandaReply({ ...base, authAs: null, toRecipients: [], ccRecipients: [] });   // REVIEW, no Graph call
    }
    if (!email.internet_message_id || !email.graph_id) return { class: 'REVIEW', reasons: ['no_message_identity'], policy_version: policy.POLICY_VERSION };
    let meta = null; let recent = 0;
    try { meta = await graph.messageMeta(mailbox, email.graph_id); } catch (e) { log.warn('[amanda_auto_reply] header read failed:', e.message); }
    try {
      const { count, error } = await db.from('outbound_email_drafts').select('id', { count: 'exact', head: true })
        .eq('draft_kind', KIND).eq('to_email', String(email.sender_email || '').toLowerCase()).gte('created_at', iso(now() - 3600e3));
      if (error) throw error; recent = count || 0;
    } catch (e) { return { class: 'REVIEW', reasons: ['rate_check_failed'], policy_version: policy.POLICY_VERSION }; }   // fail closed
    return policy.decideAmandaReply({ ...base, authAs: meta ? policy.authAsFrom(meta.headers) : null,
      toRecipients: meta ? meta.to : [], ccRecipients: meta ? meta.cc : [], recentAutoReplies: recent });
  }

  // ---- receipt helpers ----
  async function load(id) { const { data, error } = await db.from('outbound_email_drafts').select('*').eq('id', id).single(); if (error) throw error; return data; }
  async function cas(rec, fromStatus, patch) {
    const lease = { lease_expires_at: iso(now() + LEASE_MS) };
    const { data, error } = await db.from('outbound_email_drafts').update({ ...patch, ...lease })
      .eq('id', rec.id).eq('status', fromStatus).eq('lease_token', rec.lease_token).select('*');
    if (error) throw error;
    if (!data || data.length !== 1) throw new LeaseLost(`${fromStatus} -> ${patch.status || fromStatus}`);
    return data[0];
  }
  async function takeOver(rec) {
    const t = token();
    const { data, error } = await db.from('outbound_email_drafts').update({ lease_token: t, lease_expires_at: iso(now() + LEASE_MS) })
      .eq('id', rec.id).eq('lease_token', rec.lease_token).lt('lease_expires_at', iso(now())).select('*');
    if (error) throw error;
    return data && data.length === 1 ? data[0] : null;
  }

  // ---- EXECUTION: claim, then drive the state machine ----
  async function execute({ inbound, draft, decision, contract, communityName }) {
    if (!decision || decision.class !== 'EXECUTE') return { skipped: 'not_execute' };
    const row = {
      draft_kind: KIND, source_email_ref: keyFor(inbound.internet_message_id), status: 'claimed',
      persona: 'amanda', from_mailbox: mailbox, to_email: String(inbound.sender_email || '').toLowerCase(), to_name: inbound.sender_name || null,
      subject: /^re:/i.test(inbound.subject || '') ? inbound.subject : `Re: ${inbound.subject || ''}`,
      body_text: draft.body, related_type: 'email_triage', related_id: inbound.id, ai_drafted: true,
      draft_reason: 'Amanda automatic reply (authority gate EXECUTE)', disposition: 'auto_ok',
      lease_token: token(), lease_expires_at: iso(now() + LEASE_MS), claimed_at: iso(now()), attempts: 0,
      conversation_id: inbound.conversation_id || null, inbound_email_id: inbound.id,
      objective_id: (contract && contract.objective && contract.objective.id) || null,
      community_name: communityName || null, policy: decision,
    };
    const { data, error } = await db.from('outbound_email_drafts').insert(row).select('*').single();
    if (error) {
      if (error.code === '23505') { log.log(`[amanda_auto_reply] already claimed: ${row.source_email_ref}`); return { skipped: 'already_claimed' }; }
      log.error('[amanda_auto_reply] claim failed (reply stays a pending draft):', error.message);
      return { skipped: 'claim_failed', error: error.message };
    }
    // No source id handed over: ingest files the message right after the insert, which changes its
    // Graph id (Issue #29 live proof, 2026-10-04). The source is resolved at reply time instead.
    return drive(data);
  }

  // Drive one receipt from its current state as far as it can go now.
  async function drive(rec) {
    try {
      if (rec.status === 'claimed') rec = await stepClaimed(rec);
      if (rec.status === 'draft_created') rec = await stepDraftCreated(rec);
      if (rec.status === 'draft_ready') rec = await stepSend(rec);
      if (rec.status === 'send_requested' || rec.status === 'unverified') return await verify(rec);
      return { status: rec.status };
    } catch (e) {
      if (e.code === 'lease_lost') { log.log('[amanda_auto_reply] another worker owns this receipt; stopping'); return { skipped: 'lease_lost' }; }
      return failPreSend(rec, e);
    }
  }

  async function stepClaimed(rec) {
    if (rec.attempts >= MAX_ATTEMPTS) return escalate(rec, 'failed', `gave up after ${rec.attempts} attempts`, true);
    // 1) A draft we own (by marker) may already exist: crash after createReply, before the id was stored.
    const owned = await graph.findOwnedDrafts(mailbox, rec.source_email_ref);
    if (owned.length === 1) return cas(rec, 'claimed', { status: 'draft_created', graph_draft_id: owned[0].id });
    if (owned.length > 1) return escalate(rec, 'unverified', `found ${owned.length} TrustEd reply drafts for this message; a person must choose`, true);
    // 2) Unmarked drafts in the conversation since the claim are NOT ours by proof: never adopt or delete.
    if (rec.conversation_id) {
      const conv = (await graph.findConversationDrafts(mailbox, rec.conversation_id)).filter((d) => !rec.claimed_at || Date.parse(d.createdDateTime) >= Date.parse(rec.claimed_at) - 60e3);
      if (conv.length) return escalate(rec, 'unverified', `found ${conv.length} unmarked draft(s) in this conversation; not adopting or deleting`, true);
    }
    // 3) Create the reply draft, carrying the ownership marker from the start.
    let sourceGraphId = await resolveSource(rec);
    if (!sourceGraphId) return escalate(rec, 'failed', 'source message not found in Amanda\'s mailbox', true);
    rec = await cas(rec, 'claimed', { attempts: (rec.attempts || 0) + 1 });
    let d = await graph.createReply(mailbox, sourceGraphId, rec.source_email_ref);
    if (!d) {   // 404 = no draft was created: the source moved between resolve and reply. Re-resolve once.
      sourceGraphId = await resolveSource(rec);
      d = sourceGraphId ? await graph.createReply(mailbox, sourceGraphId, rec.source_email_ref) : null;
    }
    if (!d || !d.id) throw new Error('createReply returned no draft (source message not found)');
    return cas(rec, 'claimed', { status: 'draft_created', graph_draft_id: d.id, conversation_id: rec.conversation_id || d.conversationId || null });
  }

  async function stepDraftCreated(rec) {
    const m = await graph.getMessage(mailbox, rec.graph_draft_id);
    if (!m) {   // gone: back to claimed (bounded by attempts)
      return cas(rec, 'draft_created', { status: 'claimed', graph_draft_id: null, last_error: 'reply draft disappeared before send' });
    }
    if (!m.isDraft) {   // someone sent it from Outlook: verify and record
      rec = await cas(rec, 'draft_created', { status: 'unverified', last_error: 'draft was sent outside TrustEd' });
      return rec;
    }
    if (m.marker !== rec.source_email_ref) await graph.setMarker(mailbox, rec.graph_draft_id, rec.source_email_ref);
    const mark = markerHtml(rec.source_email_ref);
    const { html, attachments } = buildEmail(rec.body_text, rec.community_name || '');
    if (!m.body.includes(mark)) await graph.patchBody(mailbox, rec.graph_draft_id, `<div ${mark}>${html}</div>` + m.body);   // once: idempotent on resume
    const have = new Set((await graph.listAttachments(mailbox, rec.graph_draft_id)).map((a) => `${a.name}|${a.contentId || ''}`));
    for (const a of attachments || []) if (!have.has(`${a.name}|${a.contentId || ''}`)) await graph.addAttachment(mailbox, rec.graph_draft_id, a);
    return cas(rec, 'draft_created', { status: 'draft_ready' });
  }

  async function stepSend(rec) {
    rec = await cas(rec, 'draft_ready', { status: 'send_requested', send_requested_at: iso(now()) });   // write-ahead
    try {
      await graph.send(mailbox, rec.graph_draft_id);
      return cas(rec, 'send_requested', { status: 'unverified' });
    } catch (e) {
      // /send may or may not have been accepted: never resend; verification decides.
      try { return await cas(rec, 'send_requested', { status: 'unverified', last_error: String(e.message).slice(0, 500) }); }
      catch (_) { return rec; }
    }
  }

  // ---- VERIFICATION: Sent Items, by the draft's immutable id ----
  async function verify(rec) {
    const m = rec.graph_draft_id ? await graph.getMessage(mailbox, rec.graph_draft_id) : null;
    const sentFolder = m && !m.isDraft ? await graph.sentItemsId(mailbox) : null;
    if (m && !m.isDraft && m.parentFolderId === sentFolder) return recordSent(rec, m);
    const checks = (rec.verify_checks || 0) + 1;
    const { error } = await db.from('outbound_email_drafts').update({ verify_checks: checks }).eq('id', rec.id).in('status', ['send_requested', 'unverified']);
    if (error) log.warn('[amanda_auto_reply] verify_checks update failed:', error.message);
    if (checks > VERIFY_DELAYS.length) return escalate({ ...rec, verify_checks: checks }, 'unverified', 'sent copy not found in Amanda\'s Sent Items after bounded checks; never resending', false);
    schedule(() => { load(rec.id).then((r) => (OPEN.includes(r.status) && !r.escalated_at ? verify(r) : null)).catch((e) => log.warn('[amanda_auto_reply] follow-up verify failed:', e.message)); }, VERIFY_DELAYS[checks - 1]);
    return { status: rec.status, verify_checks: checks, pending_verification: true };
  }

  async function recordSent(rec, m) {
    const { data, error } = await db.from('outbound_email_drafts').update({
      status: 'sent', verified_at: iso(now()), sent_at: m.sentDateTime || iso(now()), sent_from: mailbox,
      sent_internet_message_id: m.internetMessageId || null, lease_token: null,
    }).eq('id', rec.id).in('status', ['send_requested', 'unverified']).select('id');
    if (error) throw error;
    if (!data || data.length !== 1) return { status: 'sent', duplicate_verify: true };   // another verifier recorded it
    const when = m.sentDateTime || iso(now());
    // Inbound: handled, draft marked sent (re-read by internet_message_id: the row may have been re-ingested).
    const imid = String(rec.source_email_ref).replace(/^email:/, '');
    const { data: inRows } = await db.from('email_messages').select('id, extracted, community_id, conversation_id').eq('internet_message_id', imid).eq('direction', 'inbound');
    for (const r of inRows || []) {
      const ex = r.extracted || {}; const draft = { ...(ex.draft || {}), status: 'sent', sent_by: 'amanda_auto_reply', receipt_id: rec.id };
      const { error: ue } = await db.from('email_messages').update({ triage_status: 'handled', reviewed_by: 'amanda (automatic reply)', reviewed_at: iso(now()), extracted: { ...ex, draft } }).eq('id', r.id);
      if (ue) log.warn('[amanda_auto_reply] inbound update failed:', ue.message);
    }
    const first = (inRows || [])[0] || {};
    const { error: oe } = await db.from('email_messages').insert({
      mailbox, direction: 'outbound', sender_email: mailbox, sender_name: 'Amanda Albright', recipients: [rec.to_email],
      subject: rec.subject, body_preview: String(rec.body_text || '').slice(0, 2000), body_full: String(rec.body_text || ''),
      conversation_id: first.conversation_id || rec.conversation_id || null, graph_id: m.id, internet_message_id: m.internetMessageId || null,
      received_at: when, sent_at: when, classification: 'outbound_reply', classification_confidence: 'high',
      persona: 'amanda', community_id: first.community_id || null, resolution_confidence: 'high', triage_status: 'handled',
      record_ownership: 'association_record', reviewed_by: 'amanda (automatic reply)', reviewed_at: iso(now()),
    });
    if (oe) log.warn('[amanda_auto_reply] outbound row failed:', oe.message);
    if (rec.objective_id) {
      const { error: ee } = await db.from('objective_events').insert({ objective_id: rec.objective_id, actor: 'amanda', kind: 'message_out', summary: `Sent by email to ${rec.to_email} (receipt ${rec.id})` });
      if (ee) log.warn('[amanda_auto_reply] timeline event failed:', ee.message);
    }
    await cron(true, { action: 'sent', receipt: rec.id, to: rec.to_email, sent_internet_message_id: m.internetMessageId || null });
    log.log(`[amanda_auto_reply] sent and verified: receipt ${rec.id} -> ${rec.to_email}`);
    return { status: 'sent' };
  }

  // ---- ESCALATION: visible to a person; the draft stays available ----
  async function escalate(rec, status, reason, preSend) {
    const patch = { status, escalated_at: iso(now()), last_error: String(reason).slice(0, 500), lease_token: null };
    const q = db.from('outbound_email_drafts').update(patch).eq('id', rec.id).eq('status', rec.status);
    const { error } = rec.lease_token && PRE_SEND.includes(rec.status) ? await q.eq('lease_token', rec.lease_token) : await q;
    if (error) log.warn('[amanda_auto_reply] escalate update failed:', error.message);
    const imid = String(rec.source_email_ref).replace(/^email:/, '');
    const banner = preSend
      ? `Amanda's automatic reply did not go out (${reason}). Review and send this draft yourself.`
      : `Amanda may already have replied automatically (${reason}). Check Amanda's Sent Items before sending.`;
    const { data: inRows } = await db.from('email_messages').select('id, extracted').eq('internet_message_id', imid).eq('direction', 'inbound');
    for (const r of inRows || []) {
      const ex = r.extracted || {}; const draft = { ...(ex.draft || {}), review_hint: `${banner} ${(ex.draft && ex.draft.review_hint) || ''}`.trim(), auto_reply: { receipt_id: rec.id, status } };
      await db.from('email_messages').update({ triage_status: 'needs_review', extracted: { ...ex, draft } }).eq('id', r.id);
    }
    await cron(false, { action: 'escalated', receipt: rec.id, status, pre_send: !!preSend }, reason);
    log.warn(`[amanda_auto_reply] escalated receipt ${rec.id}: ${reason}`);
    return { ...rec, ...patch };
  }
  async function failPreSend(rec, e) {
    log.error('[amanda_auto_reply] step failed:', e.message);
    let cur = rec; try { cur = await load(rec.id); } catch (_) {}
    if (!PRE_SEND.includes(cur.status)) return { status: cur.status, error: e.message };
    if ((cur.attempts || 0) >= MAX_ATTEMPTS || e.temporary === false) return escalate(cur, 'failed', e.message, true);
    const { error } = await db.from('outbound_email_drafts').update({ last_error: String(e.message).slice(0, 500), lease_expires_at: iso(now()) }).eq('id', cur.id).eq('lease_token', cur.lease_token);
    if (error) log.warn('[amanda_auto_reply] lease release failed:', error.message);
    return { status: cur.status, error: e.message, retry_at_recovery: true };
  }
  // The message to reply to, resolved NOW: by its stable internetMessageId (immutable id), else
  // the current stored graph_id only if Graph confirms it still points at a real (non-draft) message.
  async function resolveSource(rec) {
    const imid = String(rec.source_email_ref).replace(/^email:/, '');
    const byImid = await graph.findByInternetMessageId(mailbox, imid);
    if (byImid) return byImid;
    const stored = await inboundGraphId(rec);
    if (!stored) return null;
    const m = await graph.getMessage(mailbox, stored);
    return m && !m.isDraft ? stored : null;
  }
  async function inboundGraphId(rec) {
    const imid = String(rec.source_email_ref).replace(/^email:/, '');
    const { data } = await db.from('email_messages').select('graph_id').eq('internet_message_id', imid).eq('direction', 'inbound').limit(1);
    return data && data[0] ? data[0].graph_id : null;
  }

  // ---- RECOVERY sweep (boot + 6h push recovery; never a polling loop) ----
  async function sweep() {
    const { data, error } = await db.from('outbound_email_drafts').select('*').eq('draft_kind', KIND).in('status', OPEN).is('escalated_at', null).limit(50);
    if (error) { log.warn('[amanda_auto_reply] sweep query failed:', error.message); return { error: error.message }; }
    const out = [];
    for (const rec of data || []) {
      if (rec.status === 'send_requested' || rec.status === 'unverified') { out.push(await verify(rec)); continue; }
      if (rec.lease_expires_at && Date.parse(rec.lease_expires_at) > now()) { out.push({ id: rec.id, skipped: 'lease_live' }); continue; }
      const mine = await takeOver(rec);
      out.push(mine ? await drive(mine) : { id: rec.id, skipped: 'lost_takeover' });
    }
    return out;
  }

  // ---- human override support (POST /api/email-triage/:id/send) ----
  async function receiptFor(internetMessageId) {
    if (!internetMessageId) return null;
    const { data, error } = await db.from('outbound_email_drafts').select('*').eq('draft_kind', KIND).eq('source_email_ref', keyFor(internetMessageId)).maybeSingle();
    if (error) throw error;
    return data || null;
  }
  // One fresh Graph verification before a person may override an unverified receipt.
  async function verifyNow(rec) {
    const m = rec.graph_draft_id ? await graph.getMessage(mailbox, rec.graph_draft_id) : null;
    if (m && !m.isDraft && m.parentFolderId === (await graph.sentItemsId(mailbox))) { await recordSent(rec, m); return 'sent'; }
    return 'unresolved';
  }
  // A person is taking over a pre-send receipt: stop recovery from also sending.
  async function releaseToHuman(rec) {
    const { data, error } = await db.from('outbound_email_drafts').update({ status: 'failed', escalated_at: iso(now()), last_error: 'released to a person (manual send)', lease_token: null })
      .eq('id', rec.id).in('status', [...PRE_SEND, 'failed']).select('id');
    if (error) throw error;
    return !!(data && data.length === 1);
  }

  return { decide, execute, drive, verify, sweep, receiptFor, verifyNow, releaseToHuman, keyFor, MARKER_PROP, KIND };
}

let _default = null;
const getAutoReply = () => (_default || (_default = createAutoReply()));
// Boot sweep: a few seconds after listen. One DB query when nothing is open.
function startAutoReplyRecovery() {
  const t = setTimeout(() => { getAutoReply().sweep().catch((e) => console.error('[amanda_auto_reply] boot sweep threw:', e.message)); }, 8000);
  if (t.unref) t.unref();
}

module.exports = { createAutoReply, getAutoReply, startAutoReplyRecovery, LEASE_MS, MAX_ATTEMPTS, VERIFY_DELAYS, KIND, MARKER_PROP };
