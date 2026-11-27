// ============================================================================
// tests/test_newfirst_iremit.js  (Ed 2026-11-23)
// Synthetic data only (the repo is public). Real ZIPs, when IREMIT_FIXTURES points at
// a directory of them, must tie too.
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const X = require('../lib/banking/extractors/newfirst_iremit');
const I = require('../lib/ar/iremit_receipts');
const R = require('../lib/ar/vantaca_receipts');

let n = 0; const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const rec = (date, assoc, acct, cents, chk) => `${date}${assoc.padStart(6, '0')}${acct.padStart(12, '0')}${String(cents).padStart(10, '0')}${chk}${' '.repeat(20)}`;
const D = '20261103';
const txtOf = (lines) => Buffer.from(lines.join('\r\n') + '\r\n');
const LINES = [rec(D, '101', '99900000001', 5500, X.ECHECK), rec(D, '020', '99900000002', 65400, X.CARD), rec(D, '020', '2099001', 7190, '00012345'), rec(D, '020', '99900000003', 5000, X.ECHECK)];
const txt = () => X.parseTxt(txtOf(LINES), { filename: 'Lockbox_HOU_20261103_NFB.txt' });

const detail = (rows, date = '11/03/2026', epay = true) => `  Remittance Report\n Account Name :  CLIENT ${epay ? 'ECHECK' : ''}Report Date :   ${date}\n Remittance Number   Name   Check #\n`
  + rows.map((r) => `   ${r[0]}      ${r[1]}          ${r[2]}      ${r[3]}      ${r[3]}${epay ? `ACH      ${r[4]}` : ''}`).join('\n')
  + `\n        Totals:   ${rows.length} checks   ${rows.reduce((s, r) => s + Number(r[3].replace(',', '')), 0).toFixed(2)}   ${rows.reduce((s, r) => s + Number(r[3].replace(',', '')), 0).toFixed(2)}\n`;
const summary = (rows, date = '11/03/2026') => `  Summary Report\n ECHECKReport Date :  ${date}\n Association   DDA#   Remittance Item   Total Deposit\n`
  + rows.map((r) => `   ${r[0]}      ${r[1]}   xx${r[2]}      ${r[3]}      ${r[4]}`).join('\n')
  + `\n   Totals:   ${rows.reduce((s, r) => s + r[3], 0)}   ${rows.reduce((s, r) => s + Number(r[4]), 0).toFixed(2)}\n`;
const reports = () => ({
  epay_detail: X.parseDetail(detail([['99900000001', 'Pat Example', '111111', '55.00', 'ECK'], ['99900000002', 'Sam Sample', '999999', '654.00', 'CC'], ['99900000003', 'Lee Test', '111111', '50.00', 'ECK']])),
  epay_summary: X.parseSummary(summary([['020', 'ONE HOA INC', '2222', 2, '704.00'], ['101', 'TWO OWNERS ASSN', '3333', 1, '55.00']])),
  check_detail: X.parseDetail(detail([['2099001', 'DANA OWNER', '0000012345', '71.90']], '11/03/2026', false)),
  check_summary: X.parseSummary(summary([['020', 'ONE HOA INC', '2222', 1, '71.90']])),
  images: X.parseImages('Date Processed: 11/03/2026\nImage Report\n Batch: 100001 Seq: 1 Remittance #: 2099001 Remittance Name: DANA OWNER Check#: 0000012345      Amount: 71.90 Image 1 of 1'),
});

