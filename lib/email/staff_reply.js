'use strict';
// ============================================================================
// lib/email/staff_reply.js  (Ed 2026-10-18, PR #225) — Answered by Staff
// ----------------------------------------------------------------------------
// Bedrock staff answer some homeowner mail themselves, in Outlook, sending AS the
// shared mailbox (info@ / welcome@). Those replies land in that mailbox's Sent
// Items. trustEd must recognise them so no AI teammate drafts or sends a second
// answer. This runs ONLY during the manual Pull inbox and as a final check right
// before an approved AI reply is sent. No polling, no background job.
//
// EVIDENCE (lib/email/staff_reply_match.js decides; this file gathers):
//   - the reply: the shared mailbox's own Sent Items (from = the mailbox);
//   - the proof: the journal copy of that exact message (archive1emails@, same
//     internetMessageId) carries In-Reply-To / References. Sent Items copies have
//     no headers in Graph, so the journal is the only header source;
//   - the inbound: trustEd's own stored row (internet_message_id, sender, time).
//   ANSWERED needs all of: shared-mailbox send, addressed to the inbound's sender
//   (or form submitter), sent after it, and a journal header naming it. Anything
//   less is REVIEW (Needs Review), never answered. Read, Archive, Filed, flags,
//   subject lines and conversation ids alone are never evidence. A reply with no
//   outside recipient (an internal forward to emma@ etc.) is not a candidate.
//
// Graph and the store are injected so every rule is testable offline.
// ============================================================================
const { classifyStaffReply, normalizeId } = require('./staff_reply_match');

const DEFAULT_MAILBOXES = ['info@bedrocktx.com', 'welcome@bedrocktx.com'];
const OWN_DOMAIN = /@bedrocktx\.com$/i;
const norm = (v) => String(v || '').trim().toLowerCase();

function staffReplyMailboxes() {
  const env = String(process.env.STAFF_REPLY_MAILBOXES || '').split(',').map(norm).filter(Boolean);
  return env.length ? env : DEFAULT_MAILBOXES;
}
const isStaffReplyMailbox = (mbx) => staffReplyMailboxes().includes(norm(mbx));
const journalMailbox = () => process.env.JOURNAL_MAILBOX || 'archive1emails@bedrocktx.com';

const addrs = (list) => (list || []).map((x) => norm(typeof x === 'string' ? x : (x && x.emailAddress && x.emailAddress.address) || (x && (x.address || x.email)))).filter(Boolean);
// A reply that reaches nobody outside Bedrock (an internal forward) never answers a homeowner.
const hasOutsideRecipient = (r) => [...addrs(r.toRecipients), ...addrs(r.ccRecipients)].some((a) => !OWN_DOMAIN.test(a));

// Who the reply must have gone to: the form submitter for relayed form mail, else the sender.
function expectedRecipients(inbound) {
  const out = new Set();
  if (inbound.sender_email) out.add(norm(inbound.sender_email));
  try {
    const { suggestReplyTo } = require('./reply_recipient');
    const s = suggestReplyTo({ senderEmail: inbound.sender_email, bodyText: inbound.body_full || inbound.body_preview || '', mailbox: inbound.mailbox });
    if (s && s.email) out.add(norm(s.email));
  } catch (_) { /* sender alone */ }
  return [...out];
}

