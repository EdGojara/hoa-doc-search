// ============================================================================
// lib/ea/tessa.js  (Ed 2026-07-11) — Tessa McCall, Ed's executive-assistant AI
// ----------------------------------------------------------------------------
// Turns a rough thought Ed types or dictates into a finished email. Two voices:
//   mode 'ed'    -> ghostwrites AS Ed (first person, his name), for real
//                   correspondence to a bank / vendor / admin contact.
//   mode 'tessa' -> writes AS Tessa on Ed's behalf ("Ed asked me to follow up
//                   on..."), for scheduling + follow-up nudges.
// Returns { subject, body }. Nothing is sent here — Ed approves, then the API
// sends via Graph. Voice/tone: crisp, warm, no fluff, no em-dashes (Ed's rule).
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ED_VOICE = `You are ghostwriting an email AS Ed Gojara, owner of Bedrock Association
Management. Write in the first person as Ed. Direct, warm, professional, and
brief. He signs off simply ("Thanks, Ed" or "Ed"). Do not identify yourself as
an assistant or AI. This is Ed's own email.`;

const TESSA_VOICE = `You are Tessa McCall, the executive assistant at Bedrock Association
Management, writing on behalf of the owner. Write the email AS Tessa, following
up or handling admin/banking/vendor items on his behalf. Professional, warm,
efficient. Do NOT name the owner in a signature or title (small company, it reads
as pretentious). Close simply with "Tessa" or "Thanks, Tessa" — the full sign-off
(Tessa McCall, Executive Assistant, Bedrock Association Management) is appended
automatically, so do not repeat the title or company yourself.`;

function buildPrompt(mode, ctx) {
  const voice = mode === 'ed' ? ED_VOICE : TESSA_VOICE;
  const to = ctx.recipientName ? `The recipient is ${ctx.recipientName}. ` : '';
  return `${voice}

${to}Ed will give you a rough thought or instruction. Turn it into a complete,
send-ready email. Keep it concise (a few short paragraphs at most). Use commas,
never em-dashes. Do not invent facts, amounts, dates, or commitments Ed did not
state. If a needed detail is missing, write the email so it reads naturally
without it (do not leave blanks or placeholders like [DATE]).

Return ONLY a JSON object (no markdown fence):
{ "subject": "string, a clear subject line", "body": "string, the full email body including the greeting and sign-off" }`;
}

async function draftEmail({ thought, mode, recipientName }) {
  if (!thought || !String(thought).trim()) return { degraded: true };
  const m = mode === 'ed' ? 'ed' : 'tessa';
  const completion = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1500,
    system: buildPrompt(m, { recipientName }),
    messages: [{ role: 'user', content: `Ed's thought: ${String(thought).trim()}` }],
  });
  const text = completion.content?.[0]?.text || '';
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const p = JSON.parse(cleaned);
    return { subject: p.subject || '', body: p.body || '', mode: m };
  } catch (e) {
    return { degraded: true, error: e.message };
  }
}

// Draft a REPLY to an email Ed forwarded/BCC'd to Tessa. Same two voices.
async function draftReply({ incomingSubject, incomingBody, fromName, mode }) {
  const m = mode === 'tessa' ? 'tessa' : 'ed';
  const voice = m === 'ed' ? ED_VOICE : TESSA_VOICE;
  const system = `${voice}

Ed forwarded you an email and wants a reply drafted. Read it and write a
complete, send-ready reply. Concise, commas not em-dashes, no invented facts or
commitments. If a decision is genuinely required that only Ed can make, draft
the reply the safe/neutral way and note nothing in brackets.

Return ONLY JSON: { "subject": "string (use 'Re: ...' when replying)", "body": "string, full reply with greeting + sign-off" }`;
  const completion = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1500,
    system,
    messages: [{ role: 'user', content: `From: ${fromName || 'the sender'}\nSubject: ${incomingSubject || '(none)'}\n\n${String(incomingBody || '').slice(0, 6000)}` }],
  });
  const text = completion.content?.[0]?.text || '';
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { const p = JSON.parse(cleaned); return { subject: p.subject || '', body: p.body || '', mode: m }; }
  catch (e) { return { degraded: true, error: e.message }; }
}

module.exports = { draftEmail, draftReply };
