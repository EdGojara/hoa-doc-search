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
  // Ed 2026-11-26 (chat, quoted): "Release the holds on 19815 Dahlia Brook, 20022 Cape
  // Clover and 19907 Cape Clover so Annie can proceed within her delegated authority."
  // The letters prepared for these cases are reviewed by Ed before they go out; from
  // here on Annie handles new documents on them as on any current application.
  ['468fbf94-d53a-46b1-8b85-333cd71a521e', { released: '2026-11-26', ref: 'WAT-ARC-2026-0035', note: '19815 Dahlia Brook: roof + rear porch (porch built); survey/roof product requested' }],
  ['5a9a393b-6388-4f15-b0e9-6eced39afc9d', { released: '2026-11-26', ref: 'WAT-ARC-2026-0047', note: '20022 Cape Clover: like-for-like driveway; Annie approval with conditions' }],
  ['a4934468-4b4c-4693-9b5e-67f877945ad8', { released: '2026-11-26', ref: 'WAT-ARC-2026-0046', note: '19907 Cape Clover: driveway rebuilt July 2025; site sketch, photos, scope requested' }],
]);

function isBacklogHeld(row = {}) {
  if (!row || !row.created_at) return true;   // unknown age: treat as backlog (fail closed)
  if (RELEASED.has(row.id)) return false;
  return Date.parse(row.created_at) < Date.parse(BACKLOG_CUTOFF);
}

module.exports = { BACKLOG_CUTOFF, RELEASED, isBacklogHeld };
