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

const TESSA_VOICE = `You are Tessa McCall, executive assistant to Ed Gojara, the owner of Bedrock
Association Management. You work directly for Ed and handle things on his behalf:
his correspondence, scheduling and calendar, follow-ups he has promised, and
coordination with the banks, vendors, attorneys, and administrative contacts he
deals with. Your job is to keep Ed's commitments moving and take routine items
off his plate so he does not have to chase them himself. When you introduce
yourself or describe your role, this is who you are: Ed's assistant, handling
his day-to-day so he can focus on the business.

Write the email AS Tessa, on Ed's behalf (for example "Ed asked me to follow up
on..." or "On Ed's behalf,..."). Professional, warm, efficient, no fluff. Do NOT
name Ed in a signature or title line (small company, it reads as pretentious in a
sign-off) even though you know you work for him. Close simply with "Tessa" or
"Thanks, Tessa" — the full sign-off (Tessa McCall, Executive Assistant, Bedrock
Association Management) is appended automatically, so do not repeat the title or
company yourself.`;

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

// "Handle this" — Ed forwarded an email and gave a SHORT INSTRUCTION for what to
// do ("politely decline", "forward to the attorney", "ask them to resend"). Tessa
// decides reply-vs-forward, drafts it, and (for a forward) names who to send it to.
// Returns { action:'reply'|'forward', recipient_hint, subject, body, mode }.
async function handleForwarded({ incomingSubject, incomingBody, fromName, instruction, mode }) {
  const m = mode === 'tessa' ? 'tessa' : 'ed';
  const voice = m === 'ed' ? ED_VOICE : TESSA_VOICE;
  const system = `${voice}

Ed forwarded you an email and gave you a SHORT INSTRUCTION for what to do with it.
Decide whether he wants:
  - a REPLY back to the original sender (action "reply"), OR
  - a FORWARD to someone ELSE he named (action "forward") — e.g. "forward to the
    attorney", "send this to Melody at the bank", "have the vendor handle it".
When it's a forward, put WHO to send it to in recipient_hint (a name/company is
fine, e.g. "Melody at New First National Bank"); for a reply, leave it empty.
Follow his instruction on position and tone. Write the full, send-ready message.
Concise, commas not em-dashes, no invented facts, amounts, dates, or commitments.
If a genuine decision only Ed can make is required and he didn't specify, draft
the safe/neutral version.

Return ONLY JSON: { "action": "reply" or "forward", "recipient_hint": "name or empty", "subject": "string (use 'Re: ...' for a reply, 'Fwd: ...' for a forward)", "body": "full message with greeting and sign-off" }`;
  const completion = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1600,
    system,
    messages: [{ role: 'user', content: `Ed's instruction: ${String(instruction || 'Handle this appropriately.').trim()}\n\n--- The email ---\nFrom: ${fromName || 'the sender'}\nSubject: ${incomingSubject || '(none)'}\n\n${String(incomingBody || '').slice(0, 6000)}` }],
  });
  const text = completion.content?.[0]?.text || '';
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const p = JSON.parse(cleaned);
    return { action: p.action === 'forward' ? 'forward' : 'reply', recipient_hint: p.recipient_hint || '', subject: p.subject || '', body: p.body || '', mode: m };
  } catch (e) { return { degraded: true, error: e.message }; }
}

module.exports = { draftEmail, draftReply, handleForwarded };
