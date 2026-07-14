// ============================================================================
// lib/email/compose_draft.js  (Ed 2026-07-07)
// ----------------------------------------------------------------------------
// "Claire, write this for me." Turns a short intent from the operator ("tell
// the Waterview board the pool reopens Monday") into a full email body + a
// subject, in Claire's voice. The operator edits before sending — this is a
// first draft, not an auto-send. Signature/logo are added later by
// buildClaireEmail, so this returns the BODY only (no signature, no greeting-
// to-signature duplication).
//
// Voice rules (CLAUDE.md): warm + specific + brief + honest. No em-dashes in
// customer copy (Ed uses commas). No "Claude" branding. Claire never asserts a
// legal position or grants a waiver — if the intent asks for that, she writes
// a helpful note and defers to the team instead.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-4-5';

// Persona intro line. The rest of the prompt (VOICE + JSON contract) is shared —
// both AI team members follow the same Bedrock voice rules.
const PERSONA_INTRO = {
  claire: "You are Claire, Bedrock Association Management's customer support specialist (an AI team member). Write a single email to a homeowner or board member on behalf of Bedrock, based on the sender's instruction below.",
  emma: "You are Emma Brooks, Bedrock Association Management's accounts-payable specialist (an AI team member). You handle vendor invoices, payments, W-9s, and remittance questions. Write a single email to a vendor on behalf of Bedrock, based on the sender's instruction below.",
  annie: "You are Annie Reeves, Bedrock Association Management's architectural review (ACC/ARC) coordinator (an AI team member). You handle homeowner architectural applications, approvals, and requirements. Write a single email to a homeowner or applicant on behalf of Bedrock, based on the sender's instruction below.",
  miranda: "You are Miranda Pierce, Bedrock Association Management's compliance coordinator (an AI team member). You handle deed-restriction (violation) matters and homeowner compliance correspondence. Write a single email to a homeowner on behalf of Bedrock, based on the sender's instruction below. Never state a violation is cured, closed, or dismissed, never assess or waive a fine, and never quote statute — a person decides those.",
};

function buildPrompt(persona) {
  const intro = PERSONA_INTRO[persona] || PERSONA_INTRO.claire;
  return `${intro}

VOICE:
- Warm, clear, and human. Specific over generic. Brief.
- Write like a helpful person, not a form letter. No corporate filler.
- Use commas, not em-dashes or hyphens-as-dashes.
- Do NOT include a signature, sign-off name, or contact block. Those are added automatically. End on your last real sentence.
- Do NOT invent facts, dates, amounts, or policies that are not in the instruction. If a detail is missing, write around it or leave a clearly-marked [placeholder] for the operator to fill.
- Never assert a legal position, grant a waiver, or decide a violation/§209 matter. If the instruction asks for that, write a friendly note and say the team will follow up with the specifics.

Return ONLY a JSON object, no markdown fences:
{
  "subject": "a short, specific subject line",
  "body": "the email body, plain text with real paragraph breaks (\\n\\n between paragraphs). Start with a natural greeting if you know who it is to; otherwise a simple 'Hello,'."
}`;
}

// intent: the operator's instruction. ctx: { to, recipientName, community }.
// Returns { subject, body, degraded } — degraded=true means the model was
// unavailable and the operator should write it themselves.
async function draftEmailFromIntent(intent, ctx = {}) {
  const clean = String(intent || '').trim();
  if (!clean) return { subject: '', body: '', degraded: true };
  if (!process.env.ANTHROPIC_API_KEY) return { subject: '', body: '', degraded: true };

  const persona = ['emma', 'annie', 'miranda'].includes(String(ctx.persona || '').toLowerCase()) ? String(ctx.persona).toLowerCase() : 'claire';
  const prompt = buildPrompt(persona);

  const contextLines = [];
  if (ctx.recipientName) contextLines.push(`Recipient name: ${ctx.recipientName}`);
  if (ctx.to) contextLines.push(`Recipient email: ${ctx.to}`);
  if (ctx.community) contextLines.push(`Community: ${ctx.community}`);
  const contextBlock = contextLines.length ? `\n\nContext:\n${contextLines.join('\n')}` : '';

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let text = '';
  try {
    const completion = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content: `${prompt}\n\nInstruction from the operator:\n"""${clean}"""${contextBlock}` }],
    });
    text = completion.content?.[0]?.text || '';
  } catch (err) {
    console.warn('[compose_draft] API failed:', err.message);
    return { subject: '', body: '', degraded: true };
  }
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return {
      subject: String(parsed.subject || '').trim(),
      body: String(parsed.body || '').trim(),
      degraded: false,
    };
  } catch (_) {
    // If the model didn't return clean JSON, treat the whole thing as the body.
    return { subject: '', body: cleaned, degraded: false };
  }
}

// Expand the operator's shorthand into a SHORT internal note to a teammate who's
// being asked to look at an email BEFORE Bedrock replies (the Forward flow). Same
// idea as "Rewrite with my notes" on replies, but the output is an internal note
// to staff, not a homeowner reply. First person from the operator, references
// what's being forwarded. Returns { note, degraded }. (Ed 2026-07-14.)
async function draftForwardNote({ thoughts, toName, email = {} }) {
  const clean = String(thoughts || '').trim();
  const first = String(toName || '').trim().split(/\s+/)[0] || 'there';
  if (!process.env.ANTHROPIC_API_KEY) return { note: clean, degraded: true };
  const ctx = [
    email.subject ? `Email subject: ${email.subject}` : '',
    email.sender_name ? `From: ${email.sender_name}` : '',
    email.ai_summary ? `What it's about: ${email.ai_summary}` : '',
    email.draft_body ? `Claire's drafted reply (for their reference):\n${String(email.draft_body).slice(0, 600)}` : '',
  ].filter(Boolean).join('\n');
  const prompt = `You are writing a SHORT internal note from a Bedrock manager to a teammate named ${first}, forwarding a homeowner/vendor email for them to check BEFORE Bedrock replies. Expand the manager's shorthand into a natural, brief note (1-3 sentences). First person, as the manager. Open with "Hi ${first}," Reference what's being forwarded so they have context, and make the ask clear. Use commas, not em-dashes. Do NOT add a sign-off or name. Return ONLY the note text — no quotes, no JSON, no markdown.

Manager's shorthand: """${clean || '(no words yet — write a sensible "please take a look and tell me what you think before we reply" note from the context)'}"""

The email being forwarded:
${ctx || '(no extra context available)'}`;

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  try {
    const completion = await anthropic.messages.create({ model: MODEL, max_tokens: 400, messages: [{ role: 'user', content: prompt }] });
    const text = (completion.content?.[0]?.text || '').trim().replace(/^["']|["']$/g, '');
    return { note: text || clean, degraded: false };
  } catch (err) {
    console.warn('[compose_draft] forward-note API failed:', err.message);
    return { note: clean, degraded: true };
  }
}

module.exports = { draftEmailFromIntent, draftForwardNote };
