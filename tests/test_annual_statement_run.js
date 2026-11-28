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
{ const gd = billingGates({ opts: { ...base, disclosure: 'Note' }, community: comm(), budget: { status: 'approved' }, lockbox: lb }); check('disclosure: free text without a recorded approval blocks a billing run', gd.blockers.some((b) => /disclosure-approved/.test(b))); }
{ const gd = billingGates({ opts: { ...base, disclosure: 'Note', preview: true }, community: comm(), budget: { status: 'draft' }, lockbox: lb }); check('disclosure: in a preview it only warns', !gd.blockers.some((b) => /disclosure/.test(b)) && gd.warnings.some((w) => /disclosure-approved/.test(w))); }
{ const gd = billingGates({ opts: { ...base, disclosure: 'Note', 'disclosure-approved': 'Board, 12/1/2026, minutes' }, community: comm(), budget: { status: 'approved' }, lockbox: lb }); check('disclosure: an approved wording passes and is carried', !gd.blockers.some((b) => /disclosure/.test(b)) && gd.billing.disclosure_approved === 'Board, 12/1/2026, minutes'); }

// Counsel hold: accounts in bankruptcy / with counsel never reach the print file.
{
  const { applyCounselHolds, counselHoldReason } = require('../scripts/build_annual_statements');
  const st = (property_id, state, extra = {}) => ({ property_id, state, ...extra });
  const D = (property_id) => ({ property_id, account_number: property_id, addressee: { name: 'X' }, prior_balance_cents: 1000 });
  const r = applyCounselHolds([D('a'), D('b'), D('c'), D('d'), D('e')],
    [st('a', 'in_bankruptcy', { attorney_firm: 'Firm' }), st('b', 'at_legal'), st('c', 'current')],
    new Map([['d', 74255], ['c', 500]]));
  check('counsel hold: bankruptcy and at-legal held, current and clean mailed', r.held.map((h) => h.d.property_id).join() === 'a,b,d' && r.mail.map((d) => d.property_id).join() === 'c,e');
  check('counsel hold: legal fees with no enforcement state are HELD (§209.0064), and listed', r.unflagged.length === 1 && r.unflagged[0].d.property_id === 'd' && r.held[2].state === 'legal_fees_unflagged' && /209.0064/.test(r.held[2].reason));
  const r2 = applyCounselHolds([D('d')], [], new Map([['d', 74255]]), new Set(['d']));
  const { printedLegalFees } = require('../scripts/build_annual_statements');
  const pl = printedLegalFees([{ property_id: 'p', amount_cents: 5000, transaction_date: '2026-07-31' }, { property_id: 'q', amount_cents: 2500, transaction_date: '2026-10-12' }, { property_id: 'q', amount_cents: -2500, transaction_date: '2026-10-20' }], '2026-10-01');
  check('legal fees: only fees that print (dated in the activity window) count; older fees in the balance forward do not', !pl.has('p') && pl.get('q') === 2500);
  check('legal fees: with no activity window nothing is itemized, so nothing is held', printedLegalFees([{ property_id: 'q', amount_cents: 2500, transaction_date: '2026-10-12' }], null).size === 0);
  check('counsel hold: an account on the legal-fee sign-off list is mailed', r2.mail.length === 1 && r2.held.length === 0 && r2.unflagged.length === 1);
  check('counsel hold: reason names the firm', /bankruptcy/i.test(r.held[0].reason) && /Firm/.test(r.held[0].reason));
  check('counsel hold: every non-current state holds', ['in_bankruptcy', 'at_legal', 'in_collections', 'lien_filed', 'judgment', 'on_payment_plan'].every((k) => counselHoldReason({ state: k })) && !counselHoldReason({ state: 'current' }) && !counselHoldReason(null));
  check('counsel hold: empty inputs are safe', applyCounselHolds([], null).mail.length === 0);
}

