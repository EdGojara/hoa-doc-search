// tests/test_close_controls.js  (Ed 2026-10-09: month-end close, PR A)
// The checklist is a pure function of facts from the books: each control's
// PASS / WARNING / BLOCK, the $0.00 bank tolerance, Data Completeness (a balanced
// ledger is not enough), the LOPF broken-entry shape, override binding (the
// evidence hash moves when the numbers move), and determinism.
const { evaluateClose, hash, _test: T } = require('../lib/close/controls');

let pass = 0; let fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); } };
const by = (results, code) => results.find((r) => r.code === code) || {};

const CID = '00000000-0000-0000-0000-0000000000c1';
const facts = (o = {}) => ({ period_start: '2026-09-01', period_end: '2026-09-30', counted_lines: 1200, fingerprint: 'f',
  through_debits_cents: 100000, through_credits_cents: 100000, period_debits_cents: 5000, period_credits_cents: 5000,
  broken_entries: [], draft_entries: [], invalid_dates: [], backdated_into_closed: [], unbalanced_funds: [], voided_without_reversal: [], ...o });
const acct = (id, gl, extra = {}) => ({ id, account_nickname: `Acct ${id}`, gl_account_number: gl, is_active: true, account_last4: '1234', ...extra });
const rec = (id, acctId, o = {}) => ({ id, bank_account_id: acctId, period_end: '2026-09-30', status: 'reconciled', difference_cents: 0, gl_ending_balance_cents: 250000, ...o });
const stmt = (acctId, end = '2026-09-30') => ({ bank_account_id: acctId, statement_period_start: '2026-09-01', statement_period_end: end, status: 'completed' });
const clean = () => ({
  community: { id: CID }, facts: facts(),
  bank: { accounts: [acct('a1', '1000')], statements: [stmt('a1')], recs: [rec('r1', 'a1')], rec_items: [], gl_balances: { 1000: 250000 } },
  ar: { as_of: '2026-09-30', aging_total_cents: 152563, reconciliation: { tied: true, difference_cents: 0, gl_ar_cents: 171527, aging_matches_ledger: true,
    prepaid: { subledger_cents: 11615, gl_cents: 11615, difference_cents: 0 }, owners_in_credit: [{ property_id: 'p', net_cents: -1000 }] } },
  ap: { open_rows: [{ id: 'i1', balance_cents: 47125 }], gl_ap_cents: 47125, ap_account_number: '2000', held: [] },
  recognition: { schedules: [{ id: 's1', description: '2026 assessments', status: { overdue: false, missing_months: [], missing_cents: 0 } }],
    balance_accounts: [{ account_number: '2205', account_name: 'Deferred Assessments', gl_balance_cents: 79449, has_schedule: true }] },
  conversion: { gate: { allowed: true, basis: 'onboarded', conversion: 'CONV-LPF-20260731' }, open_items: [] },
  sources: { requirements: [], homeowner: { applies: true, batches: [{ id: 'b1', period_label: 'Vantaca AR through 9/30', as_of_date: '2026-09-30', source_format: 'csv', status: 'committed' }], mode: 'import' },
    ap_exceptions: [], recurring_gaps: [], other_evidence: [] },
});

console.log('a clean month');
const ok = evaluateClose(clean());
check('every control PASSes on a complete, reconciled, tied month', ok.results.every((r) => r.status === 'PASS'), JSON.stringify(ok.results.filter((r) => r.status !== 'PASS').map((r) => [r.code, r.status, r.explanation])));
check('every result has code, group, label, explanation and an evidence hash; a PASS carries no corrective action',
  ok.results.every((r) => r.code && r.group && r.label && r.explanation && /^[0-9a-f]{32}$/.test(r.evidence_hash) && r.action === null));
check('the summary counts the results', ok.summary.pass === ok.results.length && ok.summary.block === 0 && ok.summary.total === ok.results.length);
check('deterministic: the same facts give byte-identical results', JSON.stringify(evaluateClose(clean())) === JSON.stringify(ok));

console.log('general ledger');
const unbal = evaluateClose({ ...clean(), facts: facts({ through_credits_cents: 99999 }) });
check('debits ≠ credits by one cent: GL-01 BLOCK', by(unbal.results, 'GL-01').status === 'BLOCK' && by(unbal.results, 'GL-01').amount_cents === 1);
const lopf = evaluateClose({ ...clean(), facts: facts({ broken_entries: [
  { reference: 'JE-2026-00169', posting_date: '2026-07-28', problem: 'no_lines', header_debits_cents: 87750, line_debits_cents: 0 },
  { reference: 'JE-2026-00170', posting_date: '2026-07-28', problem: 'no_lines', header_debits_cents: 173150, line_debits_cents: 0 }] }) });
