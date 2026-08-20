// ============================================================================
// lib/email/amanda_signature.js  (Ed 2026-07-19)
// ----------------------------------------------------------------------------
// Amanda Albright — Bedrock's Senior Community Manager. The escalation tier:
// she owns the tough, cross-domain, relationship-heavy cases the specialists
// (Annie/ACC, Miranda/DRV, Emma/AP) can't cleanly resolve on their own. She
// coordinates and recommends; she does not waive fines or take legal positions
// (same compliance scoping as Claire). Same branded honest-AI signature.
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

function buildAmandaEmail(bodyText, communityName) {
  return buildPersonaEmail('amanda', bodyText, communityName);
}

module.exports = { buildAmandaEmail };
