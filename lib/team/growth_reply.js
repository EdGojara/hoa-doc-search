// ============================================================================
// lib/team/growth_reply.js  (Ed 2026-08-30)
// ----------------------------------------------------------------------------
// The draft engine for the internal Bedrock-ops team (Maggie today). Like the
// community operator engine, but it grounds on BEDROCK's own knowledge (the
// growth primer / approved positioning), not a community's governing documents,
// and it is unconditionally DARK: whatever it produces is a proposal for a human
// to review and release. Nothing is ever sent or published from here.
//
// Two modes, same path:
//   - respond: a prospect / inbound message to reply to (pass `inbound`)
//   - compose: an outreach or content task to draft (pass `task`)
// ============================================================================

const core = require('./operator_core');

async function draftGrowthReply(config, { inbound = null, task = null, contactName = null, communityHint = null } = {}) {
  const senderName = core.greetingName(inbound || {}, contactName) || 'there';
  let body = config.fallback(senderName);
  let grounded = false;

  try {
    const brief = inbound
      ? `MODE: respond to a prospect message.\nFrom: ${inbound.sender_name || contactName || 'a prospect'} (greet them as ${senderName})\nSubject: ${inbound.subject || '(none)'}\n\n${inbound.body || inbound.body_preview || ''}`
      : `MODE: compose outreach/content for a task.\nTASK: ${task || '(none given)'}`;
    const ctx = communityHint ? `\n\nWHAT WE KNOW ABOUT THE COMMUNITY / PROSPECT (use only what's here; never invent facts):\n${communityHint}\n` : '';

    const userContent = `${brief}\n${ctx}\nDraft the message (or content). Remember: you are drafting for a human to review and release. Lead with proof, promise less than we can do, and keep it warm and specific. Assert only the approved positioning.`;
    const system = config.systemPromptFor();

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await anthropic.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 1000, system, messages: [{ role: 'user', content: userContent }] });
    const out = core.cleanModelBody((resp.content || []).map((b) => b.text || '').join(''), config.sigNames || []);
    console.log(`[growth_reply:${config.persona}] draft:`, JSON.stringify({ outLen: out.length, mode: inbound ? 'respond' : 'compose' }));
    if (out.length > 30) { body = out; grounded = true; }
  } catch (e) {
    console.warn(`[growth_reply:${config.persona}] generation failed, using fallback:`, e.message);
  }

  // Unconditionally dark: outbound to the market / published content is always a
  // human-released proposal. Never auto_ok.
  return {
    draftable: true, careful: true, persona: config.persona,
    subject: inbound ? `Re: ${inbound.subject || 'your message'}` : (task ? `Draft: ${String(task).slice(0, 60)}` : 'Draft'),
    body,
    disposition: 'needs_review', confidence: grounded ? 'medium' : 'low',
    disposition_reason: 'outbound to the market / published content — always human-released (dark)',
    review_hint: `${config.reviewHintLabel || config.persona}: ${inbound ? 'prospect reply' : 'composed draft'} · ${grounded ? 'grounded' : 'fallback'} · needs_review`,
  };
}

module.exports = { draftGrowthReply };
