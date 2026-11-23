// Corrections to posted interest go through Kat's queue (Ed 2026-11-23): new entries only, tagged with
// the month they correct; the original charge is never touched; a review after posting finds nothing.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const I = require('../lib/ar/monthly_interest');
const K = require('../lib/accounting/interest_corrections');
const J = require('../lib/accounting/journal_entry_runs');
let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ok   ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n    ' + e.message); } };
const T = '11111111-aaaa-4aaa-8aaa-111111111111';
const settings = { rate_bps: 1000, grace_days: 30, due_offset_days: 0, calc_cutoff: 'prior_month_end', income_account_number: '4030' };
const base = { tenures: [{ id: T, property_id: 'p', kind: 'owner', start_date: '2020-01-01', end_date: null }], properties: [{ id: 'p', street_address: '1 Sample' }], cutoverDate: '2026-08-01', settings };
let n = 0;
const row = (d, cat, cents, x = {}) => ({ id: 'r' + (++n), tenure_id: T, property_id: 'p', transaction_date: d, txn_type: 'charge', charge_category: cat, amount_cents: cents, created_at: '2026-09-01T00:00:00Z', ...x });
const late = { created_at: '2026-11-20T00:00:00Z' };
const open = () => [row('2026-07-31', 'assessment', 120000, { txn_type: 'balance_brought_forward', created_at: '2026-08-01' }), row('2026-07-31', 'late_fee', 9000, { txn_type: 'balance_brought_forward', created_at: '2026-08-01' })];
const posted = () => ['2026-09-01', '2026-10-01', '2026-11-01'].map((d) => row(d, 'interest', 1000));
const pay = (d, c) => row(d, 'payment', -c, { txn_type: 'payment', ...late });
const build = (rows, x = {}) => K.buildItems(I.reviewPostedInterest({ ...base, ...x, rows }), { today: '2026-11-23' });
const amounts = (b) => b.items.map((i) => [i.homeowner.corrects_month, (i.lines[1].account_number === '1300' ? -1 : 1) * i.lines[0].debit_cents]);
// What posting an approved item adds to the ledger (homeowner_charge.postLine with its tag).
const post = (i) => { const ar = i.lines.find((l) => l.account_number === '1300'); return row(i.posting_date, 'interest', ar.debit_cents - ar.credit_cents, { txn_type: ar.debit_cents ? 'charge' : 'adjustment', corrects_month: i.homeowner.corrects_month, tenure_id: i.homeowner.tenure_id, ...late }); };
const facts = { community_id: 'c', cutover_date: '2026-08-01', accounts: { 1300: { id: 'a' }, 4030: { id: 'b' } }, properties: { p: { street_address: '1 Sample' } }, posted_refs: new Set() };

