// ============================================================================
// tests/test_billing_worksheet_drafts.js  (Ed 2026-10-07)
// ----------------------------------------------------------------------------
// Bedrock Office Billing: SAVE PROGRESS on the community invoice worksheet, and
// Still Creek Ranch's NSF / Insufficient Funds Fee category.
//
//   * Saving stores the worksheet (edited rates, quantities, amounts, removed
//     categories, one-off choices) and never touches invoices.
//   * Saving again UPDATES the same worksheet (no duplicates); a save based on
//     an older revision is refused.
//   * Reopening the same community + month restores it exactly (no activity
//     auto-fill over it); one-offs staged after the save are added, removed
//     one-offs stay removed, one-offs billed elsewhere are dropped (never twice).
//   * Generate uses the on-screen values and is refused when a newer save
//     exists; afterwards the worksheet records the invoice it became.
//   * The NSF fee ($35.00 per occurrence) is a rate-card row on Still Creek's
//     contract (data, not page logic), on the Activity invoice by default, no
//     activity source: qty 0 = $0, 1 = $35, 2 = $70.
//
//   node tests/test_billing_worksheet_drafts.js
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const W = require('../lib/billing/worksheet_drafts');

let passed = 0; const pending = [];
function check(name, fn) {
  pending.push(Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓ ' + name); },
    (e) => { console.error('  ✗ ' + name + '\n    ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n    ')); process.exitCode = 1; }));
}

// ---- minimal in-memory supabase for billing_worksheet_drafts ----------------
function fakeDb() {
  const rows = []; const touched = new Set();
  let nextId = 1;
  function q(table) {
    touched.add(table);
    const filt = []; let op = 'select'; let payload = null;
    const api = {
      select() { return api; },
      eq(col, val) { filt.push([col, val]); return api; },
      insert(obj) { op = 'insert'; payload = obj; return api; },
      update(obj) { op = 'update'; payload = obj; return api; },
      async maybeSingle() { const r = run(); return { data: r[0] || null, error: null }; },
      async single() { const r = run(); if (r.error) return r; return { data: r[0], error: null }; },
      then(res, rej) { const r = run(); return Promise.resolve(r.error ? r : { data: r, error: null }).then(res, rej); },
    };
    const match = (r) => filt.every(([c, v]) => r[c] === v);
    function run() {
      if (table !== 'billing_worksheet_drafts') return [];
      if (op === 'insert') {
        if (rows.some((r) => r.community_id === payload.community_id && r.invoice_type === payload.invoice_type && r.service_period === payload.service_period)) return { error: { code: '23505', message: 'duplicate key' } };
        const row = { id: 'w' + nextId++, removed_pending_item_ids: [], generated_invoice_id: null, generated_at: null, ...JSON.parse(JSON.stringify(payload)) };
        rows.push(row); op = 'select'; return [row];
      }
      if (op === 'update') { const hit = rows.filter(match); hit.forEach((r) => Object.assign(r, JSON.parse(JSON.stringify(payload)))); return hit; }
      return rows.filter(match);
    }
    return api;
  }
  return { from: q, rows, touched };
}

const C = 'a0000000-0000-4000-8000-000000000006';           // Still Creek Ranch
const KEY = { communityId: C, type: 'activity', period: '2026-09' };
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const P3 = '33333333-3333-4333-8333-333333333333';
const SHEET = [
  { source: 'reimbursable', category: 'color_copies', description: 'Color copies', qty: 412, unit_price: 0.45, amount: 185.4, sort_order: 10, junk: 'x' },
  { source: 'reimbursable', category: 'bank_fees', description: 'Bank Fees', qty: 1, unit_price: 37.5, amount: 37.5, sort_order: 20 },
  { source: 'adhoc', category: null, description: 'Board dinner reimbursement', qty: 1, unit_price: 120, amount: 120, sort_order: 5000, pending_item_id: P1 },
];