const g2 = by(lopf.results, 'GL-02');
check('LOPF shape: posted entries whose lines were deleted are a BLOCK, named, with what the header says', g2.status === 'BLOCK' && g2.count === 2 && /JE-2026-00169/.test(g2.explanation) && /no lines/.test(g2.explanation) && /reverse it instead/.test(g2.action));
check('a draft dated in the month: GL-03 BLOCK', by(evaluateClose({ ...clean(), facts: facts({ draft_entries: [{ reference: 'JE-9', amount_cents: 100 }] }) }).results, 'GL-03').status === 'BLOCK');
check('an invalid posting date: GL-04 BLOCK', by(evaluateClose({ ...clean(), facts: facts({ invalid_dates: [{ reference: 'JE-9', posting_date: '2026-09-15', problem: 'date_outside_period' }] }) }).results, 'GL-04').status === 'BLOCK');
check('recorded into a closed month after it closed: GL-05 BLOCK', by(evaluateClose({ ...clean(), facts: facts({ backdated_into_closed: [{ reference: 'JE-9', posting_date: '2026-08-15', created_at: '2026-10-02' }] }) }).results, 'GL-05').status === 'BLOCK');
check('a fund out of balance: GL-06 BLOCK', by(evaluateClose({ ...clean(), facts: facts({ unbalanced_funds: [{ fund_code: 'RES', difference_cents: 500 }] }) }).results, 'GL-06').status === 'BLOCK');
check('voided without reversal: GL-07 WARNING (listed, not silently dropped)', by(evaluateClose({ ...clean(), facts: facts({ voided_without_reversal: [{ reference: 'JE-8', amount_cents: 100 }] }) }).results, 'GL-07').status === 'WARNING');

console.log('cash (tolerance is exactly $0.00)');
const cents = clean(); cents.bank.recs = [rec('r1', 'a1', { difference_cents: 1 })];
check('a ONE-CENT unreconciled difference is a BLOCK (no tolerance)', by(evaluateClose(cents).results, 'CASH-01').status === 'BLOCK' && /\$0\.01/.test(by(evaluateClose(cents).results, 'CASH-01').explanation));
const inprog = clean(); inprog.bank.recs = [rec('r1', 'a1', { status: 'in_progress', difference_cents: null })];
check('a reconciliation still in progress is a BLOCK', by(evaluateClose(inprog).results, 'CASH-01').status === 'BLOCK');
const norec = clean(); norec.bank.recs = [];
check('no reconciliation for the month is a BLOCK', /no reconciliation/.test(by(evaluateClose(norec).results, 'CASH-01').explanation));
const glOff = clean(); glOff.bank.gl_balances = { 1000: 249900 };
check('reconciled book balance ≠ GL cash: CASH-02 BLOCK with the difference', by(evaluateClose(glOff).results, 'CASH-02').status === 'BLOCK' && by(evaluateClose(glOff).results, 'CASH-02').amount_cents === 100);
const shared = clean(); shared.bank.accounts.push(acct('a2', '1000')); shared.bank.statements.push(stmt('a2')); shared.bank.recs.push(rec('r2', 'a2', { gl_ending_balance_cents: 0 }));
check('two physical accounts on one GL cash account: CASH-03 WARNING (NewFirst 5313 case)', by(evaluateClose(shared).results, 'CASH-03').status === 'WARNING' && by(evaluateClose(shared).results, 'CASH-02').status === 'PASS');
const stale = clean(); stale.bank.rec_items = [{ reconciliation_id: 'r1', category: 'outstanding_check', amount_cents: -4500, date_ref: '2026-05-01', check_number: '1042' },
  { reconciliation_id: 'r1', category: 'deposit_in_transit', amount_cents: 9000, date_ref: '2026-09-30' }];