(async () => {
  await t('nothing to correct: no entries', () => assert.deepStrictEqual(build([...open(), ...posted()]), { items: [], held: [] }));
  await t('a backdated payment credits every month it affects, and only those', () => {
    const b = build([...open(), ...posted(), pay('2026-09-10', 60000)]);
    assert.deepStrictEqual(amounts(b), [['2026-10', -500], ['2026-11', -500]]);
    assert.ok(/payment -600\.00 effective 2026-09-10/.test(b.items[0].evidence.basis)); assert.ok(/original charge is unchanged/.test(b.items[0].evidence.basis));
  });
  await t('an assessment credit and a paid-off month are credited; fees, letters and legal charges never change interest', () => {
    assert.deepStrictEqual(amounts(build([...open(), ...posted(), row('2026-08-15', 'assessment', -30000, { txn_type: 'adjustment', ...late })])), [['2026-09', -250], ['2026-10', -250], ['2026-11', -250]]);
    assert.deepStrictEqual(amounts(build([...open(), ...posted(), pay('2026-08-15', 200000)])), [['2026-09', -1000], ['2026-10', -1000], ['2026-11', -1000]]);
    for (const c of ['late_fee', 'certified_letter', 'fine', 'interest_x']) assert.deepStrictEqual(build([...open(), ...posted(), row('2026-08-15', c, 50000, late)]).items, []);
  });
  await t('a late assessment charge is an undercharge; with an account needing review it is listed, not prepared', () => {
    const rows = [...open(), ...posted(), row('2026-07-31', 'assessment', 60000, { txn_type: 'balance_brought_forward', ...late })];
    assert.deepStrictEqual(amounts(build(rows)), [['2026-09', 500], ['2026-10', 500], ['2026-11', 500]]);
    const b = build(rows, { enforcement: [{ property_id: 'p', state: 'at_legal' }] }); assert.strictEqual(b.items.length, 0); assert.ok(b.held.every((h) => /attorney/.test(h.reason)));
    const credit = build([...open(), ...posted(), pay('2026-09-10', 60000)], { enforcement: [{ property_id: 'p', state: 'at_legal' }] }); assert.strictEqual(credit.items.length, 2, 'a credit is still prepared');
  });
  await t('a returned payment restores the interest, held for review', () => {
    const rows = [...open(), row('2026-09-01', 'interest', 1000), row('2026-10-01', 'interest', 500), pay('2026-09-10', 60000), row('2026-09-12', 'payment_reversal', 60000, late)];
    const b = build(rows); assert.strictEqual(b.items.length, 0); assert.deepStrictEqual(b.held.map((h) => [h.month, h.correction_cents]), [['2026-10', 500]]);
  });
  await t('after the corrections post, nothing is left, the originals are intact, and no month is charged again', () => {
    const rows = [...open(), ...posted(), pay('2026-09-10', 60000)]; const before = JSON.stringify(rows);
    const after = [...rows, ...build(rows).items.map(post)];
    assert.strictEqual(JSON.stringify(rows), before); assert.deepStrictEqual(build(after), { items: [], held: [] });
    for (const m of ['2026-10', '2026-11']) assert.strictEqual(I.computeInterest({ ...base, rows: after, runDate: `${m}-01`, asOfDate: I.cutoffFor(settings, `${m}-01`) }).items[0].skip, true);
    const dec = I.computeInterest({ ...base, rows: after, runDate: '2026-12-01', asOfDate: '2026-11-30' }).items[0];
    assert.strictEqual(dec.interest_cents, 500, 'a correction dated in November is not December\'s or November\'s interest'); assert.strictEqual(dec.skip, false);
  });
  await t('a second change after a correction gets its own entry (new id) for the difference only', () => {
    const rows = [...open(), ...posted(), pay('2026-09-10', 60000)]; const first = build(rows); const after = [...rows, ...first.items.map(post), pay('2026-09-20', 60000)];
    const second = build(after); assert.deepStrictEqual(amounts(second), [['2026-10', -500], ['2026-11', -500]]);
    assert.ok(second.items.every((i) => /-2$/.test(i.id)) && !second.items.some((i) => first.items.some((f) => f.id === i.id)));
  });
  await t('a fully credited month can be restored only by a correction, never a duplicate run', () => {
    const rows = [...open(), row('2026-09-01', 'interest', 1000), row('2026-11-20', 'interest', -1000, { txn_type: 'adjustment', corrects_month: '2026-09', ...late })];
    assert.strictEqual(I.computeInterest({ ...base, rows, runDate: '2026-09-01', asOfDate: '2026-08-31' }).items[0].skip, true); assert.deepStrictEqual(amounts(build(rows)), [['2026-09', 1000]]);
  });
  await t('waived interest, a former owner, and a month with no clear owner are listed, never prepared', () => {
    const w = build([...open(), ...posted(), row('2026-09-15', 'interest', -1000, { txn_type: 'adjustment' }), pay('2026-08-10', 60000)]); assert.ok(w.held.some((h) => /waived/.test(h.reason)) && !w.items.some((i) => i.homeowner.corrects_month === '2026-09'));
    assert.deepStrictEqual(build([...open(), ...posted(), row('2026-09-15', 'interest', -1000, { txn_type: 'adjustment' })]).items, [], 'a waiver alone is not charged back');
    const f = build([...open(), ...posted(), pay('2026-08-10', 60000)], { tenures: [{ ...base.tenures[0], end_date: '2026-11-05' }] }); assert.strictEqual(f.items.length, 0); assert.ok(f.held.every((h) => /sold/.test(h.reason)));
    const two = [...base.tenures, { id: 'x', property_id: 'p', kind: 'owner', start_date: '2020-01-01', end_date: null }];
    assert.ok(build([row('2026-09-01', 'interest', 1000, { tenure_id: null })], { tenures: two }).held.every((h) => /no clear owner/.test(h.reason)));
  });
  await t('unstamped interest (no owner on the row) is corrected for the owner of that month', () => {
    assert.deepStrictEqual(amounts(build([...open(), row('2026-10-01', 'interest', 1000, { tenure_id: null }), pay('2026-09-10', 60000)])), [['2026-10', -500]]);
  });
  await t('the entries pass Kat\'s own validation, balanced, and carry the month and owner', () => {
    const b = build([...open(), ...posted(), pay('2026-09-10', 60000)]); const r = J.buildProposals(facts, b.items);
    assert.deepStrictEqual(r.exceptions, []); assert.strictEqual(r.totals.amount_cents, 1000); assert.ok(r.items.every((i) => i.homeowner.kind === 'credit' && i.homeowner.corrects_month && i.homeowner.tenure_id === T));
    const bad = JSON.parse(JSON.stringify(b.items)); bad[0].homeowner.charge_category = 'payment'; bad[1].homeowner.corrects_month = '2026-13';
    assert.strictEqual(J.buildProposals(facts, bad).exceptions.length, 2);
  });

  // ---- queue behavior, with a stand-in database ---------------------------------
  const M = require('../lib/accounting/monthly_runs');
  const world = (rows, runs = []) => {
    const calls = { superseded: [], prepared: [] };
    const orig = { s: M.supersede, p: M.prepare, l: I.loadInputs };
    M.supersede = async (_, o) => { calls.superseded.push(o.run_id); }; M.prepare = async (_, o) => { calls.prepared.push(o); return { run: { id: 'new' } }; };
    I.loadInputs = async () => ({ ...base, rows, collections: [], enforcement: [], plans: [], community: { gl_cutover_date: '2026-08-01' } });
    const q = (data) => { const o = { select: () => o, eq: () => o, in: () => o, order: () => o, limit: () => Promise.resolve({ data, error: null }), maybeSingle: () => Promise.resolve({ data: calls.policy === null ? null : { enabled: true, settings }, error: null }) }; return o; };
    return { db: { from: (tb) => q(tb === 'accounting_runs' ? runs : []) }, calls, done: () => { M.supersede = orig.s; M.prepare = orig.p; I.loadInputs = orig.l; } };
  };
  const rowsX = [...open(), ...posted(), pay('2026-09-10', 60000)];
  await t('queue: one prepared run; unchanged is left alone; changed is replaced; no longer needed is withdrawn; other runs untouched', async () => {
    let w = world(rowsX); await K.prepareCorrections(w.db, { community_id: 'c', today: '2026-11-23' }); assert.strictEqual(w.calls.prepared.length, 1); assert.strictEqual(w.calls.prepared[0].process, 'journal_entry'); const items = w.calls.prepared[0].items; w.done();
    const run = { id: 'old', status: 'prepared', preview: { submitted: items } }; const other = { id: 'other', status: 'prepared', preview: { submitted: [{ id: 'lopf-x', lines: [] }] } };
    w = world(rowsX, [run, other]); assert.strictEqual((await K.prepareCorrections(w.db, { community_id: 'c', today: '2026-11-24' })).existing, true); assert.deepStrictEqual(w.calls, { superseded: [], prepared: [] }); w.done();
    w = world(rowsX, [run]); await K.prepareCorrections(w.db, { community_id: 'c', today: '2026-12-02' }); assert.deepStrictEqual(w.calls.superseded, ['old']); assert.strictEqual(w.calls.prepared[0].items[0].posting_date, '2026-12-02', 'a run left from an earlier month is dated again'); w.done();
    w = world([...rowsX, pay('2026-09-11', 60000)], [run, other]); await K.prepareCorrections(w.db, { community_id: 'c', today: '2026-11-24' }); assert.deepStrictEqual(w.calls.superseded, ['old']); assert.strictEqual(w.calls.prepared.length, 1); w.done();
    w = world([...open(), ...posted()], [run, other]); await K.prepareCorrections(w.db, { community_id: 'c', today: '2026-11-24' }); assert.deepStrictEqual(w.calls, { superseded: ['old'], prepared: [] }); w.done();
    w = world(rowsX, [run]); w.calls.policy = null; assert.ok((await K.prepareCorrections(w.db, { community_id: 'c' })).skipped); assert.strictEqual(w.calls.superseded.length, 0); w.done();
  });
  await t('approval: refused when the ledger changed; allowed when it still matches; other entries are not checked', async () => {
    const items = build(rowsX).items; const run = { community_id: 'c', preview: { submitted: items } }; const ids = items.map((i) => i.id);
    let w = world(rowsX); await K.assertCurrent(w.db, run, ids); w.done();
    w = world([...rowsX, pay('2026-09-11', 60000)]); await assert.rejects(K.assertCurrent(w.db, run, ids), /ledger changed/); await K.assertCurrent(w.db, run, []); w.done();
    w = world([...open(), ...posted()]); await assert.rejects(K.assertCurrent(w.db, run, [ids[0]]), (e) => e.code === 'stale_preview'); w.done();
  });
  await t('a failed review never breaks the posting it follows', async () => { const r = await K.afterPosting({ from() { throw new Error('down'); } }, { community_id: 'c', reason: 'x' }); assert.strictEqual(r.error, 'down'); });
  await t('wiring: reviewed when interest is prepared and after Kat posts; approval rechecks; nothing here edits or deletes a ledger row', () => {
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8'); const mr = read('lib/accounting/monthly_runs.js'); const me = read('lib/accounting/interest_corrections.js');
    assert.ok(/assertCurrent\(supabase, run/.test(mr) && (mr.match(/afterPosting\(supabase/g) || []).length === 2);
    assert.ok(!/\.update\(|\.delete\(|\.insert\(|approveAndPost|postApproved|postInterest/.test(me));
    assert.ok(mr.includes('require(\'./interest_corrections\').isCorrection(i.id)') && mr.includes('prepareCorrections(supabase, { community_id: run.community_id, reason: \'refresh requested by'), 'refresh recalculates');
    assert.ok(/corrects_month: it\.homeowner\.corrects_month/.test(read('lib/accounting/journal_entry_runs.js')) && /corrects_month:raw_row_jsonb->>corrects_month/.test(read('lib/ar/monthly_interest.js')));
  });
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
