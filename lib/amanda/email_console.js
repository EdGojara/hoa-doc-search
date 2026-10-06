// ============================================================================
// lib/amanda/email_console.js  (Ed 2026-10-06) — Amanda's email desk
// ----------------------------------------------------------------------------
// What the "Amanda · Operations" card shows about her email: what she has
// prepared and is waiting on a person, and everything that actually happened
// (prepared, sent, blocked, failed), with the reason when it did not go.
//
// Why this exists. On 2026-10-06 Ed asked why Amanda's emails were not all on
// her screen. Three separate gaps, none visible from any one place:
//   1. Recording lived in each caller, not in the send. graph_send.sendAs writes
//      nothing, so anything that called it directly (a one-off script sent
//      "Photo check" on 10/05; the draft "forward" route) left no row anywhere.
//   2. Failures were mostly console-only. The draft queue kept send_error, the
//      auto-reply kept last_error, but no screen listed either.
//   3. There was no Amanda outbox on her card, so a prepared email had nowhere
//      to wait visibly.
//
// SOURCE OF TRUTH: outbound_email_drafts is the canonical lifecycle record for
// what Amanda prepares, sends and fails to send. email_messages is the existing
// sent-timeline record. Microsoft 365 Sent Items is NOT a record: it is read only
// to DETECT sends that bypassed both, which are shown as 'unrecorded' exceptions
// to investigate. Nothing here writes, backfills or mutates any row.
//
// So the activity list is built from three sources and reconciled:
//   * outbound_email_drafts (persona amanda): prepared / failed / blocked / sent
//   * email_messages (persona amanda, outbound): what trustEd recorded as sent
//   * Amanda's Microsoft 365 Sent Items (read-only, detection only): a message
//     there with no trustEd record shows as an 'unrecorded' exception, so a
//     bypass can never make an email that really left invisible.
//
// Nothing here sends. Prepared emails are staged as outbound_email_drafts rows
// and released through the existing POST /api/email-drafts/:id/send, which
// already builds with Amanda's signature (buildAmandaEmail), records the send
// and keeps send_error on failure. One send path, one signature path.
// ============================================================================
const { route: aiRoute } = require('../ai/router');
const { stripEmDashes } = require('../tone');
const { ROSTER } = require('../team/roster');

const PERSONA = 'amanda';
const ME = ROSTER.find((m) => m.persona === PERSONA) || { name: 'Amanda Albright', signature_title: 'Senior Community Manager' };

const AMANDA_VOICE = `You are ${ME.name}, ${ME.signature_title} at Bedrock Association Management.
You are the operating manager: you run day-to-day community operations, handle
escalations and community-wide issues, and coordinate the team, boards, vendors and
staff. Staff and Ed hand you instructions; you turn them into clear, complete emails.

Write the email AS AMANDA. It is your email. Direct, organized, courteous, plain
English, no fluff. Lead with what the reader needs to know or do. Use commas, never
em-dashes. Do not invent facts, amounts, dates, policies or commitments you were not
given; if a detail is missing, write so it reads naturally without it (no [DATE]
placeholders). Close simply with "Thank you," and "Amanda". Your full signature
(name, title, company, logo) is appended automatically, so do not add it.`;

function buildPrompt(recipientName) {
  const to = recipientName ? `The recipient is ${recipientName}. ` : '';
  const { ATTACHMENT_RULE, PROPORTIONALITY_RULE } = require('../team/reply_judgment');
  return `${AMANDA_VOICE}

${ATTACHMENT_RULE}

${PROPORTIONALITY_RULE}

${to}You will get an instruction or rough thought. Turn it into a complete, send-ready
email of a few short paragraphs at most.

Return ONLY a JSON object (no markdown fence):
{ "subject": "string, a clear subject line", "body": "string, the full email body including the greeting and sign-off" }`;
}

/**
 * Draft an email in Amanda's voice. Same contract as lib/ea/tessa.js draftEmail
 * ({ thought, recipientName } -> { subject, body } | { degraded }), so it can be
 * injected into the shared request runner.
 */
