// ============================================================================
// lib/team/bedrock_ops_reply.js  (Ed 2026-08-30)
// ----------------------------------------------------------------------------
// The shared draft engine for the internal Bedrock-ops team (Maggie, Vivian).
// Like the community operator engine, but it grounds on BEDROCK's own knowledge
// (each persona's primer), not a community's governing docs, and it is
// unconditionally DARK — whatever it produces is a proposal for a human to
// review and release. Nothing is ever sent, published, or acted on from here.
//
// Two modes, same path:
//   - respond: a message to reply to (pass `inbound`)
//   - compose: a task to draft / prepare (pass `task`)
//
// A persona may supply `reservedDetect(text) -> { hit, reason }`. When it fires
// (a harassment/discrimination complaint, an employment decision, a legal
// question), the draft becomes a discreet acknowledgment that ROUTES to a human
// (and counsel), takes no position, and the disposition is flagged RESERVED.
// This is policy-as-code, not a prompt hoping the model behaves.
// ============================================================================

const core = require('./operator_core');

async function draftBedrockOpsReply(config, { inbound = null, task = null, contactName = null, contextHint = null, communityHint = null } = {}) {
  const senderName = core.greetingName(inbound || {}, contactName) || 'there';
  const ctxHint = contextHint || communityHint || null;
  const text = inbound ? `${inbound.subject || ''}\n${inbound.body || inbound.body_preview || ''}` : (task || '');
  const reserved = config.reservedDetect ? config.reservedDetect(text) : null;
  const isReserved = !!(reserved && reserved.hit);

  let body = config.fallback ? config.fallback(senderName) : `Hi ${senderName},\n\nThank you for reaching out. I'll take a look and follow up.`;
  let grounded = false;

  try {
    const brief = inbound
      ? `MODE: respond to a message.\nFrom: ${inbound.sender_name || contactName || 'sender'} (greet them as ${senderName})\nSubject: ${inbound.subject || '(none)'}\n\n${inbound.body || inbound.body_preview || ''}`
      : `MODE: compose / prepare for a task.\nTASK: ${task || '(none given)'}`;
    const ctx = ctxHint ? `\n\nCONTEXT (use only what's here; never invent facts):\n${ctxHint}\n` : '';
    const reservedInstr = isReserved
      ? `\n\nRESERVED / ESCALATE — this involves ${reserved.reason}. You do NOT handle it, decide it, investigate it, or advise on it. Draft ONLY a brief, discreet, human acknowledgment that makes clear you are routing it to the appropriate person (and counsel where relevant) and that it will be handled with care and confidentiality. Take no position and offer no opinion on the substance.\n`
      : '';
    const userContent = `${brief}\n${ctx}${reservedInstr}\nDraft the message (or prepared material) for a human to review and release.`;
    const system = config.systemPromptFor();

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await anthropic.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 1000, system, messages: [{ role: 'user', content: userContent }] });
    const out = core.cleanModelBody((resp.content || []).map((b) => b.text || '').join(''), config.sigNames || []);
    console.log(`[bedrock_ops_reply:${config.persona}] draft:`, JSON.stringify({ outLen: out.length, mode: inbound ? 'respond' : 'compose', reserved: isReserved }));
    if (out.length > 30) { body = out; grounded = true; }
  } catch (e) {
    console.warn(`[bedrock_ops_reply:${config.persona}] generation failed, using fallback:`, e.message);
  }

  return {
    draftable: true, careful: true, persona: config.persona,
    subject: inbound ? `Re: ${inbound.subject || 'your message'}` : (task ? `Draft: ${String(task).slice(0, 60)}` : 'Draft'),
    body,
    disposition: 'needs_review',
    confidence: isReserved ? 'low' : (grounded ? 'medium' : 'low'),
    disposition_reason: isReserved
      ? `RESERVED: ${reserved.reason} — routed to a human${/legal|complaint|harassment|discrimination|leave|accommodation|wage/i.test(reserved.reason) ? ' and counsel' : ''}, not handled here`
      : 'internal draft — always human-released (dark)',
    review_hint: `${config.reviewHintLabel || config.persona}: ${inbound ? 'reply' : 'composed'} · ${grounded ? 'grounded' : 'fallback'}${isReserved ? ` · RESERVED:${reserved.reason}` : ''} · needs_review`,
  };
}

module.exports = { draftBedrockOpsReply };
