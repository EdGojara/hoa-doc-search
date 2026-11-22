// ============================================================================
// tests/test_annual_statement_run.js  (Ed 2026-11-22)
// The annual statement run: announcement page from validated JSON, coupon and
// notice text, PREVIEW watermark, and the final-run gates (an unapproved
// budget still refuses). Offline; fictional data only (public repo).
// Run: node tests/test_annual_statement_run.js
// ============================================================================
const AS = require('../lib/statements/assessment_statement');
const { billingGates, PREVIEW_LABEL } = require('../scripts/build_annual_statements');

let failures = 0;
const check = (name, cond, detail) => { if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`); else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`); } };

const FEES = { card_fee_bps: 350, debit_card_fee_bps: null, ach_fee_cents: 295, ach_tier_threshold_cents: 35000, ach_fee_above_cents: 595 };
const live = (keys) => Object.fromEntries(keys.map((k) => [k, { status: 'live' }]));
const comm = (extra = {}) => ({ name: 'Testwood Glen', portal_module_config: { ...live(['arc', 'messages', 'claire']), financials: { status: 'hidden' }, ...extra } });
const annRaw = (over = {}) => ({
  schema: 'trusted.statement_announcement.v1', community: 'Testwood Glen', year: 2027,
  portal_url: 'https://portal.example.test/portal-login.html', portal_features: ['arc', 'messages', 'claire'],
  switch_date: '2027-01-04', vantaca_end_date: '2027-01-03',
  notice_text: 'Assessments are due January 1, 2027 and are delinquent if not paid when due.',
  support: { email: 'help@example.test', phone: '(555) 555-0100' }, _comment: 'ignored', ...over,
});
const stmt = () => ({
  asOf: new Date('2026-11-22T12:00:00Z'), association: { name: 'Testwood Glen Owners Association, Inc.' },
  mgmt: { name: 'Example Management LLC', line1: '1 Test Way', city: 'Testville, TX 77000', phone: '555-555-0100' },
  account_number: '9990001', due_date: '1/1/2027', balance_cents: 71900, prior_balance_cents: 0,
  addressee: { name: 'Pat Example', street: '1 Example Ct', cityline: 'Testville, TX 77000' }, property_label: '9990001 - 1 Example Ct', property_address: '1 Example Ct',
  notice: 'NOTICE FROM RUN', activity: [], remit: { name: 'Testwood Glen Owners Association, Inc.', block: 'Testwood Glen Owners Association, Inc.\nPO Box 1\nTestville, TX 77000' }, scanline: null,
});

console.log('\nAnnouncement validation');
let r = AS.resolveAnnouncement(annRaw(), { community: comm({ payment_fees: FEES }), year: 2027 });
check('a complete announcement with fees configured resolves for a final run', r.ok, r.errors.join('; '));
check('fee lines come from fee_quote (card 3.5%, ACH up to and including $350.00)', r.ok && /3\.5% processing fee on card/.test(r.ann.fees.lines.card) && /\$2\.95 .*up to and including \$350\.00; \$5\.95 above/.test(r.ann.fees.lines.ach) && !r.ann.fees.pending);
r = AS.resolveAnnouncement(annRaw(), { community: comm(), year: 2027 });
check('final run: fees not configured -> refused with a clear error', !r.ok && r.errors.some((e) => /payment fees are not configured/.test(e)), r.errors.join('; '));
r = AS.resolveAnnouncement(annRaw(), { community: comm(), year: 2027, preview: true });
check('preview: fees not configured -> proposed schedule, labeled pending', r.ok && r.ann.fees.pending && r.warnings.some((w) => /payment fees are not configured/.test(w)));
const ph = annRaw({ switch_date: '[[ED: switch date]]' });
r = AS.resolveAnnouncement(ph, { community: comm({ payment_fees: FEES }), year: 2027 });
check('final run: a placeholder is refused', !r.ok && r.errors.some((e) => /placeholder/.test(e)));
r = AS.resolveAnnouncement(ph, { community: comm({ payment_fees: FEES }), year: 2027, preview: true });
check('preview: a placeholder is allowed and flagged', r.ok && r.ann.switch_date.ph === 'ED: switch date');
check('unknown field refused', !AS.resolveAnnouncement(annRaw({ freestyle: 'x' }), { community: comm({ payment_fees: FEES }), year: 2027 }).ok);
check('wrong community refused', !AS.resolveAnnouncement(annRaw({ community: 'Other' }), { community: comm({ payment_fees: FEES }), year: 2027 }).ok);
check('year mismatch refused', !AS.resolveAnnouncement(annRaw(), { community: comm({ payment_fees: FEES }), year: 2028 }).ok);
check('non-https portal refused', !AS.resolveAnnouncement(annRaw({ portal_url: 'http://x.test/' }), { community: comm({ payment_fees: FEES }), year: 2027 }).ok);
check('Vantaca end on or after the switch date refused (one channel at a time)', !AS.resolveAnnouncement(annRaw({ vantaca_end_date: '2027-01-04' }), { community: comm({ payment_fees: FEES }), year: 2027 }).ok);
check('a feature not live for the association refused (final)', !AS.resolveAnnouncement(annRaw({ portal_features: ['financials'] }), { community: comm({ payment_fees: FEES }), year: 2027 }).ok);
check('an unknown feature key refused', !AS.resolveAnnouncement(annRaw({ portal_features: ['pay_with_crypto'] }), { community: comm({ payment_fees: FEES }), year: 2027, preview: true }).ok);
check('notice_text cannot be a placeholder', !AS.resolveAnnouncement(annRaw({ notice_text: '[[x]]' }), { community: comm({ payment_fees: FEES }), year: 2027, preview: true }).ok);