const c4 = by(evaluateClose(stale).results, 'CASH-04');
check('reconciling items listed; an outstanding check over 90 days is a WARNING naming it', c4.status === 'WARNING' && /#1042/.test(c4.explanation) && c4.count === 2);
const manual = clean(); manual.bank.rec_items = [{ reconciliation_id: 'r1', category: 'manual_adjustment', amount_cents: 3 }];
check('a manual adjustment item is a WARNING (explicit, documented; not tolerance)', by(evaluateClose(manual).results, 'CASH-04').status === 'WARNING');

console.log('homeowners and AP');
const arOff = clean(); arOff.ar.reconciliation = { ...arOff.ar.reconciliation, tied: false, difference_cents: -715000 };
check('AR not tied to 1300: AR-01 BLOCK, and the action says not to post to make it tie', by(evaluateClose(arOff).results, 'AR-01').status === 'BLOCK' && /Do not post/.test(by(evaluateClose(arOff).results, 'AR-01').action));
const ppOff = clean(); ppOff.ar.reconciliation.prepaid = { subledger_cents: 11615, gl_cents: 12000, difference_cents: -385 };
check('owner credits ≠ GL 2400: AR-02 BLOCK', by(evaluateClose(ppOff).results, 'AR-02').status === 'BLOCK');
const lopf2400 = clean(); lopf2400.ar.reconciliation.prepaid = { subledger_cents: 742781, gl_cents: 776288, difference_cents: -33507 }; lopf2400.ar.former_credit_cents = 33507; lopf2400.ar.former_credit_count = 5; lopf2400.ar.gl_2410_cents = null;
check('LOPF 9/30: current $7,427.81 + former owners’ $335.07 = GL 2400 $7,762.88: AR-02 PASS', by(evaluateClose(lopf2400).results, 'AR-02').status === 'PASS');
const cg2410 = clean(); cg2410.ar.reconciliation.prepaid = { subledger_cents: 743261, gl_cents: 918905, difference_cents: -175644 }; cg2410.ar.former_credit_cents = 470728; cg2410.ar.former_credit_count = 8; cg2410.ar.gl_2410_cents = 295084;
check('Canyon Gate 9/30: current $7,432.61 + former $4,707.28 = 2400 $9,189.05 + 2410 $2,950.84: AR-02 PASS', by(evaluateClose(cg2410).results, 'AR-02').status === 'PASS' && /2410/.test(by(evaluateClose(cg2410).results, 'AR-02').explanation));
check('owner credit balances are listed separately (AR-03)', by(ok.results, 'AR-03').count === 1);
check('AR aging failing to compute is a BLOCK, never a silent pass', by(evaluateClose({ ...clean(), ar: { error: 'boom' } }).results, 'AR-01').status === 'BLOCK');
const apOff = clean(); apOff.ap.gl_ap_cents = 43715;   // LOPF: the stray $3,409.50 debit in 2000
check('open AP ≠ GL 2000: AP-01 BLOCK with the difference ($3,409.50 LOPF shape)', by(evaluateClose(apOff).results, 'AP-01').status === 'BLOCK' && by(evaluateClose(apOff).results, 'AP-01').amount_cents === 3410);
const held = clean(); held.ap.held = [{ id: 'h', vendor: 'Lake Pro', vendor_invoice_number: '9', total_cents: 1000, status: 'on_hold' }];
check('held / disputed / review invoices: AP-02 WARNING', by(evaluateClose(held).results, 'AP-02').status === 'WARNING');

console.log('recognition and conversion');
const behind = clean(); behind.recognition.schedules[0].status = { overdue: true, missing_months: ['2026-09-01'], missing_cents: 13241 };
check('recognition due through period end not posted: REC-01 BLOCK (only the owner can close past it)', by(evaluateClose(behind).results, 'REC-01').status === 'BLOCK' && /owner/.test(by(evaluateClose(behind).results, 'REC-01').action));
const notOnb = clean(); notOnb.conversion.gate = { allowed: false, basis: 'not_onboarded', reason: 'Still Creek Ranch has not been onboarded into trustEd yet.' };
check('a community not onboarded: CONV-01 BLOCK with the lifecycle reason', by(evaluateClose(notOnb).results, 'CONV-01').status === 'BLOCK' && /not been onboarded/.test(by(evaluateClose(notOnb).results, 'CONV-01').explanation));
const items = clean(); items.conversion.open_items = [{ id: 'x', kind: 'deferral_residue', account_number: '2205', amount_cents: 12 }];
check('an open conversion reconciling item is DISCLOSED (WARNING), not an accounting error', by(evaluateClose(items).results, 'CONV-02').status === 'WARNING');

console.log('data completeness: a balanced ledger is not enough');
const noFeed = clean(); noFeed.sources.homeowner.batches = [{ id: 'conv', period_label: 'Conversion opening balances 2026-07-31', as_of_date: '2026-07-31', source_format: 'manual', status: 'committed' },
  { id: 'payoff', period_label: 'Closing payoff check', as_of_date: '2026-10-01', source_format: 'manual', status: 'committed' }];
const d1 = by(evaluateClose(noFeed).results, 'DATA-01');
check('no homeowner feed covering the month: DATA-01 BLOCK, even though every GL control passes', d1.status === 'BLOCK' && evaluateClose(noFeed).results.filter((r) => r.group === 'General ledger').every((r) => r.status === 'PASS'));
check('a manual one-off row or the conversion opening is not a feed (the 10/1 manual payoff does not satisfy September)', /not a feed/.test(d1.explanation));
const reverted = clean(); reverted.sources.homeowner.batches[0].status = 'reverted';
check('a reverted import does not count', by(evaluateClose(reverted).results, 'DATA-01').status === 'BLOCK');
const nativeOk = clean(); nativeOk.sources.homeowner = { applies: true, batches: [], mode: 'native', assessment_revenue_cents: 1324125, receipt_entries: 41 };
check('native billing: assessment revenue AND receipts posted in the month satisfies the feed', by(evaluateClose(nativeOk).results, 'DATA-01').status === 'PASS');
const cgShape = clean(); cgShape.sources.homeowner = { applies: true, batches: [], mode: 'native', assessment_revenue_cents: 0, receipt_entries: 41 };
check('Canyon Gate shape: receipts but $0 assessment revenue in the month is a BLOCK', by(evaluateClose(cgShape).results, 'DATA-01').status === 'BLOCK' && /no assessment revenue/.test(by(evaluateClose(cgShape).results, 'DATA-01').explanation));
const noHo = clean(); noHo.sources.homeowner = { applies: false };
check('no homeowner ledger at all: the feed is not required', by(evaluateClose(noHo).results, 'DATA-01').status === 'PASS');
const noStmt = clean(); noStmt.bank.statements = [stmt('a1', '2026-08-29')];
check('the statement must end within the month (an August statement does not cover September): DATA-02 BLOCK', by(evaluateClose(noStmt).results, 'DATA-02').status === 'BLOCK');
const busDay = clean(); busDay.bank.statements = [stmt('a1', '2026-09-29')];
check('a statement cycle ending on a business day inside the month (9/29) counts', by(evaluateClose(busDay).results, 'DATA-02').status === 'PASS');
const bare = clean(); bare.recognition.balance_accounts.push({ account_number: '1400', account_name: 'Prepaid Insurance', gl_balance_cents: 1200000, has_schedule: false });
check('a prepaid/deferred balance with no recognition schedule: DATA-03 BLOCK', by(evaluateClose(bare).results, 'DATA-03').status === 'BLOCK' && /1400/.test(by(evaluateClose(bare).results, 'DATA-03').explanation));
const exc = clean(); exc.sources.ap_exceptions = [{ id: 'e', vendor_name: 'Comcast', total_cents: 18900, reason: 'no_vendor' }];
check('a bill received but not booked (intake exception): DATA-04 BLOCK', by(evaluateClose(exc).results, 'DATA-04').status === 'BLOCK');
const gaps = clean(); gaps.sources.recurring_gaps = [{ vendor_id: 'v', vendor: 'Star Protection Agency' }];
check('a monthly vendor with no bill this month: DATA-05 WARNING (not a guess at a BLOCK)', by(evaluateClose(gaps).results, 'DATA-05').status === 'WARNING');
const other = clean(); other.sources.requirements = [{ id: 'aaaaaaaa-1111-2222-3333-444444444444', source_key: 'other', label: 'Edward Jones statement', required: true }];
check('a configured "other" source with no evidence for the month: BLOCK', evaluateClose(other).results.some((r) => r.code.startsWith('DATA-OTHER-') && r.status === 'BLOCK'));
other.sources.other_evidence = [{ id: 'ev', requirement_id: 'aaaaaaaa-1111-2222-3333-444444444444', provided_by: 'kat@x', document_ref: 'library_documents:1' }];
check('... and PASS once evidence is provided', evaluateClose(other).results.some((r) => r.code.startsWith('DATA-OTHER-') && r.status === 'PASS'));
const off = clean(); off.sources.homeowner.batches = []; off.sources.requirements = [{ source_key: 'homeowner_feed', required: false, set_reason: 'association bills through its MUD directly' }];
check('a source turned off by configuration PASSes and says why', by(evaluateClose(off).results, 'DATA-01').status === 'PASS' && /MUD/.test(by(evaluateClose(off).results, 'DATA-01').explanation));

console.log('override binding');
const a1 = by(evaluateClose(apOff).results, 'AP-01').evidence_hash;
const apOff2 = clean(); apOff2.ap.gl_ap_cents = 43700;
check('the evidence hash changes when the BLOCK\'s numbers change (an override cannot carry to different evidence)', a1 !== by(evaluateClose(apOff2).results, 'AP-01').evidence_hash);
check('... and is identical for identical evidence', a1 === by(evaluateClose(apOff).results, 'AP-01').evidence_hash);
check('hash() is key-order independent', hash({ a: 1, b: [1, 2] }) === hash({ b: [1, 2], a: 1 }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
