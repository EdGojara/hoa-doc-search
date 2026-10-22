// ============================================================================
// lib/email/agent_desk.js — the AI employee email desk (Ed 2026-10-22)
// ----------------------------------------------------------------------------
// ONE desk for every AI employee the roster gives an email_desk (lib/team/roster):
// Amanda, Kat, Annie, Maggie and Miranda today. Generalized from Amanda's desk
// (lib/amanda/email_inbox.js), which stays in place for her existing routes.
//
// Inbox    inbound mail delivered to the agent's own Microsoft 365 mailbox, plus mail
//          Communications routed to the agent (email_messages.persona) from a shared
//          inbox. The same email_messages rows Communications reads: no second ingestion,
//          no copies. A contact can write to several agents; each sees what is theirs.
// Thread   the conversation (both directions) and, read-only from Microsoft 365, the
//          real To/CC. A reply already sent from the agent's mailbox in the thread is
//          reported, so a second reply is never prepared by mistake.
// Reply    staged in the agent's Outbox (outbound_email_drafts: persona, from_mailbox,
//          draft_kind, source_email_ref). Never sent from here. Sending is the existing
//          approval route (api/email_drafts.js), which requires the signed-in approver,
//          refuses a draft from another agent's desk, replies IN THREAD when the message
//          lives in the agent's own mailbox, and records who approved it.
// Facts    before drafting, the agent's record checks for the topic (lib/agents/
//          operational_facts); after drafting, statements those records contradict.
// ============================================================================
const { stripEmDashes } = require('../tone');

const OPEN = ['draft'];
const lower = (a) => String(a || '').trim().toLowerCase();
const replySubject = (s) => require('./quote_original').replySubject(s);

/** The desk configuration for an agent, from the roster. Throws for anyone without a desk. */
function deskFor(persona, deps = {}) {
  const roster = deps.roster || require('../team/roster');
  const gs = deps.graphSend || require('./graph_send');
  const m = roster.get(String(persona || '').toLowerCase());
  if (!m || !m.email_desk) { const e = new Error('not_a_desk_agent'); e.code = 'not_a_desk_agent'; throw e; }
  const cfg = m.email_desk;
  const mailbox = lower(gs.personaMailbox(m.persona));
  const aliases = new Set([mailbox, ...String(m.mailbox || '').split(/[\s/,]+/).filter((x) => /@$/.test(x)).map((x) => `${x}bedrocktx.com`)].map(lower));
  return {
    persona: m.persona, name: m.name, title: m.title, mailbox, aliases: [...aliases],
    responsibilities: cfg.responsibilities || m.lane || null, approval: cfg.approval || 'human',
    guards: cfg.guards || [], facts: cfg.facts || [], reply_kind: cfg.reply_kind || 'agent_reply',
  };
}

/** Every desk agent (for the selector). */
function desks(deps = {}) {
  const roster = deps.roster || require('../team/roster');
  return roster.deskAgents().map((m) => deskFor(m.persona, deps)).map((d) => ({ persona: d.persona, name: d.name, title: d.title, mailbox: d.mailbox, responsibilities: d.responsibilities, approval: d.approval }));
}

/** Is this stored message on the agent's desk? Pure. */
function onDesk(desk, m) {
  return !!m && m.direction === 'inbound' && m.persona !== 'tessa' && (lower(m.mailbox) === desk.mailbox || m.persona === desk.persona);
}

/** Reply status. Pure. A reply sent in the thread from the agent's mailbox counts, whatever screen sent it. */
function replyStatus(msg, { replies = [], sentInThread = [], receipts = [] } = {}) {
  const mine = replies.filter((r) => r.source_email_ref === msg.id);
  if (mine.some((r) => r.status === 'sent')) return 'replied';
  if (sentInThread.some((o) => o.conversation_id && o.conversation_id === msg.conversation_id && String(o.received_at || o.created_at) > String(msg.received_at))) return 'replied';
  if (mine.some((r) => OPEN.includes(r.status))) return 'reply_staged';
  const ref = msg.internet_message_id ? 'email:' + msg.internet_message_id : null;
  if (ref && receipts.some((r) => r.source_email_ref === ref && r.status === 'sent')) return 'auto_replied';
  if (msg.triage_status === 'handled') return 'handled';
  return 'needs_reply';
}

