'use strict';
// ============================================================================
// lib/email/staff_reply.js  (Ed 2026-10-18, PR #225) — Answered by Staff
// ----------------------------------------------------------------------------
// Bedrock staff answer some homeowner mail themselves, in Outlook, sending AS the
// shared mailbox (info@ / welcome@). trustEd must recognise those replies so no AI
// teammate drafts or sends a second answer. This runs ONLY during the manual Pull
// inbox and as a final check right before an approved AI reply is sent.
//
// EVIDENCE (lib/email/staff_reply_match.js decides; this file gathers):
//   - the reply: a message the shared mailbox SENT (from = the mailbox, not a draft);
//   - the proof: the journal copy of that exact message (archive1emails@, same
//     internetMessageId) carries In-Reply-To / References (Sent Items copies have
//     no headers in Graph);
//   - the inbound: trustEd's own stored row (internet_message_id, sender, time).
//   ANSWERED needs all of: shared-mailbox send, to the inbound's sender (or form
//   submitter), after it, and a journal header naming it. Anything less is REVIEW.
//   Read, Archive, Filed, flags, subjects and conversation ids alone are never
//   evidence; a reply reaching nobody outside Bedrock (internal forward) is not a
//   candidate.
//
// COMPLETENESS: every Graph and database read pages through ALL results. A read
// that hits its page cap with more pages left is INCOMPLETE and fails closed (the
// send-time guard blocks; the Pull records Needs Review / an error). A partial list
// is never treated as "no staff reply".
//
// OVERRIDE: the send-time guard has exactly one manual bypass, for mail with no
// conversation identifiers (old rows). It is owner-only, needs a written reason, and
// is recorded on the email before the send. A VERIFIED staff reply and a FAILED or
// INCOMPLETE lookup can never be overridden.
// ============================================================================
const { classifyStaffReply, normalizeId } = require('./staff_reply_match');

const DEFAULT_MAILBOXES = ['info@bedrocktx.com', 'welcome@bedrocktx.com'];
const OWN_DOMAIN = /@bedrocktx\.com$/i;
const OPEN_STATUSES = ['new', 'needs_review', 'linked'];
const CLOSED_UNTOUCHED = ['dismissed', 'spam'];
const MIN_OVERRIDE_REASON = 15;
const norm = (v) => String(v || '').trim().toLowerCase();

function staffReplyMailboxes() {
  const env = String(process.env.STAFF_REPLY_MAILBOXES || '').split(',').map(norm).filter(Boolean);
  return env.length ? env : DEFAULT_MAILBOXES;
}
const isStaffReplyMailbox = (mbx) => staffReplyMailboxes().includes(norm(mbx));
const journalMailbox = () => process.env.JOURNAL_MAILBOX || 'archive1emails@bedrocktx.com';

const addrs = (list) => (list || []).map((x) => norm(typeof x === 'string' ? x : (x && x.emailAddress && x.emailAddress.address) || (x && (x.address || x.email)))).filter(Boolean);
const hasOutsideRecipient = (r) => [...addrs(r.toRecipients), ...addrs(r.ccRecipients)].some((a) => !OWN_DOMAIN.test(a));
const senderOf = (m) => norm((m.from && m.from.emailAddress && m.from.emailAddress.address) || (m.sender && m.sender.emailAddress && m.sender.emailAddress.address));

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

class IncompleteResultsError extends Error {
  constructor(what) { super(`incomplete results: ${what} has more pages than the safety cap; refusing to treat a partial list as complete`); this.code = 'incomplete_results'; }
}