async function draftAmandaEmail({ thought, recipientName, attachmentBlocks = [], attachmentSummary = '' }, deps = {}) {
  if (!thought || !String(thought).trim()) return { degraded: true, error: 'empty' };
  let anthropic = deps.anthropic;
  if (!anthropic) {
    const Anthropic = require('../ai/anthropic');
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  // Attachments (when replying to an email that has them) go in as readable
  // blocks; a rejected block falls back to text-only naming the files.
  const judgment = require('../team/reply_judgment');
  const userText = `Instruction: ${String(thought).trim()}` + (attachmentSummary ? `

ATTACHMENTS: ${attachmentSummary}` : '');
  const call = (content) => anthropic.messages.create({ model: aiRoute('team.amanda_email_draft'), max_tokens: 1500, system: buildPrompt(recipientName), messages: [{ role: 'user', content }] });
  let blocks = Array.isArray(attachmentBlocks) ? attachmentBlocks : [];
  const ask = async (extra) => {
    const t = userText + (extra ? `

${extra}` : '');
    try { return await call(blocks.length ? [...blocks, { type: 'text', text: t }] : t); }
    catch (e) {
      if (!blocks.length) throw e;
      blocks = [];
      return call(t + `

(The attachments could not be opened. Acknowledge them by name: ${attachmentSummary || 'attached files'}. Do not ask the sender to resend them.)`);
    }
  };
  const textOf = (c) => (c.content && c.content[0] && c.content[0].text) || '';
  let completion = await ask();
  // Deterministic guard: never claim facts are unavailable when an attachment was read.
  if (blocks.length && judgment.checkReply(parseBody(textOf(completion)), { attachmentsRead: true }).claims_unavailable) completion = await ask(judgment.RETRY_NOTE);
  const text = textOf(completion);
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const p = JSON.parse(cleaned);
    return { subject: stripEmDashes(p.subject || ''), body: stripEmDashes(p.body || '') };
  } catch (e) {
    return { degraded: true, error: 'draft_unreadable' };
  }
}

