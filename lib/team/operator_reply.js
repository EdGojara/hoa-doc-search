// ============================================================================
// lib/team/operator_reply.js  (Ed 2026-08-29)
// ----------------------------------------------------------------------------
// The operator ENGINE. One function drives every persona's reply through the
// shared operator core; the persona is passed in as a config (its voice/system
// prompts per audience, its lane's reserved boundary, its escalation triggers,
// its fallback). This is "one brain, faces per persona" made literal: the hard
// parts — grounding, audience + disclosure gating, the reserved gate, board
// data, the exception router — live once in operator_core; a persona is the
// thin set of differences on top.
//
// It is the same pipeline Amanda's amanda_reply.js runs by hand. Turning on a
// teammate is: write their config, train it against scenarios with
// scripts/train_persona.js, then wire draftOperatorReply(config, ...) into their
// inbox. Nothing here is wired to a live path on its own.
// ============================================================================

const core = require('./operator_core');

function reviewHint(label, reasons, ctx) {
  const bits = [];
  if (reasons && reasons.length) bits.push(reasons.join(' + '));
  if (ctx.violations.length) bits.push(`${ctx.violations.length} open violation(s) [${[...new Set(ctx.violations.map((v) => v.stage))].join(',')}]`);
  if (ctx.ar_balance != null && Math.abs(ctx.ar_balance) > 0.5) bits.push(`AR ${ctx.ar_balance > 0 ? 'owes' : 'credit'} $${Math.abs(ctx.ar_balance).toFixed(2)}`);
  if (ctx.acc.length) bits.push(`${ctx.acc.length} open ACC`);
  return `${label}: ${bits.join(' · ') || 'cross-domain'}`;
}