async function loadInbox(supabase, persona, { days = 30, limit = 100 } = {}, deps = {}) {
  const desk = deskFor(persona, deps);
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const source_errors = {};
  const { data: msgs, error } = await supabase.from('email_messages')
    .select('id, mailbox, direction, sender_name, sender_email, recipients, subject, body_preview, received_at, triage_status, persona, classification, community_id, internet_message_id, conversation_id, community:community_id(name)')
    .eq('direction', 'inbound').or(`mailbox.eq.${desk.mailbox},persona.eq.${desk.persona}`).neq('persona', 'tessa').gte('received_at', since)
    .order('received_at', { ascending: false }).limit(limit);
  if (error) return { desk: { persona: desk.persona, name: desk.name, mailbox: desk.mailbox }, items: [], source_errors: { inbox: error.message }, since };
  const rows = (msgs || []).filter((m) => onDesk(desk, m));
  let replies = [], receipts = [], sentInThread = [];
  if (rows.length) {
    const ids = rows.map((m) => m.id);
    const convs = [...new Set(rows.map((m) => m.conversation_id).filter(Boolean))];
    const refs = rows.filter((m) => m.internet_message_id).map((m) => 'email:' + m.internet_message_id);
    const [rq, sq, aq] = await Promise.all([
      supabase.from('outbound_email_drafts').select('id, source_email_ref, status, persona, created_at, sent_at').eq('draft_kind', desk.reply_kind).in('source_email_ref', ids),
      convs.length ? supabase.from('email_messages').select('conversation_id, received_at, created_at').eq('direction', 'outbound').eq('mailbox', desk.mailbox).in('conversation_id', convs) : Promise.resolve({ data: [] }),
      desk.persona === 'amanda' && refs.length ? supabase.from('outbound_email_drafts').select('source_email_ref, status').eq('draft_kind', 'amanda_auto_reply').in('source_email_ref', refs) : Promise.resolve({ data: [] }),
    ]);
    if (rq.error) source_errors.replies = rq.error.message; else replies = rq.data || [];
    if (sq.error) source_errors.sent = sq.error.message; else sentInThread = sq.data || [];
    if (aq.error) source_errors.auto_replies = aq.error.message; else receipts = aq.data || [];
  }
  const items = rows.map((m) => ({
    id: m.id, from_name: m.sender_name || null, from_email: m.sender_email || null, to: m.recipients || [],
    subject: m.subject || '', preview: m.body_preview || '', received_at: m.received_at,
    community: (m.community && m.community.name) || null, routed_to: m.persona || null, mailbox: m.mailbox,
    delivered_to_agent: lower(m.mailbox) === desk.mailbox,
    classification: m.classification || null, triage_status: m.triage_status || null,
    reply_status: replyStatus(m, { replies, sentInThread, receipts }),
    staged_reply_id: (replies.find((r) => r.source_email_ref === m.id && OPEN.includes(r.status)) || {}).id || null,
  }));
  return { desk: { persona: desk.persona, name: desk.name, mailbox: desk.mailbox, responsibilities: desk.responsibilities }, items, needs_reply: items.filter((i) => i.reply_status === 'needs_reply').length, source_errors, since };
}