function createStaffReplyService({ graphGet, store = null, now = () => new Date(), maxPages = 50 } = {}) {
  if (typeof graphGet !== 'function') throw new Error('staff_reply: graphGet is required');

  // Every page, or an IncompleteResultsError. Never a silent partial list.
  async function pageAll(path, what) {
    const out = [];
    let next = path;
    for (let n = 0; next; n++) {
      if (n >= maxPages) throw new IncompleteResultsError(what);
      const j = await graphGet(next);
      if (!j || !Array.isArray(j.value)) { const e = new Error(`unexpected Graph response for ${what}`); e.code = 'bad_response'; throw e; }
      out.push(...j.value);
      next = j['@odata.nextLink'] ? String(j['@odata.nextLink']).replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, '') : null;
    }
    return out;
  }
  const SEL = 'id,internetMessageId,conversationId,subject,from,sender,toRecipients,ccRecipients,sentDateTime,isDraft';
  const sentBy = (mailbox) => (m) => senderOf(m) === norm(mailbox) && !m.isDraft && m.internetMessageId && m.conversationId;

  // PULL: the shared mailbox's sent replies since `sinceISO` (Sent Items, every page).
  async function listSentReplies(mailbox, sinceISO) {
    const filter = sinceISO ? `&$filter=sentDateTime ge ${sinceISO}` : '';
    const all = await pageAll(`/users/${encodeURIComponent(mailbox)}/mailFolders('sentitems')/messages?$select=${SEL}&$top=50&$orderby=sentDateTime desc${filter}`, `${mailbox} Sent Items`);
    return all.filter(sentBy(mailbox));
  }

  // SEND TIME: every message in the conversation, in ANY folder of the shared mailbox (a
  // reply someone moved out of Sent Items still counts), every page; drafts excluded.
  async function repliesInConversation(mailbox, conversationId) {
    const cid = String(conversationId).replace(/'/g, "''");
    const all = await pageAll(`/users/${encodeURIComponent(mailbox)}/messages?$select=${SEL}&$top=50&$filter=conversationId eq '${cid}'`, `${mailbox} conversation`);
    return all.filter(sentBy(mailbox));
  }

  // Journal headers for one sent message; null when no journal copy exists. Throws on failure.
  const headerCache = new Map();
  async function journalHeaders(internetMessageId) {
    const key = normalizeId(internetMessageId);
    if (headerCache.has(key)) return headerCache.get(key);
    const id = String(internetMessageId).replace(/'/g, "''");
    const copies = await pageAll(`/users/${encodeURIComponent(journalMailbox())}/messages?$filter=internetMessageId eq '${encodeURIComponent(id)}'&$select=internetMessageHeaders`, 'journal lookup');
    const withHeaders = copies.find((c) => Array.isArray(c.internetMessageHeaders) && c.internetMessageHeaders.length);
    const h = withHeaders ? withHeaders.internetMessageHeaders : null;
    headerCache.set(key, h);
    return h;
  }

  // Decide one inbound against replies in its conversation. Never throws: a lookup failure
  // is REVIEW with reason lookup_failed.
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
      let best = null;
      for (const exp of tos.length ? tos : [null]) {
        const v = classifyStaffReply({ inbound: { ...inbound, replyTo: exp }, sent: { from: senderOf(r), toRecipients: sentRecipients, sentDateTime: r.sentDateTime }, journalHeaders: headers, sharedMailbox: inbound.mailbox });
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
      status: 'review', mailbox: norm(inbound.mailbox), reasons: [...new Set(reasons)].sort(),
      candidate_replies: cands.map((r) => ({ internet_message_id: r.internetMessageId, sent_at: r.sentDateTime })),
      checked_at: now().toISOString(),
    } };
  }

  // PULL INBOX reconcile: rows in the conversations the window's replies belong to. Only
  // OPEN rows change status; handled rows get the evidence noted; dismissed/spam rows are
  // never touched; every write is conditional on the row being unchanged since read.
  async function reconcileStored(mailbox, replies, { skipIds = new Set() } = {}) {
    const st = { answered: 0, review: 0, noted: 0, unchanged: 0, skipped_closed: 0, conflicts: 0, errors: [], changes: [] };
    if (!store) return st;
    const convs = [...new Set((replies || []).filter(hasOutsideRecipient).map((r) => r.conversationId))];
    for (const cid of convs) {
      let rows;
      try { rows = await store.inboundInConversation(mailbox, cid); }
      catch (e) { st.errors.push({ conversation_id: cid, error: String(e.message || e).slice(0, 200) }); continue; }
      for (const row of rows || []) {
        if (skipIds.has(row.id)) continue;
        if (CLOSED_UNTOUCHED.includes(row.triage_status)) { st.skipped_closed++; continue; }
        const prior = row.extracted && row.extracted.staff_reply;
        if (prior && prior.status === 'answered') { st.unchanged++; continue; }
        const v = await evaluateInbound(row, replies);
        if (v.status === 'none') { st.unchanged++; continue; }
        try {
          const res = v.status === 'answered' ? await store.applyAnswered(row, v.evidence) : await store.applyReview(row, v.evidence);
          if (res.conflict) { st.conflicts++; st.changes.push({ id: row.id, action: 'skipped_changed_since_read' }); continue; }
          if (!res.changed) { st.unchanged++; continue; }
          st.changes.push(res.change);
          if (res.change.action === 'answered') st.answered++;
          else if (res.change.action === 'evidence_noted') st.noted++;
          else st.review++;
        } catch (e) { st.errors.push({ inbound_id: row.id, error: String(e.message || e).slice(0, 200) }); }
      }
    }
    return st;
  }

  // SEND TIME: may a reply to this inbound go out now?
  //   verified staff reply (stored or found now) -> 409, never overridable;
  //   lookup failure / incomplete results        -> 503, never overridable;
  //   ambiguous match                            -> 409 until explicitly confirmed (audited);
  //   no conversation identifiers                -> 409; only the owner, with a written reason,
  //                                                 may override (audited before the send).
  // `actor` = { email, is_owner }. Allowed-by-exception results carry `audit` to record.
  async function guardBeforeSend(inbound, { confirmed = false, override = null, actor = null } = {}) {
    if (!inbound || !isStaffReplyMailbox(inbound.mailbox)) return { allow: true, reason: 'not_a_staff_reply_mailbox' };
    const prior = inbound.extracted && inbound.extracted.staff_reply;
    const blocked = (ev) => ({ allow: false, status: 409, error: 'answered_by_staff', evidence: ev, overridable: false,
      message: `Already answered by staff from ${ev.mailbox || inbound.mailbox}${ev.sent_at ? ' at ' + new Date(ev.sent_at).toLocaleString('en-US', { timeZone: 'America/Chicago' }) + ' Central' : ''}. Nothing was sent.` });
    if (prior && prior.status === 'answered') return blocked(prior);
    const at = now().toISOString();
    if (!inbound.conversation_id || !inbound.internet_message_id || !inbound.received_at) {
      const reason = override && String(override.reason || '').trim();
      if (!reason) {
        return { allow: false, status: 409, error: 'staff_reply_unverifiable', overridable: 'owner_with_reason',
          message: 'trustEd cannot verify whether staff already answered this email (it has no conversation identifiers), so it will not send. Check the shared mailbox\'s Sent Items. Only the account owner can override, with a written reason that is recorded.' };
      }
      if (!actor || !actor.is_owner) return { allow: false, status: 403, error: 'staff_reply_override_owner_only', message: 'Only the account owner can override the staff-reply check.' };
      if (reason.length < MIN_OVERRIDE_REASON) return { allow: false, status: 400, error: 'staff_reply_override_reason_required', message: `An override needs a written reason (at least ${MIN_OVERRIDE_REASON} characters).` };
      return { allow: true, reason: 'owner_override_unverifiable', audit: { kind: 'owner_override_unverifiable', at, by: actor.email || null, reason, mailbox: norm(inbound.mailbox) } };
    }
    let replies;
    try { replies = await repliesInConversation(inbound.mailbox, inbound.conversation_id); }
    catch (e) {
      return { allow: false, status: 503, error: 'staff_reply_check_failed', overridable: false,
        message: e.code === 'incomplete_results' ? 'The staff-reply check could not read the whole conversation, so nothing was sent. Try again; if it repeats, check the shared mailbox.' : 'Could not check whether staff already answered this email. Nothing was sent; try again in a moment.' };
    }
    const v = await evaluateInbound(inbound, replies);
    if (v.status === 'answered') {
      if (store) { try { await store.applyAnswered(inbound, v.evidence); } catch (_) { /* the block stands regardless */ } }
      return blocked(v.evidence);
    }
    if (v.status === 'review') {
      if (v.evidence.reasons.includes('lookup_failed')) return { allow: false, status: 503, error: 'staff_reply_check_failed', overridable: false, message: 'Could not verify whether staff already answered this email. Nothing was sent; try again in a moment.' };
      if (confirmed) return { allow: true, reason: 'confirmed_after_review', evidence: v.evidence, audit: { kind: 'confirmed_after_review', at, by: (actor && actor.email) || null, reasons: v.evidence.reasons, candidate_replies: v.evidence.candidate_replies, mailbox: norm(inbound.mailbox) } };
      return { allow: false, status: 409, error: 'staff_reply_review_required', needs_confirmation: true, evidence: v.evidence,
        message: `Staff may already have answered this email (a reply from ${inbound.mailbox} exists in this conversation, but trustEd could not prove it answers this message). Check ${inbound.mailbox} Sent Items, then confirm to send.` };
    }
    return { allow: true, reason: 'no_staff_reply' };
  }

  return { listSentReplies, repliesInConversation, journalHeaders, evaluateInbound, reconcileStored, guardBeforeSend, store };
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

