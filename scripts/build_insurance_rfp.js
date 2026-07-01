#!/usr/bin/env node
// ===========================================================================
// build_insurance_rfp.js  (Ed 2026-07-01)
// ---------------------------------------------------------------------------
// Render an extracted insurance program (from extract_insurance_program.js)
// into a Bedrock-branded Request for Proposal PDF a broker can quote from —
// the important coverage specs only, NOT the raw policy. Normalizes/dedupes
// the program first (lib/insurance_rfp.js), then HTML -> PDF via puppeteer
// (same engine as the builder letters).
//
//   node -r dotenv/config scripts/build_insurance_rfp.js <program.json> <out.pdf> [opts.json]
// opts.json (all optional): { community, renewalDate, submissionDeadline,
//   rfpDate, includePremium, includeCarrier, contactName, contactEmail,
//   contactPhone, managerName }
// ===========================================================================

const fs = require('fs');
const { renderInsuranceRfpHTML, normalizeInsuranceProgram } = require('../lib/insurance_rfp');

async function htmlToPdfBuffer(html) {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    try { await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch (_) {}
    return await page.pdf({ format: 'Letter', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, preferCSSPageSize: true });
  } finally { try { await browser.close(); } catch (_) {} }
}

(async () => {
  const [programPath, outPath, optsPath] = process.argv.slice(2);
  if (!programPath || !outPath) { console.error('usage: <program.json> <out.pdf> [opts.json]'); process.exit(1); }

  const raw = JSON.parse(fs.readFileSync(programPath, 'utf8'));
  const program = normalizeInsuranceProgram(raw);
  const opts = optsPath ? JSON.parse(fs.readFileSync(optsPath, 'utf8')) : {};

  console.log('Named insured:', program.entity.named_insured);
  console.log('Coverage lines (deduped):');
  for (const c of program.coverages) {
    console.log(`  • ${c.line} — ${c.carrier || '?'} | ${(c.limits || []).length} limits | premium ${c.annual_premium || '—'} | ${c.effective_date || '?'}→${c.expiration_date || '?'}`);
  }
  console.log(`SOV items: ${program.statement_of_values.length} | curated notes: ${program.notes.length}`);

  const html = renderInsuranceRfpHTML(program, opts);
  const pdf = await htmlToPdfBuffer(html);
  fs.writeFileSync(outPath, pdf);
  // also drop the rendered HTML next to it for quick eyeballing
  fs.writeFileSync(outPath.replace(/\.pdf$/i, '.html'), html);
  console.log(`\nwrote ${outPath} (${(pdf.length / 1024).toFixed(0)} KB)`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
