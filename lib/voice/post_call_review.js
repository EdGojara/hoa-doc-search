// ============================================================================
// lib/voice/post_call_review.js — pacing-failure review of finished Claire calls
// ----------------------------------------------------------------------------
// After every Claire call ends, this module reviews the transcript via a fast
// Haiku call and writes structured observations about pacing failures to
// claire_pacing_observations (migration 105). Ed periodically sweeps the
// unreviewed observations and decides which patterns to encode into the
// system prompt or per-community config.
//
// This is the "Claire learns" capability. Without this, the same pacing
// mistakes repeat every call indefinitely. With this, patterns surface,
// get reviewed by a human, and ship as concrete behavior changes.
//
// Design rules:
//   - Always-on. Not feature-flagged. Additive only — failures here can
//     never affect call experience (already over) or break call_log.js.
//   - Single Haiku call per call, returns a structured array. Cost is
//     trivial (~$0.001 per call review).
//   - Errors swallowed with a warn log. Never re-throw.
//   - Skip review for very short calls (<2 caller utterances) — not enough
//     signal to identify pacing patterns.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const REVIEW_MODEL = 'claude-haiku-4-5-20251001';

const REVIEW_PROMPT = `You are reviewing a transcript of an AI voice assistant (Claire) handling a phone call for an HOA management company. Identify Claire's PACING FAILURES — moments where Claire's timing, turn-taking, or conversational rhythm went wrong.

Focus on PACING, not content accuracy. Content review happens elsewhere.

Categorize each failure as ONE of:
- interrupted_caller — Claire started speaking while caller was mid-thought
- awkward_silence — dead air (3+ seconds) where Claire should have responded or signaled listening
- misread_intent — caller asked X, Claire responded to Y (intent-recognition failure)
- missed_exception — Claire gave a general rule when the docs contain an exception/carve-out that applied
- over_long_response — Claire monologued where 1-2 sentences would have been right
- under_responsive — caller asked a complex question, got a terse non-answer
- wrong_handoff_decision — Claire offered/didn't offer warm-transfer when the opposite was right
- wrong_tone — formality/register mismatch with the caller
- other — anything pacing-related that doesn't fit above; explain in reasoning

Severity:
- low — minor friction, didn't derail the call
- medium — noticeable, would frustrate a homeowner
- high — call broke down, escalation needed, caller hung up frustrated

Reply with ONLY valid JSON, no preamble:
{
  "observations": [
    {
      "observation_type": "<from list above>",
      "description": "<one-sentence summary of what went wrong>",
      "example_text": "<relevant snippet from transcript — Claire + caller lines>",
      "severity": "<low|medium|high>"
    },
    ...
  ]
}

If no pacing failures detected, return {"observations": []} — that's the right answer for clean calls. Don't invent failures to fill the list.`;

/**
 * Review a finished call's transcript for pacing failures.
 * Writes any findings to claire_pacing_observations.
 *
 * @param {object} opts
 * @param {string} opts.callSid — Twilio call SID (used to look up the
 *   homeowner_calls.id for the FK on observations)
 * @param {Array} opts.history — full conversation as [{role, content}]
 * @param {object} [opts.logger]
 */
async function reviewCallForPacing({ callSid, history, logger = console }) {
  // Skip short calls — not enough signal
  const callerTurns = (history || []).filter((h) => h.role === 'user').length;
  if (callerTurns < 2) {
    logger.log(`[post_call_review ${callSid}] skipping — only ${callerTurns} caller turn(s)`);
    return;
  }

  // Look up the call row id (FK target)
  let callId = null;
  try {
    const { data } = await supabase
      .from('homeowner_calls')
      .select('id')
      .eq('call_sid', callSid)
      .maybeSingle();
    callId = data?.id || null;
  } catch (e) {
    logger.warn(`[post_call_review ${callSid}] call lookup failed: ${e.message}`);
    return; // can't write observations without an FK target
  }
  if (!callId) {
    logger.warn(`[post_call_review ${callSid}] no homeowner_calls row found`);
    return;
  }

  // Format transcript for the review prompt
  const transcript = history
    .map((h) => `${h.role === 'user' ? 'Caller' : 'Claire'}: ${h.content}`)
    .join('\n');

  let parsed;
  try {
    const resp = await anthropic.messages.create({
      model: REVIEW_MODEL,
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `${REVIEW_PROMPT}\n\nTranscript:\n${transcript}`,
      }],
    });
    const text = (resp.content || []).map((b) => b.text || '').join('').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn(`[post_call_review ${callSid}] non-JSON response`);
      return;
    }
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    logger.warn(`[post_call_review ${callSid}] review call failed: ${e.message}`);
    return;
  }

  const observations = Array.isArray(parsed?.observations) ? parsed.observations : [];
  if (observations.length === 0) {
    logger.log(`[post_call_review ${callSid}] clean call — no pacing failures`);
    return;
  }

  // Write observations as a single batch insert
  const rows = observations
    .filter((o) => o && o.observation_type && o.description)
    .map((o) => ({
      call_id: callId,
      observation_type: o.observation_type,
      description: String(o.description).slice(0, 2000),
      example_text: o.example_text ? String(o.example_text).slice(0, 4000) : null,
      severity: ['low', 'medium', 'high'].includes(o.severity) ? o.severity : 'medium',
    }));
  if (rows.length === 0) {
    logger.warn(`[post_call_review ${callSid}] all observations malformed, skipping insert`);
    return;
  }
  try {
    const { error } = await supabase.from('claire_pacing_observations').insert(rows);
    if (error) throw error;
    logger.log(`[post_call_review ${callSid}] wrote ${rows.length} pacing observation(s)`);
  } catch (e) {
    logger.warn(`[post_call_review ${callSid}] observations insert failed: ${e.message}`);
  }
}

module.exports = { reviewCallForPacing };
