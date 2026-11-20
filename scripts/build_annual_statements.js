#!/usr/bin/env node
// ============================================================================
// scripts/build_annual_statements.js  (Ed 2026-11-20)
// ----------------------------------------------------------------------------
// ANNUAL ASSESSMENT STATEMENT BATCH: print-ready PDFs + a manifest, per
// association. Builds files only; it never mails, emails, posts a charge or
// writes to the database. Distribution waits for Ed.
//
//   node scripts/build_annual_statements.js --community "Waterview Estates" \
//        --year 2027 --due 2027-01-01 --rate-cents 64000 --out <dir>
//   node scripts/build_annual_statements.js --community "Waterview Estates" \
//        --sample 20 --out <dir>          (bank scanline read-test proofs)
//
// A billing batch REFUSES to build unless:
//   * the association's budget for --year is APPROVED in TrustEd
//     (community_budgets.status = 'approved'), and --rate-cents is given (the
//     approved per-lot annual assessment; never inferred from a prior year);
//   * the association has a VERIFIED lockbox (lib/payments/lockbox.js) or the
//     operator passes --office-remit to send checks c/o Bedrock's office.
// Every statement is validated (mailing address, account number, encodable
// amount, scanline present when the lockbox is verified); failures go to the
// exceptions list and are left out of the print file, never printed blank.
// A sample run prints current balances only, watermarked NOT FOR MAILING.
//
// Print: the PDF embeds the OCR-A face installed on the machine that runs it
// (Windows "OCR A Extended"); the run stops if no OCR-A face loads, because a
// scanline in a fallback font will not read at the bank.
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { fetchAllQuery } = require('../lib/db/fetch_all');
const { buildStatementData, renderStatementsHTML } = require('../lib/statements/assessment_statement');
const { lockboxFor } = require('../lib/payments/lockbox');


