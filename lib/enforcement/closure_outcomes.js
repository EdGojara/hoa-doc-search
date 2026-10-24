// ============================================================================
// lib/enforcement/closure_outcomes.js  (Ed 2026-10-24, migration 545)
// ----------------------------------------------------------------------------
// How a violation was closed, and what that means for repeat-offense counting.
// The values must match the violations_closure_outcome_check CHECK in migration
// 545; the resolved_via mapping must match violations_closure_coherent.
//
// current_stage is NOT changed by this: a closed case still reads 'cured' (many
// readers depend on it). resolved_via keeps a compatible legacy value.
//
// Recurrence (detectRecurrence):
//   counted   cured_verified, cured_reported  -> may be a prior offense (still only
//             flagged for a person; nothing escalates automatically)
//   excluded  voided_error, duplicate, administrative, expired_unverified -> never
//   legacy    NULL outcome on a closed case (every case closed before 545) ->
//             never counted automatically; surfaces "prior history needs
//             verification" for a person to confirm or dismiss
// ============================================================================

const CLOSURE_OUTCOMES = {
  cured_verified:     { label: 'Cured, verified (photo or inspection on file)', resolved_via: 'cured' },
  cured_reported:     { label: 'Cured, reported by owner (not yet verified)',  resolved_via: 'cured' },
  voided_error:       { label: 'Voided, opened in error',                      resolved_via: 'voided' },
  duplicate:          { label: 'Duplicate of another case on this property',   resolved_via: 'voided' },
  administrative:     { label: 'Administrative closure',                        resolved_via: 'withdrawn' },
  expired_unverified: { label: 'Expired, cure not verified',                    resolved_via: 'withdrawn' },
};
const OUTCOME_KEYS = Object.keys(CLOSURE_OUTCOMES);
const COUNTED_OUTCOMES = ['cured_verified', 'cured_reported'];
const NOT_COUNTED_OUTCOMES = ['voided_error', 'duplicate', 'administrative', 'expired_unverified'];
// What can prove a verified cure: a photo or document on the account, a photo the
// homeowner emailed in, or an inspection photo. Each must belong to the same property.
const EVIDENCE_TYPES = ['account_attachment', 'email_attachment', 'inspection_photo'];

function resolvedViaFor(outcome) {
  const o = CLOSURE_OUTCOMES[outcome];
  return o ? o.resolved_via : null;
}

// Pure validation of a closure request (no database). Returns { ok: true, ... }
// or { ok: false, status, error, detail } with a plain-English detail.
function validateClosureRequest(body) {
  const b = body || {};
  const outcome = b.closure_outcome == null ? '' : String(b.closure_outcome).trim();
  const reasonRaw = b.reason != null ? b.reason : b.note;
  const reason = (reasonRaw == null ? '' : String(reasonRaw)).slice(0, 1000).trim();
  if (!reason) return { ok: false, status: 400, error: 'reason_required', detail: 'Pick or type the reason this case is being closed.' };
  if (!outcome) return { ok: false, status: 400, error: 'outcome_required', detail: 'Choose how this case is being closed.' };
  if (!CLOSURE_OUTCOMES[outcome]) return { ok: false, status: 400, error: 'invalid_outcome', detail: 'That closure outcome is not one of the allowed choices.' };
  const duplicateOf = b.duplicate_of_violation_id ? String(b.duplicate_of_violation_id).trim() : null;
  if (outcome === 'duplicate' && !duplicateOf) {
    return { ok: false, status: 400, error: 'survivor_required', detail: 'A duplicate must name the case it duplicates (the one that stays open or on record).' };
  }
  let evidence = null;
  if (b.evidence && typeof b.evidence === 'object' && b.evidence.type && b.evidence.id) {
    evidence = { type: String(b.evidence.type), id: String(b.evidence.id) };
  }
  if (outcome === 'cured_verified') {
    if (!evidence) return { ok: false, status: 400, error: 'evidence_required', detail: 'A verified cure needs a photo or inspection on file. Pick it, or choose "Cured, reported by owner".' };
    if (!EVIDENCE_TYPES.includes(evidence.type)) return { ok: false, status: 400, error: 'evidence_invalid', detail: 'That evidence type is not accepted. Use a photo or document on the account, an emailed photo, or an inspection photo.' };
  }
  return {
    ok: true,
    outcome,
    reason,
    resolved_via: resolvedViaFor(outcome),
    duplicate_of_violation_id: outcome === 'duplicate' ? duplicateOf : null,
    evidence: outcome === 'cured_verified' ? evidence : (evidence && EVIDENCE_TYPES.includes(evidence.type) ? evidence : null),
  };
}

// Is this candidate a valid surviving case for a duplicate closure? Pure.
function survivorProblem(closing, survivor) {
  if (!survivor) return 'The case it duplicates was not found.';
  if (survivor.id === closing.id) return 'A case cannot be a duplicate of itself.';
  if (survivor.property_id !== closing.property_id) return 'The case it duplicates must be on the same property.';
  if (['duplicate', 'voided_error'].includes(survivor.closure_outcome)) return 'The case it duplicates was itself closed as a duplicate or in error; pick the case that stands.';
  return null;
}

// Prior-case classification for repeat-offense counting. Pure.
function classifyPrior(prior) {
  const o = prior ? prior.closure_outcome : null;
  if (o == null || o === '') return 'legacy';
  if (COUNTED_OUTCOMES.includes(o)) return 'counted';
  return 'excluded'; // voided_error / duplicate / administrative / expired_unverified (or any unknown value: never count)
}

module.exports = {
  CLOSURE_OUTCOMES, OUTCOME_KEYS, COUNTED_OUTCOMES, NOT_COUNTED_OUTCOMES, EVIDENCE_TYPES,
  resolvedViaFor, validateClosureRequest, survivorProblem, classifyPrior,
};