console.log('\nRendered announcement + coupon');
const annOk = AS.resolveAnnouncement(annRaw(), { community: comm({ payment_fees: FEES }), year: 2027 }).ann;
const html = AS.renderStatementsHTML([stmt()], { announcement: annOk });
const pages = html.split('<section class="page').length - 1;
check('announcement page prints before each statement (2 pages per homeowner)', pages === 2 && html.indexOf('trustEd homeowner portal') < html.indexOf('ACCOUNT STATEMENT'));
check('portal URL and two-click sign-in steps', /portal\.example\.test\/portal-login\.html/.test(html) && /click <b>Sign in<\/b>/.test(html));
check('fee schedule printed', /3\.5% processing fee on card payments/.test(html) && /\$5\.95 above \$350\.00/.test(html) && /no fee to pay by check/.test(html));
check('autopay does not transfer; set up again in trustEd', /Automatic payments do not transfer/.test(html) && /set up autopay again/.test(html));
check('Vantaca change note with dates', /Starting January 4, 2027, trustEd is the only place to pay online/.test(html) && /end on January 3, 2027/.test(html));
check('check instructions use the remit address and account number', /PO Box 1/.test(html) && /account number <b>9990001<\/b>/.test(html));
check('the false "instant processing" portal line is gone', !/instant processing/i.test(html) && !/your owner portal/i.test(html));
check('coupon names trustEd as the one online channel', /pay online in the trustEd portal/.test(AS.couponInstructions(stmt(), annOk)) && !/Vantaca/.test(AS.couponInstructions(stmt(), annOk)));
check('coupon without an announcement: checks only, no portal claim', !/online|portal/i.test(AS.couponInstructions(stmt(), null)));
check('notice prints the run wording', /NOTICE FROM RUN/.test(html));
check('default notice states no delinquency rule', !/delinquent|January 31/i.test(AS.DEFAULT_NOTICE));
check('no em-dashes in homeowner copy', !/—/.test(html));
const phAnn = AS.resolveAnnouncement(annRaw({ switch_date: '[[ED: switch date]]' }), { community: comm(), year: 2027, preview: true }).ann;
const phHtml = AS.renderStatementsHTML([stmt()], { announcement: phAnn, sampleLabel: PREVIEW_LABEL });
check('placeholder prints highlighted, never as fact', /<span class="ph">\[ED: switch date\]<\/span>/.test(phHtml));
check('pending fee schedule is labeled', /PENDING: fees are not yet configured/.test(phHtml));

console.log('\nPreview watermark');
const marks = (phHtml.match(/<div class="sample">PREVIEW - NOT FOR MAILING<\/div>/g) || []).length;
check('PREVIEW watermark on every page (announcement and statement)', marks === 2 && pages === 2, `marks=${marks}`);
check('no watermark in a final render', !/class="sample"/.test(html));

console.log('\nRun gates');
const base = { year: '2027', 'rate-cents': '71900', due: '2027-01-01', 'notice-text': 'Due when due.' };
const lb = { bank: 'Test', association_code: '1' };
let g = billingGates({ opts: base, community: comm(), budget: { status: 'draft' }, lockbox: lb });
check('final: draft budget refuses', g.blockers.some((b) => /budget is draft/.test(b)), g.blockers.join('; '));
g = billingGates({ opts: base, community: comm(), budget: null, lockbox: lb });
check('final: no budget refuses', g.blockers.some((b) => /not in TrustEd/.test(b)));
g = billingGates({ opts: { ...base, preview: true }, community: comm(), budget: { status: 'draft' }, lockbox: lb });
check('preview: draft budget is a warning, not a blocker', !g.blockers.length && g.warnings.some((w) => /PREVIEW: 2027 budget is draft/.test(w)), g.blockers.join('; '));
g = billingGates({ opts: { ...base, preview: true, 'rate-cents': undefined }, community: comm(), budget: { status: 'draft' }, lockbox: lb });
check('preview still needs the rate', g.blockers.some((b) => /--rate-cents/.test(b)));
g = billingGates({ opts: { ...base, preview: true }, community: comm(), budget: { status: 'draft' }, lockbox: null });
check('preview still needs a lockbox or --office-remit', g.blockers.some((b) => /office-remit/.test(b)));
g = billingGates({ opts: { ...base, 'notice-text': undefined }, community: comm(), budget: { status: 'approved' }, lockbox: lb });
check('final: no notice wording refuses (never a hard-coded rule)', g.blockers.some((b) => /statement notice/.test(b)));
g = billingGates({ opts: { ...base, 'notice-text': undefined }, community: comm({ payment_fees: FEES }), budget: { status: 'approved' }, lockbox: lb, announcementRaw: annRaw() });
check('final: approved budget + valid announcement passes; notice taken from the announcement', !g.blockers.length && /delinquent if not paid when due/.test(g.noticeText), g.blockers.join('; '));
g = billingGates({ opts: base, community: comm(), budget: { status: 'approved' }, lockbox: lb, announcementRaw: annRaw({ switch_date: '[[x]]' }) });
check('final: announcement placeholders and missing fees refuse', g.blockers.some((b) => /placeholder/.test(b)) && g.blockers.some((b) => /payment fees/.test(b)));

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall annual statement run checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
