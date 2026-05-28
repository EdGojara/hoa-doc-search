// ============================================================================
// GLOBAL_RULES — canonical injection blocks for catastrophic-output letters
// ----------------------------------------------------------------------------
// Per CLAUDE.md: statutory wording (Texas §209 cure rights, civil-damages
// limits, Servicemembers Civil Relief Act, etc.) injects at render time from
// this single source. Letters never freestyle this language.
//
// Update flow when statute changes:
//   1. Update the block here
//   2. Bump the GLOBAL_RULES_VERSION below
//   3. Every renderer that uses these blocks gets the new language on the
//      next render — no template files need editing
//
// Discipline:
//   - Every block is exact statutory wording or attorney-reviewed copy
//   - Do not modify language without attorney sign-off
//   - Track changes in git so we have a per-version audit trail
//
// Used by:
//   - lib/lawn_force_mow_renderer.js
//   - lib/enforcement/violation_letter.js (future migration)
//   - lib/builder_letter.js (future migration)
//   - All other catastrophic-output renderers
// ============================================================================

const GLOBAL_RULES_VERSION = 1;
const GLOBAL_RULES_REVIEWED_AT = '2026-05-28';

const GLOBAL_RULES = {
  // -------------------------------------------------------------------------
  // Texas §209.006-007 hearing rights — included CONDITIONALLY in violation
  // letters when no notice has been sent for the SAME violation in the prior
  // 6 months. Renderers must compute this conditional based on violation
  // history before deciding to inject this block.
  // -------------------------------------------------------------------------
  tx_209_hearing_rights_conditional: `Please note that you may have certain rights under Section 209.006-007 of the Texas Property Code. Pursuant to Chapter 209 of the Texas Property Code: (i) you may request a hearing, in writing, under Section 209.007 on or before the thirtieth (30th) day after the date this letter is sent; and (ii) you may have special rights or relief related to any enforcement action described herein under federal law, including the Servicemembers Civil Relief Act (50 U.S.C. Section 501, et seq.) if you are serving on active duty.`,

  // -------------------------------------------------------------------------
  // §209.006(b)(1) administrative fee disclosure — required when the
  // Association is applying an administrative fee for the cost of producing
  // and mailing the notice. Renderers must substitute {{admin_fee_amount}}
  // before injection.
  // -------------------------------------------------------------------------
  tx_209_admin_fee_disclosure: `Please be advised that, as of the date of this letter, a {{admin_fee_amount}} fee has been applied to your account. This letter is not a demand for payment of the amount at this time. The notice of the fee amount is included in this letter to be in compliance with Texas Property Code Section 209.006(b)(1).`,

  // -------------------------------------------------------------------------
  // Civil damages cap reference — Texas Property Code allows civil damages
  // up to $200/day. Included in force-mow and lien-eligible enforcement to
  // surface the maximum financial exposure if the homeowner ignores the
  // notice and the Association files suit.
  // -------------------------------------------------------------------------
  tx_force_mow_civil_damages: `The Association reserves the right to pursue any and all further legal remedies, up to and including filing suit to enforce your contractual obligations pursuant to the Declaration. If the Violation is not cured, the Association may also seek injunctive relief and damages, attorney's fees, costs, fines, assessments, and all other amounts allowed by law including, but not limited to, civil damages in an amount up to $200.00 per day for each day a violation continues under the Texas Property Code.`,

  // -------------------------------------------------------------------------
  // Servicemembers Civil Relief Act — federal protection. Goes at the end
  // of every enforcement letter as a standard disclosure.
  // -------------------------------------------------------------------------
  servicemembers_relief_act: `Please be advised that you may have special rights or relief related to this enforcement action under federal law, including the Servicemembers Civil Relief Act (50 U.S.C. app Section 501 et seq.) if the owner is serving on active military duty.`,
};

/**
 * Inject a GLOBAL_RULES block with variable substitution.
 * @param {string} key — Rule key (e.g., 'tx_209_admin_fee_disclosure')
 * @param {Object} [vars] — Variables to substitute (e.g., { admin_fee_amount: '$25.00' })
 * @returns {string} The fully rendered text
 */
function injectGlobalRule(key, vars = {}) {
  const block = GLOBAL_RULES[key];
  if (!block) {
    throw new Error(`GLOBAL_RULES: unknown rule key '${key}'`);
  }
  return Object.entries(vars).reduce(
    (text, [varName, varValue]) => text.replace(new RegExp(`{{${varName}}}`, 'g'), String(varValue)),
    block,
  );
}

module.exports = {
  GLOBAL_RULES,
  GLOBAL_RULES_VERSION,
  GLOBAL_RULES_REVIEWED_AT,
  injectGlobalRule,
};
