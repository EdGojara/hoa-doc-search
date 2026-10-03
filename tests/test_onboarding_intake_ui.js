// ============================================================================
// tests/test_onboarding_intake_ui.js  (Issue #15) — Start-screen drag and drop
// ----------------------------------------------------------------------------
// The pure intake logic the page uses (public/js/onboarding-intake.js) plus
// page guards. The box a file is dropped on is never its identity: what the
// server read from the PDF decides; a mis-drop is rerouted and said out loud.
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const I = require('../public/js/onboarding-intake.js');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
let t = 1000;
const file = (name, size = 100) => ({ name, size, lastModified: t++ });
const rec = (type, as_of, extra = {}) => ({ type, as_of, period_start: null, dated_at_cutoff: as_of ? as_of === '2026-07-31' : null, note: null, ...extra });
const REPORTS = ['gl_trial_balance', 'balance_sheet', 'ar_aging', 'homeowner_transactions', 'prepaid_homeowners', 'ap_aging'].map((type) => ({ type, name: type, report: type }));

check('drop-all: six files in one drop are each filed by their recognized report; all six rows Supplied', () => {
  const files = REPORTS.map((r) => file(`${r.type}.pdf`));
  const m = I.merge([], files, REPORTS.map((r) => rec(r.type, '2026-07-31')), null);
  assert.strictEqual(m.held.length, 6); assert.deepStrictEqual(m.notices, []);
  const pkg = I.applyToPackage(REPORTS, m.held);
  assert.ok(pkg.reports.every((r) => r.status === 'supplied' && r.dated_at_cutoff === true));
  assert.deepStrictEqual(pkg.unrecognized, []);
});
check('per-report drop: a file dropped on its own row is filed there with no notice', () => {
  const m = I.merge([], [file('AR Aging.pdf')], [rec('ar_aging', '2026-07-31')], 'ar_aging');
  assert.deepStrictEqual(m.notices, []);
  assert.strictEqual(I.applyToPackage(REPORTS, m.held).reports.find((r) => r.type === 'ar_aging').file, 'AR Aging.pdf');
});
check('mis-drop: a Balance Sheet dropped on the AR Aging row is filed as the Balance Sheet (contents decide) and the user is told', () => {
  const m = I.merge([], [file('BalanceSheet.pdf')], [rec('balance_sheet', '2026-07-31')], 'ar_aging');
  const pkg = I.applyToPackage(REPORTS, m.held);
  assert.strictEqual(pkg.reports.find((r) => r.type === 'balance_sheet').status, 'supplied');
  assert.strictEqual(pkg.reports.find((r) => r.type === 'ar_aging').status, 'needed', 'the target row is NOT marked supplied');
  assert.deepStrictEqual(m.notices, [{ kind: 'rerouted', filename: 'BalanceSheet.pdf', dropped_on: 'ar_aging', type: 'balance_sheet' }]);
  assert.match(I.noticeText(m.notices[0], (x) => ({ ar_aging: 'AR Aging', balance_sheet: 'Balance Sheet' }[x])), /dropped on AR Aging, but its contents are the Balance Sheet; it is filed there/);
});
check('mis-drop of a non-report: listed as not recognized, never filed under the row it was dropped on', () => {
  const m = I.merge([], [file('notes.pdf')], [rec(null, null, { note: 'not a report Trusted recognizes yet' })], 'gl_trial_balance');
  const pkg = I.applyToPackage(REPORTS, m.held);
  assert.strictEqual(pkg.reports.find((r) => r.type === 'gl_trial_balance').status, 'needed');
  assert.strictEqual(pkg.unrecognized[0].filename, 'notes.pdf');
  assert.strictEqual(m.notices[0].kind, 'unrecognized');
});
check('multi-file onto one row: each file is identified separately (two different reports dropped on one row land in their own rows)', () => {
  const m = I.merge([], [file('GLTrialBalance.pdf'), file('APAging.pdf')], [rec('gl_trial_balance', '2026-07-31', { period_start: '2026-01-01' }), rec('ap_aging', '2026-07-31')], 'gl_trial_balance');
  const pkg = I.applyToPackage(REPORTS, m.held);
  assert.strictEqual(pkg.reports.find((r) => r.type === 'gl_trial_balance').file, 'GLTrialBalance.pdf');
  assert.strictEqual(pkg.reports.find((r) => r.type === 'ap_aging').file, 'APAging.pdf');
  assert.deepStrictEqual(m.notices.map((n) => n.kind), ['rerouted']);
});
check('re-drop: the same file is not sent twice; a newer file of the same report replaces the older, but a misdated one never displaces one dated at the cutoff', () => {
  const a = file('AR Aging.pdf');
  let m = I.merge([], [a], [rec('ar_aging', '2026-06-30')], null);
  assert.deepStrictEqual(I.newFiles(m.held, [a]), [], 'already held: nothing to send');
  m = I.merge(m.held, [file('AR Aging (1).pdf')], [rec('ar_aging', '2026-07-31')], null);
  assert.strictEqual(m.held.filter((h) => h.type === 'ar_aging').length, 1); assert.strictEqual(m.held[0].filename, 'AR Aging (1).pdf'); assert.strictEqual(m.notices[0].kind, 'replaced');
  m = I.merge(m.held, [file('AR Aging (2).pdf')], [rec('ar_aging', '2026-05-31')], null);
  assert.strictEqual(m.held.find((h) => h.type === 'ar_aging').filename, 'AR Aging (1).pdf'); assert.strictEqual(m.notices[0].kind, 'kept_existing');
});
check('after drop the row shows the period / cutoff the report itself prints', () => {
  assert.strictEqual(I.periodText({ as_of: '2026-07-31', period_start: '2026-01-01' }), '1/1/2026 - 7/31/2026');
  assert.strictEqual(I.periodText({ as_of: '2026-07-31' }), 'as of 7/31/2026');
  assert.strictEqual(I.periodText({ as_of: null }), 'no date printed');
});
check('page: one prominent drop-all zone + every report row a drop / click target; the native picker is a hidden fallback; recognition goes through /recognize (no batch)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  assert.ok(/<div id="nb_dropall" class="dropzone" role="button" tabindex="0"[^>]*><b>Drop all Vantaca reports here<\/b>/.test(html));
  assert.ok(/<input id="nb_files" type="file" multiple accept="\.pdf,application\/pdf" hidden>/.test(html), 'picker hidden, multi-file');
  assert.ok(html.indexOf('id="nb_dropall"') < html.indexOf('id="nb_package"'), 'drop-all sits above the checklist');
  assert.ok(/class="droptarget" tabindex="0"/.test(html) && /addEventListener\('drop', \(ev\) => \{ const tr = rowOf\(ev\); if \(!tr\) return; ev\.preventDefault\(\); tr\.classList\.remove\('over'\); recognizeInto\(dragFiles\(ev\), tr\.dataset\.report\)/.test(html), 'each row accepts drops');
  assert.ok(/zone\.addEventListener\('drop'/.test(html) && /zone\.addEventListener\('click'/.test(html), 'drop-all accepts drops and opens the picker on click');
  assert.ok(/\/api\/onboarding\/recognize/.test(html) && !/recognizeInto[\s\S]{0,800}\/api\/onboarding\/onboard'/.test(html.slice(html.indexOf('async function recognizeInto'), html.indexOf('async function loadStartPackage'))), 'recognizing never creates a batch');
  assert.ok(/<script src="\/js\/onboarding-intake\.js"><\/script>/.test(html) && /OnboardingIntake\.merge\(held, fresh, r\.files, droppedOn \|\| null\)/.test(html), 'the page uses the tested logic');
  assert.ok(/for \(const h of held\) fd\.append\('files', h\.file\)/.test(html), 'Start submits the held set (one file per report)');
});

(async () => {
  let pass = 0, fail = 0;
  console.log('Onboarding: Start-screen drag and drop (Issue #15)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
