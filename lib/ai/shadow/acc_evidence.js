// lib/ai/shadow/acc_evidence.js — assemble the ACC evidence package Miranda (and
// the verifier) should see, as a FROZEN, content-hashed transaction with an
// explicit per-artifact state and a readiness verdict computed BEFORE reasoning.
// PHASE 1 of the evidence-readiness layer (Ed/ChatGPT 2026-09-19; see
// lib/ai/EVIDENCE_READINESS.md). PDFs go through document-understanding (not
// pdf-parse — the form-PDF scar), photos through vision, guidelines through
// retrieval, prior decisions as precedent. Read/extract only — no side effects.
// All deps injectable.
//
// The point of Phase 1: an expected application PDF ends in EXACTLY ONE explicit
// state — PRESENT_READABLE, MISSING, EXTRACTION_FAILED, or NOT_APPLICABLE — and
// never silently disappears while the package is considered READY. A transient
// extraction failure is RETRIED (bounded, deterministic); if it still fails, that
// is a recorded EXTRACTION_FAILED, not a silent drop.
const crypto = require('crypto');
const path = require('path');
const EXTRACT_MODEL = 'claude-sonnet-5'; // strong document/vision handling for transcription
const BUCKET = 'documents';
const MAX_PHOTOS = 3;
const DEFAULT_ATTEMPTS = 3;

// per-artifact state + package readiness
const STATE = { PRESENT_READABLE: 'PRESENT_READABLE', MISSING: 'MISSING', EXTRACTION_FAILED: 'EXTRACTION_FAILED', NOT_APPLICABLE: 'NOT_APPLICABLE' };
const READINESS = { READY: 'READY', INCOMPLETE: 'INCOMPLETE', EXTRACTION_FAILED: 'EXTRACTION_FAILED', CONFLICT: 'CONFLICT' };

function _mediaType(p) {
  const e = path.extname(String(p || '')).toLowerCase();
  if (e === '.png') return 'image/png';
  if (e === '.webp') return 'image/webp';
  if (e === '.gif') return 'image/gif';
  return 'image/jpeg';
}

async function _download(supabase, p) {
  const { data, error } = await supabase.storage.from(BUCKET).download(p);
  if (error || !data) throw new Error(error ? error.message : 'no data');
  return Buffer.from(await data.arrayBuffer());
}

async function _transcribePdf(anthropic, buf) {
  const r = await anthropic.messages.create({
    model: EXTRACT_MODEL, max_tokens: 1500,
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } },
      { type: 'text', text: 'Transcribe the ACC-relevant facts from this application as concise text: project/structure type, every dimension and measurement, materials, colors, setbacks/placement, and any stated conditions. Do not judge compliance; just extract the facts.' },
    ] }],
  });
  return (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

async function _describeImage(anthropic, buf, media_type) {
  const r = await anthropic.messages.create({
    model: EXTRACT_MODEL, max_tokens: 500,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type, data: buf.toString('base64') } },
      { type: 'text', text: 'Describe the ACC-relevant details visible: structure/material/color, existing conditions, and placement. Facts only.' },
    ] }],
  });
  return (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

// Bounded, deterministic retry. `fn` must THROW on a failure that warrants a
// retry — including an empty extraction (a PDF that "loaded" but transcribed to
// nothing is a failed extraction, not readable content). Returns the attempt
// count and the final outcome, so a failure is always an explicit recorded state.
async function _withRetry(fn, attempts) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const value = await fn();
      if (value == null || String(value).trim() === '') throw new Error('empty extraction');
      return { ok: true, value, attempts: i };
    } catch (e) { lastErr = e; }
  }
  return { ok: false, error: (lastErr && lastErr.message) || 'extraction failed', attempts };
}

