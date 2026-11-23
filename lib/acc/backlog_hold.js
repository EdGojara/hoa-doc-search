// ============================================================================
// lib/acc/backlog_hold.js  (Ed 2026-11-18)
// ----------------------------------------------------------------------------
// HOLD THE EXISTING ACC BACKLOG. Ed: "HOLD all existing backlog applications
// until I review their history. Do not send any old decision letters without my
// specific authorization, even if TrustEd currently shows them as pending. Keep
// the existing backlog hold in place through deployments and restarts. Do not
// let this delay new applications."
//
// Every ACC case created before BACKLOG_CUTOFF is held: Annie never issues it,
// and no final decision letter on it is sent except from Ed's own account (his
// specific authorization). Cases created after the cutoff are untouched: Annie
// processes and sends them as usual. The hold lives in code, so no deployment,
// migration or restart releases it. Ed releases a case by authorizing it; its id
// is then added to RELEASED (or he sends it himself from his account).
// Requests for more information are not decision letters and are not held.
// ============================================================================
const BACKLOG_CUTOFF = '2026-11-19T03:04:33Z';
// Backlog cases Ed has specifically authorized Annie to issue (id + date + note).
const RELEASED = new Map([
]);

function isBacklogHeld(row = {}) {
  if (!row || !row.created_at) return true;   // unknown age: treat as backlog (fail closed)
  if (RELEASED.has(row.id)) return false;
  return Date.parse(row.created_at) < Date.parse(BACKLOG_CUTOFF);
}

module.exports = { BACKLOG_CUTOFF, RELEASED, isBacklogHeld };
