// ============================================================================
// lib/acc/documents.js  (Issue #14, Ed 2026-10-02)
// ----------------------------------------------------------------------------
// ACC cases are reviewed against the documents ACTUALLY on the case.
//
// Scar (WAT-ARC-2026-0025, 6019 Sweetspire Ridge): the homeowner emailed her
// application AND "Survey of 6019 Sweetspire Ridge_circled.pdf". Graph returned
// both and both were stored, but:
//   1. intake tagged EVERY pdf as the application form, and the engine reads
//      only the first one, so the survey never reached the model and the
//      analysis said "Survey ... Not submitted";
//   2. the survey was archived as "photo_2.pdf", so its name was gone;
//   3. storage upload errors were never checked (upload() returns {error}, it
//      does not throw), and fetch failures were skipped, so a dropped file
//      could never be seen.
//
// This module is the one place that:
//   - tags files for the engine (first PDF = the form; every other file is a
//     supporting document the engine reads as a document or image);
//   - archives files with their ORIGINAL names and checks every upload;
//   - records each document in document_manifest and each failure in
//     document_intake_errors (migration 479; tolerant before it);
//   - re-runs the review against the CURRENT document set and stores it as the
//     case's current review, leaving the original intake analysis untouched.
// Nothing here decides, approves, changes status or sends anything.
// ============================================================================

const isMissingColumn = (err) => !!err && /column .* does not exist|could not find the .* column|schema cache/i.test(err.message || '');
const isPdfFile = (f) => /pdf/i.test(f.mimetype || f.contentType || '') || /\.pdf$/i.test(f.originalname || f.filename || '');
const safeName = (n) => String(n || 'document').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').slice(0, 90);

// Graph attachments -> engine files. Only the FIRST pdf is the application form
// ('pdf'); every other file goes to 'images', where the engine reads PDFs as
// document blocks and images as images. Original names ride along.
function tagFilesForEngine(atts) {
  let formTaken = false;
  return (atts || []).map((a) => {
    const pdf = a.isPdf === true || isPdfFile(a);
    const asForm = pdf && !formTaken;
    if (asForm) formTaken = true;
    return { fieldname: asForm ? 'pdf' : 'images', buffer: a.buffer, mimetype: a.contentType || a.mimetype, originalname: a.filename || a.originalname };
  });
}

// Archive engine files under a case. Every upload's {error} is checked; a
// failure becomes an intake error (never a path to a file that doesn't exist).
// newCase: the first 'pdf' becomes application.pdf (unchanged path).
async function archiveCaseFiles(supabase, { decisionId, files, sourceRef = null, newCase = false, now = () => new Date().toISOString() }) {
  const stamp = Date.now();
  const res = { applicationPath: null, supporting: [], photos: [], manifest: [], errors: [] };
  for (let i = 0; i < (files || []).length; i++) {
    const f = files[i];
    const pdf = isPdfFile(f);
    let path, kind;
    if (newCase && f.fieldname === 'pdf' && !res.applicationPath) { path = `acc_decisions/${decisionId}/application.pdf`; kind = 'application'; }
    else if (pdf) { path = `acc_decisions/${decisionId}/doc_${stamp}_${i}_${safeName(f.originalname)}`.replace(/(\.pdf)?$/i, '.pdf'); kind = 'supporting'; }
    else { const ext = /png/i.test(f.mimetype || '') ? 'png' : 'jpg'; path = `acc_decisions/${decisionId}/photo_${stamp}_${i}.${ext}`; kind = 'photo'; }
    let error = null;
    try {
      const up = await supabase.storage.from('documents').upload(path, f.buffer, { contentType: pdf ? 'application/pdf' : (f.mimetype || 'image/jpeg'), upsert: true });
      if (up && up.error) error = up.error.message || String(up.error);
    } catch (e) { error = e.message; }
    if (error) { res.errors.push({ filename: f.originalname || null, source_ref: sourceRef, stage: 'store', error, at: now() }); continue; }
    if (kind === 'application') res.applicationPath = path; else if (kind === 'supporting') res.supporting.push(path); else res.photos.push(path);
    res.manifest.push({ path, filename: f.originalname || null, kind, mime: f.mimetype || null, source_ref: sourceRef, received_at: now() });
  }
  return res;
}