function parseBody(raw) {
  try { return JSON.parse(String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()).body || ''; } catch (_) { return String(raw || ''); }
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** "a@x.com; Bob <b@y.com>" | ['a@x.com'] -> ['a@x.com','b@y.com'] (deduped, lowercased). */
function parseAddresses(v) {
  const parts = Array.isArray(v) ? v : String(v || '').split(/[,;\n]/);
  const out = [];
  for (const raw of parts) {
    const s = String(raw || '').trim();
    const m = s.match(/<([^>]+)>/);
    const a = (m ? m[1] : s).trim().toLowerCase();
    if (a && EMAIL_RE.test(a) && !out.includes(a)) out.push(a);
  }
  return out;
}

/**
 * Stage an email in Amanda's outbox (outbound_email_drafts, status 'draft').
 * Throws on a write error: a prepared email that silently fails to stage is the
 * exact disappearing-email bug this console exists to end.
 */
async function stageDraft(supabase, { to, cc, toName, subject, body, createdBy, reason, kind = 'amanda_console', communityId = null, communityName = null }) {
  const toList = parseAddresses(to);
  if (!toList.length) throw new Error('recipient_required');
  if (!String(subject || '').trim()) throw new Error('subject_required');
  if (!String(body || '').trim()) throw new Error('body_required');
  const ccList = parseAddresses(cc).filter((a) => !toList.includes(a));
  const { AMANDA_MAILBOX } = require('../email/graph_send');
  const { data, error } = await supabase.from('outbound_email_drafts').insert({
    persona: PERSONA,
    from_mailbox: AMANDA_MAILBOX,
    to_email: toList.join(', '),
    to_name: toName || null,
    cc: ccList.length ? ccList.join(', ') : null,
    subject: stripEmDashes(String(subject).trim()),
    body_text: stripEmDashes(String(body).trim()),
    draft_kind: kind,
    ai_drafted: true,
    draft_reason: reason || 'Prepared by Amanda; waiting for a person to review and send.',
    status: 'draft',
    created_by: createdBy || null,
    community_id: communityId,
    community_name: communityName,
  }).select('id, to_email, cc, subject, status, created_at').single();
  if (error) throw new Error('stage_failed: ' + error.message);
  return data;
}

const BLOCKED_RE = /\b(suppress|blocked|forbidden|denied|not allowed|permission|policy|guard|403|access ?denied|raop)\b/i;

/**
 * One outbound_email_drafts row -> activity status.
 *   prepared  waiting in the outbox, never attempted
 *   failed    an attempt errored (send_error / last_error), still needs a person
 *   blocked   a policy / permission / guard stopped it (reason kept)
 *   sent      went out
 *   discarded a person threw it away
 */
function classifyDraft(row) {
  const err = row.send_error || row.last_error || null;
  if (row.status === 'sent') return { status: 'sent', reason: null };
  if (row.status === 'discarded') return { status: 'discarded', reason: null };
  if (row.status === 'failed' || row.status === 'unverified') {
    return { status: BLOCKED_RE.test(err || '') ? 'blocked' : 'failed', reason: err || (row.status === 'unverified' ? 'Send could not be confirmed in Sent Items.' : 'Send failed.') };
  }
  if (err) return { status: BLOCKED_RE.test(err) ? 'blocked' : 'failed', reason: err };
  if (row.draft_kind === 'amanda_auto_reply') return { status: 'in_progress', reason: `Automatic reply ${String(row.status || '').replace(/_/g, ' ')}` };
  return { status: 'prepared', reason: null };
}

// ---------------------------------------------------------------------------
// MATCHING: is a Sent Items message the same email as a trustEd record?
//
// The "Unrecorded" banner is an exception people act on, so it is biased hard
// against FALSE ALARMS (calling a recorded send unrecorded). The cost of that
// bias is that a bypass identical to a recorded send (same subject, an
// overlapping recipient, within the hour) is not separately flagged; one-to-one
// pairing below keeps even that case visible when the bypass is an extra copy.
//
//   1. Message id first. Automatic replies store the sent message's
//      internetMessageId (read back from Sent Items at verification), so they
//      match exactly. Human sends (draft queue, Communications reply, compose)
//      cannot: Graph sendMail returns 202 with no id, so for those:
//   2. Heuristic, ALL of:
//      - subject equal after normalising: any number of Re:/Fw:/Fwd:/AW:/SV:
//        prefixes, [EXTERNAL]-style tags, case, whitespace, and dash / quote
//        variants (en/em dash vs hyphen, curly vs straight quotes);
//      - at least one address in common across To + CC (order, case, display
//        names and extra recipients do not matter);
//      - sent within MATCH_WINDOW_MS of the record's send time (records stamp
//        after Graph accepts the send, so small gaps are normal).
//   3. One-to-one: each record pairs with at most one Sent Items message, the
//      closest in time. Two quick sends with the same subject to the same
//      person each need their own record.
//
// Coverage guards (no banner when we cannot actually know):
//   - if a record source failed to load, nothing is flagged (status 'unchecked');
//   - a Sent Items message older than the oldest record we loaded (record list
//     hit its row cap) is 'unchecked', not 'unrecorded';
//   - calendar responses / meeting messages (eventMessage) are not emails we
//     send and are never flagged.
// ---------------------------------------------------------------------------
const MATCH_WINDOW_MS = 60 * 60e3;
function normSubject(s) {
  let t = String(s || '').normalize('NFKC')
    .replace(/[‐-―−]/g, '-').replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"')
    .replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 10; i++) {
    const n = t.replace(/^\s*(\[[^\]]{1,20}\]|\((?:external|ext)\))\s*/i, '').replace(/^\s*(re|fw|fwd|aw|sv|wg)\s*(\[\d+\])?\s*:\s*/i, '');
    if (n === t) break; t = n;
  }
  return t.toLowerCase();
}
const addrSet = (...lists) => new Set(lists.flatMap((l) => parseAddresses(l)));
function overlaps(a, b) { for (const x of a) if (b.has(x)) return true; return false; }
function heuristicMatch(rec, msg) {
  return normSubject(rec.subject) === normSubject(msg.subject)
    && overlaps(addrSet(rec.to, rec.cc), addrSet(msg.to, msg.cc))
    && Math.abs(new Date(rec.at) - new Date(msg.at)) <= MATCH_WINDOW_MS;
}
/** Pair messages to records one-to-one: exact message id first, then the closest heuristic match. */
function pairOneToOne(records, msgs) {
  const used = new Set(); const paired = new Map();
  for (const m of msgs) {
    if (!m.internet_message_id) continue;
    const r = records.find((x) => !used.has(x) && x.internet_message_id && x.internet_message_id === m.internet_message_id);
    if (r) { used.add(r); paired.set(m, r); }
  }
  for (const m of msgs) {
    if (paired.has(m)) continue;
    let best = null; let gap = Infinity;
    for (const r of records) {
      if (used.has(r) || !heuristicMatch(r, m)) continue;
      const g = Math.abs(new Date(r.at) - new Date(m.at));
      if (g < gap) { gap = g; best = r; }
    }
    if (best) { used.add(best); paired.set(m, best); }
  }
  return paired;
}

