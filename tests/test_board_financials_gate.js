// tests/test_board_financials_gate.js  (Ed 2026-10-08)
// Board-facing financial / AR output requires the community to be formally
// onboarded (a POSTED accounting conversion) with its books kept in trustEd.
// Still Creek and Waterview (books marked trustEd, never onboarded) must not
// populate board packets from their partial legacy ledger; Canyon Gate and LOPF
// (posted conversions) keep the corrected aging; the demo community passes.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'; process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test';
const fs = require('fs'); const path = require('path');
const { evaluateBoardFinancials } = require('../lib/community/lifecycle');

let pass = 0; let fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); } };
const posted = { ready: true, batch_code: 'CONV-X-20260731' }; const none = { ready: false };

console.log('the decision');
check('onboarded (posted conversion) + books in trustEd: allowed', evaluateBoardFinancials({ lifecycle: { name: 'Canyon Gate', books_of_record: 'trusted' }, readiness: posted }).allowed === true);
const notOnb = evaluateBoardFinancials({ lifecycle: { name: 'Still Creek Ranch', books_of_record: 'trusted' }, readiness: none });
check('books marked trustEd but never onboarded (Still Creek / Waterview): refused, with the reason', notOnb.allowed === false && notOnb.basis === 'not_onboarded' && /Still Creek Ranch has not been onboarded/.test(notOnb.reason));
check('books kept elsewhere (Eaglewood): refused even if a conversion were posted', evaluateBoardFinancials({ lifecycle: { name: 'Eaglewood', books_of_record: 'vantaca' }, readiness: posted }).allowed === false);
check('no readiness answer at all: refused (never presented as complete)', evaluateBoardFinancials({ lifecycle: { name: 'X', books_of_record: 'trusted' }, readiness: undefined }).allowed === false);
check('the demo community (synthetic data) passes', evaluateBoardFinancials({ lifecycle: { name: 'Drama Creek', books_of_record: 'trusted' }, readiness: none, isDemo: true }).allowed === true);
check('the demo flag never overrides books kept elsewhere', evaluateBoardFinancials({ lifecycle: { name: 'D', books_of_record: 'vantaca' }, readiness: none, isDemo: true }).allowed === false);
const gateCode = (fs.readFileSync(path.join(__dirname, '..', 'lib/community/lifecycle.js'), 'utf8').split('Board-facing financial and AR output')[1] || '')
  .split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
check('no community-specific names or ids in the gate code (comments may cite the motivating case)', gateCode.length > 200 && !/Still Creek|Waterview|a0000000-|Canyon|Lakes of Pine/.test(gateCode));

console.log('every ledger-derived board section is gated');
const src = fs.readFileSync(path.join(__dirname, '..', 'api/board_packets.js'), 'utf8').replace(/\r\n/g, '\n');
const bp = require('../api/board_packets');
const LEDGER = ['ar_aging', 'delinquency', 'legal_referral', 'balance_sheet', 'income_statement', 'ap_approval', 'reserve_activity', 'bank_rec'];
check('BOARD_LEDGER_SECTIONS covers every section built from the GL or homeowner ledger', LEDGER.every((k) => bp.BOARD_LEDGER_SECTIONS.includes(k)) && bp.BOARD_LEDGER_SECTIONS.length === LEDGER.length, JSON.stringify(bp.BOARD_LEDGER_SECTIONS));
const fn = src.slice(src.indexOf('async function autoFillSection('), src.indexOf('\n}\n', src.indexOf('async function autoFillSection(')));
const iGate = fn.indexOf('canProduceBoardFinancials(cid)'); const iNative = fn.indexOf('if (NATIVE.includes(sectionKey)) {');
const firstLedgerRead = Math.min(...['balanceSheet(', 'budgetVsActual(', 'computeArAging(', 'buildFinancialSectionData('].map((s) => fn.indexOf(s)).filter((i) => i >= 0));
check('autoFillSection checks the gate inside the native block, BEFORE any ledger read', iNative >= 0 && iGate > iNative && iGate < firstLedgerRead, JSON.stringify({ iNative, iGate, firstLedgerRead }));
check('a refused section returns 409 books_not_onboarded with the reason (assemble lists it as needs-attention)', /_status: 409, error: 'books_not_onboarded', message: gate\.reason/.test(fn));
check('both packet paths (assemble and per-section auto-fill) go through autoFillSection', (src.match(/await autoFillSection\(/g) || []).length === 2 && !/await buildFinancialSectionData\(/.test(src.replace(fn, '')));
check('non-ledger sections (agenda, minutes, DRV, ARC) are not gated', ['agenda', 'prior_minutes', 'drv', 'arc_decisions'].every((k) => !bp.BOARD_LEDGER_SECTIONS.includes(k)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
