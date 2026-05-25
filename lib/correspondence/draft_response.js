// ============================================================================
// lib/correspondence/draft_response.js
// ----------------------------------------------------------------------------
// AI draft generator for inbound homeowner interactions. Uses Sonnet (per
// CLAUDE.md standard) for higher-quality drafting in Bedrock voice — the
// draft is a child interaction (type='ai_draft', parent_interaction_id
// pointing to the inbound) that staff edits + sends.
//
// Voice rules are HARD-CODED into the prompt per memory notes:
// - feedback_no_document_citation_voice (no "Section X" citations)
// - feedback_bespoke_touch (use names not "Dear Homeowner")
// - feedback_dont_offer_stopping_points (action over process)
// - project_encode_ed_5min (sound like Ed in 5 min, not generic CFO)
//
// Cost: Sonnet at ~$0.01-0.05 per draft. ~200 drafts/day = ~$3-9/day at
// current Bedrock scale; ~$60-200/mo at 50-community franchise scale.
// Drafting is conditional on urgency (skip low + spam) so volume is
// realistic, not blanket.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-4-5';

/**
 * Draft a response to an inbound interaction in Bedrock voice. Returns
 * { subject, content, tone_notes, needs_human_review_before_send,
 *   needs_review_reason } suitable for writing as a child interaction
 * with type='ai_draft', status='draft'. Returns null on parse failure.
 *
 * @param {object} interaction — the inbound being responded to
 * @param {object} context — drafting context
 * @param {string} [context.community_name]
 * @param {string} [context.homeowner_name]
 * @param {Array}  [context.homeowner_tags]      [{tag_key}, ...]
 * @param {object} [context.latest_ar]           {balance_total, enforcement_stage, at_legal, in_collections}
 * @param {Array}  [context.thread_interactions] [{direction, subject, content, sent_at}, ...] prior thread
 * @param {string} [context.staff_signoff_name='the Bedrock team']
 * @param {object} [opts]
 * @param {object} [opts.logger=console]
 * @returns {Promise<object|null>}
 */
async function draftResponseForInteraction(interaction, context, { logger = console } = {}) {
  const tagsLine = (context.homeowner_tags || []).length > 0
    ? `Homeowner tags (staff-only context): ${context.homeowner_tags.map((t) => t.tag_key).join(', ')}`
    : '';
  const arLine = context.latest_ar
    ? `Account status (staff-only context): $${context.latest_ar.balance_total ?? 0} balance, enforcement_stage=${context.latest_ar.enforcement_stage || 'unknown'}${context.latest_ar.at_legal ? ', WITH LEGAL — do NOT discuss balance specifics' : ''}${context.latest_ar.in_collections ? ', IN COLLECTIONS — do NOT discuss balance specifics' : ''}`
    : '';

  const priorThread = (context.thread_interactions || []).slice(0, 5)
    .map((i) => `[${String(i.direction || '').toUpperCase()} ${i.sent_at || ''}] ${i.subject || ''}\n${(i.content || '').slice(0, 600)}`)
    .join('\n\n---\n\n');

  const signoffName = context.staff_signoff_name || 'the Bedrock team';

  const prompt = `You're drafting a response to an inbound from a homeowner, in the voice of Bedrock Association Management.

VOICE RULES (hard — violating any breaks the draft):
- Conversational, not corporate. Specific, not generic.
- NEVER cite documents by section/article/page/paragraph number. "According to Section 4.2" is BANNED. Say "there's a rule about it" or paraphrase plainly. Same for "per Article III" / "per the CC&Rs" — use natural language.
- "Dear Homeowner" is BANNED. Use the homeowner's actual name.
- No legalese unless the situation genuinely demands it (legal threats received, §209 process, ADA).
- Acknowledge the specific thing they raised before answering — quote a phrase or fact from their message, not "we received your inquiry".
- Tell them what you're going to DO, not what process you'll follow. Concrete action over abstraction.
- Never end with "let me know if you have other questions" or similar stopping-point offers. End with what's next.
- If account is in collections/legal, do NOT discuss balance specifics — defer to "your file is with our attorney; please direct payment questions to them at [placeholder]".

CONTEXT:
Community: ${context.community_name || 'their community'}
Homeowner: ${context.homeowner_name || '(name not yet on file)'}
${tagsLine}
${arLine}

THE INBOUND (what you're responding to):
Subject: ${interaction.subject || '(no subject)'}
${interaction.content || '(no body)'}

${priorThread ? `PRIOR CORRESPONDENCE IN THIS THREAD (most recent first):\n${priorThread}\n\n` : ''}

Draft a response. Return ONLY a JSON object (no markdown fences, no commentary):
{
  "subject": "string — typically 'Re: <original subject>' or a focused new subject",
  "content": "string — full email body in plain text, includes greeting (use their name) and sign-off (use '${signoffName}')",
  "tone_notes": "string — 1-line note on the tone you chose (e.g., 'warm + concrete', 'formal + factual', 'apologetic + action-forward')",
  "needs_human_review_before_send": true | false,
  "needs_review_reason": "string — only when needs_human_review_before_send=true (e.g., 'legal exposure — homeowner mentioned attorney', 'fee waiver request — discretionary policy call')"
}

Default tone: warm-but-concrete. Switch to formal-factual when: compliance/§209, legal threat received, fee waiver/policy discretion, board-member-direct correspondence. Switch to apologetic-action-forward when Bedrock missed something or response is late.

needs_human_review_before_send=true when: legal exposure mentioned, attorney involvement, fee waiver / policy discretion call, board governance topic, fair housing / ADA, anything where a wrong answer is hard to retract.`;

  let resp;
  try {
    resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    logger.warn(`[draft_response] API call failed: ${err.message}`);
    return null;
  }

  const text = (resp.content[0]?.text || '').trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.warn(`[draft_response] JSON parse failed: ${err.message}; raw: ${cleaned.slice(0, 300)}`);
    return null;
  }

  // Light validation — drafts are inherently free-text; we don't strip
  // content but coerce missing fields to safe defaults.
  parsed.subject = String(parsed.subject || `Re: ${interaction.subject || ''}`).slice(0, 250);
  parsed.content = String(parsed.content || '').trim();
  if (!parsed.content) return null; // empty draft is worse than no draft
  parsed.tone_notes = String(parsed.tone_notes || '').slice(0, 200);
  parsed.needs_human_review_before_send = !!parsed.needs_human_review_before_send;
  if (parsed.needs_human_review_before_send && !parsed.needs_review_reason) {
    parsed.needs_review_reason = 'flagged by drafter';
  }
  parsed.drafted_at = new Date().toISOString();
  parsed.drafted_by_model = MODEL;

  return parsed;
}

module.exports = { draftResponseForInteraction, MODEL };
