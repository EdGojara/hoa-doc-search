// lib/ai/shadow/acc_evidence.js — assemble the FULL ACC evidence package Miranda
// should see (parity with the human reviewer), plus a manifest recording exactly
// what she got. PDFs go through document-understanding (not pdf-parse — the
// form-PDF scar), photos through vision, guidelines through retrieval, and prior
// community decisions as precedent. Produces { bundle_text, manifest,
// input_complete }. Read/extract only — no side effects. All deps injectable.
const path = require('path');
const EXTRACT_MODEL = 'claude-sonnet-5'; // strong document/vision handling for transcription
const BUCKET = 'documents';
const MAX_PHOTOS = 3;

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
  const buf = Buffer.from(await data.arrayBuffer());
  return buf;
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

// accRow: { id, community_id, community_name, homeowner_address, project_summary,
//           application_pdf_storage_path, packet_pdf_storage_path, photo_storage_paths }
// deps: { supabase, getRelevantChunks, anthropic }
async function gatherEvidence(accRow, deps) {
  const { supabase, getRelevantChunks, anthropic } = deps;
  const manifest = [];
  const parts = [`Community: ${accRow.community_name}`, `Property: ${accRow.homeowner_address || '(address n/a)'}`];

  // 1) project summary (native text)
  const summary = accRow.project_summary || '';
  manifest.push({ source: 'project_summary', type: 'text', method: 'native', ok: !!summary, chars: summary.length });
  if (summary) parts.push(`\nAPPLICATION SUMMARY:\n${summary}`);

  // 2) application + packet PDFs (document understanding)
  let pdfRead = false;
  for (const [label, p] of [['application', accRow.application_pdf_storage_path], ['packet', accRow.packet_pdf_storage_path]]) {
    if (!p) continue;
    try {
      const buf = await _download(supabase, p);
      const text = await _transcribePdf(anthropic, buf);
      manifest.push({ source: label + '_pdf', type: 'pdf', path: p, method: 'document_understanding', model: EXTRACT_MODEL, ok: !!text, chars: text.length });
      if (text) { parts.push(`\n${label.toUpperCase()} DOCUMENT (transcribed):\n${text}`); pdfRead = true; }
    } catch (e) {
      manifest.push({ source: label + '_pdf', type: 'pdf', path: p, method: 'document_understanding', ok: false, error: e.message });
    }
  }

  // 3) photos (vision)
  const photos = (accRow.photo_storage_paths || []).slice(0, MAX_PHOTOS);
  for (const p of photos) {
    try {
      const buf = await _download(supabase, p);
      const desc = await _describeImage(anthropic, buf, _mediaType(p));
      manifest.push({ source: 'photo', type: 'image', path: p, method: 'vision', model: EXTRACT_MODEL, ok: !!desc, chars: desc.length });
      if (desc) parts.push(`\nPHOTO (${path.basename(p)}):\n${desc}`);
    } catch (e) {
      manifest.push({ source: 'photo', type: 'image', path: p, method: 'vision', ok: false, error: e.message });
    }
  }

  // 4) governing documents (retrieval)
  let guidelines = '';
  try {
    guidelines = String(await getRelevantChunks('architectural guidelines fence height setback shed accessory structure paint approved color palette solar pergola', accRow.community_name) || '');
  } catch (e) { manifest.push({ source: 'governing_docs', type: 'retrieval', ok: false, error: e.message }); }
  if (guidelines) { manifest.push({ source: 'governing_docs', type: 'retrieval', method: 'hybrid_retrieval', ok: true, chars: guidelines.length }); parts.push(`\nCOMMUNITY ARCHITECTURAL GUIDELINES (retrieved):\n${guidelines}`); }

  // 5) community precedent (prior decisions, same community)
  try {
    const { data: prior } = await supabase.from('acc_decisions')
      .select('homeowner_address, project_summary, decision_type, created_at')
      .eq('community_name', accRow.community_name).neq('id', accRow.id)
      .order('created_at', { ascending: false }).limit(6);
    const rows = (prior || []).filter((r) => r.decision_type);
    manifest.push({ source: 'community_precedent', type: 'db', ok: rows.length > 0, count: rows.length });
    if (rows.length) parts.push('\nCOMMUNITY PRECEDENT (prior decisions, this community):\n' + rows.map((r) => `- ${r.decision_type}: ${(r.project_summary || '').slice(0, 90)}`).join('\n'));
  } catch (e) { manifest.push({ source: 'community_precedent', type: 'db', ok: false, error: e.message }); }

  // sufficient if we have application evidence (a read PDF or a real summary) AND guidelines
  const input_complete = (pdfRead || summary.length >= 40) && guidelines.length > 0;
  return { bundle_text: parts.join('\n'), manifest, input_complete };
}

module.exports = { gatherEvidence, EXTRACT_MODEL, BUCKET };
