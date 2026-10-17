// ============================================================================
// lib/email/public_identity.js  (Ed 2026-10-16): the team's public addresses for
// browser pages. Served at /team-identity.js (staff-gated like every page) so the
// HTML never hard-codes Amanda's address: it reads AMANDA_PUBLIC_EMAIL from
// lib/email/graph_send.js, the one canonical setting.
// ============================================================================
const gs = require('./graph_send');

function teamIdentity() {
  return {
    amanda: {
      name: gs.AMANDA_DISPLAY_NAME,
      email: gs.AMANDA_PUBLIC_EMAIL,
      display: gs.amandaDisplayAddress(),
      // Both addresses that are Amanda (public alias + mailbox identity), for
      // "never CC Amanda on her own reply" checks. Never shown as her address.
      addresses: gs.AMANDA_ADDRESSES,
    },
  };
}

// A classic script: pages load it synchronously before their own code.
function identityScript() {
  return 'window.TEAM_IDENTITY = ' + JSON.stringify(teamIdentity()).replace(/</g, '\u003c') + ';\n';
}

module.exports = { teamIdentity, identityScript };
