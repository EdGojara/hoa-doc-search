// tests/onboarding_qr_package_local.js  (Issue #15) — LOCAL-ONLY regression
// The Quail Ridge 7/31/2026 source set as the fixture for the source package:
// the six original Vantaca PDFs are recognized by their headers, all dated at the
// cutoff, and the GL they carry asks for exactly the six package reports.
// Reads the PDFs from Downloads (ONBOARDING_QR_DIR overrides); they are client
// records and are NEVER committed. Skips cleanly when they are not present.
// Prints only types, dates and counts (no names, accounts or amounts).
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('../lib/onboarding/adapters/vantaca');
const { pdfToLayoutText } = require('../lib/onboarding/pdf_layout');

const DIR = process.env.ONBOARDING_QR_DIR || path.join(os.homedir(), 'Downloads');
const FILES = { 'GLTrialBalance (16).pdf': 'gl_trial_balance', 'BalanceSheet (18).pdf': 'balance_sheet', 'AR Aging (8).pdf': 'ar_aging',
  'TransactionHistoryAssoc (3).pdf': 'homeowner_transactions', 'PrepaidHomeowners (1).pdf': 'prepaid_homeowners', 'APAging (4).pdf': 'ap_aging' };
const CUTOFF = '2026-07-31';

(async () => {
  const missing = Object.keys(FILES).filter((f) => !fs.existsSync(path.join(DIR, f)));
  if (missing.length) { console.log(`SKIP  Quail Ridge originals not present (${missing.length} missing)`); return; }
  let pass = 0, fail = 0; const check = (n, c, x = '') => { if (c) { pass++; console.log('PASS ', n); } else { fail++; console.log('FAIL ', n, x); } };
  const parsed = {}; const seen = [];
  for (const [file, want] of Object.entries(FILES)) {
    const text = await pdfToLayoutText(fs.readFileSync(path.join(DIR, file)));
    const id = V.identify(text);
    seen.push({ file, type: id && id.type, as_of: id && id.as_of });
    check(`${file}: recognized as ${want}, dated at the cutoff`, id && id.type === want && V.cutoffCheck(id, CUTOFF).ok === true, JSON.stringify(id));
    if (id) parsed[id.type] = V.parse(id.type, text, { filename: file, sha256: 'local' });
  }
  const req = V.requiredSources(parsed, V.inferRoles(parsed), CUTOFF);
  check('the QR GL asks for exactly the six package reports (AR, prepaid and AP all carry balances)', JSON.stringify(req.map((r) => r.type).sort()) === JSON.stringify(Object.values(FILES).sort()), JSON.stringify(req.map((r) => r.type)));
  check('every request uses the package name dated 7/31/2026', req.every((r) => /7\/31\/2026/.test(r.report)), JSON.stringify(req.map((r) => r.report)));
  const dates = V.reportDates(parsed);
  check('the intake cutoff control would pass: all six parsed reports carry 7/31/2026', dates.length === 6 && dates.every((d) => d.as_of === CUTOFF), JSON.stringify(dates));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
