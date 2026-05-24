// ============================================================================
// lib/voice/sentence_completeness.js — semantic endpointing helper
// ----------------------------------------------------------------------------
// Deepgram's endpointing is silence-based: after ~800ms of no audio it
// declares the utterance "final." But humans pause much longer than 800ms
// mid-thought ("uhh… I was wondering about… my fees"). The result is Claire
// interrupting people who paused to think.
//
// This module adds a SEMANTIC layer: after Deepgram says "final," we ask
// Haiku "is this sentence semantically complete?" If NO, the bridge buffers
// the text and waits for more speech before responding. If YES (or timeout
// fallback), the bridge proceeds with the response.
//
// Design rules:
//   - Single fast Haiku call. Target latency ~150-250ms.
//   - Returns {complete, confidence, reasoning} — bridge uses confidence to
//     decide whether to wait or proceed conservatively.
//   - Failure-mode default: assume complete. Worse to hang Claire forever
//     than to interrupt occasionally.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';

const PROMPT = `You evaluate whether a caller's spoken sentence is semantically COMPLETE or whether they're likely still mid-thought.

The caller is calling an HOA management company's AI assistant. Their speech was just transcribed from audio. The transcription system ended the utterance after a brief silence, but the silence may have been a thinking pause, not the actual end of their sentence.

COMPLETE: the sentence reads as a finished question, statement, or request. Example: "Can you tell me what time the pool closes?" / "I need to schedule a clubhouse rental." / "Thanks." / "Yes." / "My name is Sarah."

INCOMPLETE: the sentence trails off, ends on a preposition/article/conjunction, or is clearly a fragment the caller will continue. Example: "I was wondering about my…" / "Can you tell me what the rules are about" / "And the other thing is" / "So I think we should" / "My address is twenty thousand"

When in doubt: lean COMPLETE for short utterances (under 5 words) — they're often single-word answers or quick acknowledgments. Lean INCOMPLETE if the sentence ends mid-clause.

Reply with ONLY valid JSON, no preamble:
{"complete": true|false, "confidence": "high"|"medium"|"low", "reasoning": "<short phrase>"}`;

/**
 * Check whether a caller's utterance is semantically complete.
 *
 * @param {string} text — the caller's transcribed utterance
 * @returns {Promise<{complete: boolean, confidence: string, reasoning: string}>}
 */
async function isSentenceComplete(text) {
  const fallback = { complete: true, confidence: 'low', reasoning: 'fallback (api error or parse failure)' };
  if (!text || !text.trim()) return { complete: true, confidence: 'high', reasoning: 'empty text' };

  // Hard short-circuit for one-word utterances — almost always complete.
  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount <= 2) {
    return { complete: true, confidence: 'high', reasoning: 'short utterance (<=2 words)' };
  }

  try {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `${PROMPT}\n\nUtterance: "${text}"`,
      }],
    });
    const raw = (resp.content || []).map((b) => b.text || '').join('').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return fallback;
    const parsed = JSON.parse(m[0]);
    return {
      complete: parsed.complete === true,
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low',
      reasoning: String(parsed.reasoning || '').slice(0, 200),
    };
  } catch (_) {
    return fallback;
  }
}

module.exports = { isSentenceComplete };
