// ============================================================================
// ocr_pdf.js
// ----------------------------------------------------------------------------
// PDF OCR fallback via AI vision. Triggered when pdf-parse yields no text
// from a scanned image-only PDF — common for older bylaws, CC&Rs, and
// historical minutes that pre-date digital workflows.
//
// Approach: send the PDF as a `document` content block to the vision model.
// For multi-page scans, split into page ranges with pdf-lib first so each
// slice stays under Anthropic's per-request size cap and the model's output
// token budget. Slices run in parallel (concurrency 3) to keep wall time
// inside the per-doc reindex timeout.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');

let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

let _pdfLib = null;
function pdfLib() {
  if (!_pdfLib) _pdfLib = require('pdf-lib');
  return _pdfLib;
}

// 10 pages/slice keeps each request well under Anthropic's 32MB / 100-page
// PDF cap AND under the default 8K output-token budget for dense legal text
// (~700 tokens/page). Concurrency 3 means a 60-page doc finishes in ~2 waves.
const PAGES_PER_SLICE = 10;
const OCR_CONCURRENCY = 3;
const OCR_MODEL = 'claude-sonnet-4-6';
const OCR_MAX_TOKENS = 8000;

const OCR_PROMPT =
  'Transcribe every word in this document verbatim. Preserve paragraph breaks ' +
  'and section headings. Do not summarize, paraphrase, or skip anything. ' +
  'If a word is illegible, write [illegible]. Return ONLY the transcribed ' +
  'text — no preamble, no commentary.';

async function _ocrSlice(anthropic, buffer) {
  const base64 = buffer.toString('base64');
  const resp = await anthropic.messages.create({
    model: OCR_MODEL,
    max_tokens: OCR_MAX_TOKENS,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: OCR_PROMPT },
      ],
    }],
  });
  const blocks = resp.content || [];
  return blocks.map((b) => b.text || '').join('\n').trim();
}

async function _splitPdfByPages(buffer, pagesPerSlice) {
  const { PDFDocument } = pdfLib();
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const pageCount = src.getPageCount();
  if (pageCount <= pagesPerSlice) return [buffer];

  const slices = [];
  for (let start = 0; start < pageCount; start += pagesPerSlice) {
    const end = Math.min(start + pagesPerSlice, pageCount);
    const out = await PDFDocument.create();
    const idxs = Array.from({ length: end - start }, (_, i) => start + i);
    const copied = await out.copyPages(src, idxs);
    copied.forEach((p) => out.addPage(p));
    const bytes = await out.save();
    slices.push(Buffer.from(bytes));
  }
  return slices;
}

// ocrPdfWithAi — extract text from a scanned PDF via AI vision.
// Returns the transcribed text (empty string if the API key is missing or
// OCR yields nothing usable). Errors on individual slices degrade gracefully:
// we keep whatever text we did get rather than failing the whole doc.
async function ocrPdfWithAi(buffer, filename) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[ocr] ANTHROPIC_API_KEY missing — skipping OCR for', filename);
    return '';
  }
  const anthropic = getAnthropic();

  let slices;
  try {
    slices = await _splitPdfByPages(buffer, PAGES_PER_SLICE);
  } catch (e) {
    console.warn('[ocr] pdf-lib split failed for', filename, '— OCRing whole file:', e.message);
    slices = [buffer];
  }

  const results = new Array(slices.length).fill('');
  for (let i = 0; i < slices.length; i += OCR_CONCURRENCY) {
    const batch = slices.slice(i, i + OCR_CONCURRENCY);
    const batchOut = await Promise.all(batch.map(async (slice, j) => {
      try {
        return await _ocrSlice(anthropic, slice);
      } catch (e) {
        console.warn(`[ocr] slice ${i + j + 1}/${slices.length} for ${filename} failed:`, e.message);
        return '';
      }
    }));
    batchOut.forEach((t, j) => { results[i + j] = t; });
  }
  return results.filter(Boolean).join('\n\n').trim();
}

module.exports = { ocrPdfWithAi };