// Extract one document/image artifact with retry -> a manifest entry with an
// explicit STATE. No source path => NOT_APPLICABLE (nothing was expected here).
async function _extractArtifact({ source, required, type, sourcePath, method, model, run, attempts }) {
  if (!sourcePath) return { entry: { source, required, type, state: STATE.NOT_APPLICABLE, source_path: null, method, attempts: 0 }, content: '' };
  const r = await _withRetry(run, attempts);
  if (r.ok) return { entry: { source, required, type, state: STATE.PRESENT_READABLE, source_path: sourcePath, method, model, attempts: r.attempts, chars: String(r.value).length }, content: r.value };
  return { entry: { source, required, type, state: STATE.EXTRACTION_FAILED, source_path: sourcePath, method, model, attempts: r.attempts, error: r.error }, content: '' };
}

function _readiness(manifest) {
  const req = manifest.filter((m) => m.required);
  // A required artifact whose source exists but could not be read after retries
  // is a SYSTEM failure — it must not silently proceed on other material.
  if (req.some((m) => m.state === STATE.EXTRACTION_FAILED)) return READINESS.EXTRACTION_FAILED;
  // A required artifact that was never provided is INCOMPLETE (ask for it).
  if (req.some((m) => m.state === STATE.MISSING)) return READINESS.INCOMPLETE;
  return READINESS.READY;
}

