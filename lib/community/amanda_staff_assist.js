// ============================================================================
// lib/community/amanda_staff_assist.js  (Ed 2026-08-20)
// ----------------------------------------------------------------------------
// A colleague emails Amanda for help and gets HELP.
//
// Ed: "i want amanda to act like a manager and actual correspond with our
// staff."
//
// The gap this fills, exactly as it happened. Martha forwarded Amanda a board
// thread with one line on top: "Hi Amanda, Please help me with a response to
// Alexis." No attachment, so the document-review path correctly skipped it, and
// it fell through to the escalation path — which is a FORM LETTER. Martha, a
// community manager, got:
//
//   "I'm sorry this has been frustrating ... I've pulled the full history on
//    your property ..."
//
// Byte-identical to what a one-word test email got. Amanda answered a
// colleague as though she were an angry homeowner with a lot, apologised for
// nothing, and claimed to have pulled records she never opened.
//
// Three separate failures behind one bad reply:
//   1. Sender type was never considered. Staff and homeowners took one path.
//   2. The escalation reply is templated, so it cannot answer a question. It is
//      a holding message, and a holding message sent to a manager who asked for
//      a draft is worse than silence — she waits for something that is not coming.
//   3. It fired at all because ESCALATE_WORDS matches "board member".
//
// WHAT THIS DOES: reads the whole thread and produces what was actually asked
// for. If Martha wants a reply to Alexis, Amanda writes the reply to Alexis and
// hands it over ready to send.
//
// This only became possible on 2026-08-20. Until the body_full fix, the stored
// message was 255 characters and the thread Martha wanted answered was not in
// the database at all.
//
// BOUNDARIES, same as her escalation tier: she coordinates and recommends. No
// waiver, no fine or balance adjustment, no ACC decision, no legal position. If
// the ask needs one, she says what she would bring to the board or to Ed.
//
// She has no calendar. She never proposes a meeting or a call — she offered
// Martha "20 minutes" once and there was no such thing to offer.
// ============================================================================
const { route: aiRoute } = require('../../lib/ai/router');
const Anthropic = require('../../lib/ai/anthropic');

const MODEL = aiRoute('team.amanda_staff_assist');

/** Is this a colleague asking for help, rather than a homeowner in trouble? */
function isStaffAskingForHelp(email) {
  const from = String(email.sender_email || '').toLowerCase();
  if (!/@bedrocktx\.com$/i.test(from)) return false;
  // Her own mail bouncing around, and automated internal noise, are not asks.
  if (/^(no-?reply|do-?not-?reply|notification)/i.test(from)) return false;
  return true;
}

/**
 * What did they actually want? Used for the review hint and to tell the model
 * which shape of answer to produce, not to constrain what it says.
 */
function classifyAsk(email) {
  const text = `${email.subject || ''}\n${email.body_full || email.body || email.body_preview || ''}`;
  const top = text.slice(0, 900).toLowerCase();
  if (/\b(draft|write|respond|response|reply|word(ing)?|how (do|should) i (say|answer|reply|respond)|say to)\b/.test(top)) return 'draft_a_reply';
  if (/\b(review|look over|check|thoughts|feedback|does this (look|read))\b/.test(top)) return 'review_my_work';
  if (/\b(what (do|should)|advice|guidance|how do (i|we) handle|not sure|stuck|help me (understand|figure))\b/.test(top)) return 'advice';
  return 'advice';
}

/** Who else is on the thread, so Amanda can name the right person. */
function threadPeople(text) {
  const out = [];
  const re = /^\s*From:\s*([^<\n]+?)\s*(?:<([^>]+)>)?\s*$/gim;
  let m;
  while ((m = re.exec(String(text || ''))) && out.length < 8) {
    const name = String(m[1] || '').trim();
    if (name && !out.some((p) => p.name === name)) out.push({ name, email: m[2] || null });
  }
  return out;
}

