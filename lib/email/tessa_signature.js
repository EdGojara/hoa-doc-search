// ============================================================================
// lib/email/tessa_signature.js  (Ed 2026-07-13, upgraded 2026-07-29)
// ----------------------------------------------------------------------------
// Tessa McCall — Ed's executive assistant. When she sends correspondence AS
// Tessa she now carries the FULL branded signature (logo + gold rule + honest-
// AI disclosure), same pattern as the front-office personas (see
// annie_signature.js) — because she is sending real correspondence, not just a
// personal note. Only the name/title/mailbox differ.
//   - Title is "Executive Assistant," full stop — NO owner (Ed's) name in it.
//   - Not community-scoped: no community name in the org line.
//   - No invented phone number.
// When she GHOSTWRITES as Ed the email carries no signature block (it's his
// own) — that path never calls this builder.
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

function buildTessaEmail(bodyText, communityName, quotedHtml) {
  return buildPersonaEmail('tessa', bodyText, communityName, quotedHtml);
}

module.exports = { buildTessaEmail };