// Assemble the frozen, content-hashed evidence package. deps: { supabase,
// getRelevantChunks, anthropic }. opts: { attempts }.
async function assembleEvidencePackage(accRow, deps, opts) {
  const { supabase, getRelevantChunks, anthropic } = deps;
  const attempts = (opts && opts.attempts) || DEFAULT_ATTEMPTS;
  const manifest = [];
  const parts = [`Community: ${accRow.community_name}`, `Property: ${accRow.homeowner_address || '(address n/a)'}`];

  // 1) project summary (native text) — supplemental application evidence
  const summary = accRow.project_summary || '';
  const summaryReadable = summary.trim().length >= 40;
  manifest.push({ source: 'project_summary', required: false, type: 'text', state: summaryReadable ? STATE.PRESENT_READABLE : (summary ? STATE.PRESENT_READABLE : STATE.NOT_APPLICABLE), method: 'native', attempts: 0, chars: summary.length });
  if (summary) parts.push(`\nAPPLICATION SUMMARY:\n${summary}`);

  // 2) application PDF (REQUIRED artifact when a path exists) + packet PDF (supplemental)
  for (const [label, p, required] of [['application', accRow.application_pdf_storage_path, true], ['packet', accRow.packet_pdf_storage_path, false]]) {
    const { entry, content } = await _extractArtifact({
      source: label + '_pdf', required, type: 'pdf', sourcePath: p, method: 'document_understanding', model: EXTRACT_MODEL, attempts,
      run: async () => _transcribePdf(anthropic, await _download(supabase, p)),
    });
    manifest.push(entry);
    if (content) parts.push(`\n${label.toUpperCase()} DOCUMENT (transcribed):\n${content}`);
  }

  // 3) photos (vision) — supplemental
  const photos = (accRow.photo_storage_paths || []).slice(0, MAX_PHOTOS);
  for (const p of photos) {
    const { entry, content } = await _extractArtifact({
      source: 'photo', required: false, type: 'image', sourcePath: p, method: 'vision', model: EXTRACT_MODEL, attempts,
      run: async () => _describeImage(anthropic, await _download(supabase, p), _mediaType(p)),
    });
    manifest.push(entry);
    if (content) parts.push(`\nPHOTO (${path.basename(p)}):\n${content}`);
  }

  // 4) governing documents (retrieval) — REQUIRED. Retrieval THROW => system
  //    failure (EXTRACTION_FAILED); empty result => MISSING (nothing to reason on).
  let guidelines = '';
  const gq = 'architectural guidelines fence height setback shed accessory structure paint approved color palette solar pergola';
  const gRes = await _withRetry(async () => {
    const g = String((await getRelevantChunks(gq, accRow.community_name)) || '');
    if (!g) return '__EMPTY__'; // distinguish "ran, nothing found" from "threw"
    return g;
  }, attempts);
  if (gRes.ok && gRes.value !== '__EMPTY__') { guidelines = gRes.value; manifest.push({ source: 'governing_docs', required: true, type: 'retrieval', state: STATE.PRESENT_READABLE, method: 'hybrid_retrieval', attempts: gRes.attempts, chars: guidelines.length }); parts.push(`\nCOMMUNITY ARCHITECTURAL GUIDELINES (retrieved):\n${guidelines}`); }
  else if (gRes.ok) { manifest.push({ source: 'governing_docs', required: true, type: 'retrieval', state: STATE.MISSING, method: 'hybrid_retrieval', attempts: gRes.attempts }); }
  else { manifest.push({ source: 'governing_docs', required: true, type: 'retrieval', state: STATE.EXTRACTION_FAILED, method: 'hybrid_retrieval', attempts: gRes.attempts, error: gRes.error }); }

  // 5) community precedent (prior decisions) — supplemental
  try {
    const { data: prior, error: pe } = await supabase.from('acc_decisions')
      .select('homeowner_address, project_summary, decision_type, created_at')
      .eq('community_name', accRow.community_name).neq('id', accRow.id)
      .order('created_at', { ascending: false }).limit(6);
    if (pe) throw new Error(pe.message);
    const rows = (prior || []).filter((r) => r.decision_type);
    manifest.push({ source: 'community_precedent', required: false, type: 'db', state: rows.length ? STATE.PRESENT_READABLE : STATE.NOT_APPLICABLE, attempts: 1, count: rows.length });
    if (rows.length) parts.push('\nCOMMUNITY PRECEDENT (prior decisions, this community):\n' + rows.map((r) => `- ${r.decision_type}: ${(r.project_summary || '').slice(0, 90)}`).join('\n'));
  } catch (e) { manifest.push({ source: 'community_precedent', required: false, type: 'db', state: STATE.EXTRACTION_FAILED, attempts: 1, error: e.message }); }

  // application evidence must exist SOMEWHERE for the package to be usable: a
  // readable application PDF or a substantive summary. If neither, INCOMPLETE.
  const appPdf = manifest.find((m) => m.source === 'application_pdf');
  const hasAppEvidence = (appPdf && appPdf.state === STATE.PRESENT_READABLE) || summaryReadable;
  let readiness = _readiness(manifest);
  if (readiness === READINESS.READY && !hasAppEvidence) readiness = READINESS.INCOMPLETE;

  const bundle_text = parts.join('\n');
  const stateFingerprint = manifest.map((m) => `${m.source}:${m.state}`).sort().join('|');
  const content_hash = crypto.createHash('sha256').update(bundle_text + '\n##STATES##\n' + stateFingerprint).digest('hex');

  const pkg = {
    package_id: crypto.randomUUID(),
    version: 1,
    acc_decision_id: accRow.id || null,
    community: accRow.community_name || null,
    assembled_at: new Date().toISOString(),
    bundle_text,
    manifest: manifest.map((m) => Object.freeze(m)),
    conflicts: [], // populated by Phase 2 conflict detection
    readiness,
    content_hash,
  };
  Object.freeze(pkg.manifest);
  return Object.freeze(pkg);
}

// Back-compat adapter: existing callers (shadow runner, diagnostics) still get
// { bundle_text, manifest, input_complete }. input_complete now means the package
// reached READY (stricter + correct — a failed required artifact is no longer a
// silent pass). The full package is attached as `package` for the gate.
async function gatherEvidence(accRow, deps, opts) {
  const pkg = await assembleEvidencePackage(accRow, deps, opts);
  return { bundle_text: pkg.bundle_text, manifest: pkg.manifest, input_complete: pkg.readiness === READINESS.READY, package: pkg };
}

module.exports = { assembleEvidencePackage, gatherEvidence, STATE, READINESS, EXTRACT_MODEL, BUCKET };
