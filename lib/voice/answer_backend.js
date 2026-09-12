// ============================================================================
// lib/voice/answer_backend.js  (Ed 2026-09-12 — GPT-Live-1 voice PoC)
// ----------------------------------------------------------------------------
// The ONE grounded-answer backend every Claire voice surface delegates to.
//
// This is the seam that makes the A/B honest: the current Twilio+Deepgram+
// ElevenLabs bridge, the portal, and the new GPT-Live-1 provider all reach the
// SAME brain through this function, so when Ed calls "Claire A" and "Claire B"
// he is comparing voice layers over an identical backend. The voice layer is
// swappable; reason.js (retrieval + guardrails + judgment) is not.
//
// It wraps reason.js streamTurn with exactly the same inputs lib/voice/bridge.js
// already uses, collects the streamed sentences into one grounded answer, and
// scrubs em-dashes (Ed's rule spans voice, not just email). The GPT-Live-1
// delegation tool calls this and speaks the returned text; the model never
// freelances a substantive answer.
// ============================================================================
const { streamTurn } = require('./reason');
const { stripEmDashes } = require('../tone');

// Haiku on voice surfaces — same default as bridge.js (speed-tuned; overridable).
const VOICE_MODEL = process.env.CLAIRE_LLM_MODEL || 'claude-haiku-4-5-20251001';

/**
 * Produce the grounded answer for one voice turn.
 *
 * @param {object} opts
 * @param {string} opts.utterance         what the caller said (required)
 * @param {Array}  [opts.history]         [{role, content}] prior turns (excl. this utterance)
 * @param {object} [opts.community]       community context (scopes retrieval)
 * @param {object} [opts.caller]          matched homeowner context, if any
 * @param {string} [opts.caller_phone]    caller phone, for identity-bound tools
 * @param {object} [opts.warmup]          pre-call AR/violations/ACC snapshot
 * @param {Promise}[opts.empathyPromise]  parallel emotional-load detection
 * @param {string} [opts.model]           override the reasoning model
 * @returns {Promise<{text:string, empty:boolean}>}
 */
async function answerForVoice({
  utterance, history = [], community = null, caller = null,
  caller_phone = null, warmup = null, empathyPromise = null, model,
} = {}) {
  if (!utterance || !String(utterance).trim()) return { text: '', empty: true };

  let full = '';
  for await (const sentence of streamTurn({
    model: model || VOICE_MODEL,
    utterance: String(utterance),
    history: Array.isArray(history) ? history : [],
    community,
    caller,
    caller_phone,
    warmup,
    empathyPromise,
  })) {
    // streamTurn yields answer sentences as strings; control objects (tool
    // passthroughs) are not spoken here — the voice layer handles those.
    if (typeof sentence === 'string') full += (full ? ' ' : '') + sentence;
  }

  const text = stripEmDashes(full.trim());
  return { text, empty: !text };
}

module.exports = { answerForVoice, VOICE_MODEL };
