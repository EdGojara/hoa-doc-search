// ============================================================================
// lib/voice/emotional_load.js — empathy-mode detector
// ----------------------------------------------------------------------------
// Parallel to sentence_completeness.js. Single fast Haiku call that reads the
// caller's utterance and decides:
//   - emotional_load: true | false  — is the caller in a distressed register?
//   - confidence: high | medium | low
//   - protected_interest: short phrase ("kids' sleep", "property value",
//     "fairness in how they're being treated", "voice with the board")
//
// Used by bridge.js (voice) AND api/messaging.js draft layer (text replies)
// AND askEd advisor (when staff asks how to handle a homeowner). Same
// detector, three surfaces — single source of truth for the empathy-mode
// decision so all three behave consistently.
//
// Design rules (per Ed's spec 2026-06-06):
//   - Confidence-gated. Only fire empathy posture at MEDIUM+ confidence.
//     Low-confidence false positives turn every routine call into a faux-
//     empathy performance, which IS the AI-tell pattern we are fighting.
//   - The protected_interest is named in the CALLER'S framing, not from a
//     fixed taxonomy. The model is told to write what THEY are guarding,
//     not classify into buckets.
//   - Failure-mode default: emotional_load=false. Better a slightly clinical
//     response than a faux-empathy performance on a routine question.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';

const PROMPT = `You read a single message from a homeowner to an HOA management company. You decide whether they are in an EMOTIONAL register that warrants an empathy-first response, and you identify what they are PROTECTING.

EMOTIONAL register means: angry, exhausted, scared, ignored, helpless, defensive, fighting-for-something. Signals include repeated frustration ("I've called before, nobody is helping"), protective language ("my kids", "my home", "my family"), urgency, exhaustion, or feeling targeted. They are not just asking a question — they are escalating because something matters to them personally.

NEUTRAL register means: asking for information, requesting an action, polite confusion, routine business. Even short and direct messages are neutral if there's no emotional charge.

PROTECTED INTEREST means: what are they actually guarding? Not the surface complaint — the deeper thing. Common examples (but DO NOT pick from a fixed list — describe what THEY are protecting in their own framing):
- their kids' ability to sleep / feel safe
- the peace in their own home
- their property's appearance or value
- fairness in how they're treated vs. neighbors
- being heard after multiple attempts
- control over their own household
- their reputation with the board or their HOA neighbors
- the time / money they've already invested

Write the protected_interest in 3-10 words, in the homeowner's own framing. Do NOT use generic categories. ("kids' sleep in their own home" — yes. "family" — too generic.)

If you cannot identify a clear emotional register OR a specific protected interest, return emotional_load=false. Better to default to neutral than to invent empathy.

Reply with ONLY valid JSON, no preamble:
{"emotional_load": true|false, "confidence": "high"|"medium"|"low", "protected_interest": "<short phrase or empty string>", "register_signals": "<short phrase describing what tipped you off>"}`;

/**
 * Detect emotional load + protected interest in a homeowner utterance.
 *
 * @param {string} text — the homeowner's transcribed utterance or written message
 * @param {object} [opts]
 * @param {string} [opts.priorTurns] — optional context: prior turns in the
 *     same conversation, for cases where a follow-up utterance is short
 *     ("yes", "exactly") but emotional load is inherited from earlier turns.
 * @returns {Promise<{emotional_load: boolean, confidence: string, protected_interest: string, register_signals: string}>}
 */
async function detectEmotionalLoad(text, opts = {}) {
  const fallback = {
    emotional_load: false,
    confidence: 'low',
    protected_interest: '',
    register_signals: 'fallback (api error or parse failure)',
  };
  if (!text || !text.trim()) return fallback;

  // Hard short-circuit for very short acknowledgments — "yes" / "no" / "ok"
  // can't carry emotional load on their own. If they DID emotionally
  // colored a previous turn, the inherited load is captured by the bridge's
  // turn-state, not by this single utterance check.
  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount <= 2) {
    return {
      emotional_load: false,
      confidence: 'high',
      protected_interest: '',
      register_signals: 'short ack — too brief to carry load on its own',
    };
  }

  try {
    const userContent = opts.priorTurns
      ? `Prior turns in this conversation (for context only):\n${opts.priorTurns}\n\nCurrent utterance to analyze:\n"${text}"`
      : `Utterance: "${text}"`;

    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 220,
      messages: [{ role: 'user', content: `${PROMPT}\n\n${userContent}` }],
    });
    const raw = (resp.content || []).map((b) => b.text || '').join('').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return fallback;
    const parsed = JSON.parse(m[0]);
    return {
      emotional_load: parsed.emotional_load === true,
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low',
      protected_interest: String(parsed.protected_interest || '').slice(0, 120),
      register_signals: String(parsed.register_signals || '').slice(0, 200),
    };
  } catch (e) {
    console.warn('[voice/emotional_load] detection failed:', e.message);
    return fallback;
  }
}

/**
 * Should empathy posture fire? Confidence-gated wrapper around
 * detectEmotionalLoad. Defaults to NOT firing on low confidence to avoid
 * the faux-empathy tell.
 */
function shouldFireEmpathy(loadResult) {
  if (!loadResult || !loadResult.emotional_load) return false;
  return loadResult.confidence === 'high' || loadResult.confidence === 'medium';
}

module.exports = { detectEmotionalLoad, shouldFireEmpathy };
