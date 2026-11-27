// ============================================================================
// lib/amanda/internal_replies.js  (Ed 2026-11-28: standing authority, internal correspondence)
// ----------------------------------------------------------------------------
// Ed: "I want Amanda to respond autonomously to routine internal emails from Bedrock employees
// and AI teammates. This is standing authority, not a one-time instruction ... Send routine
// internal responses without waiting for my approval. Existing authorization requirements for
// financial postings, payments, contractual commitments and restricted decisions remain
// unchanged ... Do not create duplicate responses or unnecessary acknowledgments."
//
// Why this exists: since 2026-10-22 every AI-employee reply, Amanda's included, waited as a
// pending draft (graph_ingest: "The Issue #29 auto-reply gate is no longer consulted"), and the
// Issue #29 gate itself only ever allowed Ed as a sender. So a staff member writing to Amanda
// got a draft nobody sent: Martha's four emails of 11/27 sat unanswered.
//
// The path, for mail delivered to Amanda's mailbox and classified internal, once Amanda drafted:
//   1. sender      an ACTIVE Bedrock staff member (user_profiles, @bedrocktx.com), or an AI
//                  teammate mailbox behind a loop guard (never an automatic reply, at most
//                  LOOP_CAP automatic replies per conversation per day)
//      careful     a draft Amanda marked careful goes to the send check WITH what she held; the
//                  check must find the reply leaves that part to a person
//   2. restricted  a deterministic screen: anything about approving or releasing payments,
//                  postings, refunds, write-offs, contracts, waivers, legal positions or
//                  personnel stays a draft for a person (no acknowledgement either)
//   3. send check  one routed model call (team.amanda_internal_send_check): does the message
//                  need a reply at all; does the draft state anything as done or true that the
//                  thread does not show; does it commit to an action Amanda cannot take; is it
//                  courteous. A wording problem gets ONE revision from the thread alone and a
//                  fresh check. Any doubt, model error or unparseable answer = not sent.
//   4. send        the existing Issue #29 receipt machinery (lib/amanda/auto_reply): claimed
//                  once per inbound message, same-thread reply from Amanda's mailbox, verified in
//                  Sent Items, escalated to a person when unsure. Never a second reply.
// A message that needs no reply ("thanks", FYI, an automatic reply) is marked handled, silently.
// ============================================================================
const { route: aiRoute } = require('../ai/router');

const INTERNAL = /@bedrocktx\.com$/i;
const LOOP_CAP = 2;
const norm = (a) => String(a || '').trim().toLowerCase();

function enabled(env = process.env) { return norm(env.AMANDA_INTERNAL_REPLIES) !== 'off'; }

// Deterministic: topics that stay with a person whatever the model says.
const RESTRICTED = [
  [/\b(approve|release|authori[sz]e|send|issue|make)\s+(the\s+|a\s+|this\s+|that\s+)?(payment|wire|ach|transfer|refund|check run)\b/i, 'payment_or_refund'],
  [/\b(post|reverse|void)\s+(the\s+|a\s+|this\s+|that\s+)?(entry|entries|journal|charge|credit|adjustment)\b/i, 'posting'],
  [/\b(write[- ]?off|waive|waiver|forgive)\b/i, 'write_off_or_waiver'],
  [/\b(sign|execute|terminate|renew)\s+(the\s+|a\s+|this\s+|that\s+)?(contract|agreement|proposal|engagement)\b/i, 'contract'],
  [/\b(legal advice|lawsuit|sue|litigation|demand letter|cease and desist)\b/i, 'legal'],
  [/\b(salary|payroll|raise|termination|fire[d]?|disciplin|hr complaint|harass)/i, 'personnel'],
  [/\b(password|bank account number|routing number|ssn|social security)\b/i, 'sensitive_data'],
];
function restrictedTopics(...texts) {
  const t = texts.map((x) => String(x || '')).join('\n');
  return [...new Set(RESTRICTED.filter(([re]) => re.test(t)).map(([, k]) => k))];
}

const AUTO_SUBJECT = /^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|undeliverable|delivery (status )?notification)\b/i;

// Who is this sender? { kind: 'staff' | 'ai' | null, why }
async function classifySender(supabase, email, { aiMailboxes } = {}) {
  const s = norm(email && email.sender_email);
  if (!s || !INTERNAL.test(s)) return { kind: null, why: 'not_internal' };
  if (/^(no-?reply|do-?not-?reply|notification|notifications|postmaster|mailer-daemon)@/i.test(s)) return { kind: null, why: 'system_sender' };
  const ai = aiMailboxes || require('./reply_policy').aiMailboxes();
  if (ai.has(s)) return { kind: 'ai', why: 'ai_teammate' };
  const { data, error } = await supabase.from('user_profiles').select('email, role, is_active').ilike('email', s).limit(1);
  if (error) return { kind: null, why: 'staff_lookup_failed' };
  const u = (data || [])[0];
  if (!u || u.is_active === false || !['staff', 'admin', 'owner'].includes(String(u.role || '').toLowerCase())) return { kind: null, why: 'not_active_staff' };
  return { kind: 'staff', why: 'active_staff' };
}

