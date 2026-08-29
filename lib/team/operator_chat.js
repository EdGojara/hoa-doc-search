// ============================================================================
// lib/team/operator_chat.js  (Ed 2026-08-29)
// ----------------------------------------------------------------------------
// The CONVERSATIONAL operator. Same core as the email engine (grounding, the
// reserved gate, audience + disclosure, board data), but multi-turn: you talk
// to a teammate and they answer, reason, ask a clarifying question, and stay in
// their lane — the way you talk to an assistant, not a form letter.
//
// The difference from operator_reply.js is the shape of the interaction, not the
// brain. Grounding refreshes on each turn's question; the conversation history
// carries context; the reserved gate runs on every user turn. This is the layer
// the askEd-style chat surface and the voice brain compose to make a persona
// something you HOLD A CONVERSATION with.
// ============================================================================

const core = require('./operator_core');

const CHAT_ADDENDUM = `

You are in a live conversation, not writing a one-off email. Answer directly and concisely. Reason openly when it helps. Ask a clarifying question when you genuinely need one. If you do not know, or the context below does not contain it, say so plainly and say how you will find out — never guess. Use what was already said earlier in the conversation.`;

// config: the same persona config shape operator_reply uses.
// state: { history:[{role,content}], audience, communityId, communityName, propertyId }
async function chatOperator(config, { history = [], userMessage, supabase, communityId = null, communityName = null, audience = 'staff', propertyId = null }) {
  const gate = core.reservedAsk({ body: userMessage }, config.gateRole || 'homeowner');

  let docContext = '';
  let profileBlock = '';
  try {
    const g = await core.assembleGrounding({ email: { body: userMessage }, communityName });
    docContext = g.docContext; profileBlock = g.profileBlock;
  } catch (e) { /* best-effort */ }
  const boardBlock = (config.servesBoard && audience === 'board' && supabase) ? await core.boardDataContext(supabase, communityId) : '';

  let accountFacts = '';
  if (propertyId && supabase) {
    try {
      const ctx = await core.propertyContext(supabase, { propertyId });
      accountFacts = [
        ctx.violations.length ? `Open violations: ${ctx.violations.map((v) => `${v.category || 'violation'} (stage ${v.stage})`).join('; ')}` : null,
        ctx.ar_balance != null && Math.abs(ctx.ar_balance) > 0.5 ? `Account balance: ${ctx.ar_balance > 0 ? 'owes' : 'credit'} $${Math.abs(ctx.ar_balance).toFixed(2)}` : null,
        ctx.acc.length ? `Open ACC/architectural items: ${ctx.acc.map((a) => a.project_summary || a.decision_type).filter(Boolean).join('; ')}` : null,
      ].filter(Boolean).join('\n');
    } catch (e) { /* best-effort */ }
  }

  const contextBlock = [
    (core.audienceGetsCommunityFacts(audience) && profileBlock) ? `COMMUNITY FACTS:\n${profileBlock}` : '',
    accountFacts ? `THIS PERSON'S ACCOUNT (private to them):\n${accountFacts}` : '',
    docContext ? `GOVERNING DOCUMENTS & RULES:\n${docContext}` : '',
    boardBlock ? `BOARD GOVERNANCE DATA:\n${boardBlock}` : '',
    gate.allow ? '' : `NOTE: this turn asks for a reserved decision (${gate.reason.replace(/_/g, ' ')}). You may NOT decide it — explain what you can and say you'll bring it to the board or the team.`,
  ].filter(Boolean).join('\n\n');

  const system = config.systemPromptFor(audience, communityName) + CHAT_ADDENDUM
    + (contextBlock ? `\n\nCONTEXT FOR THIS TURN (answer only from this and the conversation, do not invent):\n${contextBlock}` : '');

  const messages = [...history, { role: 'user', content: userMessage }];
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const resp = await anthropic.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 900, system, messages });
  const reply = core.cleanModelBody((resp.content || []).map((b) => b.text || '').join(''), config.sigNames || []);

  return {
    reply,
    gate,
    grounded: !!docContext,
    history: [...messages, { role: 'assistant', content: reply }],
  };
}

module.exports = { chatOperator };
