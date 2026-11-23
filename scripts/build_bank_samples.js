#!/usr/bin/env node
// ============================================================================
// scripts/build_bank_samples.js  (Ed 2026-11-20)
// ----------------------------------------------------------------------------
// LOCKBOX VALIDATION SAMPLES for the bank: one 2027 annual assessment
// statement per association, FICTIONAL homeowner and TEST amount, the real
// account-number structure and the proposed lockbox identifiers, so the bank
// can read-test the scanline, account matching, check digit, coupon position
// and remittance address before any production statement is printed.
// Labeled "SAMPLE — BANK VALIDATION ONLY — DO NOT PAY" on every page. Builds
// files only: no database writes, nothing mailed or emailed.
//
//   node scripts/build_bank_samples.js --out <dir>
//
// Each PDF is verified after it is written: the scanline text is read back
// from the PDF, the OCR-A face must be the embedded font for it, and its
// position and pitch are measured against the band (0.25-0.5 in from the
// bottom edge, 0.25 in clear border, 10 characters per inch).
// ============================================================================
const fs = require('fs');
const path = require('path');
const url = require('url');
const { renderStatementsHTML, OCR_FONT } = require('../lib/statements/assessment_statement');
const { LOCKBOXES, buildScanline } = require('../lib/payments/lockbox');
const BRAND = require('../lib/brand');


// The OCR-A TrueType file to embed (never committed: licensed per machine).
// OCR_A_FONT_PATH overrides; else the Windows OCR A Extended face.
function ocrFontDataUri() {
  const cands = [process.env.OCR_A_FONT_PATH, 'C:/Windows/Fonts/OCRAEXT.TTF', '/usr/share/fonts/truetype/ocr-a/OCRA.ttf'].filter(Boolean);
  const f = cands.find((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
  if (!f) throw new Error('no OCR-A font file found; set OCR_A_FONT_PATH to an OCR-A .ttf');
  return 'data:font/ttf;base64,' + fs.readFileSync(f).toString('base64');
}

const MGMT = { name: 'Bedrock Association Management LLC', line1: BRAND.service.address, city: BRAND.service.addressCityStateZip, phone: '832-588-2485' };
const LABEL = 'SAMPLE — BANK VALIDATION ONLY — DO NOT PAY';

// One representative statement per NewFirst association. Account numbers keep
// each association's real length and Vantaca prefix but are fictional (above
// every real account; checked against TrustEd before use).
const SAMPLES = [
  { community: 'Waterview Estates', legal: 'Waterview Estates Owners Association, Inc.', account: '10199991', owner: 'Pat Testerson', amount: 61234,
    mail: ['100 Sample Lane', 'Richmond, TX 77407'], property: '100 Sample Lane' },
  { community: 'Lakes of Pine Forest', legal: 'Lakes of Pine Forest Homeowners Association, Inc.', account: '2019991', owner: 'Chris Validation', amount: 45678,
    mail: ['200 Sample Lane', 'Houston, TX 77084'], property: '200 Sample Lane' },
  { community: 'Still Creek Ranch', legal: 'Still Creek Ranch Homeowners Association, Inc.', account: '10299991', owner: 'Alex Lockboxer', amount: 49512,
    mail: ['300 Sample Lane', 'Richmond, TX 77406'], property: '300 Sample Lane' },
  { community: 'Canyon Gate at Cinco Ranch', legal: 'Canyon Gate at Cinco Ranch Owners Association, Inc.', account: '10599991', owner: 'Sam Scanline', amount: 142599,
    mail: ['400 Sample Lane', 'Katy, TX 77450'], property: '400 Sample Lane' },
];

function statusNote(lb) {
  if (!lb) return 'No NewFirst lockbox configuration: scanline not printed.';
  const prov = [];
  if (!lb.remittance_verified) prov.push('remittance address');
  if (!lb.scanline_verified) prov.push(`association code ${String(lb.association_code).padStart(6, '0')}`);
  if (!lb.remittance_verified || lb.proposed) prov.push('management code 0000');
  return prov.length ? `PROVISIONAL, for NewFirst to confirm: ${prov.join(', ')}.` : 'Identifiers as on current Vantaca coupons; please confirm read.';
}

function sampleData(x) {
  const lb = LOCKBOXES[x.community];
  const due = '2027-01-01';
  const d = {
    asOf: new Date(),
    association: { name: x.legal },
    community_name: x.community,
    mgmt: MGMT,
    account_number: x.account,
    due_date: '1/1/2027',
    balance_cents: x.amount,
    prior_balance_cents: 0,
    addressee: { name: x.owner, street: x.mail[0], cityline: x.mail[1] },
    property_label: `${x.account} - ${x.property}`,
    property_address: x.property,
    notice: `Annual Assessments are due on January 1st and are delinquent after January 31st to avoid any penalties. Your balance may reflect a prior balance. If you have any questions, please contact our office at ${MGMT.phone}.`,
    activity: [
      { date: null, description: '-- Prior Balance --', charge_cents: 0, payment_cents: 0, total_cents: 0, prior: true },
      { date: due, description: '2027 Annual Assessment', charge_cents: x.amount, payment_cents: 0, total_cents: x.amount },
    ],
    remit: { name: x.legal, block: lb ? [x.legal, ...lb.lines].join('\n') : x.legal },
    owner_name_raw: x.owner,
    sample_note: `Fictional homeowner and test amount. ${statusNote(lb)}`,
  };
  d.scanline = buildScanline(lb, { accountNumber: d.account_number, ownerName: d.owner_name_raw, amountCents: d.balance_cents });
  return { d, lb };
}

async function verifyPdf(file, expectedLine) {
  const pdfjs = await import(url.pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)) }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  await page.getOperatorList();
  const items = tc.items.filter((i) => i.str && i.str.trim());
  // the scanline is the lowest text on the page
  const yMin = Math.min(...items.map((i) => i.transform[5]));
  const lineItems = items.filter((i) => Math.abs(i.transform[5] - yMin) < 2).sort((a, b) => a.transform[4] - b.transform[4]);
  const text = lineItems.map((i) => i.str).join('');
  const x0 = lineItems[0].transform[4];
  const last = lineItems[lineItems.length - 1];
  const x1 = last.transform[4] + last.width;
  const fontName = lineItems[0].fontName;
  const fontObj = page.commonObjs.has(fontName) ? page.commonObjs.get(fontName) : null;
  const ptsPerIn = 72;
  return {
    pages: doc.numPages,
    scanline_in_pdf: text.replace(/\s+/g, ' ').trim(),
    // The PDF text layer carries no space glyphs for OCR-A; the characters must
    // match in order, and the spacing is proven by the measured pitch below.
    matches_expected: text.replace(/\s+/g, '') === expectedLine.replace(/\s+/g, ''),
    font: fontObj ? fontObj.name : fontName,
    baseline_from_bottom_in: +(yMin / ptsPerIn).toFixed(3),
    right_clearance_in: +((vp.width - x1) / ptsPerIn).toFixed(3),
    left_clearance_in: +(x0 / ptsPerIn).toFixed(3),
    chars_per_inch: +(expectedLine.length / ((x1 - x0) / ptsPerIn)).toFixed(2),
  };
}