function checkPrompt({ inbound, thread, draft, held = null }) {
  return `You check one email reply before it is sent automatically by Amanda, an AI community manager at Bedrock Association Management, to a Bedrock colleague. Be strict: when unsure, do not send.

THE MESSAGE AMANDA RECEIVED (with any quoted thread below it):
From: ${inbound.sender_name || ''} <${inbound.sender_email || ''}>
Subject: ${inbound.subject || ''}
${String(thread || '').slice(0, 12000)}

AMANDA'S DRAFT REPLY:
${String(draft || '').slice(0, 6000)}
${held ? `
Amanda flagged that part of this needs a person (${held}). The reply must leave that part to a person (say so, or ask), never decide it; if it decides it, "no_commitments" is false.
` : ''}
Answer ONLY with JSON:
{"needs_reply": true|false,      // false for a thank-you, FYI, sign-off, automatic reply, or anything that asks nothing and needs no answer
 "supported": true|false,        // false if the draft states as done, received, deposited, sent, approved or true ANYTHING that the message and thread above do not show
 "no_commitments": true|false,   // false if the draft promises or performs a payment, posting, refund, write-off, contract, waiver, legal position or personnel decision
 "courteous": true|false,        // false if the tone is curt, scolding or condescending to a colleague
 "issues": ["short reasons for any false above"]}`;
}

function parseCheck(raw) {
  try {
    const t = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const j = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    if (typeof j.needs_reply !== 'boolean' || typeof j.supported !== 'boolean' || typeof j.no_commitments !== 'boolean' || typeof j.courteous !== 'boolean') return null;
    return { needs_reply: j.needs_reply, ok: j.supported && j.no_commitments && j.courteous, supported: j.supported, no_commitments: j.no_commitments, courteous: j.courteous, issues: Array.isArray(j.issues) ? j.issues.map(String).slice(0, 6) : [] };
  } catch (_) { return null; }
}

// One bounded revision when the check finds an unsupported claim or a curt tone: rewrite using ONLY
// what the message and thread show, then the check runs again. Never a second revision.
async function reviseDraft({ inbound, thread, draft, issues }, { client } = {}) {
  const c = client || (process.env.ANTHROPIC_API_KEY ? new (require('../ai/anthropic'))({ apiKey: process.env.ANTHROPIC_API_KEY }) : null);
  if (!c) return null;
  try {
    const r = await c.messages.create({ model: aiRoute('team.amanda_staff_assist'), max_tokens: 900, messages: [{ role: 'user', content: `Rewrite Amanda's reply to a Bedrock colleague. Amanda is a warm, capable senior community manager. Fix exactly these problems: ${issues.join('; ')}.

Rules: state nothing as done, received, deposited or true unless the message or thread below shows it; when something is unknown, ask for it plainly. Be courteous and brief. No em-dashes. Plain text, no signature, start with "Hi ${String(inbound.sender_name || '').trim().split(/\s+/)[0] || 'there'},".

MESSAGE AND THREAD:
${String(thread || '').slice(0, 12000)}

CURRENT DRAFT:
${String(draft || '').slice(0, 6000)}

Return only the rewritten reply.` }] });
    const t = r && r.content && r.content[0] && String(r.content[0].text || '').trim();
    // Her signature block is added at send; a bare sign-off here would print her name twice.
    return t ? require('../tone').stripEmDashes(t).replace(/\n+\s*(?:(?:thanks|thank you|best|regards)[,!.]?\s*\n+\s*)?amanda\s*$/i, '').trim() : null;
  } catch (_) { return null; }
}

async function sendCheck({ inbound, thread, draft, held = null }, { client } = {}) {
  const c = client || (process.env.ANTHROPIC_API_KEY ? new (require('../ai/anthropic'))({ apiKey: process.env.ANTHROPIC_API_KEY }) : null);
  if (!c) return { ok: false, needs_reply: true, issues: ['send check unavailable'] };
  try {
    const r = await c.messages.create({ model: aiRoute('team.amanda_internal_send_check'), max_tokens: 400, messages: [{ role: 'user', content: checkPrompt({ inbound, thread, draft, held }) }] });
    const parsed = parseCheck(r && r.content && r.content[0] && r.content[0].text);
    return parsed || { ok: false, needs_reply: true, issues: ['send check answer was not readable'] };
  } catch (e) { return { ok: false, needs_reply: true, issues: ['send check failed: ' + String(e.message).slice(0, 120)] }; }
}

/**
 * Decide and (when every condition holds) send Amanda's reply to one internal message.
 * inbound = the stored email_messages row (+ id); draft = { body, careful, persona }.
 * Returns { action: 'sent' | 'no_reply_needed' | 'review' | 'skipped', reasons, result? }.
 */