async function loadThread(supabase, persona, id, deps = {}) {
  const desk = deskFor(persona, deps);
  const ga = deps.graphAttachments || require('./graph_attachments');
  const { data: m, error } = await supabase.from('email_messages')
    .select('id, mailbox, direction, sender_name, sender_email, recipients, subject, body_full, body_preview, received_at, triage_status, persona, community_id, graph_id, internet_message_id, conversation_id, has_attachments, extracted, community:community_id(name)')
    .eq('id', id).maybeSingle();
  if (error) throw new Error('thread_load_failed: ' + error.message);
  if (!m) return null;
  if (!onDesk(desk, m)) return { not_on_desk: true };
  let thread = []; let alreadyReplied = null;
  if (m.conversation_id) {
    const { data: t } = await supabase.from('email_messages')
      .select('id, mailbox, direction, sender_name, sender_email, recipients, subject, body_full, body_preview, received_at, created_at, persona, reviewed_by')
      .eq('conversation_id', m.conversation_id).order('received_at', { ascending: true }).limit(40);
    thread = (t || []).map((x) => ({ id: x.id, direction: x.direction, from: x.sender_name || x.sender_email, from_email: x.sender_email,
      to: x.recipients || [], subject: x.subject, body: x.body_full || x.body_preview || '', at: x.received_at || x.created_at, approved_by: x.direction === 'outbound' ? x.reviewed_by || null : undefined }));
    const sent = (t || []).filter((x) => x.direction === 'outbound' && lower(x.mailbox) === desk.mailbox && String(x.received_at || x.created_at) > String(m.received_at));
    if (sent.length) { const last = sent[sent.length - 1]; alreadyReplied = { at: last.received_at || last.created_at, subject: last.subject, to: last.recipients || [], approved_by: last.reviewed_by || null }; }
  }
  let body = m.body_full || ''; let to = m.recipients || []; let cc = []; const graph_errors = [];
  if (m.graph_id) {
    const [txt, rc] = await Promise.all([ga.fetchMessageText(m.mailbox, m.graph_id), ga.fetchMessageRecipients(m.mailbox, m.graph_id)]);
    if (txt && txt.length > body.length) body = txt;
    if ((rc.to || []).length || (rc.cc || []).length) { to = rc.to; cc = rc.cc; } else graph_errors.push('recipients_unavailable');
  }
  if (!body) body = m.body_preview || '';
  const mine = new Set(desk.aliases);
  const sender = lower(m.sender_email);
  // Reply all: the sender in To, everyone else on the original (To + CC) in CC, never this agent.
  const reply_all_cc = [...new Set([...to, ...cc].map(lower))].filter((a) => a && !mine.has(a) && a !== sender);
  const inThread = !!m.graph_id && lower(m.mailbox) === desk.mailbox;
  const thread_items = thread.length ? thread : [{ id: m.id, direction: 'inbound', from: m.sender_name || m.sender_email, from_email: m.sender_email, to, subject: m.subject, body, at: m.received_at }];
  return {
    desk: { persona: desk.persona, name: desk.name, mailbox: desk.mailbox, aliases: desk.aliases },
    message: { id: m.id, from_name: m.sender_name, from_email: m.sender_email, to, cc, subject: m.subject, body, received_at: m.received_at,
      community: (m.community && m.community.name) || null, community_id: m.community_id || null, routed_to: m.persona, triage_status: m.triage_status,
      mailbox: m.mailbox, graph_id: m.graph_id || null, conversation_id: m.conversation_id || null, has_attachments: !!m.has_attachments,
      emma_handoff: desk.persona === 'amanda' ? ((m.extracted && m.extracted.emma_handoff) || null) : null },
    thread: thread_items.map((x) => (x.id === m.id ? { ...x, body } : x)),
    already_replied: alreadyReplied,
    reply: { to: m.sender_email, subject: replySubject(m.subject), reply_all_cc, default_mode: reply_all_cc.length ? 'all' : 'sender',
      sends_from: desk.mailbox, in_thread: inThread,
      threading: inThread ? `Replies in the original thread from ${desk.mailbox}.` : `This message was delivered to ${m.mailbox}, not ${desk.mailbox}: the reply goes as a new message from ${desk.mailbox} with the original quoted.` },
    graph_errors,
  };
}

/** Recipients for a reply. Pure. Never this agent, never the sender in CC. */
function replyRecipients(desk, thread, { mode = 'all', extraCc = '' } = {}) {
  const parse = (v) => String(v || '').split(/[,;\s]+/).map(lower).filter((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a));
  const mine = new Set(desk.aliases);
  const sender = lower(thread.reply && thread.reply.to);
  const base = mode === 'sender' ? [] : ((thread.reply && thread.reply.reply_all_cc) || []);
  const cc = [...new Set([...base.map(lower), ...parse(extraCc)])].filter((a) => a !== sender && !mine.has(a));
  return { mode: mode === 'sender' ? 'sender' : 'all', to: (thread.reply && thread.reply.to) || null, cc };
}

/**
 * Stage a reply in the agent's Outbox. One open reply per message (unique index on
 * source_email_ref + draft_kind): staging again replaces its text. Refuses when a reply was
 * already sent in the thread from the agent's mailbox, unless a follow-up is explicitly asked.
 */
