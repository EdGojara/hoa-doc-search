'use strict';
// ============================================================================
// lib/team/maggie_prospect_reply.js  (Ed 2026-10-19) — Maggie's reply to a
// prospective management client who wrote in through the bedrocktx.com form.
// ----------------------------------------------------------------------------
// Ed's standard for this reply (after reviewing the first live draft):
//   warm, confident, natural, professional; no self-description as AI (the email
//   footer is the disclosure); no jargon ("AI-native"); lead with Bedrock's
//   management experience and service; technology only as benefits to the client;
//   never disparage competitors; never promise samples, attachments or services
//   that are not available; ask ONE useful question about the community and offer
//   a conversation.
// A prose rule a model ignores must become a check (CLAUDE.md): every draft is
// validated; one retry names the violations; if it still fails, an approved
// fallback is used. Maggie drafts; a human reviews and sends.
// ============================================================================

const RULES = `REPLY STANDARD for a prospective client who wrote in through the Bedrock website (follow exactly):
- Warm, confident, natural and professional. Short: 4 to 6 sentences across 2 or 3 short paragraphs.
- Do NOT describe yourself or Bedrock as AI, an AI team, or AI-native. The email footer already handles that. No technical jargon.
- Lead with Bedrock's management experience and service: responsive help for homeowners, clear and timely information for boards, well-run finances.
- If you mention technology, describe only what it does for the client (faster answers, clear financials and reserve visibility for the board, nothing falling through the cracks). Never explain how it works.
- Never mention or compare other management companies.
- Do NOT promise or offer anything not confirmed available: no samples, sample packets, attachments, proposals, pricing, demos, trials, savings or guarantees.
- Ask exactly ONE useful question about their community (for example its name, roughly how many homes, and what prompted them to reach out), and offer a short conversation at a time that suits them.
- Do not use em dashes. Do not sign your name; the signature is added automatically.`;

const BANNED = [
  [/\bAI[- ]native\b/i, 'jargon: "AI-native"'],
  [/\b(I am|I'm|I’m|we are|we're|we’re)\s+(Bedrock'?s\s+|Bedrock’s\s+|an?\s+)?AI\b/i, 'self-description as AI'],
  [/\b(as an AI|AI assistant|AI team member|AI teammate|artificial intelligence|machine learning|LLM|automation platform|algorithm)/i, 'AI self-description or technical jargon'],
  [/\b(sample|samples|sample packet|attached|attachment|send (you |over )|I'?ll send|we'?ll send|brochure|pricing|price|quote|proposal|free trial|trial|demo|guarantee|guaranteed|save you|savings)\b/i, 'promises materials or services not confirmed available'],
  [/\b(other|another|your current|previous|old)\s+(management|managers?)\s+(compan(y|ies)|firms?)\b|\bunlike (other|most)\b|\bcompetitors?\b/i, 'mentions or compares other management companies'],
  [/—/, 'em dash'],
];

function validateProspectDraft(body) {
  const text = String(body || '');
  const violations = [];
  for (const [re, why] of BANNED) if (re.test(text)) violations.push(why);
  const questions = (text.match(/\?/g) || []).length;
  if (questions < 1) violations.push('asks no question about the community');
  if (questions > 2) violations.push(`asks ${questions} questions (ask one about the community, plus at most the offer of a conversation)`);
  if (!/\b(conversation|call|talk|chat|meet|speak)\b/i.test(text)) violations.push('does not offer a conversation');
  if (text.length > 1400) violations.push('too long');
  return [...new Set(violations)];
}

// Approved fallback (used when the model cannot meet the standard).
function fallbackProspectReply(name) {
  const hi = name ? `Hi ${String(name).split(/\s+/)[0]},` : 'Hello,';
  return `${hi}

Thank you for reaching out to Bedrock Association Management. We manage homeowner associations in the greater Houston area, and our focus is straightforward: responsive service for homeowners and clear, timely information for the boards we work with.

The tools we use behind the scenes simply mean faster answers, financials and reserve information your board can see at a glance, and nothing falling through the cracks.

So I can point you in the right direction, could you tell me a little about your community, such as its name, roughly how many homes it has, and what prompted you to reach out? I would be glad to set up a short conversation at a time that works for you.

Warm regards,`;
}

async function draftMaggieProspectReply({ name = null, message = '', community = null, phone = null, intent = 'prospective_management_client', notes = null, draftFn = null } = {}) {
  const draft = draftFn || require('./bedrock_ops_reply').draftBedrockOpsReply;
  const { OPS_CONFIGS } = require('./bedrock_ops_configs');
  const who = intent === 'board_seeking_new_management' ? 'a community board looking for new management' : 'a prospective management client';
  const facts = [`They wrote in through the Bedrock website contact form as ${who}.`, community ? `Community they named: ${community}.` : 'They did not name a community.', phone ? `Phone they gave: ${phone}.` : ''].filter(Boolean).join(' ');
  const base = `${facts}\n\n${RULES}${notes ? `\n\nReviewer notes to incorporate: ${notes}` : ''}`;
  const attempts = [];
  for (let i = 0; i < 2; i++) {
    const hint = i === 0 ? base : `${base}\n\nYour previous draft broke the standard (${attempts[0].violations.join('; ')}). Rewrite it so it meets every rule.`;
    let d = null;
    try { d = await draft(OPS_CONFIGS.maggie, { inbound: { subject: 'Inquiry from the Bedrock website', body: message, sender_name: name }, contactName: name, contextHint: hint }); }
    catch (e) { attempts.push({ violations: [`generation failed: ${e.message}`] }); continue; }
    const body = String((d && d.body) || '').trim();
    const violations = validateProspectDraft(body);
    attempts.push({ violations });
    if (!violations.length) return { draftable: true, careful: false, persona: 'maggie', body, quality: { source: 'model', attempts: attempts.length },
      review_hint: 'Prospective management opportunity from the website. Maggie drafted it to the reply standard; review and send.' };
  }
  return { draftable: true, careful: false, persona: 'maggie', body: fallbackProspectReply(name), quality: { source: 'approved_fallback', attempts: attempts.length, violations: attempts.map((a) => a.violations) },
    review_hint: `Prospective management opportunity from the website. The generated draft did not meet the reply standard (${(attempts[attempts.length - 1] || { violations: [] }).violations.join('; ') || 'unknown'}), so the approved reply is used; personalise it before sending.` };
}

module.exports = { draftMaggieProspectReply, validateProspectDraft, fallbackProspectReply, PROSPECT_RULES: RULES };
