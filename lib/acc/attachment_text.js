// ============================================================================
// lib/acc/attachment_text.js  (Ed 2026-10-29)
// ----------------------------------------------------------------------------
// The ACC transport guard (lib/email/graph_send accDecisionGuard) used to read
// only the subject and body. A decision letter attached as a PDF under a
// neutral body ("Please see the attached") went out with no authorized
// decision recorded: the Communications reply lets staff attach any uploaded
// file or filed library document, and the Draft Queue sends stored attachments.
//
// This reads what an attachment SAYS so the same check can run on it:
//   PDF   first PDF_PAGES pages (a decision letter states the outcome on page
//         one; packets start with the letter), via pdfjs-dist
//   DOCX  raw text, via mammoth
//   text  .txt / .html / .eml as UTF-8
// Images and anything else are not readable here.
//
// A readable attachment is judged by its text. An UNREADABLE one (a scan, an
// image, an encrypted PDF) cannot be judged, so the guard refuses it unless the
// case's authorized decision is named, whenever it is named like a decision OR
// the email is about an architectural application. Unreadable files in other
// mail pass, because homeowners are routinely sent photos and scanned records.
// ============================================================================

const PDF_PAGES = 2;
const MAX_CHARS = 20000;

// Names that read as a decision letter. The filed ACC scans in the library are
// named "20018 Cape Clover Trail - Roof - Approved.pdf", "...Gazebo Denial.pdf",
// "5226 Jay Thrush appd remove tree.pdf", "...fence apprvoal with
// stipulations.pdf", so the abbreviations and misspellings count. A blank
// application form ("Architectural Review Application.pdf") does not match.
const DECISION_NAME = /(?:^|[^a-z])(?:decision|appro?v\w*|apprvo\w*|appd|denial|denied|disapprov\w*|stipulations?)(?:[^a-z]|$)/i;
function looksLikeDecisionName(name) {
  const n = String(name || '');
  return /^decision-/i.test(n) || DECISION_NAME.test(n);
}

function kindOf(att) {
  const name = String(att.name || att.filename || '').toLowerCase();
  const type = String(att.contentType || att.mime || '').toLowerCase();
  if (type.includes('pdf') || name.endsWith('.pdf')) return 'pdf';
  if (type.includes('wordprocessingml') || name.endsWith('.docx')) return 'docx';
  if (type.startsWith('text/') || /\.(txt|html?|eml)$/.test(name)) return 'text';
  return 'other';
}

// pdfjs-dist (the current engine, as lib/onboarding/pdf_layout.js uses it), not
// pdf-parse: pdf-parse's bundled 2018 pdf.js read the first PDF in a process
// and then failed on later ones ("Unknown compression method"), and a guard
// that silently cannot read PDFs lets every attached letter through.
let pdfjsPromise = null;
const pdfjs = () => (pdfjsPromise = pdfjsPromise || import('pdfjs-dist/legacy/build/pdf.mjs'));
async function pdfText(buf) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  try {
    const parts = [];
    for (let p = 1; p <= Math.min(doc.numPages, PDF_PAGES); p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      parts.push(content.items.map((it) => it.str || '').join(' '));
    }
    return parts.join('\n');
  } finally { try { await doc.destroy(); } catch (_) {} }
}

function bufferOf(att) {
  if (Buffer.isBuffer(att.buffer)) return att.buffer;
  const b64 = att.contentBytes || att.content;
  if (typeof b64 === 'string' && b64) { try { return Buffer.from(b64, 'base64'); } catch (_) { return null; } }
  return null;
}

async function textOf(att, deps = {}) {
  const kind = kindOf(att);
  const buf = bufferOf(att);
  if (!buf || !buf.length) return { kind, text: '' };
  try {
    if (kind === 'pdf') return { kind, text: (await pdfText(buf)).slice(0, MAX_CHARS) };
    if (kind === 'docx') {
      const mammoth = deps.mammoth || require('mammoth');
      const { value } = await mammoth.extractRawText({ buffer: buf });
      return { kind, text: String(value || '').slice(0, MAX_CHARS) };
    }
    if (kind === 'text') return { kind, text: buf.toString('utf8').slice(0, MAX_CHARS) };
  } catch (e) {
    console.warn('[acc guard] could not read attachment', att.name || '(unnamed)', e.message);
  }
  return { kind, text: '' };
}

// For each attachment: { name, kind, text, readable, decisionName }.
async function readAttachments(attachments, deps) {
  const out = [];
  for (const att of Array.isArray(attachments) ? attachments : []) {
    if (!att || att.isInline) continue;
    const name = String(att.name || att.filename || 'attachment');
    const { kind, text } = await textOf(att, deps);
    out.push({ name, kind, text, readable: text.replace(/\s+/g, '').length >= 40, decisionName: looksLikeDecisionName(name) });
  }
  return out;
}

module.exports = { readAttachments, looksLikeDecisionName, kindOf, PDF_PAGES };
