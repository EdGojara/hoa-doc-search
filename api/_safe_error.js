// ============================================================================
// safeErrorMessage — strip vendor names from any error before it reaches the
// user. Errors from the Anthropic SDK and underlying fetch can include the
// word "claude", the model ID ("claude-sonnet-4-6"), or "anthropic.com" —
// none of which should ever land in front of a homeowner or board member.
//
// Apply at every "send error to client" boundary.
// ============================================================================

function safeErrorMessage(err, fallback = 'Something went wrong. Please try again.') {
  if (!err) return fallback;
  let msg = (typeof err === 'string') ? err : (err.message || err.error || String(err));
  if (!msg) return fallback;

  // Scrub vendor names + model IDs (case-insensitive)
  msg = msg
    .replace(/claude-sonnet-[0-9-]+/gi, 'the AI service')
    .replace(/claude-opus-[0-9-]+/gi, 'the AI service')
    .replace(/claude-haiku-[0-9-]+/gi, 'the AI service')
    .replace(/claude-[a-z0-9-]+/gi, 'the AI service')
    .replace(/anthropic[.-][a-z0-9]+/gi, 'the AI service')
    .replace(/api\.anthropic\.com/gi, 'the AI service')
    .replace(/\banthropic\b/gi, 'the AI service')
    .replace(/\bclaude\b/gi, 'the AI service')
    .replace(/openai\.com/gi, 'the voice service')
    .replace(/\bopenai\b/gi, 'the voice service')
    .replace(/whisper-[0-9]+/gi, 'the voice service')
    .replace(/text-embedding-[a-z0-9-]+/gi, 'the embedding service')
    .replace(/tts-[0-9]+/gi, 'the voice service');

  // Common SDK fetch-failure pattern → friendly text
  if (/fetch failed/i.test(msg) || /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET/i.test(msg)) {
    return 'Could not reach the AI service. The connection may be intermittent — please try again in a moment.';
  }
  if (/overloaded/i.test(msg)) {
    return 'The AI service is overloaded right now. Please try again in a few seconds.';
  }
  if (/rate.?limit/i.test(msg)) {
    return 'Rate limit reached — please wait a moment and try again.';
  }
  if (/401|unauthorized/i.test(msg)) {
    return 'AI service authentication failed. Notify Ed.';
  }
  if (/timeout/i.test(msg)) {
    return 'The request timed out. Please try again.';
  }

  // Truncate long messages
  if (msg.length > 240) msg = msg.slice(0, 240) + '…';
  return msg;
}

module.exports = { safeErrorMessage };
