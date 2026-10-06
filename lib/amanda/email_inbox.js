// ============================================================================
// lib/amanda/email_inbox.js  (Ed 2026-10-06) — Amanda's inbox on her email desk
// ----------------------------------------------------------------------------
// Mail addressed to Amanda, and Reply as Amanda, on the Amanda · Operations card.
//
// Why. The Canyon Gate president emailed Amanda ("New Team Member for Canyon Gate
// at Cinco Ranch HOA", to amandaalbright@, cc Ed). Ingest stored it within 26
// seconds, in Amanda's mailbox, with the community attached. But content routing
// set persona='miranda', and every Amanda screen filtered on persona, so mail
// ADDRESSED to Amanda was invisible on Amanda's screens. Nothing was lost; it was
// filed under a different teammate.
//
// So the inbox is "delivered to Amanda's mailbox" (email_messages.mailbox =
// AMANDA_MAILBOX, direction inbound), whoever content routing later assigned it
// to. No second ingestion: this reads the same email_messages rows Communications
// reads (Pull inbox / push fill them).
//
// Replies are staged, never sent from here: an outbound_email_drafts row
// (draft_kind 'amanda_reply', source_email_ref = the inbound email_messages id)
// waits in Amanda's Outbox. Sending it is the existing draft route, which for
// this kind replies IN THREAD (Graph createReply carries the real quoted history
// and threading headers), runs Amanda's double-send guard against her automatic
// reply, builds with her existing signature, logs the reply on the conversation,
// and marks the inbound handled. See api/email_drafts.js.
// ============================================================================
const { stripEmDashes } = require('../tone');

const REPLY_KIND = 'amanda_reply';

const replySubject = (s) => require('../email/quote_original').replySubject(s);

/**
 * Reply status for one inbound message. Pure.
 *   replied       an Amanda reply to it was sent
 *   reply_staged  a reply is waiting in her Outbox
 *   auto_replied  her automatic reply answered it
 *   handled       someone marked it handled (e.g. replied from Communications)
 *   needs_reply   none of the above
 */
function replyStatus(msg, { replies = [], receipts = [] } = {}) {
  const mine = replies.filter((r) => r.source_email_ref === msg.id);
  if (mine.some((r) => r.status === 'sent')) return 'replied';
  if (mine.some((r) => r.status === 'draft')) return 'reply_staged';
  const ref = msg.internet_message_id ? 'email:' + msg.internet_message_id : null;
  if (ref && receipts.some((r) => r.source_email_ref === ref && r.status === 'sent')) return 'auto_replied';
  if (msg.triage_status === 'handled') return 'handled';
  return 'needs_reply';
}

/** Recent mail delivered to Amanda's mailbox, newest first, with reply status. Never throws on a side source. */
async function loadInbox(supabase, { days = 30, limit = 100 } = {}, deps = {}) {
  const gs = deps.graphSend || require('../email/graph_send');
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const source_errors = {};
  const { data: msgs, error } = await supabase.from('email_messages')
    .select('id, sender_name, sender_email, recipients, subject, body_preview, received_at, triage_status, persona, classification, community_id, internet_message_id, conversation_id, community:community_id(name)')
    .eq('mailbox', gs.AMANDA_MAILBOX).eq('direction', 'inbound').gte('received_at', since)
    .order('received_at', { ascending: false }).limit(limit);
  if (error) return { items: [], source_errors: { inbox: error.message }, since };
  const rows = msgs || [];
  let replies = []; let receipts = [];
  if (rows.length) {
    const ids = rows.map((m) => m.id);
    const refs = rows.filter((m) => m.internet_message_id).map((m) => 'email:' + m.internet_message_id);
    const [rq, aq] = await Promise.all([
      supabase.from('outbound_email_drafts').select('id, source_email_ref, status, created_at, sent_at').eq('draft_kind', REPLY_KIND).in('source_email_ref', ids),
      refs.length ? supabase.from('outbound_email_drafts').select('source_email_ref, status').eq('draft_kind', 'amanda_auto_reply').in('source_email_ref', refs) : Promise.resolve({ data: [] }),
    ]);
    if (rq.error) source_errors.replies = rq.error.message; else replies = rq.data || [];
    if (aq.error) source_errors.auto_replies = aq.error.message; else receipts = aq.data || [];
  }
  const items = rows.map((m) => ({
    id: m.id, from_name: m.sender_name || null, from_email: m.sender_email || null, to: m.recipients || [],
    subject: m.subject || '', preview: m.body_preview || '', received_at: m.received_at,
    community: (m.community && m.community.name) || null, routed_to: m.persona || null,
    classification: m.classification || null, triage_status: m.triage_status || null,
    reply_status: replyStatus(m, { replies, receipts }),
    staged_reply_id: (replies.find((r) => r.source_email_ref === m.id && r.status === 'draft') || {}).id || null,
  }));
  return { items, needs_reply: items.filter((i) => i.reply_status === 'needs_reply').length, source_errors, since };
}

