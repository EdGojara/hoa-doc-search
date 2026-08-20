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
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.AMANDA_ASSIST_MODEL || 'claude-sonnet-4-5';

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

async function draftAmandaStaffAssist({ email, communityName = null, senderFirstName = null }) {
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

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const r = await anthropic.messages.create({
    model: MODEL, max_tokens: 2000, messages: [{ role: 'user', content: prompt }],
  });

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

  return {
    draftable: true,
    careful: out.held.length > 0,
    assist_type: askType,
    subject: /^re:/i.test(email.subject || '') ? email.subject : `Re: ${email.subject || 'your question'}`,
    body: out.body,
    needs_from_them: out.needs,
    held_for_human: out.held,
    review_hint: hint,
  };
}

module.exports = { draftAmandaStaffAssist, isStaffAskingForHelp, classifyAsk };
