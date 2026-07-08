// Inspect all four remaining Landmark PDFs to get authoritative sqft +
// stories per elevation for the bulk-upload grid.

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TEMP = 'C:\\Users\\edget\\AppData\\Local\\Temp';
const PDFS = [
  { name: 'PARAMOUNT', planNumber: '2080', file: '2080 - PARAMOUNT.pdf' },
  { name: 'SOUTHFORK', planNumber: '2380', file: '2380 - SOUITHFORK.pdf' },
  { name: 'MAJESTIC',  planNumber: '2550', file: '2550 - MAJESTIC.pdf' },
  { name: 'MEYERSON',  planNumber: '2740', file: '2740 - MEYERSON.pdf' },
];
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
    chunks.push({ buffer: Buffer.from(await chunk.save()) });
  }
  return { chunks, total };
}

function makePrompt(planName, planNumber) {
  return `This is a DRB Landmark master plan submittal for ${planName} (plan ${planNumber}).

For each elevation in this PDF chunk, return:
- code: elevation letter as printed (A, B, C, M, O, P, etc.)
- has_detail_pages: true if real elevation drawings or floor plan pages
- square_footage: living-area sqft as integer (look for "LIVING", "TOTAL LIVING", "FIRST FLOOR LIVING")
- stories: 1, 1.5, 2, 2.5, 3
- notes: brief location reference

Return JSON only, no preamble, no fences:
{
  "plan_name": "${planName}",
  "ai_confidence": "high",
  "elevations": [{"code":"A","has_detail_pages":true,"square_footage":0,"stories":1,"notes":""}]
}`;
}

async function inspectOne(pdf) {
  const fp = path.join(TEMP, pdf.file);
  if (!fs.existsSync(fp)) return { name: pdf.name, error: 'file not found at ' + fp };
  const buf = fs.readFileSync(fp);
  let chunks, total;
  try {
    ({ chunks, total } = await splitPdf(buf, MAX_PAGES_PER_CHUNK));
  } catch (e) { return { name: pdf.name, error: 'pdf-lib load failed: ' + e.message }; }

  const elevs = new Map();
  let planName = pdf.name;
  const prompt = makePrompt(pdf.name, pdf.planNumber);
  for (let i = 0; i < chunks.length; i++) {
    try {
      const r = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 4000,
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: chunks[i].buffer.toString('base64') } },
          { type: 'text', text: prompt },
        ]}],
      });
      let raw = (r.content?.[0]?.text || '').trim();
      const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (fenced) raw = fenced[1].trim();
      const parsed = JSON.parse(raw);
      planName = parsed.plan_name || planName;
      (parsed.elevations || []).forEach((e) => {
        const cur = elevs.get(e.code);
        if (!cur || (e.has_detail_pages && !cur.has_detail_pages) || (!cur.square_footage && e.square_footage)) {
          elevs.set(e.code, e);
        }
      });
    } catch (e) {
      // swallow chunk failures; continue with others
    }
  }
  return { name: pdf.name, planNumber: pdf.planNumber, planName, totalPages: total, elevations: [...elevs.entries()].sort().map(([code, e]) => ({ code, ...e })) };
}

(async () => {
  const results = [];
  for (const pdf of PDFS) {
    console.log('Inspecting ' + pdf.name + '...');
    const r = await inspectOne(pdf);
    results.push(r);
  }

  console.log('\n=================================');
  console.log('SUMMARY');
  console.log('=================================');
  for (const r of results) {
    console.log('\n' + r.name + ' (Plan ' + r.planNumber + ', "' + r.planName + '")');
    if (r.error) { console.log('  ERROR: ' + r.error); continue; }
    console.log('  ' + r.totalPages + ' pages, ' + r.elevations.length + ' elevations:');
    for (const e of r.elevations) {
      console.log('    ' + e.code + ' | sqft ' + (e.square_footage || '?') + ' | ' + (e.stories || '?') + ' story');
    }
  }
})();