console.log('\nSaving');
check('lines keep only worksheet fields as numbers; bad input is refused', () => {
  const n = W.normalizeLines(SHEET);
  assert.ok(!('junk' in n[0]));
  assert.deepStrictEqual([n[0].qty, n[0].unit_price, n[0].amount], [412, 0.45, 185.4]);
  assert.throws(() => W.normalizeLines('x'), /lines must be an array/);
  assert.throws(() => W.normalizeLines(new Array(301).fill({ description: 'a' })), /at most 300/);
});
check('first save creates revision 1; saving again UPDATES the same worksheet (revision 2), never a second row; invoices untouched', async () => {
  const db = fakeDb();
  const a = await W.saveDraft(db, { ...KEY, lines: SHEET, removedPendingIds: [], baseRevision: 0, savedBy: 'ed@x' });
  assert.deepStrictEqual([a.revision, a.saved_by, a.lines.length], [1, 'ed@x', 3]);
  const b = await W.saveDraft(db, { ...KEY, lines: SHEET.slice(0, 2), removedPendingIds: [P1], baseRevision: 1 });
  assert.strictEqual(b.revision, 2);
  assert.strictEqual(db.rows.length, 1, 'one worksheet per community + type + month');
  assert.deepStrictEqual(db.rows[0].removed_pending_item_ids, [P1]);
  assert.deepStrictEqual([...db.touched], ['billing_worksheet_drafts'], 'saving never touches invoices or any other table');
});
check('a save based on an older revision is refused and changes nothing (no silent overwrite)', async () => {
  const db = fakeDb();
  await W.saveDraft(db, { ...KEY, lines: SHEET, baseRevision: 0 });
  await W.saveDraft(db, { ...KEY, lines: SHEET, baseRevision: 1 });
  await assert.rejects(W.saveDraft(db, { ...KEY, lines: [], baseRevision: 1 }), (e) => e.code === 'newer_draft_saved' && e.status === 409);
  assert.strictEqual(db.rows[0].lines.length, 3);
  await assert.rejects(W.saveDraft(fakeDb(), { ...KEY, lines: [], baseRevision: 4 }), (e) => e.code === 'draft_missing');
});
check('the key must be a community, fixed|activity, and YYYY-MM', async () => {
  await assert.rejects(W.saveDraft(fakeDb(), { ...KEY, type: 'builder_arc', lines: [] }), /fixed' or 'activity/);
  await assert.rejects(W.saveDraft(fakeDb(), { ...KEY, period: '2026-13', lines: [] }), /YYYY-MM/);
});

console.log('\nRestoring');
check('restore returns the saved lines EXACTLY (edited rate/qty/amount, removed categories stay removed)', () => {
  const saved = W.normalizeLines(SHEET.slice(0, 2));
  const m = W.mergeRestore({ savedLines: saved, removedPendingIds: [], pendingLines: [] });
  assert.deepStrictEqual(m.lines, saved);
});
check('one-offs: staged after the save are added; removed from this invoice stay removed; billed elsewhere are dropped and reported', () => {
  const saved = W.normalizeLines(SHEET);                                     // includes one-off P1
  const pendingNow = [
    { source: 'adhoc', description: 'New courier charge', qty: 1, unit_price: 18, amount: 18, pending_item_id: P2 },   // staged after the save
    { source: 'adhoc', description: 'Removed by Ed', qty: 1, unit_price: 9, amount: 9, pending_item_id: P3 },          // removed from this invoice
  ];                                                                          // P1 is no longer pending (billed elsewhere)
  const m = W.mergeRestore({ savedLines: saved, removedPendingIds: [P3], pendingLines: pendingNow });
  assert.deepStrictEqual(m.lines.map((l) => l.description), ['Color copies', 'Bank Fees', 'New courier charge']);
  assert.strictEqual(m.added_pending, 1);
  assert.deepStrictEqual(m.dropped_pending.map((d) => d.pending_item_id), [P1]);
});