async function stageReply(supabase, persona, { thread, body, cc, createdBy, reason, factCheck = null, followUp = false }, deps = {}) {
  const desk = deskFor(persona, deps);
  const message = thread && thread.message;
  if (!message || !message.id || !message.from_email) throw new Error('message_required');
  if (!createdBy) throw new Error('signed_in_person_required');
  if (thread.already_replied && !followUp) { const e = new Error('already_replied'); e.code = 'already_replied'; e.detail = thread.already_replied; throw e; }
  const text = stripEmDashes(String(body || '').trim());
  if (!text) throw new Error('body_required');
  const ccList = replyRecipients(desk, thread, { mode: 'sender', extraCc: cc }).cc;
  const row = {
    persona: desk.persona, from_mailbox: desk.mailbox,
    to_email: message.from_email, to_name: message.from_name || null, cc: ccList.length ? ccList.join(', ') : null,
    subject: stripEmDashes(replySubject(message.subject)), body_text: text,
    draft_kind: desk.reply_kind, related_type: 'email_triage', related_id: message.id, source_email_ref: message.id,
    community_id: message.community_id || null, community_name: message.community || null,
    ai_drafted: true, status: 'draft', created_by: createdBy,
    draft_reason: reason || `Reply prepared on ${desk.name}'s desk; waiting for a person to review and send.`,
    policy: { desk: desk.persona, sends_from: desk.mailbox, in_thread: !!(thread.reply && thread.reply.in_thread), approval: desk.approval, guards: desk.guards, fact_check: factCheck },
  };
  const { data: open, error: oe } = await supabase.from('outbound_email_drafts').select('id, persona').eq('draft_kind', desk.reply_kind).eq('source_email_ref', message.id).eq('status', 'draft').limit(1);
  if (oe) throw new Error('stage_failed: ' + oe.message);
  if (open && open.length && open[0].persona !== desk.persona) { const e = new Error('reply_staged_by_another_agent'); e.code = 'reply_staged_by_another_agent'; e.detail = open[0].persona; throw e; }
  const cols = 'id, persona, from_mailbox, to_email, cc, subject, body_text, status, policy, created_at, updated_at';
  const q = open && open.length
    ? supabase.from('outbound_email_drafts').update({ to_email: row.to_email, cc: row.cc, subject: row.subject, body_text: row.body_text, created_by: row.created_by, draft_reason: row.draft_reason, policy: row.policy, send_error: null, updated_at: new Date().toISOString() }).eq('id', open[0].id).eq('status', 'draft').select(cols).single()
    : supabase.from('outbound_email_drafts').insert(row).select(cols).single();
  const { data, error } = await q;
  if (error) throw new Error('stage_failed: ' + error.message);
  return { ...data, replaced: !!(open && open.length) };
}

/** The agent's Outbox: open drafts and recent sends, this agent only. */
async function loadOutbox(supabase, persona, { days = 30 } = {}, deps = {}) {
  const desk = deskFor(persona, deps);
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const { data, error } = await supabase.from('outbound_email_drafts')
    .select('id, persona, from_mailbox, sent_from, draft_kind, status, to_email, to_name, cc, subject, body_text, created_by, approved_by, sent_at, sent_internet_message_id, send_error, policy, created_at, updated_at, source_email_ref')
    .eq('persona', desk.persona).neq('draft_kind', 'amanda_auto_reply').in('status', ['draft', 'sent']).gte('created_at', since)
    .order('created_at', { ascending: false }).limit(100);
  if (error) return { desk: { persona: desk.persona, mailbox: desk.mailbox }, drafts: [], sent: [], source_errors: { outbox: error.message } };
  const { classifyDraft } = require('../amanda/email_console');
  const { packageHash } = require('./reply_guard');
  // package_sha256: the fingerprint of exactly what the desk shows; Send echoes it back.
  // record_status is the stored state; status/reason are the desk's display labels.
  const rows = (data || []).map((d) => ({ ...d, record_status: d.status, ...classifyDraft(d), package_sha256: d.status === 'draft' ? packageHash(d) : null, sends_from: d.sent_from || d.from_mailbox || desk.mailbox }));
  return { desk: { persona: desk.persona, name: desk.name, mailbox: desk.mailbox }, drafts: rows.filter((d) => d.record_status === 'draft'), sent: rows.filter((d) => d.record_status === 'sent'), source_errors: {} };
}

/** Explicit reassignment to another agent's desk, recorded with who did it. */
async function reassign(supabase, persona, id, { to, by }, deps = {}) {
  const from = deskFor(persona, deps); const target = deskFor(to, deps);
  if (!by) throw new Error('signed_in_person_required');
  const { data: m, error } = await supabase.from('email_messages').select('id, mailbox, direction, persona, extracted').eq('id', id).maybeSingle();
  if (error) throw new Error('load_failed: ' + error.message);
  if (!m || !onDesk(from, m)) { const e = new Error('not_on_desk'); e.code = 'not_on_desk'; throw e; }
  const log = [...(((m.extracted || {}).reassignments) || []), { from: m.persona, to: target.persona, by, at: new Date().toISOString() }];
  const { error: ue } = await supabase.from('email_messages').update({ persona: target.persona, extracted: { ...(m.extracted || {}), reassignments: log } }).eq('id', id);
  if (ue) throw new Error('reassign_failed: ' + ue.message);
  return { id, from: m.persona, to: target.persona, by };
}

module.exports = { deskFor, desks, onDesk, replyStatus, loadInbox, loadThread, replyRecipients, stageReply, loadOutbox, reassign };
