// ============================================================================
// lib/email/persona_reply.js  (Ed 2026-07-20)
// ----------------------------------------------------------------------------
// A general-purpose, in-VOICE reply draft for any AI team member — so every
// specialist (Kat, Amanda, Reese, Paige) can reply to ANYTHING in their queue,
// not just the narrow trigger cases their dedicated handlers cover. Emma and
// Claire keep their own data-grounded generators; this covers the rest.
//
// Every draft is REVIEW-FIRST (a human approves before it sends) and honest-AI.
// Hard guardrails apply to all: never take a legal position, waive a fine,
// adjust a balance, grant an ACC/architectural decision, or commit to a figure
// or date the platform hasn't confirmed — those are drafted as "what I'll bring
// to the team/board" and held for a person.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-5';

// Role + voice per persona. Kept short — the shared guardrails do the heavy
// lifting; this just gives each teammate their lane and tone.
const PERSONAS = {
  kat: {
    name: 'Katherine "Kat" Reed', title: 'Accounting Manager',
    lane: 'accounting — month-end close, reconciliation, financial statements, budgets, the general ledger, escrow/closing money, refunds and uncashed checks. You are the controller over Emma (AP).',
    careful: true,
  },
  amanda: {
    name: 'Amanda Albright', title: 'Senior Community Manager',
    lane: 'escalated, cross-domain, relationship-heavy community issues that a specialist could not close alone. Take ownership, be calm and genuinely empathetic, and lay out clear next steps.',
    careful: true,
  },
  reese: {
    name: 'Reese Calloway', title: 'Resale & Estoppels',
    lane: 'resale certificates, estoppels, closings, title-company requests, and ownership transfers.',
    careful: true,
  },
  paige: {
    name: 'Paige Chandler', title: 'Board Operations',
    lane: 'board meeting packages, agendas, minutes, and notices.',
    careful: false,
  },
};

const GUARDRAILS = `HARD RULES (never break, this is a draft a human approves before it sends):
- Identify as Bedrock's AI team member; offer a real person ("you can reach a person on our team anytime").
- NEVER state a dollar figure, balance, date, or account detail you have not been given below. If answering needs data you don't have, say you're pulling it and will follow up — don't guess.
- NEVER take a legal position, waive or reduce a fine, adjust a balance, grant an architectural/ACC decision, or promise a specific payment/completion date. Frame anything like that as "I'll bring this to the board/team" and hold it.
- Be warm, specific, and concise. No corporate filler, no fake urgency, no invented facts.
- If the email genuinely isn't yours to handle or clearly needs a human, say so briefly and offer the hand-off rather than forcing an answer.`;

function ctxBlock(context = {}) {
  const lines = [];
  if (context.communityName) lines.push(`Community: ${context.communityName}`);
  if (context.contactName) lines.push(`Writer / contact: ${context.contactName}`);
  if (context.propertyAddress) lines.push(`Property: ${context.propertyAddress}`);
  if (context.vendorName) lines.push(`Vendor: ${context.vendorName}`);
  if (Array.isArray(context.extra)) lines.push(...context.extra.filter(Boolean));
  return lines.length ? `\n\nWHAT THE PLATFORM KNOWS (ground your reply in ONLY this — do not invent beyond it):\n${lines.join('\n')}` : '\n\n(No linked account context — keep the reply general and, if it needs specifics, say you\'ll look them up.)';
}

// Draft a reply as `persona`. Returns { draftable, persona, subject, body, careful }.
async function draftPersonaReply({ persona, email, context = {}, notes = null, currentDraft = null }) {
  const p = PERSONAS[persona];
  if (!p) return { draftable: false };

  let roster = '';
  try { roster = await require('./team_roster').teamRosterBlock(); } catch (_) {}

  const sys = `You are ${p.name}, Bedrock Association Management's AI ${p.title}, drafting a reply for a human to review before it sends. Your lane: ${p.lane}${roster}

${GUARDRAILS}

Write ONLY the email body — no subject line, no "From/To", no signature (the branded signature is appended automatically). Greet the sender by first name when you know it.`;

  const askedText = `${email.subject || ''}\n\n${email.body_full || email.body_preview || ''}`.slice(0, 8000);
  const steer = notes ? `\n\nThe reviewer added these notes to fold in — follow them:\n"${notes}"` : '';
  const revise = currentDraft ? `\n\nRevise THIS existing draft (keep what works, apply the notes):\n"""\n${currentDraft}\n"""` : '';

  const user = `Reply to this email as ${p.name.split(' ')[0]}.${ctxBlock(context)}\n\n--- THE EMAIL ---\nSubject: ${email.subject || '(no subject)'}\nFrom: ${email.sender_name || email.sender_email || 'sender'}\n\n${askedText}${steer}${revise}`;

  try {
    const resp = await anthropic.messages.create({
      model: MODEL, max_tokens: 900,
      system: sys, messages: [{ role: 'user', content: user }],
    });
    const body = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!body) return { draftable: false };
    const subject = /^re:/i.test(email.subject || '') ? email.subject : `Re: ${email.subject || 'your message'}`;
    return { draftable: true, persona, subject, body, careful: !!p.careful };
  } catch (e) {
    console.warn('[persona_reply] draft failed:', e.message);
    return { draftable: false };
  }
}

module.exports = { draftPersonaReply, PERSONAS };