t('layout: date, association, account, cents, check number and type', () => {
  const r = txt(); assert.deepStrictEqual(r.defects, []);
  assert.deepStrictEqual(r.records.map((x) => [x.date, x.association_code, x.account, x.amount_cents, x.kind, x.check_number]), [
    ['2026-11-03', '101', '99900000001', 5500, 'echeck', null], ['2026-11-03', '020', '99900000002', 65400, 'card', null],
    ['2026-11-03', '020', '2099001', 7190, 'check', '00012345'], ['2026-11-03', '020', '99900000003', 5000, 'echeck', null]]);
});
t('an unreadable record makes the file unusable, never skipped', () => {
  const cut = LINES[0].slice(0, 63);
  for (const bad of [cut, LINES[0].replace('0000005500', '00000A5500'), LINES[0].replace('0000005500', '0000000000'), LINES[0].slice(0, 63) + 'X', rec('20261303', '101', '1', 1, X.ECHECK)]) {
    const p = X.parseTxt(txtOf([LINES[1], bad]), { filename: 'x.txt' }); assert.strictEqual(p.defects.length, 1);
    assert.strictEqual(X.tieOut(p, reports()).ok, false);
  }
  assert.ok(X.parseTxt(txtOf([LINES[0]]), { filename: 'Lockbox_HOU_20261104_NFB.txt' }).defects[0].includes("is not the file's"));
  assert.strictEqual(X.parseTxt(Buffer.from(''), { filename: 'x.txt' }).defects.length, 1);
});
t('identity: placeholder numbers never identify; identical payments are numbered; a dashed account is flagged', () => {
  const p = X.parseTxt(txtOf([LINES[0], LINES[0], rec(D, '101', '99900000009', 5500, X.ECHECK), `${D}00010199-0000-0001000000512500111111${' '.repeat(20)}`]), { filename: 'x.txt' });
  assert.strictEqual(new Set(p.records.map((r) => r.ref)).size, 4);
  assert.ok(p.records[1].ref.endsWith('#2')); assert.ok(!/111111/.test(p.records[0].ref));
  assert.strictEqual(p.records[3].account_irregular, true);
});
t('reports tie to their own totals', () => {
  const r = reports(); for (const k of ['epay_detail', 'epay_summary', 'check_detail', 'check_summary']) assert.deepStrictEqual(r[k].defects, [], k);
  assert.strictEqual(r.images.rows[0].batch, '100001');
  assert.ok(X.parseDetail(detail([['1', 'A B', '111111', '5.00', 'ECK']]).replace('1 checks', '2 checks')).defects.length);
});
t('tie-out: every record pairs with one report row; checks get batch and sequence', () => {
  const r = X.tieOut(txt(), reports()); assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.records[2].batch, '100001'); assert.strictEqual(r.records[1].bank_last4, '2222'); assert.strictEqual(r.records[0].bank_name, 'Pat Example');
});
t('tie-out refuses: a missing report, a changed amount, a wrong date, a missing image, an extra report row', () => {
  const bad = (f) => { const r = reports(); f(r); return X.tieOut(txt(), r); };
  assert.ok(!bad((r) => { delete r.epay_summary; }).ok);
  assert.ok(!bad((r) => { r.epay_detail.rows[0].amount_cents = 5501; }).ok);
  assert.ok(!bad((r) => { r.check_detail.date = '2026-11-04'; }).ok);
  assert.ok(!bad((r) => { delete r.images; }).ok);
  assert.ok(!bad((r) => { r.epay_detail.rows.push({ ...r.epay_detail.rows[0] }); }).ok);
  assert.ok(!bad((r) => { r.epay_summary.associations['020'].cents = 1; }).ok);
  assert.ok(!bad((r) => { r.epay_detail.rows[1].kind = 'echeck'; }).ok);
});

// ---- planning -----------------------------------------------------------------
const owners = new Map([['2099002', 'Sam & Jo Sample'], ['2099001', 'Dana Owner'], ['2099003', 'Someone Else']]);
const cross = [{ association_code: '020', remittance_account: '99900000002', vantaca_account_id: '2099002', status: 'confirmed' }, { association_code: '020', remittance_account: '99900000003', vantaca_account_id: '2099003', status: 'confirmed' }];
const files = () => [{ sha256: 'a'.repeat(64), filename: 'f.txt', tie: X.tieOut(txt(), reports()) }];
const facts = (extra = {}) => ({ community: { id: 'c', gl_cutover_date: '2026-08-01' }, accounts: new Map([...owners.keys()].map((a, i) => [a, [{ property_id: `p${i}`, tenure_id: `t${i}`, current: true }]])),
  existingRefs: [], existingPayments: [], glArCredits: [], existingJeRefs: new Set(), gl: { cash_by_last4: { 2222: '1000' }, default_cash: '1000', ar: '1300', fee: '1380' }, undeposited: '1020', ...extra });
const items = (o = {}) => I.toItems({ files: files(), communityName: 'Lakes of Pine Forest', owners, crosswalk: cross, ...o });
const W = { from: '2026-11-01', to: '2026-11-30' };
const ref = (a) => items().items.find((x) => x.provenance.remittance_account === a).vantaca_ref;