console.log('\nGenerating');
check('generate based on an older worksheet than the saved one is refused; same revision or no saved worksheet passes', async () => {
  const db = fakeDb();
  assert.strictEqual(await W.assertGenerateNotStale(db, { ...KEY, draftRevision: 0 }), null);
  await W.saveDraft(db, { ...KEY, lines: SHEET, baseRevision: 0 });
  await W.saveDraft(db, { ...KEY, lines: SHEET, baseRevision: 1 });
  await assert.rejects(W.assertGenerateNotStale(db, { ...KEY, draftRevision: 1 }), (e) => e.code === 'newer_draft_saved');
  await assert.rejects(W.assertGenerateNotStale(db, { ...KEY, draftRevision: 0 }), (e) => e.code === 'newer_draft_saved', 'a screen that never saw the save cannot generate over it');
  assert.strictEqual((await W.assertGenerateNotStale(db, { ...KEY, draftRevision: 2 })).revision, 2);
});
check('after generate the worksheet records its invoice (matching revision only); nothing is created when there was no saved worksheet', async () => {
  const db = fakeDb();
  assert.strictEqual(await W.markGenerated(db, { ...KEY, draftRevision: 0, invoiceId: 'inv-1' }), null);
  assert.strictEqual(db.rows.length, 0);
  await W.saveDraft(db, { ...KEY, lines: SHEET, baseRevision: 0 });
  assert.strictEqual(await W.markGenerated(db, { ...KEY, draftRevision: 7, invoiceId: 'inv-1' }), null, 'a different revision is not marked');
  await W.markGenerated(db, { ...KEY, draftRevision: 1, invoiceId: 'inv-1' });
  assert.strictEqual(db.rows[0].generated_invoice_id, 'inv-1');
});

console.log('\nWiring');
const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'billing.js'), 'utf8').replace(/\r\n/g, '\n');
const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'billing', 'worksheet_drafts.js'), 'utf8');
check('preview restores a saved worksheet; the save route exists; generate checks staleness BEFORE creating the invoice and links it AFTER', () => {
  assert.match(api, /const saved = await worksheetDrafts\.getDraft\(supabase, \{ communityId, type, period \}\);/);
  assert.match(api, /router\.put\('\/communities\/:communityId\/worksheet-draft'/);
  const gen = api.slice(api.indexOf("router.post('/communities/:communityId/draft-invoice'"));
  const stale = gen.indexOf('assertGenerateNotStale'); const insert = gen.indexOf(".from('invoices')\n      .insert(");
  const mark = gen.indexOf('worksheetDrafts.markGenerated');
  assert.ok(stale > 0 && insert > stale && mark > insert, 'stale check -> insert -> mark');
  assert.ok(!/from\('(invoices|invoice_line_items|journal_entries|journal_entry_lines|billing_pending_items)'\)/.test(lib), 'the worksheet module never writes invoices, pending items or accounting');
});
check('page: Save progress in both areas, last-saved status, restore skips activity auto-fill, generate sends the revision', () => {
  for (const t of ['fixed', 'activity']) {
    assert.ok(page.includes(`onclick="billingSaveDraft('${t}')"`), `save button ${t}`);
    assert.ok(page.includes(`id="billing-draft-saved-${t}"`), `status ${t}`);
  }
  assert.match(page, /if \(j\.restored\) \{[\s\S]{0,900}\} else if \(type === 'activity'\) \{/);
  assert.match(page, /draft_revision: billingDraftState\[type\]\.revision/);
  assert.match(page, /💾 Last saved/);
});

console.log('\nStill Creek Ranch: NSF / Insufficient Funds Fee');
check('NSF fee is a rate-card row on Still Creek’s active contract: per unit $35.00, on the Activity invoice by default, no activity source, idempotent, not in the defaults', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '494_still_creek_nsf_fee.sql'), 'utf8');
  assert.match(sql, /'nsf_charge', 'NSF \/ Insufficient Funds Fee', 'per_unit', 35\.00,/);
  assert.match(sql, /c\.community_id = 'a0000000-0000-4000-8000-000000000006'/);
  assert.match(sql, /AND NOT EXISTS \(SELECT 1 FROM contract_reimbursables r WHERE r\.contract_id = c\.id AND r\.category = 'nsf_charge'\)/);
  assert.match(sql, /, 60, true\s*\n\s*FROM contracts c/, 'sort 60, default_on_invoice true');
  assert.ok(!/bedrock_contract_defaults/.test(sql.replace(/--.*$/gm, '')), 'not added to the reusable Contract Defaults');
  assert.ok(!/vantaca_source/.test(sql.replace(/--.*$/gm, '')), 'no activity source');
  assert.ok(!/nsf_charge|Insufficient Funds/.test(page), 'no NSF special case in page logic');
  assert.ok(!/'nsf_charge'/.test(api.replace(/\/\/.*$/gm, '')), 'no NSF special case in the API: it flows through the rate card like every category');
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'migrations', '494_still_creek_bank_fees.sql')), 'the generic Bank Fees item is gone');
});