// Full statements: activity since a date, deferrals, counsel notices.
{
  const { parseAccountList, applyDefer, counselNotices } = require('../scripts/build_annual_statements');
  const S = require('../lib/statements/assessment_statement');
  const L = (date, amount_cents, txn_type = 'charge', description = 'x') => ({ transaction_date: date, amount_cents, txn_type, description });
  const led = [L('2026-07-31', 142500), L('2026-09-05', -20000, 'payment'), L('2026-10-27', -26700, 'payment', 'Payment: Vantaca Pay eCheck VPAY payout 2026-11-02 (deposited 2026-11-02)')];
  const w = S.activityWindow(led, 95800, '2026-10-01');
  check('activity: opening is the balance before the window and the lines foot to the balance', w.opening === 122500 && w.rows.length === 1 && w.opening + w.rows[0].amount_cents === 95800);
  let threw = false; try { S.activityWindow(led, 95801, '2026-10-01'); } catch (_) { threw = true; }
  check('activity: a ledger that does not tie to the balance refuses', threw);
  const many = Array.from({ length: 20 }, (_, i) => L(`2026-10-${String(i + 1).padStart(2, '0')}`, 100));
  const w2 = S.activityWindow(many, 2000, '2026-10-01');
  check('activity: extra lines fold into the balance forward, never drop', w2.rows.length === 9 && w2.opening === 1100);
  check('activity: payment label is plain, with no payout reference', S.activityLabel(led[2]) === 'Payment received (eCheck)' && S.activityLabel(L('x', -1, 'payment', 'Chk #2163 - Payment')) === 'Payment received (check #2163)');
  check('activity: a returned payment keeps its own words', /Returned payment/.test(S.activityLabel(L('x', 20000, 'charge', 'Returned payment: insufficient funds (settled 2026-10-15)'))));
  const df = parseAccountList('# note\n100,receipt pending\n\n200\n999,typo');
  const r = applyDefer([{ account_number: '100' }, { account_number: '200' }, { account_number: '300' }], df);
  check('defer: listed accounts leave the batch with their reason; unmatched reported', r.mail.map((d) => d.account_number).join() === '300' && r.deferred[0].reason === 'receipt pending' && r.unmatched.join() === '999');
  const D = (n, why = []) => ({ account_number: n, _why: why, association: { name: 'A' }, mgmt: { name: 'M', line1: '1', city: 'C' }, addressee: { name: 'N', street: 'S', cityline: 'C' }, property_address: 'P', asOf: new Date('2026-11-23'), disclosure: 'note' });
  const cn = counselNotices([{ d: D('1'), state: 'at_legal', firm: 'F' }, { d: D('2'), state: 'in_bankruptcy', firm: 'F' }, { d: D('3'), state: 'at_legal', firm: 'Unknown' }, { d: D('4', ['no complete mailing address']), state: 'at_legal', firm: 'F' }], { F: { name: 'F', lines: ['123 Main', '555'] } });
  check('counsel notice: never a bankruptcy, an unknown firm or an incomplete address', cn.send.map((x) => x.d.account_number).join() === '1' && cn.none.length === 3);
  const cn2 = counselNotices([{ d: D('5'), state: 'on_payment_plan', firm: 'F' }, { d: D('6'), state: 'in_collections', firm: 'F' }, { d: D('7'), state: 'legal_fees_unflagged', firm: null }, { d: D('8'), state: 'lien_filed', firm: 'F' }, { d: D('9'), state: 'judgment', firm: 'F' }], { F: { name: 'F', lines: ['123 Main'] } });
  check('counsel notice: only accounts with counsel (at legal, lien, judgment), never a payment plan or collections', cn2.send.map((x) => x.d.account_number).join() === '8,9' && cn2.none.length === 3 && /not with counsel/.test(cn2.none[0].why));
  const cn3 = counselNotices([{ d: D('10'), state: 'at_legal', firm: 'F (board moving matters to G, 10/29/26)' }], { F: { name: 'F', lines: ['123 Main'] }, 'F (board moving matters to G, 10/29/26)': { name: 'F', lines: ['x'] } });
  check('counsel notice: a firm on file with a note (a firm transition) never gets a notice', cn3.send.length === 0 && /confirm the current firm/.test(cn3.none[0].why));
  check('activity: balance forward names the date it is before; folded lines move it later', w.forwardBefore === '2026-10-27' && w2.forwardBefore === '2026-10-12' && S.activityWindow([L('2026-07-31', 500)], 500, '2026-10-01').forwardBefore === '2026-10-01');
  check('activity: an interest correction reads as plain words', S.activityLabel(L('x', 41, 'charge', 'Interest correction for 2026-08: $4.42 posted, $4.83 due')) === 'Late interest adjustment');
  const html = S.renderCounselNoticesHTML(cn.send, { year: 2027, assessment_cents: 150000, due_date: '2027-01-01' });
  const body = html.split('<body>')[1];
  check('counsel notice: assessment and firm, no coupon or pay instruction', /1,500\.00/.test(body) && /123 Main/.test(body) && !/PAY THIS AMOUNT|Mail Checks|class="coupon"/.test(body) && body.includes(S.COUNSEL_MESSAGE));
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall annual statement run checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
