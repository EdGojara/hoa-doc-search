// ============================================================================
// lib/tax/gate_mode.js  (Issue #14, Ed 2026-10-02): W-9 payment gate rollout
// ----------------------------------------------------------------------------
// TAX_W9_GATE = warn | enforce   (a deployment setting, not a per-payment override)
//   warn    (DEFAULT, rollout): the check run computes and shows/logs exactly
//           the decision enforce would make, but never refuses or reserves
//           differently because of W-9 status.
//   enforce the check run refuses a check that the rule blocks.
// Unset -> warn. Case/whitespace are forgiven ("ENFORCE " -> enforce). Any
// other value is a CONFIGURATION ERROR: the gate runs in warn (payments are not
// refused because of a typo) and the error is reported loudly on every check
// run (log + response), so it is fixed rather than silently ignored.
// Switching to enforce is a deliberate operational action: set the variable
// and redeploy/restart.
// ============================================================================
function gateMode(env = process.env) {
  const raw = env.TAX_W9_GATE;
  if (raw == null || String(raw).trim() === '') return { mode: 'warn', configured: false, error: null };
  const v = String(raw).trim().toLowerCase();
  if (v === 'warn' || v === 'enforce') return { mode: v, configured: true, error: null };
  return { mode: 'warn', configured: false, error: `TAX_W9_GATE="${String(raw).slice(0, 40)}" is not warn or enforce; running in warn mode until it is fixed` };
}
module.exports = { gateMode };
