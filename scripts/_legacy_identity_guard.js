// scripts/_legacy_identity_guard.js  (Issue #15) — offline scripts that infer identity
// These one-off scripts reuse contacts by name, default dates to the run date, copy
// mailing addresses into property fields, or infer occupancy. They refuse to run
// unless the operator sets ALLOW_LEGACY_IDENTITY_SCRIPT=<script name>, so a future
// session cannot re-run one by accident while the onboarding identity model is built.
module.exports = function legacyIdentityGuard(scriptName) {
  if (process.env.ALLOW_LEGACY_IDENTITY_SCRIPT === scriptName) return;
  console.error(`[identity-safety] ${scriptName} is paused (Issue #15): it infers identity or relationships the source does not establish. `
    + `To run it deliberately, set ALLOW_LEGACY_IDENTITY_SCRIPT=${scriptName}.`);
  process.exit(3);
};
