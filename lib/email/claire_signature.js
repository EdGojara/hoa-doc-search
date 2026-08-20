// ============================================================================
// lib/email/claire_signature.js  (Ed 2026-07-06)
// ----------------------------------------------------------------------------
// Build the HTML email Claire actually sends: the approved reply body + a
// branded Bedrock signature with logo + the honest-AI line. Graph-sent mail
// ignores the mailbox's Outlook signature, so the signature has to live in the
// message we send — this is that.
//
// The logo is delivered as an INLINE CID attachment (not a data: URI and not a
// hosted URL) so it renders reliably across clients including Gmail, and works
// even though the app's static assets are auth-gated. Referenced in the HTML as
// <img src="cid:bedrocklogo">.
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

function buildClaireEmail(bodyText, communityName) {
  return buildPersonaEmail('claire', bodyText, communityName);
}

module.exports = { buildClaireEmail };