// The OCR-A TrueType file to embed (never committed: licensed per machine).
// OCR_A_FONT_PATH overrides; else the Windows OCR A Extended face.
function ocrFontDataUri() {
  const cands = [process.env.OCR_A_FONT_PATH, 'C:/Windows/Fonts/OCRAEXT.TTF', '/usr/share/fonts/truetype/ocr-a/OCRA.ttf'].filter(Boolean);
  const f = cands.find((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
  if (!f) throw new Error('no OCR-A font file found; set OCR_A_FONT_PATH to an OCR-A .ttf');
  return 'data:font/ttf;base64,' + fs.readFileSync(f).toString('base64');
}

function args() {
  const a = process.argv.slice(2); const o = {};
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, '');
    if (['office-remit', 'dry-run'].includes(k)) o[k] = true; else { o[k] = a[i + 1]; i++; }
  }
  return o;
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

function validate(d, { lockbox, sample }) {
  const why = [];
  if (!d.account_number) why.push('no account number');
  if (!d.addressee || !String(d.addressee.street || '').trim() || !String(d.addressee.cityline || '').trim()) why.push('no complete mailing address');
  if (!d.addressee || !String(d.addressee.name || '').trim() || /^Property Owner$/i.test(d.addressee.name)) why.push('no owner name');
  if (d.balance_cents > 999999) why.push('amount over $9,999.99 does not fit the coupon field');
  if (lockbox && !d.scanline) why.push('scanline could not be encoded (account/amount)');
  if (!sample && d.prior_balance_cents < 0) { /* credit carried: allowed, pay amount floors at 0 */ }
  return why;
}

const csv = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
const dollars = (c) => (Math.round(c || 0) / 100).toFixed(2);

(async () => {
  const o = args();
  if (!o.community) throw new Error('--community "<name>" is required');
  const sample = o.sample ? Math.max(1, Number(o.sample)) : 0;
  const out = path.resolve(o.out || '.');
  fs.mkdirSync(out, { recursive: true });
  const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  const { data: comm, error: ce } = await s.from('communities').select('id, name, hoa_legal_name').eq('name', o.community).maybeSingle();
  if (ce) throw ce;
  if (!comm) throw new Error(`community not found: ${o.community}`);
  const lockbox = lockboxFor(comm.name);
  const blockers = [];

  let billing = null;
  if (!sample) {
    const year = Number(o.year);
    if (!year) throw new Error('--year is required for a billing batch');
    const { data: budget, error: be } = await s.from('community_budgets').select('id, status, approved_at').eq('community_id', comm.id).eq('fiscal_year', year).maybeSingle();
    if (be) throw be;
    if (!budget || budget.status !== 'approved') blockers.push(`${year} budget is ${budget ? budget.status : 'not in TrustEd'}; the annual assessment is not approved`);
    const rate = Math.round(Number(o['rate-cents']));
    if (!(rate > 0)) blockers.push('--rate-cents (the approved per-lot annual assessment) was not given');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(o.due || ''))) blockers.push('--due YYYY-MM-DD (the assessment due date) was not given');
    if (!lockbox && !o['office-remit']) blockers.push('no verified lockbox for this association; pass --office-remit to have checks mailed c/o Bedrock office');
    billing = { year, assessment_cents: rate, due_date: o.due };
  }
  if (blockers.length) {
    const summary = { community: comm.name, mode: 'billing', status: 'BLOCKED', blockers };
    fs.writeFileSync(path.join(out, `${comm.name.replace(/\W+/g, '_')}_BLOCKED.json`), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    process.exit(2);
  }

  const owners = await fetchAllQuery(() => s.from('v_current_property_owners')
    .select('property_id, street_address').eq('community_id', comm.id), { orderBy: 'property_id' });
  owners.sort((a, b) => String(a.street_address || '').localeCompare(String(b.street_address || ''), 'en', { numeric: true }));
  const pick = sample ? owners.slice(0, sample) : owners;

  const built = await pool(pick, 8, async (row) => {
    try {
      const d = await buildStatementData(s, row.property_id, { billing: sample ? null : billing });
      return { d, why: validate(d, { lockbox, sample }) };
    } catch (e) { return { d: null, row, why: [e.message] }; }
  });
  const good = built.filter((b) => b.d && !b.why.length).map((b) => b.d);
  const bad = built.filter((b) => !b.d || b.why.length);

  const label = sample ? 'SAMPLE - BANK SCANLINE TEST - NOT FOR MAILING' : null;
  const stem = `${comm.name.replace(/\W+/g, '_')}_${sample ? 'SAMPLE' : billing.year + '_annual'}`;
  const html = renderStatementsHTML(good, { sampleLabel: label, title: stem, ocrFontDataUri: lockbox ? ocrFontDataUri() : null });
  fs.writeFileSync(path.join(out, `${stem}.html`), html);

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  let ocrLoaded = false;
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 0 });
    await page.evaluate(() => document.fonts.ready);
    ocrLoaded = await page.evaluate(() => document.fonts.check('12pt "StatementOCR"') && [...document.fonts].some((f) => f.family.replace(/["']/g, '') === 'StatementOCR' && f.status === 'loaded'));
    if (lockbox && good.length && !ocrLoaded) throw new Error('no OCR-A font is installed on this machine; the scanline would not read at the bank. Install OCR-A and rerun.');
    const pdf = await page.pdf({ format: 'Letter', printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    fs.writeFileSync(path.join(out, `${stem}.pdf`), pdf);
  } finally { await browser.close(); }

  const head = ['account_number', 'owner', 'mail_street', 'mail_cityline', 'property', 'prior_balance', 'assessment', 'pay_this_amount', 'due_date', 'scanline'];
  const lines = [head.join(',')].concat(good.map((d) => [d.account_number, d.addressee.name, d.addressee.street, d.addressee.cityline, d.property_address,
    dollars(d.prior_balance_cents), billing ? dollars(billing.assessment_cents) : '', dollars(d.balance_cents), d.due_date, d.scanline || ''].map(csv).join(',')));
  fs.writeFileSync(path.join(out, `${stem}_manifest.csv`), lines.join('\n'));
  const exc = bad.map((b) => ({ account: b.d && b.d.account_number, property: (b.d && b.d.property_address) || (b.row && b.row.street_address), reasons: b.why }));
  const summary = {
    community: comm.name, mode: sample ? 'sample' : 'billing', year: billing ? billing.year : null,
    statements: good.length, exceptions: exc.length, owners_on_file: owners.length,
    total_pay_this_amount: dollars(good.reduce((t, d) => t + d.balance_cents, 0)),
    remit: good[0] ? good[0].remit.block : null,
    lockbox: lockbox ? { bank: lockbox.bank, association_code: lockbox.association_code, scanline_verified: !!lockbox.scanline_verified } : null,
    ocr_a_font_embedded: ocrLoaded,
    cleared_for_mailing: false,
    hold_reason: 'built only; Ed authorizes distribution' + (lockbox && !lockbox.scanline_verified ? '; bank has not yet read-tested this association scanline' : ''),
    exceptions_detail: exc,
  };
  fs.writeFileSync(path.join(out, `${stem}_summary.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, exceptions_detail: exc.slice(0, 10) }, null, 2));
})().catch((e) => { console.error('STOPPED:', e.message); process.exit(1); });