(async () => {
  const outArg = process.argv.indexOf('--out');
  const out = path.resolve(outArg > 0 ? process.argv[outArg + 1] : 'bank_samples');
  fs.mkdirSync(out, { recursive: true });
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const results = [];
  const FONT = ocrFontDataUri();
  try {
    for (const x of SAMPLES) {
      const { d, lb } = sampleData(x);
      const html = renderStatementsHTML([d], { sampleLabel: LABEL, title: `${x.community} - NewFirst lockbox sample`, ocrFontDataUri: FONT });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      const ocr = 'StatementOCR (embedded OCR-A)';
      const file = path.join(out, `${x.community.replace(/\W+/g, '_')}_NewFirst_Lockbox_Sample_2027.pdf`);
      fs.writeFileSync(file, await page.pdf({ format: 'Letter', printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } }));
      await page.close();
      const v = d.scanline ? await verifyPdf(file, d.scanline) : null;
      if (v && (!v.matches_expected || Math.abs(v.chars_per_inch - 10) > 0.2 || v.baseline_from_bottom_in < 0.25 || v.baseline_from_bottom_in > 0.4 || v.right_clearance_in < 0.25)) {
        throw new Error(`${x.community}: scanline check failed ${JSON.stringify(v)}`);
      }
      if (v && !/OCR/i.test(v.font)) throw new Error(`${x.community}: the scanline embedded ${v.font}, not OCR-A; stopping`);
      results.push({ community: x.community, legal_name: x.legal, file: path.basename(file), account: x.account, account_digits: x.account.length,
        test_amount: (x.amount / 100).toFixed(2), remittance: d.remit.block, scanline: d.scanline, ocr_font: ocr, lockbox: lb ? {
          mgmt_code: lb.mgmt_code, association_code: String(lb.association_code).padStart(6, '0'), remittance_verified: !!lb.remittance_verified,
          scanline_verified: !!lb.scanline_verified, proposed: !!lb.proposed, evidence: lb.evidence } : null, verify: v });
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(out, 'samples.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.map((r) => ({ community: r.community, scanline: r.scanline, verify: r.verify })), null, 2));
})().catch((e) => { console.error('STOPPED:', e.message); process.exit(1); });