// The worksheet line exactly as the preview builds it from that rate-card row
// (api/billing.js buildDraftLineItems: qty 0, unit_price from the rate card).
const NSF_LINE = () => ({ source: 'reimbursable', category: 'nsf_charge', description: 'NSF / Insufficient Funds Fee', qty: 0, unit_price: 35, amount: 0, sort_order: 60 });
function extractFn(src, name) {
  const i = src.indexOf(`function ${name}(`); if (i < 0) throw new Error('missing ' + name);
  let depth = 0; let j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); } }
  throw new Error('unbalanced ' + name);
}
check('NSF in the worksheet is intuitive: type the number of occurrences -> qty 0 = $0.00, qty 1 = $35.00, qty 2 = $70.00 (subtotal follows, marked unsaved)', () => {
  const vm = require('vm');
  const els = {};
  const document = { getElementById: (id) => (els[id] = els[id] || { value: '', textContent: '', innerHTML: '' }) };
  const ctx = { document, billingDraftState: { activity: { lines: [NSF_LINE()], removedPending: [], dirty: false, revision: 0 } },
    billingMoney: (n) => '$' + Number(n).toFixed(2), escapeHtml: (s) => String(s), Math, Number, String };
  vm.createContext(ctx);
  for (const fn of ['billingDraftPreviewSubtotal', 'billingDraftPreviewQty', 'billingDraftPreviewRate', 'billingDraftPreviewAmount', 'billingMarkDirty', 'billingRenderSaveStatus']) vm.runInContext(extractFn(page, fn), ctx);
  const line = ctx.billingDraftState.activity.lines[0];
  assert.deepStrictEqual([line.qty, line.amount], [0, 0], 'qty 0 = $0.00 on load');
  const seen = [];
  for (const q of [0, 1, 2]) { vm.runInContext(`billingDraftPreviewQty('activity', 0, '${q}')`, ctx); seen.push([q, line.amount, els['billing-preview-amt-activity-0'].value, els['billing-preview-subtotal-activity'].textContent]); }
  assert.deepStrictEqual(seen, [[0, 0, 0, '$0.00'], [1, 35, 35, '$35.00'], [2, 70, 70, '$70.00']]);
  assert.strictEqual(ctx.billingDraftState.activity.dirty, true, 'an edit shows "unsaved changes"');
  vm.runInContext(`billingDraftPreviewAmount('activity', 0, '105')`, ctx);   // typing an amount back-fills the rate, qty stays 2
  assert.deepStrictEqual([line.qty, line.unit_price, line.amount], [2, 52.5, 105]);
});
check('Generate bills exactly qty x $35.00 (server recomputes amount from qty and rate)', () => {
  const vm = require('vm');
  const ctx = { money: (n) => Math.round(Number(n) * 100) / 100, Array, Number, String, Math };
  vm.createContext(ctx);
  vm.runInContext(extractFn(api, 'sanitizeDraftLines'), ctx);
  for (const [q, want] of [[0, 0], [1, 35], [2, 70]]) {
    const [li] = vm.runInContext(`sanitizeDraftLines([${JSON.stringify({ ...NSF_LINE(), qty: q, amount: 999 })}])`, ctx);
    assert.deepStrictEqual([li.category, li.qty, li.unit_price, li.amount], ['nsf_charge', q, 35, want]);
  }
});

Promise.all(pending).then(() => console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', with failures' : '')));