// ---- planning (pure): exactly what a decision changes on a row --------------------
// Returns { patch, change } or null when nothing should change.
function planAnswered(row, ev, at) {
  if (!row || CLOSED_UNTOUCHED.includes(row.triage_status)) return null;
  const ex = row.extracted || {};
  if (ex.staff_reply && ex.staff_reply.status === 'answered') return null;
  const open = OPEN_STATUSES.includes(row.triage_status);
  const evidence = { ...ev, prior: { triage_status: row.triage_status || null, reviewed_by: row.reviewed_by || null, reviewed_at: row.reviewed_at || null } };
  const nextEx = { ...ex, staff_reply: evidence };
  let draftChange = 'none';
  if (open && ex.draft && (ex.draft.status === undefined || ex.draft.status === null || ex.draft.status === 'pending')) {
    nextEx.draft = { ...ex.draft, status: 'superseded_by_staff', superseded_at: at,
      superseded_by: { mailbox: ev.mailbox, sent_at: ev.sent_at, reply_internet_message_id: ev.reply_internet_message_id },
      history: [...(Array.isArray(ex.draft.history) ? ex.draft.history : []), { at, event: 'superseded_by_staff', prior_status: ex.draft.status || 'pending' }] };
    draftChange = 'superseded';
  } else if (ex.draft) draftChange = `kept (${ex.draft.status || 'pending'}${open ? '' : ', row not open'})`;
  const patch = { extracted: nextEx };
  if (open) Object.assign(patch, { triage_status: 'handled', reviewed_by: 'Answered by Staff', reviewed_at: at });
  return { patch, change: { id: row.id, action: open ? 'answered' : 'evidence_noted', from_status: row.triage_status || null, to_status: open ? 'handled' : (row.triage_status || null), draft: draftChange, reply_internet_message_id: ev.reply_internet_message_id, staff_reply_sent_at: ev.sent_at } };
}
function planReview(row, ev) {
  if (!row || !OPEN_STATUSES.includes(row.triage_status)) return null;   // closed work is never re-opened
  const ex = row.extracted || {};
  const p = ex.staff_reply;
  const same = p && p.status === 'review' && JSON.stringify((p.reasons || []).slice().sort()) === JSON.stringify((ev.reasons || []).slice().sort())
    && JSON.stringify((p.candidate_replies || []).map((c) => c.internet_message_id).sort()) === JSON.stringify((ev.candidate_replies || []).map((c) => c.internet_message_id).sort());
  if (same) return null;   // idempotent: the same uncertainty is not rewritten every Pull
  const nextEx = { ...ex, staff_reply: ev };
  if (ex.draft && ![ 'sent', 'superseded_by_staff' ].includes(ex.draft.status) && !String(ex.draft.review_hint || '').includes('May already be answered by staff')) {
    nextEx.draft = { ...ex.draft, review_hint: [ex.draft.review_hint, `May already be answered by staff (a reply from ${ev.mailbox} exists in this conversation but could not be verified). Check ${ev.mailbox} Sent Items before sending.`].filter(Boolean).join(' · ') };
  }
  const patch = { extracted: nextEx };
  if (['new', 'linked'].includes(row.triage_status)) patch.triage_status = 'needs_review';
  return { patch, change: { id: row.id, action: 'needs_review', from_status: row.triage_status, to_status: patch.triage_status || row.triage_status, reasons: ev.reasons, draft: ex.draft ? 'hint added' : 'none' } };
}