function createStaffReplyService({ graphGet, store, now = () => new Date() } = {}) {
  if (typeof graphGet !== 'function') throw new Error('staff_reply: graphGet is required');

  // The shared mailbox's own replies sent since `sinceISO`, every page. Throws on failure.
  async function listSentReplies(mailbox, sinceISO) {
    const sel = 'id,internetMessageId,conversationId,subject,from,sender,toRecipients,ccRecipients,sentDateTime';
    const filter = sinceISO ? `&$filter=sentDateTime ge ${sinceISO}` : '';
    let path = `/users/${encodeURIComponent(mailbox)}/mailFolders('sentitems')/messages?$select=${sel}&$top=50&$orderby=sentDateTime desc${filter}`;
    const out = [];
    for (let guard = 0; path && guard < 100; guard++) {
      const j = await graphGet(path);
      for (const m of j.value || []) {
        const from = norm((m.from && m.from.emailAddress && m.from.emailAddress.address) || (m.sender && m.sender.emailAddress && m.sender.emailAddress.address));
        if (from === norm(mailbox) && m.internetMessageId && m.conversationId) out.push(m);
      }
      path = j['@odata.nextLink'] ? String(j['@odata.nextLink']).replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, '') : null;
    }
    return out;
  }

  // One conversation's replies (send-time check). Throws on failure.
  async function repliesInConversation(mailbox, conversationId) {
    const sel = 'id,internetMessageId,conversationId,subject,from,sender,toRecipients,ccRecipients,sentDateTime';
    const cid = String(conversationId).replace(/'/g, "''");
    const j = await graphGet(`/users/${encodeURIComponent(mailbox)}/mailFolders('sentitems')/messages?$select=${sel}&$top=50&$filter=conversationId eq '${cid}'`);
    return (j.value || []).filter((m) => norm((m.from && m.from.emailAddress && m.from.emailAddress.address)) === norm(mailbox) && m.internetMessageId);
  }

  // Journal headers for one sent message, or null when no journal copy exists. Throws on failure.
  const headerCache = new Map();
  async function journalHeaders(internetMessageId) {
    const key = normalizeId(internetMessageId);
    if (headerCache.has(key)) return headerCache.get(key);
    const id = String(internetMessageId).replace(/'/g, "''");
    const j = await graphGet(`/users/${encodeURIComponent(journalMailbox())}/messages?$filter=internetMessageId eq '${encodeURIComponent(id)}'&$select=internetMessageHeaders`);
    const h = ((j.value || [])[0] || {}).internetMessageHeaders || null;
    headerCache.set(key, h);
    return h;
  }

  // Decide one inbound against the replies in its conversation. Never throws: a lookup
  // failure is REVIEW with reason lookup_failed (the caller decides what that blocks).
  async function evaluateInbound(inbound, replies) {
    const t0 = Date.parse(inbound.received_at);
    const cands = (replies || [])
      .filter((r) => r.conversationId && r.conversationId === inbound.conversation_id && Date.parse(r.sentDateTime) > t0 && hasOutsideRecipient(r))
      .sort((a, b) => Date.parse(a.sentDateTime) - Date.parse(b.sentDateTime));
    if (!cands.length) return { status: 'none' };
    const tos = expectedRecipients(inbound);
    const reasons = [];
    for (const r of cands) {
      let headers;
      try { headers = await journalHeaders(r.internetMessageId); }
      catch (e) { reasons.push('lookup_failed'); continue; }
      const sentRecipients = [...addrs(r.toRecipients), ...addrs(r.ccRecipients)];
      // The matcher checks one expected address; accept the sender OR the form submitter.
      let best = null;
      for (const exp of tos.length ? tos : [null]) {
        const v = classifyStaffReply({ inbound: { ...inbound, replyTo: exp }, sent: { from: (r.from && r.from.emailAddress && r.from.emailAddress.address) || (r.sender && r.sender.emailAddress && r.sender.emailAddress.address), toRecipients: sentRecipients, sentDateTime: r.sentDateTime }, journalHeaders: headers, sharedMailbox: inbound.mailbox });
        if (v.status === 'answered') { best = v; break; }
        best = best || v;
      }
      if (best && best.status === 'answered') {
        return { status: 'answered', evidence: {
          status: 'answered', method: 'journal_in_reply_to', mailbox: norm(inbound.mailbox),
          reply_internet_message_id: r.internetMessageId, sent_at: r.sentDateTime, to: sentRecipients,
          subject: r.subject || null, verified_at: now().toISOString(),
        } };
      }
      reasons.push(best ? best.reason : 'missing_evidence');
    }
    return { status: 'review', evidence: {
      status: 'review', mailbox: norm(inbound.mailbox), reasons: [...new Set(reasons)],
      candidate_replies: cands.map((r) => ({ internet_message_id: r.internetMessageId, sent_at: r.sentDateTime })),
      checked_at: now().toISOString(),
    } };
  }

  // PULL INBOX: for the conversations the window's staff replies belong to, decide every
  // stored inbound row in them (including mail ingested in earlier pulls). Idempotent:
  // a row already answered by the same reply is left alone. Store failures are reported.
  async function reconcileStored(mailbox, replies, { skipIds = new Set() } = {}) {
    const stats = { answered: 0, review: 0, unchanged: 0, errors: [] };
    if (!store) return stats;
    const convs = [...new Set((replies || []).filter(hasOutsideRecipient).map((r) => r.conversationId))];
    for (const cid of convs) {
      let rows;
      try { rows = await store.inboundInConversation(mailbox, cid); }
      catch (e) { stats.errors.push({ conversation_id: cid, error: String(e.message || e).slice(0, 200) }); continue; }
      for (const row of rows || []) {
        if (skipIds.has(row.id)) continue;
        const prior = row.extracted && row.extracted.staff_reply;
        if (prior && prior.status === 'answered') { stats.unchanged++; continue; }
        const v = await evaluateInbound(row, replies);
        try {
          if (v.status === 'answered') { await store.markAnswered(row, v.evidence); stats.answered++; }
          else if (v.status === 'review') { await store.markReview(row, v.evidence); stats.review++; }
          else stats.unchanged++;
        } catch (e) { stats.errors.push({ inbound_id: row.id, error: String(e.message || e).slice(0, 200) }); }
      }
    }
    return stats;
  }

  // SEND TIME: may an AI-drafted reply to this inbound go out now?
  //   answered (stored or found now) -> blocked 409; review -> needs explicit confirmation (409
  //   until confirmed); any lookup failure -> blocked 503. Mailboxes staff don't reply as: allowed.
  async function guardBeforeSend(inbound, { confirmed = false } = {}) {
    if (!inbound || !isStaffReplyMailbox(inbound.mailbox)) return { allow: true, reason: 'not_a_staff_reply_mailbox' };
    const prior = inbound.extracted && inbound.extracted.staff_reply;
    const blocked = (ev) => ({ allow: false, status: 409, error: 'answered_by_staff', evidence: ev,
      message: `Already answered by staff from ${ev.mailbox || inbound.mailbox}${ev.sent_at ? ' at ' + new Date(ev.sent_at).toLocaleString('en-US', { timeZone: 'America/Chicago' }) + ' Central' : ''}. Nothing was sent.` });
    if (prior && prior.status === 'answered') return blocked(prior);
    if (!inbound.conversation_id || !inbound.internet_message_id || !inbound.received_at) {
      return confirmed ? { allow: true, reason: 'confirmed_without_identifiers' }
        : { allow: false, status: 409, error: 'staff_reply_review_required', needs_confirmation: true,
            message: 'trustEd cannot confirm whether staff already answered this email (it has no conversation identifiers). Check the shared mailbox\'s Sent Items, then confirm to send.' };
    }
    let replies;
    try { replies = await repliesInConversation(inbound.mailbox, inbound.conversation_id); }
    catch (e) { return { allow: false, status: 503, error: 'staff_reply_check_failed', message: 'Could not check whether staff already answered this email. Nothing was sent; try again in a moment.' }; }
    const v = await evaluateInbound(inbound, replies);
    if (v.status === 'answered') {
      if (store) { try { await store.markAnswered(inbound, v.evidence); } catch (_) { /* the block stands regardless */ } }
      return blocked(v.evidence);
    }
    if (v.status === 'review') {
      if (v.evidence.reasons.includes('lookup_failed')) return { allow: false, status: 503, error: 'staff_reply_check_failed', message: 'Could not verify whether staff already answered this email. Nothing was sent; try again in a moment.' };
      if (confirmed) return { allow: true, reason: 'confirmed_after_review', evidence: v.evidence };
      return { allow: false, status: 409, error: 'staff_reply_review_required', needs_confirmation: true, evidence: v.evidence,
        message: `Staff may already have answered this email (a reply from ${inbound.mailbox} exists in this conversation, but trustEd could not prove it answers this message). Check ${inbound.mailbox} Sent Items, then confirm to send.` };
    }
    return { allow: true, reason: 'no_staff_reply' };
  }

  return { listSentReplies, repliesInConversation, journalHeaders, evaluateInbound, reconcileStored, guardBeforeSend };
}

// ---- production adapters ----------------------------------------------------
function graphGetFromToken(getToken) {
  return async function graphGet(path) {
    const token = await getToken();
    const r = await fetch('https://graph.microsoft.com/v1.0' + path, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) { const e = new Error(`Graph GET failed (${r.status}): ${(await r.text().catch(() => '')).slice(0, 160)}`); e.status = r.status; throw e; }
    return r.json();
  };
}

// Supabase-backed store. Marking ANSWERED: status handled ("Answered by Staff"), the evidence,
// and any pending AI draft flagged superseded (contents kept, history appended). Never downgrades
// a dismissed/spam row; never touches a draft that was already sent.
function supabaseStore(supabase, { now = () => new Date() } = {}) {
  const SEL = 'id, mailbox, conversation_id, internet_message_id, sender_email, body_full, body_preview, received_at, triage_status, extracted';
  async function inboundInConversation(mailbox, conversationId) {
    const { data, error } = await supabase.from('email_messages').select(SEL)
      .eq('mailbox', mailbox).eq('conversation_id', conversationId).eq('direction', 'inbound')
      .order('received_at', { ascending: true }).limit(50);
    if (error) throw new Error(error.message);
    return data || [];
  }
  function supersede(draft, ev, at) {
    if (!draft || draft.status === 'sent' || draft.status === 'superseded_by_staff') return draft;
    return { ...draft, status: 'superseded_by_staff', superseded_at: at, superseded_by: { mailbox: ev.mailbox, sent_at: ev.sent_at, reply_internet_message_id: ev.reply_internet_message_id },
      history: [...(Array.isArray(draft.history) ? draft.history : []), { at, event: 'superseded_by_staff', prior_status: draft.status || 'pending' }] };
  }
  async function markAnswered(row, ev) {
    const at = now().toISOString();
    const ex = { ...(row.extracted || {}), staff_reply: ev };
    if (ex.draft) ex.draft = supersede(ex.draft, ev, at);
    const patch = { extracted: ex };
    if (!['dismissed', 'spam'].includes(row.triage_status)) Object.assign(patch, { triage_status: 'handled', reviewed_by: 'Answered by Staff', reviewed_at: at });
    const { error } = await supabase.from('email_messages').update(patch).eq('id', row.id);
    if (error) throw new Error(error.message);
    // Outbound drafts that reply to this inbound: flagged (their status CHECK has no
    // 'superseded'); the send-time guard blocks them regardless.
    const { error: oErr } = await supabase.from('outbound_email_drafts')
      .update({ send_error: `Superseded by staff reply sent from ${ev.mailbox} at ${ev.sent_at}; not sent.` })
      .eq('source_email_ref', row.id).eq('status', 'draft');
    if (oErr) console.warn('[staff_reply] outbound draft flag failed (send-time guard still blocks):', oErr.message);
  }
  async function markReview(row, ev) {
    const ex = { ...(row.extracted || {}), staff_reply: ev };
    if (ex.draft && ex.draft.status !== 'sent' && ex.draft.status !== 'superseded_by_staff') {
      const hint = `May already be answered by staff (a reply from ${ev.mailbox} exists in this conversation but could not be verified). Check ${ev.mailbox} Sent Items before sending.`;
      if (!String(ex.draft.review_hint || '').includes('May already be answered by staff')) ex.draft = { ...ex.draft, review_hint: [ex.draft.review_hint, hint].filter(Boolean).join(' · ') };
    }
    const patch = { extracted: ex };
    if (['new', 'linked'].includes(row.triage_status)) patch.triage_status = 'needs_review';
    const { error } = await supabase.from('email_messages').update(patch).eq('id', row.id);
    if (error) throw new Error(error.message);
  }
  return { inboundInConversation, markAnswered, markReview };
}

function productionService(supabase) {
  const gs = require('./graph_send');
  return createStaffReplyService({ graphGet: graphGetFromToken(gs.getToken), store: supabaseStore(supabase) });
}

module.exports = { createStaffReplyService, supabaseStore, productionService, graphGetFromToken, isStaffReplyMailbox, staffReplyMailboxes, journalMailbox, hasOutsideRecipient, expectedRecipients };
