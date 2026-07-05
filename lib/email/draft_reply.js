// ============================================================================
// lib/email/draft_reply.js  (Ed 2026-07-05) — Communications hub Phase 2
// ----------------------------------------------------------------------------
// Draft a reply for a triaged inbound email. NOTHING is sent — this returns a
// suggestion a human reviews, edits, and sends under their own name (approve-
// to-send). Two hard rules:
//
//   1) GUARDRAIL — never draft for compliance-sensitive mail. Legal/privileged,
//      violation/enforcement, ACC decisions, and financial/payment matters
//      FORCE a human. Same scoping discipline as the voice persona: the system
//      never asserts a legal position, grants a waiver, or decides a violation.
//   2) NEVER INVENT policy. If answering needs a community-specific fee, rule,
//      deadline, or procedure the draft doesn't actually know, it writes a warm
//      HOLDING reply ("I'll confirm the exact process and get right back to
//      you") instead of fabricating. Fabricated HOA policy is customer-facing
//      and wrong = the exact silent-failure we avoid.
//
// Tone comes from the shared lib/tone CASUAL_TONE (single source).
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const { CASUAL_TONE } = require('../tone');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-5';

// Only these classes are eligible for an auto-draft. Everything else routes to
// a human (returns draftable:false with the reason).
const DRAFTABLE = new Set(['homeowner_request', 'vendor_general']);
const REASONS = {
  legal_privileged: 'attorney / privileged — must be handled by a person, never auto-drafted',
  violation_report: 'enforcement matter — a human decides how the association responds',
  acc_request: 'ACC / architectural — decisions and acknowledgements go through a person',
  vendor_financial: 'payment / billing — routed to accounting, not auto-answered',
  spam: 'spam / noise — no reply',
  internal: 'internal / system notification — no reply needed',
  other: 'unclassified — a person should look first',
};

async function draftReply({ email, classification, contactName, communityName, extracted }) {
  if (!DRAFTABLE.has(classification)) {
    return { draftable: false, reason: REASONS[classification] || 'routed to a human for review' };
  }

  const firstName = (contactName || '').trim().split(/\s+/)[0] || '';
  const sys = `You are drafting a reply that a Bedrock Association Management team member will review and send under their own name to a homeowner or contact. This is a DRAFT, not a sent message.
${CASUAL_TONE}

HARD RULES FOR THIS DRAFT:
- Do NOT invent any community-specific policy, fee, amount, deadline, form, or procedure. If a correct answer would require a specific fact you were not given, do NOT make one up — instead write a short, warm holding reply that acknowledges exactly what they asked, says you'll confirm the specifics and get right back to them, and stops. A genuine "I'll find out" beats a confident wrong answer.
- Never grant approvals, waive rules, quote fines, or take a legal position.
- Address the SPECIFIC thing they wrote (name the pool tag, the address, the request) so it's clear a real person read it.
- Sign off simply with "Bedrock Association Management" on its own line (the staff member will add their name). No AI disclaimer, no corporate boilerplate.
- Return ONLY the email body text. No subject line, no preamble, no quotes around it.`;

  const ctx = `Community: ${communityName || '(unknown)'}
Homeowner/contact: ${contactName || '(name unknown — do not guess a name)'}${firstName ? ` (first name: ${firstName})` : ''}
They wrote:
Subject: ${email.subject || ''}
${(email.body_full || email.body_preview || '').slice(0, 4000)}

Draft the reply body now.`;

  const resp = await anthropic.messages.create({
    model: MODEL, max_tokens: 600,
    system: sys,
    messages: [{ role: 'user', content: [{ type: 'text', text: ctx }] }],
  });
  const body = ((resp.content[0] && resp.content[0].text) || '').trim();
  const subject = /^re:/i.test(email.subject || '') ? email.subject : `Re: ${email.subject || 'your message'}`;
  return { draftable: true, subject, body };
}

module.exports = { draftReply, DRAFTABLE };