/**
 * One inbound message with its conversation (both directions, oldest first) and,
 * read-only from Microsoft 365, its full body and To/CC (CC is not stored on
 * email_messages). Graph unavailable is reported, not hidden.
 */
async function loadThread(supabase, id, deps = {}) {
  const gs = deps.graphSend || require('../email/graph_send');
  const ga = deps.graphAttachments || require('../email/graph_attachments');
  const { data: m, error } = await supabase.from('email_messages')
    .select('id, mailbox, direction, sender_name, sender_email, recipients, subject, body_full, body_preview, received_at, triage_status, persona, community_id, graph_id, internet_message_id, conversation_id, community:community_id(name)')
    .eq('id', id).maybeSingle();
  if (error) throw new Error('thread_load_failed: ' + error.message);
  if (!m) return null;
  if (m.mailbox !== gs.AMANDA_MAILBOX || m.direction !== 'inbound') return { not_amanda: true };
  let thread = [];
  if (m.conversation_id) {
    const { data: t } = await supabase.from('email_messages')
      .select('id, direction, sender_name, sender_email, recipients, subject, body_full, body_preview, received_at, persona')
      .eq('conversation_id', m.conversation_id).order('received_at', { ascending: true }).limit(30);
    thread = (t || []).map((x) => ({ id: x.id, direction: x.direction, from: x.sender_name || x.sender_email, from_email: x.sender_email,
      to: x.recipients || [], subject: x.subject, body: x.body_full || x.body_preview || '', at: x.received_at }));
  }
  let body = m.body_full || '';
  let to = m.recipients || []; let cc = []; const graph_errors = [];
  if (m.graph_id) {
    const [txt, rc] = await Promise.all([ga.fetchMessageText(m.mailbox, m.graph_id), ga.fetchMessageRecipients(m.mailbox, m.graph_id)]);
    if (txt && txt.length > body.length) body = txt;
    if ((rc.to || []).length || (rc.cc || []).length) { to = rc.to; cc = rc.cc; } else graph_errors.push('recipients_unavailable');
  }
  if (!body) body = m.body_preview || '';
  const mine = new Set([gs.AMANDA_MAILBOX.toLowerCase(), 'amanda@bedrocktx.com']);
  const lower = (a) => String(a || '').toLowerCase();
  const sender = lower(m.sender_email);
  // Reply-all CC: everyone else on the original (To + CC), never Amanda, never the sender.
  const reply_all_cc = [...new Set([...to, ...cc].map(lower))].filter((a) => a && !mine.has(a) && a !== sender);
  const thread_items = thread.length ? thread : [{ id: m.id, direction: 'inbound', from: m.sender_name || m.sender_email, from_email: m.sender_email, to, subject: m.subject, body, at: m.received_at }];
  return {
    message: { id: m.id, from_name: m.sender_name, from_email: m.sender_email, to, cc, subject: m.subject, body, received_at: m.received_at,
      community: (m.community && m.community.name) || null, community_id: m.community_id || null, routed_to: m.persona, triage_status: m.triage_status,
      threaded_reply_possible: !!m.graph_id },
    thread: thread_items.map((x) => (x.id === m.id ? { ...x, body } : x)),
    // Reply All is Amanda's default for board/community threads (Ed 2026-10-06):
    // the sender in To, everyone else on the original in CC, Amanda never.
    reply: { to: m.sender_email, subject: replySubject(m.subject), reply_all_cc, default_mode: reply_all_cc.length ? 'all' : 'sender' },
    graph_errors,
  };
}

