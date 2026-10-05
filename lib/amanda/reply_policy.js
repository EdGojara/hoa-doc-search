// lib/amanda/reply_policy.js  (Issue #29, Amanda controlled send, 2026-10-04)
// ----------------------------------------------------------------------------
// THE authority gate for an automatic Amanda reply. Pure and deterministic: no
// model, no I/O. Generating text is not authority to send; this decides.
//
//   decideAmandaReply(input) -> { class: 'EXECUTE' | 'REVIEW', reasons: [] }
//
// EXECUTE only when EVERY condition holds; anything else is REVIEW, which is
// exactly today's behavior (a pending draft a person reviews). Reasons are kept
// so every pending draft can say why it was not sent.
//
// First slice (Ed, #29): AMANDA_AUTO_REPLY=on and AMANDA_AUTO_REPLY_SENDERS=
// egojara@bedrocktx.com. No global AUTO_OUTBOUND_EMAIL shortcut.
// ----------------------------------------------------------------------------
const POLICY_VERSION = 'amanda_auto_reply.v1';
const RATE_CAP_PER_HOUR = 10;
const INTERNAL = /@bedrocktx\.com$/i;

const norm = (a) => String(a || '').trim().toLowerCase();

function enabled(env = process.env) { return norm(env.AMANDA_AUTO_REPLY) === 'on'; }
function allowlist(env = process.env) { return String(env.AMANDA_AUTO_REPLY_SENDERS || '').split(',').map(norm).filter(Boolean); }

// Every AI teammate and functional inbox: never an automatic-reply recipient (no AI-to-AI loop).
function aiMailboxes(gs = require('../email/graph_send')) {
  const out = new Set((gs.TEAM_INGEST_MAILBOXES || []).map(norm));
  // Every *_MAILBOX constant is an AI teammate or functional inbox EXCEPT ED_MAILBOX (Ed himself).
  for (const [k, v] of Object.entries(gs)) if (/_MAILBOX$/.test(k) && k !== 'ED_MAILBOX' && typeof v === 'string') out.add(norm(v));
  out.add('amanda@bedrocktx.com');
  return out;
}

// input: { env, mailbox, amandaMailbox, email: { sender_email, direction, has_attachments },
//          authAs, toRecipients[], ccRecipients[], classification,
//          draft: { careful }, contract: { ok, intent, deterministic, durable, objective, audit_warnings },
//          recentAutoReplies, aiMailboxes:Set }
function decideAmandaReply(input) {
  const reasons = [];
  const env = input.env || process.env;
  const fail = (r) => reasons.push(r);
  const sender = norm(input.email && input.email.sender_email);
  const ai = input.aiMailboxes || aiMailboxes();

  if (!enabled(env)) fail('kill_switch_off');
  if (norm(input.mailbox) !== norm(input.amandaMailbox) || !input.amandaMailbox) fail('not_amanda_mailbox');
  if (!input.email || input.email.direction !== 'inbound') fail('not_inbound');
  if (!sender || !allowlist(env).includes(sender)) fail('sender_not_allowlisted');
  if (ai.has(sender) || /^(no-?reply|do-?not-?reply|notification)/i.test(sender)) fail('sender_is_ai_or_system');
  if (input.authAs !== 'Internal') fail(`not_authenticated_internal:${input.authAs || 'missing'}`);
  const everyone = [...(input.toRecipients || []), ...(input.ccRecipients || [])].map(norm).filter(Boolean);
  if (!everyone.length || everyone.some((a) => !INTERNAL.test(a))) fail('non_internal_recipient');
  if (input.email && input.email.has_attachments) fail('has_attachments');
  if (input.classification !== 'internal') fail(`classification:${input.classification || 'none'}`);

  const c = input.contract || {};
  if (!c.ok) fail('contract_not_ok');
  if (Array.isArray(c.audit_warnings) && c.audit_warnings.length) fail('contract_audit_warnings');
  if (input.draft && input.draft.careful) fail('draft_careful');
  const intentOk = (c.intent === 'query' && c.deterministic === 'status')
    || (c.intent === 'work' && c.durable === true && !!c.objective)
    || c.intent === 'decision';
  if (!intentOk) fail(`intent_not_eligible:${c.intent || 'none'}${c.intent === 'query' ? ':non_deterministic' : ''}`);
  if ((input.recentAutoReplies || 0) >= RATE_CAP_PER_HOUR) fail('rate_cap');

  // NEVER SILENT (Ed, 2026-10-05): when every SAFETY condition holds (switch, allowlisted human
  // sender, authenticated internal, internal-only thread, Amanda's mailbox, rate) but the ANSWER is
  // not eligible to go out by itself (AI-written prose, attachments, a careful draft, another
  // class of mail, no request contract), Amanda sends a fixed, non-AI acknowledgement instead of
  // going quiet. The real answer stays a pending draft for review. Nothing else changes.
  if (!reasons.length) return { class: 'EXECUTE', reasons, policy_version: POLICY_VERSION };
  const safetyFailed = reasons.some((r) => SAFETY.some((p) => r === p || r.startsWith(p + ':')));
  return { class: safetyFailed ? 'REVIEW' : 'ACKNOWLEDGE', reasons, policy_version: POLICY_VERSION };
}
// Conditions about WHO and WHERE (an acknowledgement is only allowed when all of these hold).
const SAFETY = ['kill_switch_off', 'not_amanda_mailbox', 'not_inbound', 'sender_not_allowlisted', 'sender_is_ai_or_system', 'not_authenticated_internal', 'non_internal_recipient', 'rate_cap'];

// The acknowledgement: fixed text, no model, no claim that anything was done.
function acknowledgementText(firstName) {
  return [`Hi ${firstName || 'there'},`,
    'I have this. My reply needs a person to review it before I send it, so it is waiting in review now. Nothing has been sent or changed yet.'].join('\n\n');
}

// Cheap prefilter before any Graph call: only spend the header read when it could matter.
function worthChecking({ env = process.env, mailbox, amandaMailbox, email }) {
  return enabled(env) && norm(mailbox) === norm(amandaMailbox) && !!email && email.direction === 'inbound'
    && allowlist(env).includes(norm(email.sender_email));
}

// X-MS-Exchange-Organization-AuthAs from Graph internetMessageHeaders ('Internal' for an
// authenticated sender inside the tenant; 'Anonymous' for outside mail, including spoofs).
function authAsFrom(headers) {
  const h = (headers || []).find((x) => norm(x && x.name) === 'x-ms-exchange-organization-authas');
  return h ? String(h.value || '').trim() : null;
}

module.exports = { decideAmandaReply, worthChecking, authAsFrom, acknowledgementText, enabled, allowlist, aiMailboxes, SAFETY, POLICY_VERSION, RATE_CAP_PER_HOUR };
