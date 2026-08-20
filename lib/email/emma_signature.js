// ============================================================================
// lib/email/emma_signature.js  (Ed 2026-07-08)
// ----------------------------------------------------------------------------
// Emma's outbound email: approved reply body + branded Bedrock signature +
// honest-AI line, sent from emma@bedrocktx.com. Mirrors claire_signature.js
// (same logo-as-inline-CID approach) but with Emma's AP identity. Graph-sent
// mail ignores the mailbox's Outlook signature, so it lives in the message.
// ============================================================================
//
// ---------------------------------------------------------------------------
// Ed 2026-08-20: this file used to carry its own copy of the signature table,
// the brand colours, the logo attachment and — the part that actually bit —
// this teammate's name and job title typed in by hand. Nine files, nine copies
// of who works here, drifting against roster.js.
//
// It is now a thin wrapper. Identity comes from the roster, layout comes from
// persona_signature.js, and this export exists so callers did not have to move.
// ---------------------------------------------------------------------------
const { buildPersonaEmail } = require('./persona_signature');

function buildEmmaEmail(bodyText, communityName) {
  return buildPersonaEmail('emma', bodyText, communityName);
}

module.exports = { buildEmmaEmail };