// Supabase-backed store. Every write: re-read the row, plan on the FRESH row, update only
// if updated_at is unchanged (another writer in between -> conflict, nothing overwritten).
// dryRun: plan and report, never write.
function supabaseStore(supabase, { now = () => new Date(), dryRun = false } = {}) {
  const SEL = 'id, mailbox, conversation_id, internet_message_id, sender_email, body_full, body_preview, received_at, triage_status, reviewed_by, reviewed_at, extracted, updated_at';
  async function inboundInConversation(mailbox, conversationId) {
    const { fetchAllQuery } = require('../db/fetch_all');
    const rows = await fetchAllQuery(() => supabase.from('email_messages').select(SEL)
      .eq('mailbox', mailbox).eq('conversation_id', conversationId).eq('direction', 'inbound'), { orderBy: 'id' });
    return rows.sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at));
  }
  async function fresh(id) {
    const { data, error } = await supabase.from('email_messages').select(SEL).eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }
  async function conditionalUpdate(row, patch) {
    const { data, error } = await supabase.from('email_messages').update(patch).eq('id', row.id).eq('updated_at', row.updated_at).select('id');
    if (error) throw new Error(error.message);
    return (data || []).length === 1;
  }
  async function apply(row, plan) {
    const cur = dryRun ? row : await fresh(row.id);
    if (!cur) return { changed: false };
    const p = plan(cur);
    if (!p) return { changed: false };
    if (dryRun) return { changed: true, change: { ...p.change, dry_run: true } };
    if (!(await conditionalUpdate(cur, p.patch))) return { conflict: true, changed: false };
    return { changed: true, change: p.change };
  }
  async function applyAnswered(row, ev) {
    const at = now().toISOString();
    const res = await apply(row, (cur) => planAnswered(cur, ev, at));
    if (res.changed && !dryRun && res.change.action === 'answered') {
      // Outbound drafts that reply to this inbound: flag only those not already carrying a
      // message (status CHECK has no 'superseded'); the send-time guard blocks them regardless.
      const { data, error } = await supabase.from('outbound_email_drafts')
        .update({ send_error: `Superseded by staff reply sent from ${ev.mailbox} at ${ev.sent_at}; not sent.` })
        .eq('source_email_ref', row.id).eq('status', 'draft').is('send_error', null).select('id');
      if (error) console.warn('[staff_reply] outbound draft flag failed (send-time guard still blocks):', error.message);
      res.change.outbound_drafts_flagged = (data || []).length;
    }
    return res;
  }
  async function applyReview(row, ev) { return apply(row, (cur) => planReview(cur, ev)); }
  // Audit of an exception (owner override / confirmed ambiguous send), recorded BEFORE the
  // send. Retries once on a concurrent change; throws if it cannot be recorded.
  async function appendAudit(row, entry) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = await fresh(row.id);
      if (!cur) throw new Error('email not found for audit');
      const ex = cur.extracted || {};
      const patch = { extracted: { ...ex, staff_reply_audit: [...(Array.isArray(ex.staff_reply_audit) ? ex.staff_reply_audit : []), entry] } };
      if (await conditionalUpdate(cur, patch)) return true;
    }
    throw new Error('could not record the staff-reply audit entry (email changed concurrently)');
  }
  return { inboundInConversation, applyAnswered, applyReview, appendAudit, planAnswered, planReview };
}

function productionService(supabase, opts = {}) {
  const gs = require('./graph_send');
  return createStaffReplyService({ graphGet: graphGetFromToken(gs.getToken), store: supabaseStore(supabase, opts) });
}

module.exports = { createStaffReplyService, supabaseStore, productionService, graphGetFromToken, planAnswered, planReview,
  isStaffReplyMailbox, staffReplyMailboxes, journalMailbox, hasOutsideRecipient, expectedRecipients, IncompleteResultsError, MIN_OVERRIDE_REASON };