/**
 * Recipients for a reply. mode 'all' (Amanda's default): everyone else on the
 * original (To + CC) goes in CC; 'sender': only the sender. Extra CC is added in
 * either mode. Amanda's own addresses and the sender are never in CC; addresses
 * are lowercased and de-duplicated. Pure.
 */
function replyRecipients(thread, { mode = 'all', extraCc = '' } = {}) {
  const { parseAddresses } = require('./email_console');
  const amanda = new Set(['amandaalbright@bedrocktx.com', 'amanda@bedrocktx.com']);
  try { amanda.add(String(require('../email/graph_send').AMANDA_MAILBOX).toLowerCase()); } catch (_) {}
  const sender = String((thread.reply && thread.reply.to) || '').toLowerCase();
  const base = mode === 'sender' ? [] : ((thread.reply && thread.reply.reply_all_cc) || []);
  const cc = [...new Set([...parseAddresses(base), ...parseAddresses(extraCc)])].filter((a) => a !== sender && !amanda.has(a));
  return { mode: mode === 'sender' ? 'sender' : 'all', to: (thread.reply && thread.reply.to) || null, cc };
}

/**
 * Stage a reply in Amanda's Outbox (outbound_email_drafts, draft_kind amanda_reply,
 * source_email_ref = inbound email_messages id). The unique index on
 * (source_email_ref, draft_kind) WHERE status='draft' allows one open reply per
 * message; staging again replaces the text of that open reply instead of
 * erroring, so "redo the reply" just works. Throws on write failure.
 */
async function stageReply(supabase, { message, body, cc, createdBy, reason }) {
  if (!message || !message.id || !message.from_email) throw new Error('message_required');
  const text = stripEmDashes(String(body || '').trim());
  if (!text) throw new Error('body_required');
  const { parseAddresses } = require('./email_console');
  const amanda = new Set(['amandaalbright@bedrocktx.com', 'amanda@bedrocktx.com']);
  const ccList = parseAddresses(cc).filter((a) => a !== String(message.from_email).toLowerCase() && !amanda.has(a));
  const { AMANDA_MAILBOX } = require('../email/graph_send');
  const row = {
    persona: 'amanda', from_mailbox: AMANDA_MAILBOX,
    to_email: message.from_email, to_name: message.from_name || null, cc: ccList.length ? ccList.join(', ') : null,
    subject: stripEmDashes(replySubject(message.subject)), body_text: text,
    draft_kind: REPLY_KIND, related_type: 'email_triage', related_id: message.id, source_email_ref: message.id,
    community_id: message.community_id || null, community_name: message.community || null,
    ai_drafted: true, status: 'draft', created_by: createdBy || null,
    draft_reason: reason || 'Reply prepared on Amanda’s desk; waiting for a person to review and send.',
  };
  const { data: open, error: oe } = await supabase.from('outbound_email_drafts').select('id').eq('draft_kind', REPLY_KIND).eq('source_email_ref', message.id).eq('status', 'draft').limit(1);
  if (oe) throw new Error('stage_failed: ' + oe.message);
  const cols = 'id, to_email, cc, subject, body_text, status, created_at, updated_at';
  const q = open && open.length
    ? supabase.from('outbound_email_drafts').update({ to_email: row.to_email, cc: row.cc, subject: row.subject, body_text: row.body_text, created_by: row.created_by, draft_reason: row.draft_reason, send_error: null, updated_at: new Date().toISOString() }).eq('id', open[0].id).eq('status', 'draft').select(cols).single()
    : supabase.from('outbound_email_drafts').insert(row).select(cols).single();
  const { data, error } = await q;
  if (error) throw new Error('stage_failed: ' + error.message);
  return { ...data, replaced: !!(open && open.length) };
}

module.exports = { REPLY_KIND, replyStatus, loadInbox, loadThread, replyRecipients, stageReply, replySubject };