/**
 * Merge the three sources into one newest-first list. Pure: no I/O, so it is
 * unit-tested directly.
 *   drafts    outbound_email_drafts rows (persona amanda)
 *   logged    email_messages rows (persona amanda, direction outbound)
 *   graph     Sent Items messages { subject, sentDateTime, toRecipients, ccRecipients, internetMessageId, '@odata.type' }
 *   coverage  { recordsComplete: bool, coveredFrom: iso|null } — see coverage guards above
 */
function mergeActivity({ drafts = [], logged = [], graph = [], coverage = { recordsComplete: true, coveredFrom: null } }) {
  const items = [];
  for (const d of drafts) {
    const c = classifyDraft(d);
    items.push({
      source: d.draft_kind === 'amanda_auto_reply' ? 'auto_reply' : 'outbox',
      id: d.id, status: c.status, reason: c.reason,
      at: d.sent_at || d.updated_at || d.created_at, created_at: d.created_at, sent_at: d.sent_at || null,
      to: d.to_email || '', cc: d.cc || '', subject: d.subject || '',
      internet_message_id: d.sent_internet_message_id || null,
    });
  }
  // A timeline row for an email the outbox already shows as sent is the same email.
  const asRecord = (m) => ({ source: 'trustEd', id: m.id, status: 'sent', reason: null, at: m.sent_at || m.created_at || m.received_at,
    created_at: m.created_at, sent_at: m.sent_at || m.created_at, to: Array.isArray(m.recipients) ? m.recipients.join(', ') : (m.recipients || ''),
    cc: '', subject: m.subject || '', internet_message_id: m.internet_message_id || null });
  const loggedRows = logged.map(asRecord);
  const dupOfDraft = pairOneToOne(items.filter((i) => i.status === 'sent'), loggedRows);
  for (const r of loggedRows) if (!dupOfDraft.has(r)) items.push(r);

  // Detection only: Sent Items messages with no trustEd record.
  const msgs = graph.filter((g) => !/eventMessage/i.test(g['@odata.type'] || '')).map((g) => ({
    source: 'sent_items', id: g.internetMessageId || g.id, status: 'sent', at: g.sentDateTime, created_at: g.sentDateTime, sent_at: g.sentDateTime,
    to: (g.toRecipients || []).map((t) => t.emailAddress && t.emailAddress.address).filter(Boolean).join(', '),
    cc: (g.ccRecipients || []).map((t) => t.emailAddress && t.emailAddress.address).filter(Boolean).join(', '),
    subject: g.subject || '', internet_message_id: g.internetMessageId || null,
  }));
  const paired = pairOneToOne(items.filter((i) => i.status === 'sent'), msgs);
  for (const m of msgs) {
    if (paired.has(m)) continue;
    const beforeCoverage = coverage.coveredFrom && new Date(m.at) < new Date(coverage.coveredFrom);
    if (!coverage.recordsComplete || beforeCoverage) {
      m.status = 'unchecked';
      m.reason = !coverage.recordsComplete
        ? 'Could not be checked: trustEd’s own records did not load, so this is not flagged.'
        : 'Older than the records loaded for comparison, so this is not flagged.';
    } else {
      // An exception, not a record: it left Amanda's mailbox with no trustEd row.
      m.status = 'unrecorded';
      m.reason = 'Unrecorded send: found in Amanda’s Sent Items with no matching trustEd record (same subject, a shared recipient, within an hour). Needs investigation.';
      m.unrecorded = true;
    }
    items.push(m);
  }
  return items.sort((a, b) => new Date(b.at) - new Date(a.at));
}

