// Inspect the KIMBELL master plan PDF to determine which elevations have
// real detail pages vs. only appearing on a cover-sheet header. Used to
// confirm whether the bulk-extract row for elevations A, B, C should
// commit to the catalog or be skipped.

const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const PDF_PATH = 'C:\\Users\\edget\\AppData\\Local\\Temp\\1960 - KIMBELL (1).pdf';
const MAX_PAGES_PER_CHUNK = 90;

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

const PROMPT = `This PDF is a Landmark master plan submittal for DRB Group's KIMBELL plan (plan number 1960).

Your task: tell me which elevations actually appear in this PDF as DEDICATED detail pages (elevation drawings, floor plans, etc.) vs. which elevations are only mentioned on a cover sheet / schedule but have no detail content.

For each elevation (A, B, C, D, F, G, H, L, M, O, P, Q, R, S, etc.), return:
- has_detail_pages: true | false (real elevation drawings on dedicated pages)
- cover_sheet_only: true | false (mentioned only on a cover-sheet table, no detail pages)
- square_footage: integer or null (from the elevation's own page if present)
- notes: short observation (e.g. "front elevation drawing on page 17", "schedule of plans lists this but no detail page", "blank reservation in catalog")

Also return:
- total_pages_visible: how many pages you can see in this chunk
- cover_sheet_lists: array of every elevation listed on any schedule-of-plans / cover-sheet table
- plan_name: the plan name as printed (e.g. "Kimbell")

Return ONLY valid JSON, no preamble, no markdown fences:
{
  "plan_name": "Kimbell",
  "total_pages_visible": 90,
  "cover_sheet_lists": ["A","B","C","M","O","P"],
  "elevations": [
    { "code": "A", "has_detail_pages": true,  "cover_sheet_only": false, "square_footage": 1977, "notes": "..." },
    { "code": "M", "has_detail_pages": false, "cover_sheet_only": true,  "square_footage": null, "notes": "..." }
  ]
}`;

(async () => {
  const buf = fs.readFileSync(PDF_PATH);
  console.log('Loaded ' + (buf.length / 1024 / 1024).toFixed(1) + ' MB');
  const { chunks, total } = await splitPdf(buf, MAX_PAGES_PER_CHUNK);
  console.log('PDF has ' + total + ' pages, splitting into ' + chunks.length + ' chunks');

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    console.log('\n--- chunk ' + (i + 1) + '/' + chunks.length + ' (pp ' + c.start + '-' + c.end + ') ---');
    const r = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
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
    try {
      const parsed = JSON.parse(raw);
      console.log(JSON.stringify(parsed, null, 2));
    } catch (e) {
      console.log('PARSE FAIL — raw:', raw.slice(0, 1500));
    }
  }
})();
