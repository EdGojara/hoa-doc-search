// ============================================================================
// lib/enforcement/source_weights.js — single source of truth for the
// confidence_weight defaults that the escalation engine uses.
// ----------------------------------------------------------------------------
// Ed 2026-06-13: codified after the Vantaca-import weight bug. The 0.5
// default lived in two separate places in api/enforcement.js (manual entry
// path + bulk apply path), so when the "Vantaca is full-trust Bedrock data"
// realization landed, every place needed to be updated by hand. That class
// of bug is structurally eliminated when there's exactly ONE function that
// answers "what weight does a source default to?"
//
// **EVERY violations-row insert from an import context MUST use this
// helper to set confidence_weight.** Bypassing it = the bug recurs the
// next time someone adds a new import path. If you're adding a new
// path that inserts into violations and you write a literal number for
// confidence_weight, you're doing it wrong — use this helper.
//
// What "source" means:
//   - trustEd_native: created by the trustEd inspection + drafting pipeline
//   - vantaca_import: imported from Vantaca exports. For Bedrock these
//                     are FULL-TRUST because Bedrock did the inspections
//                     itself while using Vantaca. Weight = 1.0.
//   - manual_entry:   operator-typed historical violations. Slightly
//                     discounted because it's recall-based.
//   - predecessor_import: imported from a DIFFERENT management firm's
//                     system (took-over communities). Lower trust because
//                     we didn't do the inspections. Weight = 0.3.
//   - legacy_unknown: catch-all for sources without clear provenance.
//
// Per-row operator override is still allowed via the PATCH endpoint —
// this helper only sets DEFAULTS at insert time.
// ============================================================================

const SOURCE_WEIGHTS = Object.freeze({
  trustEd_native:      1.0,
  vantaca_import:      1.0,  // Bedrock-own inspection data (Ed 2026-06-13)
  manual_entry:        0.8,
  legacy_unknown:      0.4,
  predecessor_import:  0.3,
});

/**
 * Return the default confidence_weight for a given source value.
 * Unknown sources fall back to 0.8 (mid-trust) so a typo or new source
 * never silently lands a zero-weight prior that hides chronic offenders.
 *
 * @param {string} source — one of the SOURCE_WEIGHTS keys
 * @returns {number} weight in [0, 1]
 */
function defaultWeightForSource(source) {
  if (typeof source === 'string' && Object.prototype.hasOwnProperty.call(SOURCE_WEIGHTS, source)) {
    return SOURCE_WEIGHTS[source];
  }
  // Unknown source — log so we notice if a typo is silently happening at
  // scale, but return a sane mid-trust default.
  console.warn('[source_weights] unknown source provided, defaulting to 0.8:', source);
  return 0.8;
}

/**
 * The full lookup table — exported so endpoints can iterate, documentation
 * can be auto-generated, and tests can assert the values are what we expect.
 */
function sourceWeightsTable() {
  return { ...SOURCE_WEIGHTS };
}

module.exports = {
  defaultWeightForSource,
  sourceWeightsTable,
};
