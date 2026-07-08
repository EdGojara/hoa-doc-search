// Inspect the DRISKILL master plan PDF — bulk-extract failed entirely
// (all fields blank, AI confidence "low"). Find out what elevations
// are actually in there and their square footage so Ed can either
// manually fill the bulk-upload grid or re-upload after the PDF
// is split into more digestible pieces.

const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const PDF_PATH = 'C:\\Users\\edget\\AppData\\Local\\Temp\\1800 - DRISKILL.pdf';
const MAX_PAGES_PER_CHUNK = 5;

async function splitPdf(buffer, maxPages) {
  const src = await PDFDocument.load(buffer);
  const total = src.getPageCount();
  const chunks = [];
  for (let s = 0; s < total; s += maxPages) {
    const e = Math.min(s + maxPages, total);
    const chunk = await PDFDocument.create();
    const idx = [];
    for (let i = s; i < e; i++) idx.push(i);
    const copied = await chunk.copyPages(src, idx);
    copied.forEach((p) => chunk.addPage(p));
    chunks.push({ start: s + 1, end: e, buffer: Buffer.from(await chunk.save()) });
  }
  return { chunks, total };
}

const PROMPT = `This PDF is a Landmark master plan submittal for DRB Group's DRISKILL plan (plan number 1800).

For each elevation found in this PDF chunk (A, B, C, D, F, G, H, L, M, O, P, Q, R, S, etc.), return:
- code: elevation letter as printed
- has_detail_pages: true if there are dedicated elevation drawings / floor plan pages
- square_footage: living-area sq ft as integer (look for "LIVING" / "1ST FLOOR LIVING" / "TOTAL LIVING" labels)
- stories: 1, 1.5, 2, 2.5, 3 (default 1 for one-story DRB plans)
- notes: where it appears (page numbers if you can tell)

Also return:
- plan_name: as printed (e.g. "Driskill")
- chunk_pages: total pages in THIS chunk
- cover_sheet_lists: every elevation listed on cover-sheet schedule tables
- ai_confidence: high | medium | low — your overall confidence

Return ONLY valid JSON, no preamble, no markdown fences:
{
  "plan_name": "Driskill",
  "chunk_pages": 90,
  "cover_sheet_lists": ["A","B","C","M","O","P"],
  "ai_confidence": "high",
  "elevations": [
    { "code": "A", "has_detail_pages": true, "square_footage": 1605, "stories": 1, "notes": "pages 2-6" }
  ]
}`;

(async () => {
  const buf = fs.readFileSync(PDF_PATH);
  console.log('Loaded ' + (buf.length / 1024 / 1024).toFixed(1) + ' MB');
  const { chunks, total } = await splitPdf(buf, MAX_PAGES_PER_CHUNK);
  console.log('PDF has ' + total + ' pages, splitting into ' + chunks.length + ' chunks');

  const allElevations = new Map();
  let planName = null;
  const coverSheetLists = new Set();

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    console.log('\n--- chunk ' + (i + 1) + '/' + chunks.length + ' (pp ' + c.start + '-' + c.end + ', ' + (c.buffer.length / 1024 / 1024).toFixed(1) + ' MB) ---');
    try {
      const r = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 6000,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: c.buffer.toString('base64') } },
            { type: 'text', text: PROMPT },
          ],
        }],
      });
      let raw = (r.content?.[0]?.text || '').trim();
      const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (fenced) raw = fenced[1].trim();
      const parsed = JSON.parse(raw);
      planName = planName || parsed.plan_name;
      (parsed.cover_sheet_lists || []).forEach((e) => coverSheetLists.add(e));
      (parsed.elevations || []).forEach((e) => {
        // Dedup, prefer entries with detail pages + square footage
        const existing = allElevations.get(e.code);
        if (!existing || (e.has_detail_pages && !existing.has_detail_pages) || (!existing.square_footage && e.square_footage)) {
          allElevations.set(e.code, e);
        }
      });
      console.log('  parsed:', parsed.elevations?.length || 0, 'elevations · confidence:', parsed.ai_confidence);
    } catch (e) {
      console.log('  CHUNK FAILED:', e.message);
    }
  }

  console.log('\n=================================');
  console.log('SUMMARY for ' + planName);
  console.log('  Cover sheet lists: ' + [...coverSheetLists].sort().join(', '));
  console.log('  Elevations with detail pages:');
  for (const [code, e] of [...allElevations.entries()].sort()) {
    console.log('    ' + code + ' | sqft ' + (e.square_footage || '?') + ' | ' + (e.stories || 1) + ' story | ' + (e.notes || '').slice(0, 80));
  }
})();