// Append manifest entries / intake errors (migration 479). Before 479 the
// columns don't exist: the documents are still stored and linked by path, and
// the errors are logged loudly so they are not silent.
async function recordCaseDocuments(supabase, decisionId, { manifest = [], errors = [] }) {
  if (!manifest.length && !errors.length) return { recorded: true };
  const cur = await supabase.from('acc_decisions').select('document_manifest, document_intake_errors').eq('id', decisionId).maybeSingle();
  if (cur.error && isMissingColumn(cur.error)) {
    for (const e of errors) console.error(`[acc_documents] case ${decisionId}: "${e.filename}" NOT stored (${e.stage}): ${e.error}`);
    return { recorded: false, reason: 'migration_479_not_applied' };
  }
  if (cur.error) throw new Error(`document record read failed: ${cur.error.message}`);
  const m = Array.isArray(cur.data && cur.data.document_manifest) ? cur.data.document_manifest : [];
  const e = Array.isArray(cur.data && cur.data.document_intake_errors) ? cur.data.document_intake_errors : [];
  const seen = new Set(m.map((x) => x.path));
  const up = await supabase.from('acc_decisions').update({
    document_manifest: m.concat(manifest.filter((x) => !seen.has(x.path))),
    document_intake_errors: e.concat(errors),
  }).eq('id', decisionId);
  if (up.error) throw new Error(`document record write failed: ${up.error.message}`);
  for (const x of errors) console.error(`[acc_documents] case ${decisionId}: "${x.filename}" NOT stored (${x.stage}): ${x.error}`);
  return { recorded: true };
}

// Every document on a case, with the best name we have: the manifest name, else
// the stored path's basename. Legacy cases (before the manifest) are covered by
// their stored paths.
function caseDocuments(dec) {
  const byPath = new Map((Array.isArray(dec.document_manifest) ? dec.document_manifest : []).map((m) => [m.path, m]));
  const out = [];
  const add = (path, kind) => { if (!path) return; const m = byPath.get(path); out.push({ path, kind: (m && m.kind) || kind, filename: (m && m.filename) || path.split('/').pop() }); };
  add(dec.application_pdf_storage_path, 'application');
  for (const p of dec.supporting_docs_storage_paths || []) add(p, 'supporting');
  for (const p of dec.photo_storage_paths || []) add(p, isPdfFile({ originalname: p }) ? 'supporting' : 'photo');
  return out;
}

// Re-run the review against the CURRENT documents. Writes ONLY current_review_*
// (never status, decision, or the original ai_* analysis). deps: { runEngine,
// classifyRecommendation, download(path) -> Buffer }.
async function reassessAccCase(supabase, decisionId, { runEngine, classifyRecommendation, download, trigger = 'staff', now = () => new Date().toISOString() }) {
  const { data: dec, error } = await supabase.from('acc_decisions').select('*').eq('id', decisionId).maybeSingle();
  if (error) throw new Error(`case read failed: ${error.message}`);
  if (!dec) return { status: 'not_found' };
  // A finalized / closed case is never re-reviewed: its record is history (Issue #14).
  if (!['pending_review', 'awaiting_info'].includes(dec.status)) return { status: 'not_open', case_status: dec.status };
  if (!('current_review_text' in dec)) return { status: 'unavailable', reason: 'migration_479_not_applied' };

  const docs = caseDocuments(dec);
  const files = []; const unreadable = [];
  for (const d of docs) {
    try {
      const buf = await download(d.path);
      if (!buf || !buf.length) throw new Error('empty file');
      files.push({ fieldname: d.kind === 'application' ? 'pdf' : 'images', buffer: buf, mimetype: isPdfFile({ originalname: d.path }) ? 'application/pdf' : (/\.png$/i.test(d.path) ? 'image/png' : 'image/jpeg'), originalname: d.filename });
    } catch (e) { unreadable.push({ filename: d.filename, path: d.path, error: e.message }); }
  }
  if (!files.length) return { status: 'no_documents', unreadable };
  // The form must be the 'pdf' slot if there is one; otherwise the first PDF.
  if (!files.some((f) => f.fieldname === 'pdf')) { const p = files.find((f) => /pdf/.test(f.mimetype)); if (p) p.fieldname = 'pdf'; }

  const out = await runEngine({ community: dec.community_name, files, isAdmin: true });
  const reviewText = String(out.review || '').replace(/^\*\*\*[^\n]*\n+/, '').replace(/\n+\*\*\* END[^\n]*$/, '').trim();
  const rec = await classifyRecommendation(reviewText, out.letter_body);
  const basis = { trigger, at: now(), documents: docs.filter((d) => !unreadable.some((u) => u.path === d.path)).map((d) => ({ filename: d.filename, kind: d.kind })), unreadable,
    // conditions the deterministic checks removed from the generated letter (Issue #14)
    removed_conditions: Array.isArray(out.letter_pruned) ? out.letter_pruned : [] };
  const up = await supabase.from('acc_decisions').update({
    current_review_text: reviewText || null, current_ai_recommendation: rec || null, current_letter_body: out.letter_body || null,
    current_review_at: basis.at, current_review_basis: basis,
  }).eq('id', decisionId);
  if (up.error) throw new Error(`current review write failed: ${up.error.message}`);
  return { status: 'reviewed', recommendation: rec, documents: basis.documents.length, unreadable };
}

module.exports = { tagFilesForEngine, archiveCaseFiles, recordCaseDocuments, caseDocuments, reassessAccCase, isPdfFile, safeName };