async function handleInternal({ supabase, inbound, draft, env = process.env, deps = {} }) {
  const gs = deps.graphSend || require('../email/graph_send');
  const note = async (patch) => {
    try { const { data } = await supabase.from('email_messages').select('extracted').eq('id', inbound.id).single();
      await supabase.from('email_messages').update({ extracted: { ...((data && data.extracted) || {}), amanda_internal: { at: new Date().toISOString(), ...patch } }, ...(patch.action === 'no_reply_needed' ? { triage_status: 'handled', reviewed_by: 'amanda (no reply needed)', reviewed_at: new Date().toISOString() } : {}) }).eq('id', inbound.id); }
    catch (e) { console.warn('[amanda_internal] note failed:', e.message); }
  };
  const out = (action, reasons, extra = {}) => ({ action, reasons, ...extra });
  if (!enabled(env)) return out('skipped', ['internal_replies_off']);
  if (norm(inbound.mailbox) !== norm(gs.AMANDA_MAILBOX) || inbound.direction !== 'inbound' || inbound.classification !== 'internal') return out('skipped', ['not_internal_mail_to_amanda']);
  if (!draft || !String(draft.body || '').trim()) return out('skipped', ['no_draft']);

  const who = await classifySender(supabase, inbound, deps);
  if (!who.kind) { await note({ action: 'review', reasons: [who.why] }); return out('review', [who.why]); }
  if (AUTO_SUBJECT.test(String(inbound.subject || '').trim())) { await note({ action: 'no_reply_needed', reasons: ['automatic_message'] }); return out('no_reply_needed', ['automatic_message']); }
  if (who.kind === 'ai' && inbound.conversation_id) {
    const { count, error } = await supabase.from('outbound_email_drafts').select('id', { count: 'exact', head: true }).eq('draft_kind', 'amanda_auto_reply').eq('conversation_id', inbound.conversation_id).gte('created_at', new Date(Date.now() - 86400e3).toISOString());
    if (error || (count || 0) >= LOOP_CAP) { await note({ action: 'review', reasons: ['ai_loop_guard'] }); return out('review', ['ai_loop_guard']); }
  }
  const thread = inbound.body_full || inbound.body_preview || '';
  const topics = restrictedTopics(draft.body, String(thread).split(/\n\s*(from:|-----original message|on .{4,80} wrote:)/i)[0]);
  if (topics.length) { await note({ action: 'review', reasons: topics.map((t) => 'restricted:' + t) }); return out('review', topics.map((t) => 'restricted:' + t)); }

  const check = deps.sendCheck || sendCheck;
  // A draft Amanda flagged as careful (she held part of it for a person) is not stopped by the flag
  // alone: the send check is told what she held and must find that the reply does not decide it.
  const held = draft.careful ? String(draft.review_hint || 'part of this needs a person') : null;
  let chk = await check({ inbound, thread, draft: draft.body, held });
  if (!chk.needs_reply) { await note({ action: 'no_reply_needed', reasons: chk.issues }); return out('no_reply_needed', chk.issues); }
  let body = draft.body; let revised = false;
  // A wording problem (unsupported claim, tone) gets ONE revision and a fresh check; a commitment never does.
  if (!chk.ok && chk.no_commitments !== false && (chk.supported === false || chk.courteous === false)) {
    const rewrite = await (deps.reviseDraft || reviseDraft)({ inbound, thread, draft: draft.body, issues: chk.issues });
    if (rewrite && !restrictedTopics(rewrite).length) {
      const again = await check({ inbound, thread, draft: rewrite, held });
      if (again.ok && again.needs_reply) { body = rewrite; revised = true; chk = again; }
      else chk = { ...again, issues: [...chk.issues, ...again.issues.map((i) => 'after revision: ' + i)] };
    }
  }
  if (!chk.ok) { await note({ action: 'review', reasons: chk.issues.length ? chk.issues : ['send_check_failed'], check: chk }); return out('review', chk.issues.length ? chk.issues : ['send_check_failed']); }
  draft = { ...draft, body };

  // The existing receipt machinery: claimed once per inbound message, same-thread, verified.
  const auto = deps.autoReply || require('./auto_reply').getAutoReply();
  const decision = { class: 'EXECUTE', reasons: [], policy_version: 'amanda_internal_replies.v1', standing_authority: 'Ed 2026-11-28 internal correspondence', sender_kind: who.kind, check: chk, revised };
  const result = await auto.execute({ inbound: { ...inbound }, draft, decision, contract: null, communityName: null });
  const action = result && result.skipped ? (result.skipped === 'already_claimed' ? 'skipped' : 'review') : 'sent';
  await note({ action, reasons: result && result.skipped ? [result.skipped] : [], status: result && result.status, sender_kind: who.kind });
  return out(action, result && result.skipped ? [result.skipped] : [], { result });
}

module.exports = { handleInternal, classifySender, restrictedTopics, parseCheck, checkPrompt, sendCheck, reviseDraft, enabled, LOOP_CAP };
