// ============================================================================
// lib/vendors/line_item_versions.js  (Ed 2026-10-16: reuse, no re-extraction;
// versioned, auditable reprocessing)
// ----------------------------------------------------------------------------
// A proposal's line items are extracted ONCE and stored on the proposal record
// (vendor_proposals.extracted_data). Ordinary reruns read the stored, APPROVED
// version. Re-extraction happens only when:
//   - nothing is stored yet,
//   - the source file's hash changed, or
//   - someone explicitly asks (reprocess, recorded with who asked and why).
//
// Reprocessing appends a NEW version and never overwrites or deletes an earlier one:
//   extracted_data.line_item_versions = [
//     { version, extracted_at, document_sha256, workflow, model, reason, requested_by,
//       status: 'approved' | 'pending_review' | 'superseded', items: [...comparison items],
//       totals: { cameras_new, cameras_reused, cameras_total, licenses, items_cents },
//       differs_from_approved: [{ field, approved, new }] }
//   ]
//   extracted_data.approved_line_item_version = <n>
//   extracted_data.comparison_items            = the approved version's items (read path)
//
// The first stored version is the approved one. A later version is ALWAYS
// pending_review; when its counts or totals differ from the approved version it carries
// the differences for a human to review. It is never swapped in silently: only
// approveVersion() (a human action) moves the approved pointer, and the prior version
// stays readable, marked superseded.
// Pure (no I/O): callers read the row, call these, and write extracted_data back.
// ============================================================================
const { computeQuantities } = require('./line_items');

const WORKFLOW = 'vendors.proposal_normalize';

/** The versions on a record, including a legacy unversioned extraction as version 1. */
function versionsOf(ed) {
  const e = ed || {};
  if (Array.isArray(e.line_item_versions) && e.line_item_versions.length) return e.line_item_versions;
  const legacy = Array.isArray(e.comparison_items) && e.comparison_items.some((i) => Array.isArray(i.line_items));
  return legacy ? [{ version: 1, extracted_at: e.line_items_extracted_at || null, document_sha256: e.line_items_sha256 || null, workflow: WORKFLOW, model: null, reason: 'initial extraction (unversioned)', requested_by: null, status: 'approved', items: e.comparison_items, totals: totalsOf(e.comparison_items) }] : [];
}

/** The approved version (what the workflow reads), or null. */
function currentApproved(ed) {
  const vs = versionsOf(ed);
  const n = (ed && ed.approved_line_item_version) || (vs.find((v) => v.status === 'approved') || {}).version;
  return vs.find((v) => v.version === n) || null;
}

/** Totals for a version: summed over its items, computed in code from the line items. */
function totalsOf(items) {
  const t = { cameras_new: 0, cameras_reused: 0, cameras_total: 0, licenses: 0, items_cents: 0 };
  for (const it of items || []) {
    const q = computeQuantities({ ...it, line_items_stored: true });
    for (const k of ['cameras_new', 'cameras_reused', 'cameras_total', 'licenses']) t[k] += Number(q.values[k] || 0);
    t.items_cents += q.subtotal ? q.subtotal.items_cents : 0;
  }
  return t;
}

/**
 * Should this document be extracted now? Never on an ordinary rerun of a stored document.
 *   { extract: boolean, reason: 'not_stored' | 'hash_changed' | 'reprocess_requested' | null }
 */
function needsExtraction(ed, fileSha256, { reprocess = null } = {}) {
  const approved = currentApproved(ed);
  if (reprocess) {
    if (!reprocess.requested_by || !reprocess.reason) throw new Error('reprocess requires requested_by and reason');
    return { extract: true, reason: 'reprocess_requested' };
  }
  if (!approved) return { extract: true, reason: 'not_stored' };
  if (approved.document_sha256 && fileSha256 && approved.document_sha256 !== fileSha256) return { extract: true, reason: 'hash_changed' };
  return { extract: false, reason: null };
}

/**
 * Append a new version. Returns the NEW extracted_data (inputs are not mutated).
 * First version: approved. Later versions: pending_review, with any differences from the
 * approved totals listed. Earlier versions are kept as they were.
 */
function addVersion(ed, { items, document_sha256, model = null, reason, requested_by = null, at = new Date().toISOString(), workflow = WORKFLOW }) {
  if (!reason) throw new Error('a version needs a reason');
  const base = { ...(ed || {}) };
  const vs = versionsOf(base).map((v) => ({ ...v }));
  const approved = vs.find((v) => v.version === base.approved_line_item_version) || vs.find((v) => v.status === 'approved') || null;
  const totals = totalsOf(items);
  const version = { version: (vs.length ? Math.max(...vs.map((v) => v.version)) : 0) + 1, extracted_at: at, document_sha256: document_sha256 || null, workflow, model, reason, requested_by, items, totals };
  if (!approved) {
    version.status = 'approved';
    base.approved_line_item_version = version.version;
    base.comparison_items = items;
    base.line_items_sha256 = document_sha256 || null;
  } else {
    version.status = 'pending_review';
    version.differs_from_approved = Object.keys(totals).filter((k) => totals[k] !== approved.totals[k]).map((k) => ({ field: k, approved: approved.totals[k], new: totals[k] }));
    if (approved.document_sha256 && document_sha256 && approved.document_sha256 !== document_sha256) version.differs_from_approved.unshift({ field: 'document_sha256', approved: approved.document_sha256, new: document_sha256 });
    version.review_flag = version.differs_from_approved.length ? 'differs from the approved version: review before approving' : null;
  }
  base.line_item_versions = [...vs, version];
  return base;
}

/** A human approves a reviewed version. The prior approved version is kept, marked superseded. */
function approveVersion(ed, versionNumber, { approved_by, at = new Date().toISOString() } = {}) {
  if (!approved_by) throw new Error('approval needs approved_by');
  const base = { ...(ed || {}) };
  const vs = versionsOf(base).map((v) => ({ ...v }));
  const target = vs.find((v) => v.version === versionNumber);
  if (!target) throw new Error(`no version ${versionNumber}`);
  for (const v of vs) if (v.status === 'approved' && v.version !== versionNumber) v.status = 'superseded';
  Object.assign(target, { status: 'approved', approved_by, approved_at: at });
  return { ...base, line_item_versions: vs, approved_line_item_version: versionNumber, comparison_items: target.items, line_items_sha256: target.document_sha256 };
}

module.exports = { WORKFLOW, versionsOf, currentApproved, totalsOf, needsExtraction, addVersion, approveVersion };
