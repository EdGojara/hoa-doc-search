// ============================================================================
// lib/acc/staleness.js  (Issue #14, Ed 2026-10-02)
// ----------------------------------------------------------------------------
// Is the letter about to be sent drafted from the case's CURRENT evidence?
//
// Scar (WAT-ARC-2026-0025): Annie produced a newer current review, but an older
// saved working letter stayed in the letter box, ahead of the new draft. Sending
// must not depend on someone remembering to redraft.
//
// basisReviewAt = the review the letter in the box was drafted from:
//   - a saved working draft  -> acc_decisions.letter_draft_review_at
//   - the current review's draft -> current_review_at
//   - the original intake draft  -> created_at
// The letter is STALE when:
//   - a newer review exists than the one it was drafted from;
//   - its basis is unknown (a saved draft from before provenance was tracked)
//     while a current review exists;
//   - documents arrived after the latest review (the review itself is stale).
// A stale letter blocks a FINAL send until it is redrafted or a person
// explicitly acknowledges they reviewed it. A staff-edited draft is never
// replaced automatically: staff may have edited the wording on purpose.
// ============================================================================
const t = (x) => (x ? Date.parse(x) : NaN);
const SLACK_MS = 1000;

function draftStaleness(dec, { basisReviewAt } = {}) {
  const reviewAt = dec.current_review_at || dec.created_at || null;
  const reasons = [];
  if (dec.last_document_added_at && reviewAt && t(dec.last_document_added_at) > t(reviewAt) + SLACK_MS) reasons.push('new_documents_since_review');
  if (basisReviewAt == null || basisReviewAt === '') {
    if (dec.current_review_at) reasons.push('draft_basis_unknown');
  } else if (reviewAt && t(basisReviewAt) + SLACK_MS < t(reviewAt)) {
    reasons.push('newer_review');
  }
  return { stale: reasons.length > 0, reasons, review_at: reviewAt, evidence_at: dec.last_document_added_at || null };
}

const MESSAGES = {
  newer_review: 'A newer review is available. Redraft or explicitly review the current letter before sending.',
  draft_basis_unknown: 'This saved letter was drafted before the current review. Redraft or explicitly review the current letter before sending.',
  new_documents_since_review: 'New documents arrived after the latest review. Re-review, then redraft or explicitly review the current letter before sending.',
};

module.exports = { draftStaleness, MESSAGES };