t('only this association; unknown codes are never assigned; Canyon Gate has no code and refuses', () => {
  const x = items(); assert.strictEqual(x.items.length, 3); assert.strictEqual(x.excluded[0].reason, 'other_association');
  assert.throws(() => I.toItems({ files: files(), communityName: 'Canyon Gate at Cinco Ranch' }), /no verified iRemit association code/);
});
t('a payment is ready only when every condition holds; the rest are held with the reason', () => {
  const p = I.plan(items(), facts(), W);
  const by = Object.fromEntries(p.items.map((i) => [i.provenance.remittance_account, [i.status, i.reason]]));
  assert.deepStrictEqual(by['99900000002'], ['proposed', null]);
  assert.deepStrictEqual(by['2099001'], ['held', 'check_image_review']);
  assert.deepStrictEqual(by['99900000003'], ['held', 'bank_name_differs_from_owner']);
  assert.strictEqual(p.ties, true); assert.strictEqual(p.proposed_cents, 65400); assert.strictEqual(p.held_cents, 12190);
});
t('crosswalk: unconfirmed, other-association and conflicting rows never match', () => {
  const why = (cw) => I.plan(items({ crosswalk: cw }), facts(), W).items.find((i) => i.provenance.remittance_account === '99900000002').reason;
  assert.strictEqual(why([{ ...cross[0], status: 'proposed' }]), 'account_not_in_crosswalk');
  assert.strictEqual(why([{ ...cross[0], association_code: '101' }]), 'account_not_in_crosswalk');
  assert.strictEqual(why([cross[0], { ...cross[0], vantaca_account_id: '2099003' }]), 'crosswalk_conflict');
});
t('entries: payment Dr 1020 / Cr 1300, deposit Dr cash / Cr 1020, 1020 nets to zero, ids stable', () => {
  const p = I.plan(items({ reviewedChecks: new Set([ref('2099001')]) }), facts(), W);
  assert.strictEqual(p.kat_items.length, 4);
  for (const i of p.kat_items) assert.strictEqual(i.lines.reduce((s, l) => s + l.debit_cents - l.credit_cents, 0), 0);
  assert.strictEqual(p.kat_items.flatMap((i) => i.lines).filter((l) => l.account_number === '1020').reduce((s, l) => s + l.debit_cents - l.credit_cents, 0), 0);
  assert.ok(p.kat_items.filter((i) => i.homeowner).every((i) => i.homeowner.charge_category === 'payment' && i.homeowner.property_id));
  const again = I.plan(items({ reviewedChecks: new Set([ref('2099001')]) }), facts(), W);
  assert.deepStrictEqual(again.kat_items.map((i) => i.id), p.kat_items.map((i) => i.id));
  assert.ok(!JSON.stringify(p.kat_items).includes('111111'));
});
t('duplicates: a same-amount payment from any channel within 10 days holds it; 11 days does not', () => {
  const hit = (date) => I.plan(items(), facts({ existingPayments: [{ id: 'x', vantaca_account_id: '2099002', property_id: 'p0', date, amount_cents: 65400, source: 'vantaca_deposit_register' }] }), W).items.find((i) => i.provenance.remittance_account === '99900000002').reason;
  assert.strictEqual(hit('2026-10-24'), 'possible_duplicate_of_existing_payment'); assert.strictEqual(hit('2026-10-23'), null);
});
t('a payment waiting in an open run, or a deposit already on the cash account, holds it', () => {
  const why = (x) => I.plan(items(), facts(x), W).items.find((i) => i.provenance.remittance_account === '99900000002');
  const lines = [{ account_number: '1020', debit_cents: 65400, credit_cents: 0 }, { account_number: '1300', debit_cents: 0, credit_cents: 65400 }];
  assert.strictEqual(why({ openRuns: [{ id: 'r', preview: { submitted: [{ id: 'i', posting_date: '2026-11-05', lines, homeowner: { property_id: 'p0' } }] } }] }).reason, 'possible_duplicate_of_existing_payment');
  assert.strictEqual(why({ openRuns: [{ id: 'r', preview: { proposals: [{ id: 'i', posting_date: '2026-11-05', receipts: [{ n: 1, property_id: 'p0', payment_date: '2026-11-02', lines }] }] } }] }).reason, 'possible_duplicate_of_existing_payment');
  const susp = (date, amt = 65400) => [{ id: 'r', preview: { proposals: [{ id: 's', posting_date: date, lines: [{ account_number: '1000', debit_cents: amt }, { account_number: '2420', credit_cents: amt }] }] } }];
  assert.strictEqual(why({ openRuns: susp('2026-11-04') }).reason, 'deposit_may_already_be_recorded');
  assert.strictEqual(why({ cashDebits: [{ account_number: '1000', amount_cents: 65400, date: '2026-11-04', ref: 'JE-1' }] }).reason, 'deposit_may_already_be_recorded');
  assert.strictEqual(why({ openRuns: susp('2026-11-20') }).status, 'proposed');
  assert.strictEqual(why({ openRuns: susp('2026-11-04', 65401) }).status, 'proposed');
});
t('the same file twice, or the same payment in two files, is refused', () => {
  const f = files()[0];
  assert.strictEqual(items({ files: [f, f] }).refused.length, 1);
  const g = { ...f, sha256: 'b'.repeat(64) }; const x = items({ files: [f, g] });
  assert.strictEqual(x.items.length, 3); assert.strictEqual(x.refused.length, 3);
});
t('a file that does not tie contributes nothing', () => {
  const f = files()[0]; const x = items({ files: [{ ...f, tie: { ok: false, problems: ['p'], records: f.tie.records } }] });
  assert.strictEqual(x.items.length, 0); assert.strictEqual(x.refused.length, 1);
});
t('no undeposited account refuses; an unknown bank account or a former owner holds', () => {
  assert.throws(() => I.plan(items(), facts({ undeposited: null }), W), /undeposited/);
  const g = facts(); g.gl = { ...g.gl, cash_by_last4: {} };
  assert.strictEqual(I.plan(items(), g, W).items.find((i) => i.provenance.remittance_account === '99900000002').reason, 'bank_account_not_in_trusted');
  const h = facts(); h.accounts.set('2099002', [{ property_id: 'p0', tenure_id: 't', current: false }]);
  const p = I.plan(items(), h, W); assert.strictEqual(p.items.find((i) => i.provenance.remittance_account === '99900000002').reason, 'not_the_current_owner'); assert.strictEqual(p.kat_items.length, 0);
});
t('the Vantaca posting path never sees an iRemit item', () => {
  const p = R.planReceipts({ items: items().items, excluded: [] }, facts(), W);
  assert.strictEqual(p.entries.length, 0); assert.strictEqual(p.ledgerRows.length, 0);
});
t('bank match: one line of the same amount within 3 days, each line used once', () => {
  const p = I.plan(items(), facts(), W); const m = (lines) => I.matchBank(p.kat_items, lines)[0].status;
  assert.strictEqual(m([{ id: 1, date: '2026-11-04', amount_cents: 65400 }]), 'matched');
  assert.strictEqual(m([{ id: 1, date: '2026-11-09', amount_cents: 65400 }]), 'no_bank_line');
  assert.strictEqual(m([{ id: 1, date: '2026-11-03', amount_cents: 65400 }, { id: 2, date: '2026-11-04', amount_cents: 65400 }]), 'several_bank_lines');
});
t('a checking account and its sweep sharing four digits resolve to operating cash; any other tie is no answer', () => {
  const b = (n, gl, a = true) => ({ account_last4: n, gl_account_number: gl, is_active: a });
  assert.deepStrictEqual(R.cashByLast4([b('2222', '1005'), b('2222', '1000'), b('3333', '1100'), b('3333', '1200'), b('4444', '1010'), b('5555', '1000', false)], '1000'), { 2222: '1000', 3333: null, 4444: '1010' });
});
t('names: one shared word of three letters; initials and suffixes do not count', () => {
  assert.ok(I.namesAgree('SAMPLEY', 'Pat Q Sampley')); assert.ok(!I.namesAgree('J R Jr', 'Jr LLC')); assert.ok(!I.namesAgree('', 'X')); assert.ok(!I.namesAgree(undefined, null));
});

(async () => {
  const dir = process.env.IREMIT_FIXTURES;
  if (dir && fs.existsSync(dir)) {
    const { readZip } = require('../scripts/newfirst_iremit');
    for (const f of fs.readdirSync(dir).filter((x) => /\.zip$/i.test(x))) {
      const r = await readZip(fs.readFileSync(path.join(dir, f)));
      for (const x of r.files) assert.ok(x.tie.ok, `${x.filename}: ${x.tie.problems.join('; ')}`);
      n++; console.log(`  ok  real ZIP: ${r.files.length} files tie to their reports`);
    }
  }
  console.log(`\n${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
