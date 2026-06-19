// One-off: read a large combined builder plan PDF and extract every distinct
// plan + elevation, plus the builder/community it's for. Splits the PDF into
// chunks (Claude's per-call page limit) and merges. Ed 2026-06-19.
require('dotenv').config();
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FILE = process.argv[2] || 'C:/Users/edget/AppData/Local/Temp/All New Fairway plans COMBINED (1).pdf';
const CHUNK_PAGES = 45;

const PROMPT = `This is part of a homebuilder's combined architectural plan set. Identify the BUILDER name and COMMUNITY name if shown anywhere, and list EVERY distinct plan + elevation combination in these pages.

Return ONLY JSON:
{
  "builder": "builder/company name if shown, else null",
  "community": "community/subdivision name if shown, else null",
  "plans": [ { "plan_number": "", "plan_name": "", "elevation": "", "square_footage": null, "stories": null } ]
}

- plan_number: the model/plan number as printed (e.g. "2740", "476N").
- elevation: the elevation code as printed (e.g. "A", "C4", "DEF"). null if none.
- One entry per plan+elevation actually shown. Be exhaustive across all pages.
- Use null for anything not shown; never guess.`;

async function extractChunk(bytes, label) {
  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 4000,
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(bytes).toString('base64') } },
      { type: 'text', text: PROMPT },
    ] }],
  });
  const t = (r.content?.[0]?.text || '').trim();
  const m = t.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : t); } catch (e) { console.warn(`  ${label}: parse failed`); return { plans: [] }; }
}

(async () => {
  const bytes = fs.readFileSync(FILE);
  const src = await PDFDocument.load(bytes);
  const total = src.getPageCount();
  console.log(`PDF: ${total} pages, splitting into ${CHUNK_PAGES}-page chunks`);

  let builder = null, community = null;
  const allPlans = [];
  for (let start = 0; start < total; start += CHUNK_PAGES) {
    const end = Math.min(start + CHUNK_PAGES, total);
    const chunk = await PDFDocument.create();
    const pages = await chunk.copyPages(src, Array.from({ length: end - start }, (_, i) => start + i));
    pages.forEach((p) => chunk.addPage(p));
    const chunkBytes = await chunk.save();
    const label = `pages ${start + 1}-${end}`;
    process.stdout.write(`  ${label}… `);
    const res = await extractChunk(chunkBytes, label);
    builder = builder || res.builder;
    community = community || res.community;
    (res.plans || []).forEach((p) => allPlans.push(p));
    console.log(`${(res.plans || []).length} plan rows`);
  }

  console.log('\nBUILDER:', builder, '· COMMUNITY:', community);
  // dedupe by plan_number + elevation
  const seen = new Set();
  const uniq = [];
  for (const p of allPlans) {
    const num = (p.plan_number || '').toString().trim();
    const elev = (p.elevation || '').toString().trim();
    if (!num) continue;
    const k = num + '|' + elev;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push({ plan_number: num, plan_name: p.plan_name || null, elevation: elev || null, square_footage: p.square_footage || null, stories: p.stories || null });
  }
  console.log('DISTINCT plan/elevation combos:', uniq.length);
  const byNum = {};
  for (const p of uniq) { (byNum[p.plan_number] = byNum[p.plan_number] || []).push(p.elevation || '?'); }
  for (const pn of Object.keys(byNum).sort()) console.log('  ', pn, '->', byNum[pn].sort().join(', '));
  fs.writeFileSync('scripts/_fairway_extracted.json', JSON.stringify({ builder, community, plans: uniq }, null, 2));
  console.log('\nsaved -> scripts/_fairway_extracted.json');
})();