// ---- Phase 2B (Issue #29): the amanda@ door into the shared Amanda request contract ----
// A clear OPERATIONAL request from staff (a decision request, a work request, or the
// exact-status question) goes through lib/amanda/request.handleRequest with
// channel:'email', ONCE, and the result is presented as the usual draft for review.
// Everything else (draft a reply, review my work, open advice, anything with
// attachments) keeps the staff-assist path below. Never both for one email: when
// the contract handles it, the staff-assist model is not called, and a contract
// failure becomes an honest draft instead of falling through to another drafter.
const QUOTE_RE = /^\s*(?:From:|On .+wrote:|-{2,}\s*Original Message|_{5,}|Sent from my|Get Outlook for)/im;
const SIGNOFF_RE = /^(?:thanks|thank you|thx|many thanks|regards|best|best regards|kind regards|sincerely|cheers|--)[,!.]?\s*$/i;
function requestTextFrom(email) {
  const body = String(email.body_full || email.body || email.body_preview || '');
  const cut = body.search(QUOTE_RE);
  const lines = (cut >= 0 ? body.slice(0, cut) : body).split(/\r?\n/).map((l) => l.trim());
  const keep = [];
  for (const l of lines) { if (SIGNOFF_RE.test(l)) break; if (l) keep.push(l); }
  let t = keep.join(' ').replace(/^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))\b[^,.!?]*[,.!]?\s*/i, '').replace(/^amanda[,:\s-]+/i, '').trim();
  if (t.length < 3) t = String(email.subject || '').replace(/^(?:(?:re|fw|fwd):\s*)+/i, '').trim();
  return t.slice(0, 2000);
}
function isOperationalRequest(email, text) {
  if (email.has_attachments) return false;                         // documents -> staff assist reads them
  const { screenIntent, isStatusQuery } = require('../amanda/request');
  const s = screenIntent(text);
  if (s.intent === 'decision') return true;                        // never let a decision request become a drafted "yes"
  // Classify the extracted request, never the raw body: a signature's confidentiality notice
  // ("any unauthorized review, use...") read as "review my work" on every staff email.
  const ask = classifyAsk({ subject: email.subject, body_full: text });
  if (ask === 'draft_a_reply' || ask === 'review_my_work') return false;
  return s.intent === 'work' || isStatusQuery(text);
}
// Staff-only door: links go to the operator app host (brand config), never TRUSTED_URL
// (the alternate my.* host, where a staff sign-in does not carry over).
const APP_BASE = () => require('../brand').tech.appUrl.replace(/\/+$/, '');

async function draftViaRequestContract({ email, text, contract }) {
  const { handleRequest } = require('../amanda/request');
  const anthropic = contract.anthropic !== undefined ? contract.anthropic : (process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null);
  const actor = { email: String(email.sender_email || '').toLowerCase(), name: email.sender_name || null };
  const r = await handleRequest({ channel: 'email', actor, text, community_id: contract.communityId || null,
    context_text: String(email.body_full || email.body || email.body_preview || '').slice(0, 4000) }, { supabase: contract.supabase, anthropic });
  const first = String(email.sender_name || '').trim().split(/\s+/)[0] || 'there';
  const parts = [`Hi ${first},`, r.reply || 'I could not answer this one. Nothing was changed.'];
  if (r.ok && r.plan && r.plan.length) parts.push(`What I would do next:\n${r.plan.map((p, i) => `${i + 1}. ${p}`).join('\n')}`);
  if (r.ok && r.next_dependency) parts.push(`First thing needed: ${r.next_dependency}`);
  if (r.ok && r.objective) parts.push(`${r.objective.created ? 'I opened a work item for this' : 'This is on the existing work item'}: "${r.objective.title}". It shows on Today in trustEd: ${APP_BASE()}/app/today`);
  const dest = r.ok && (r.destination || (r.action_request && r.action_request.destination));
  if (dest && dest.href) parts.push(`Where to act: ${APP_BASE()}${dest.href}`);
  if (r.ok && r.deterministic === 'status') parts.push(`The live list is on Today: ${APP_BASE()}/app/today`);
  // No hand-typed sign-off: every send path wraps this body in buildAmandaEmail, which
  // adds Amanda's real signature (Issue #29 signature rule).
  const hint = [`amanda request (${r.intent || 'unknown'})`]
    .concat(r.deterministic === 'status' ? ['exact status, no AI'] : [])
    .concat(r.objective ? [`${r.objective.created ? 'new' : 'existing'} work: ${r.objective.title}`] : [])
    .concat(!r.ok ? [`not completed: ${r.error}`] : [])
    .concat(r.audit_warnings && r.audit_warnings.length ? [`${r.audit_warnings.length} audit warning(s)`] : [])
    .concat([`AI calls: ${r.model_calls}`]).join(' · ');
  return {
    draftable: true,
    careful: !r.ok || !!(r.audit_warnings && r.audit_warnings.length),
    assist_type: `amanda_request:${r.intent || 'unknown'}`,
    subject: /^re:/i.test(email.subject || '') ? email.subject : `Re: ${email.subject || 'your request'}`,
    body: parts.join('\n\n'),
    needs_from_them: [], held_for_human: [],
    review_hint: hint,
    amanda_request: { ok: r.ok, intent: r.intent, deterministic: r.deterministic || null, durable: !!r.durable, objective: r.objective || null, model_calls: r.model_calls, error: r.error || null, audit_warnings: r.audit_warnings || [] },
  };
}

