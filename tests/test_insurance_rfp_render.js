// =============================================================================
// tests/test_insurance_rfp_render.js — extractor page-cap + RFP render rules
// =============================================================================
//
// Guards three fixes from the Waterview scar (Ed 2026-09-03):
//   1. capPdfPages trims a >100-page policy to its declarations so it never
//      400s and gets silently dropped (Property=155pg, Cyber=101pg were lost).
//   2. normalizeInsuranceProgram folds "Employers Liability" into Workers Comp
//      (it leaks in from an umbrella's underlying schedule as a phantom line).
//   3. renderInsuranceRfpHTML withholds the incumbent carrier by default and
//      caps the limits shown (a Hartford property policy carries 70+ sub-limits).
//
// Run: node tests/test_insurance_rfp_render.js   (wired into npm test)
// =============================================================================

const assert = require('assert');
const { PDFDocument } = require('pdf-lib');
const { capPdfPages, MAX_EXTRACT_PAGES } = require('../lib/insurance_extract');
const { normalizeInsuranceProgram, renderInsuranceRfpHTML } = require('../lib/insurance_rfp');

let failures = 0;
function check(name, fn) {
  const done = (err) => { if (err) { failures++; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); } else console.log(`  PASS  ${name}`); };
  try { const r = fn(); if (r && r.then) return r.then(() => done(), done); done(); }
  catch (err) { done(err); }
}

async function makePdf(pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) { const p = doc.addPage([300, 300]); p.drawText(`page ${i + 1}`, { x: 20, y: 260 }); }
  return Buffer.from(await doc.save());
}

async function pageCount(buf) { return (await PDFDocument.load(buf)).getPageCount(); }

(async () => {
  await check('capPdfPages trims a policy over the page cap', async () => {
    const big = await makePdf(MAX_EXTRACT_PAGES + 15);
    const capped = await capPdfPages(big);
    assert.strictEqual(await pageCount(capped), MAX_EXTRACT_PAGES);
  });

  await check('capPdfPages leaves a small PDF untouched', async () => {
    const small = await makePdf(8);
    const out = await capPdfPages(small);
    assert.strictEqual(await pageCount(out), 8);
  });

  check('normalize folds Employers Liability into Workers Compensation', () => {
    const prog = normalizeInsuranceProgram({ coverages: [
      { line: 'Workers Compensation', limits: [{ label: 'Each Accident', amount: '$1,000,000' }] },
      { line: 'Employers Liability', limits: [{ label: 'Each Accident', amount: '$1,000,000' }] },
    ] });
    const lines = prog.coverages.map((c) => c.line);
    assert.ok(lines.includes('Workers Compensation'), 'WC present');
    assert.ok(!lines.includes('Employers Liability'), `Employers Liability should fold into WC; got ${lines.join(', ')}`);
  });

  check('render withholds carrier by default, shows it only on request', () => {
    const prog = { entity: { named_insured: 'Test HOA' }, coverages: [
      { line: 'General Liability', carrier: 'SomeCarrier Inc', limits: [{ label: 'Each Occurrence', amount: '$1,000,000' }] },
    ] };
    assert.ok(!/Current carrier/.test(renderInsuranceRfpHTML(prog, {})), 'carrier hidden by default');
    assert.ok(/Current carrier/.test(renderInsuranceRfpHTML(prog, { includeCarrier: true })), 'carrier shown when asked');
  });

  check('render caps the number of limits shown per line', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ label: `Sub-limit ${i}`, amount: `$${i}0,000` }));
    const prog = { entity: { named_insured: 'Test HOA' }, coverages: [{ line: 'Property', limits: many }] };
    const html = renderInsuranceRfpHTML(prog, {});
    // Limit/deductible bullets render as `<li><b>$amount</b>`; key-terms and the
    // submission-instruction list use a bare `<li>`, so count only `<li><b>`.
    const bullets = (html.match(/<li><b>/g) || []).length;
    assert.ok(bullets <= 14, `expected <=14 limit bullets, got ${bullets}`);
  });

  if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nAll insurance RFP render/extract checks passed.');
})();
