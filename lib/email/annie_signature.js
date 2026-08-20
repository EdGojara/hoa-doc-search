// ============================================================================
// lib/email/annie_signature.js  (Ed 2026-07-13)
// ----------------------------------------------------------------------------
// Annie Reeves — Bedrock's architectural review (ACC/ARC) coordinator. Builds
// the HTML she sends. Same branded-logo + honest-AI pattern as Claire (see
// claire_signature.js); only the name, title, and mailbox differ.
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

function buildAnnieEmail(bodyText, communityName, quotedHtml) {
  return buildPersonaEmail('annie', bodyText, communityName, quotedHtml);
}

module.exports = { buildAnnieEmail };