// config: {
//   persona, gateRole='homeowner', careful=true, servesBoard=false,
//   reviewHintLabel, sigNames:[],
//   detectEscalation(email) -> { reasons:[] },
//   systemPromptFor(audience, communityName) -> string,
//   fallback(senderName, communityName, looked) -> string,
// }
async function draftOperatorReply(config, { email, supabase, propertyId, communityId, contactName, communityName, sourceMessageId, mailbox, graphId }) {
  // Greet the person who wrote, not the resolved account (see greetingName).
  const senderName = core.greetingName(email, contactName);
  const trig = config.detectEscalation ? config.detectEscalation(email) : { reasons: [] };
  // Shared, persona-independent severe signals — a litigation threat or possible
  // imminent harm must escalate loudly no matter which teammate caught it (see
  // exception_router). Merge into the reasons so they drive the disposition tier
  // and the review hint; harm also reshapes the draft (below).
  const inboundText = `${email.subject || ''}\n${email.body || email.body_preview || ''}`;
  const threat = core.detectLegalThreat(inboundText);
  const harm = core.detectHarmEmergency(inboundText);
  const escalationReasons = [...(trig.reasons || []), ...(threat ? [threat] : []), ...(harm ? [harm] : [])];
  const ctx = await core.propertyContext(supabase, { propertyId });
  const gate = core.reservedAsk(email, config.gateRole || 'homeowner');
  const audience = await core.resolveAudience({ email, supabase, communityId, propertyId });
  const looked = ctx.violations.length || ctx.acc.length || ctx.ar_balance != null;

  let body = config.fallback(senderName, communityName, looked);
  let grounded = false;
  try {
    const { docContext, profileBlock } = await core.assembleGrounding({ email, communityName });
    // Look at what the resident attached. A citation grounded in a glance (or in
    // text alone) is the failure mode — see attachment_vision.
    let photoRead = '';
    try {
      if (sourceMessageId || (graphId && mailbox)) {
        const { describeMessageImages } = require('./attachment_vision');
        const v = await describeMessageImages(supabase, sourceMessageId, { mailbox, graphId });
        if (v.description) photoRead = `WHAT THE RESIDENT'S ATTACHED PHOTO(S) SHOW — a factual read of the image, treat it as the evidence. Cite ONLY what is visible here; do NOT assert a violation the photo does not clearly support:\n${v.description}\n\n`;
      }
    } catch (_) { /* vision is best-effort */ }
    const boardBlock = (config.servesBoard && audience === 'board') ? await core.boardDataContext(supabase, communityId) : '';
    const accountFacts = [
      ctx.violations.length ? `Open violations: ${ctx.violations.map((v) => `${v.category || 'violation'} (stage ${v.stage})`).join('; ')}` : null,
      ctx.ar_balance != null && Math.abs(ctx.ar_balance) > 0.5 ? `Account balance: ${ctx.ar_balance > 0 ? 'owes' : 'credit'} $${Math.abs(ctx.ar_balance).toFixed(2)}` : null,
      ctx.acc.length ? `Open ACC/architectural items: ${ctx.acc.map((a) => a.project_summary || a.decision_type).filter(Boolean).join('; ')}` : null,
    ].filter(Boolean).join('\n') || 'No account facts resolved for this sender.';

    const userContent = `THE INCOMING MESSAGE:\nFrom: ${email.sender_name || contactName || 'a sender'} (greet them as ${senderName})\nSubject: ${email.subject || '(none)'}\n\n${email.body || email.body_preview || ''}\n\n`
      + `THIS SENDER'S ACCOUNT (private to them — use to inform your reply, never quote another resident's data):\n${accountFacts}\n\n`
      + `COMMUNITY FACTS:\n${core.audienceGetsCommunityFacts(audience) ? (profileBlock || 'None available.') : 'Withheld. This audience does not receive the association\'s internal community data.'}\n\n`
      + photoRead
      + `GOVERNING DOCUMENTS & RULES retrieved for this question:\n${docContext || 'None retrieved.'}\n\n`
      + (config.servesBoard && audience === 'board' && boardBlock ? `BOARD GOVERNANCE DATA (association records, appropriate for a board member, never repeat outside the board):\n${boardBlock}\n\n` : '')
      + (gate.allow ? '' : (audience === 'board'
        ? `RESERVED REQUEST DETECTED — this asks for a decision reserved to the board acting as a body. Give 2 to 3 options with the tradeoffs and your recommendation for the board's decision. Do not report the decision as already made.\n\n`
        : `RESERVED REQUEST DETECTED — the sender is asking you to ${gate.reason.replace(/_/g, ' ')}, which you have NO authority to grant, deny, or decide. Do not state or imply a decision. Acknowledge it, explain what you can, and say you are bringing it to the board or the team with your recommendation, with a next step and a timeline.\n\n`))
      + (harm ? `${core.HARM_DRAFT_INSTRUCTION}\n\n` : '')
      + `Draft the reply to ${senderName}.`;

    // Append what Ed has taught this lane in shadow review (the encode-Ed loop).
    const { loadApprovedGuidance, guidanceBlock } = require('./learned_guidance');
    const learned = guidanceBlock(await loadApprovedGuidance(supabase, config.persona));
    const system = config.systemPromptFor(audience, communityName) + (learned ? `\n\n${learned}` : '');
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 1200, system,
      messages: [{ role: 'user', content: userContent }],
    });
    const out = core.cleanModelBody((resp.content || []).map((b) => b.text || '').join(''), config.sigNames || []);
    console.log(`[operator_reply:${config.persona}] grounded draft:`, JSON.stringify({ outLen: out.length, docCtx: docContext.length, profile: profileBlock.length, audience }));
    if (out.length > 40) { body = out; grounded = true; }
  } catch (e) {
    console.warn(`[operator_reply:${config.persona}] generation failed, using fallback:`, e.message);
  }

  const disp = core.classifyDisposition({ gateAllowed: gate.allow, grounded, escalationReasons, audience });
  return {
    draftable: true, careful: config.careful !== false, persona: config.persona,
    subject: `Re: ${email.subject || 'your message'}`,
    body,
    disposition: disp.disposition, confidence: disp.confidence, disposition_reason: disp.reason,
    // Clean judgment signals (also embedded in review_hint) so callers like
    // shadow mode can record them without parsing the hint string.
    audience, grounded, reserved: !gate.allow, reserved_reason: gate.allow ? null : gate.reason,
    escalation_reasons: escalationReasons,
    review_hint: reviewHint(config.reviewHintLabel || config.persona, escalationReasons, ctx)
      + ` · aud:${audience}` + (grounded ? ' · grounded' : ' · fallback')
      + (gate.allow ? '' : ` · RESERVED:${gate.reason}`) + ` · ${disp.disposition}/${disp.confidence}`,
    context: ctx,
  };
}

module.exports = { draftOperatorReply, reviewHint };