async function draftAmandaStaffAssist({ email, communityName = null, senderFirstName = null, contract = null }) {
  // Phase 2B: only the inbound amanda@ path opts in (contract = { supabase, communityId }).
  if (contract && contract.supabase && isStaffAskingForHelp(email)) {
    const text = requestTextFrom(email);
    if (isOperationalRequest(email, text)) return draftViaRequestContract({ email, text, contract });
  }
  if (!process.env.ANTHROPIC_API_KEY) return { draftable: false, reason: 'no_api_key' };

  const body = String(email.body_full || email.body || email.body_preview || '').trim();
  // Without the thread there is nothing to help with, and a reply written from
  // a subject line is exactly the confident-and-empty output this replaces.
  if (body.length < 40) return { draftable: false, reason: 'no_body' };

  const first = senderFirstName
    || String(email.sender_name || '').trim().split(/\s+/)[0]
    || 'there';
  const askType = classifyAsk(email);
  const people = threadPeople(body);

  const shape = {
    draft_a_reply: 'They want words they can send. Write the actual reply as the main event, '
      + 'ready to paste, addressed to the right person on the thread. A paragraph about how you '
      + 'would approach it is not what they asked for.',
    review_my_work: 'They want your read on something they wrote or are about to do. Say what is '
      + 'right, what you would change and why, in that order.',
    advice: 'They are stuck and want your judgment. Answer the question directly, then give the '
      + 'one next step you would take.',
  }[askType];

  const prompt = `You are Amanda Albright, Senior Community Manager at Bedrock Association Management. A member of your own team has emailed you for help. You are writing the reply.

This is a COLLEAGUE, not a homeowner. They are not upset with you, they do not have a property here, and they have not escalated anything. Do not apologise, do not thank them for reaching out, do not reassure them, and do not offer to take ownership of their issue. They asked you a work question. Answer it.

WHO WROTE: ${email.sender_name || email.sender_email} ("${first}"), on the Bedrock team
SUBJECT: ${email.subject || '(none)'}
${communityName ? `COMMUNITY: ${communityName}\n` : ''}${people.length ? `OTHERS ON THE THREAD: ${people.map((p) => p.name).join(', ')}\n` : ''}
WHAT THEY SENT, in full:
${body.slice(0, 18000)}

WHAT THEY WANT: ${shape}

HOW TO WRITE IT:
- Read the whole thread above before you answer. The question is usually in the top few lines and the facts are further down.
- If they attached files (PDFs / photos), they are included below — READ them and use what's in them. Never ask ${first} to send a document they already attached.
- Be concrete. Name the people, the amounts and the specifics that are actually in the thread.
- Never state a fact that is not in the thread. If something you need is missing, ask ${first} for that one thing.
- Never claim to have reviewed records, pulled a history or checked an account. You have read this email and nothing else.
- You coordinate and recommend. You do not waive or reduce a fine, adjust a balance, decide an ACC application, or take a legal position. If the answer needs one of those, say what you would put in front of the board or take to Ed, and why.
- You have no calendar and cannot attend anything. NEVER propose a meeting, a call, or "20 minutes". If it needs more than writing, hand it to Ed.
- Plain sentences. No em-dashes, use commas. No GL account numbers. No bullet-point walls.
- Sign as Amanda. This is internal mail to a colleague, so no AI disclosure line.

RETURN STRICT JSON, no code fences:
{"assist_type":"${askType}",
 "body":"<your reply to ${first}>",
 "needs_from_them":["<anything you had to ask for, empty if nothing>"],
 "held_for_human":["<any part you could not decide and why, empty if none>"]}
The reply goes in "body" only. Do not put these field names in the prose.`;

  // Read any files the colleague forwarded so Amanda uses their content instead
  // of asking for what's already attached (Ed 2026-09-17). Best-effort.
  let attachBlocks = [], attachSummary = '';
  if (email.mailbox && email.graph_id) {
    try {
      const { fetchAttachmentBlocks } = require('../email/graph_attachments');
      const a = await fetchAttachmentBlocks(email.mailbox, email.graph_id);
      attachBlocks = a.blocks || []; attachSummary = a.summary || '';
    } catch (_) {}
  }
  const promptText = prompt + (attachSummary ? `\n\nATTACHMENTS: ${attachSummary}` : '');

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const call = (blocks) => anthropic.messages.create({
    model: MODEL, max_tokens: 2000, messages: [{ role: 'user', content: [{ type: 'text', text: promptText }, ...blocks] }],
  });
  let r;
  try { r = await call(attachBlocks); }
  catch (e) {
    if (attachBlocks.length) { console.warn('[amanda_staff_assist] attachment blocks rejected, retrying text-only:', e.message); r = await call([]); }
    else throw e;
  }

  const raw = String((r.content && r.content[0] && r.content[0].text) || '').trim();
  if (!raw) return { draftable: false, reason: 'empty_draft' };

  let out = { body: raw, needs: [], held: [] };
  try {
    const j = JSON.parse(raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
    if (j && typeof j.body === 'string' && j.body.trim()) {
      out.body = j.body.trim()
        // Rule ids and field names have leaked into prose before.
        .replace(/\s*[[(]\s*(assist_type|needs_from_them|held_for_human)\s*[\])]/gi, '')
        .replace(/[^\S\n]+\n/g, '\n')
        .trim();
      out.needs = Array.isArray(j.needs_from_them) ? j.needs_from_them : [];
      out.held = Array.isArray(j.held_for_human) ? j.held_for_human : [];
    }
  } catch (_) {
    console.warn('[amanda_staff_assist] model did not return JSON — reply usable, no structure');
  }

  const hint = ['staff assist: ' + askType]
    .concat(out.needs.length ? [out.needs.length + ' open question(s) back to ' + first] : [])
    .concat(out.held.length ? [out.held.length + ' held for a human'] : [])
    .join(' · ');

  const result = {
    draftable: true,
    careful: out.held.length > 0,
    assist_type: askType,
    subject: /^re:/i.test(email.subject || '') ? email.subject : `Re: ${email.subject || 'your question'}`,
    body: out.body,
    needs_from_them: out.needs,
    held_for_human: out.held,
    review_hint: hint,
  };
  // Receipts: if the colleague forwarded documents, ground + verify the figures
  // in the reply before a human approves. Best-effort.
  if (attachBlocks.length) {
    try {
      const { groundAndVerify } = require('../team/grounding');
      const gv = await groundAndVerify({ draftBody: out.body, sourceText: body, sourceBlocks: attachBlocks });
      if (gv.grounding) result.grounding = gv.grounding;
      if (gv.verification) result.verification = gv.verification;
    } catch (_) {}
  }
  return result;
}

module.exports = { draftAmandaStaffAssist, isStaffAskingForHelp, classifyAsk, requestTextFrom, isOperationalRequest };
