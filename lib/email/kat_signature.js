// ============================================================================
// lib/email/kat_signature.js  (Ed 2026-07-19)
// ----------------------------------------------------------------------------
// Katherine "Kat" Reed — Bedrock's Accounting Manager (month-end close,
// reconciliation, financial statements, budget-vs-actual; the controller over
// Emma's AP intake). Same branded-logo + honest-AI pattern as the other
// agents; only the name, title, and mailbox differ.
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

function buildKatEmail(bodyText, communityName) {
  return buildPersonaEmail('kat', bodyText, communityName);
}

module.exports = { buildKatEmail };