/** Read Amanda's Sent Items since `sinceIso`. Returns { messages, error }; never throws. */
async function readSentItems(sinceIso, deps = {}) {
  try {
    const gs = deps.graphSend || require('../email/graph_send');
    if (!gs.isConfigured()) return { messages: [], error: 'graph_not_configured' };
    const token = await gs.getToken();
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(gs.AMANDA_MAILBOX)}/mailFolders/sentitems/messages`
      + `?$top=50&$filter=${encodeURIComponent('sentDateTime ge ' + sinceIso)}&$orderby=${encodeURIComponent('sentDateTime desc')}`
      + '&$select=id,subject,sentDateTime,toRecipients,ccRecipients,internetMessageId';
    const r = await (deps.fetch || fetch)(url, { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { messages: [], error: 'sent_items_' + r.status + (j.error && j.error.code ? ' ' + j.error.code : '') };
    return { messages: j.value || [], error: null };
  } catch (e) {
    return { messages: [], error: 'sent_items_unavailable: ' + e.message };
  }
}

/**
 * Everything for the card: outbox (prepared + failed/blocked still open) and the
 * reconciled activity list for the last `days` days. Source failures are returned
 * in `source_errors`, never hidden: an unavailable source is not the same as none.
 */
async function loadEmailDesk(supabase, { days = 14, limit = 100 } = {}, deps = {}) {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const buffer = new Date(Date.now() - (days + 1) * 86400e3).toISOString();
  const RECORD_CAP = 500;
  const source_errors = {};
  const COLS = 'id, status, draft_kind, to_email, to_name, cc, subject, body_text, created_at, updated_at, sent_at, send_error, last_error, sent_internet_message_id, draft_reason';
  const [oq, dq, lq, sent] = await Promise.all([
    // The outbox has no date window: a prepared email waits until a person acts.
    supabase.from('outbound_email_drafts').select(COLS)
      .eq('persona', PERSONA).eq('status', 'draft').neq('draft_kind', 'amanda_auto_reply')
      .order('created_at', { ascending: false }).limit(limit),
    // Records are read from a day BEFORE the window (and drafts SENT in the window
    // even if prepared earlier), so a send at the window's edge always has its
    // record available to match. Capped higher than the display limit.
    supabase.from('outbound_email_drafts').select(COLS)
      .eq('persona', PERSONA).or(`created_at.gte.${buffer},sent_at.gte.${buffer}`).order('created_at', { ascending: false }).limit(RECORD_CAP),
    supabase.from('email_messages')
      .select('id, subject, recipients, created_at, received_at, sent_at, internet_message_id')
      .eq('persona', PERSONA).eq('direction', 'outbound').gte('created_at', buffer).order('created_at', { ascending: false }).limit(RECORD_CAP),
    readSentItems(since, deps),
  ]);
  if (oq.error) source_errors.outbox = oq.error.message;
  if (dq.error) source_errors.activity = dq.error.message;
  if (lq.error) source_errors.recorded = lq.error.message;
  if (sent.error) source_errors.sent_items = sent.error;
  const drafts = dq.data || [];
  const logged = lq.data || [];
  // Coverage: if a record list hit its cap, Sent Items older than its oldest row
  // cannot be judged, so they are 'unchecked', never 'unrecorded'.
  const oldest = (rows) => (rows.length >= RECORD_CAP ? rows[rows.length - 1].created_at : null);
  const caps = [oldest(drafts), oldest(logged)].filter(Boolean).sort();
  const coverage = { recordsComplete: !dq.error && !lq.error, coveredFrom: caps.length ? caps[caps.length - 1] : null };
  const activity = mergeActivity({ drafts, logged, graph: sent.messages, coverage })
    .filter((i) => new Date(i.at) >= new Date(since) || i.status === 'prepared' || i.status === 'failed' || i.status === 'blocked')
    .slice(0, limit);
  const outbox = (oq.data || []).map((d) => ({ ...d, ...classifyDraft(d) }));
  const exceptions = activity.filter((i) => i.status === 'unrecorded').length;
  return { outbox, activity, exceptions, source_errors, since };
}

module.exports = {
  PERSONA, draftAmandaEmail, stageDraft, parseAddresses, classifyDraft, mergeActivity, readSentItems, loadEmailDesk,
};
