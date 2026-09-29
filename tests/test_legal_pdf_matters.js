#!/usr/bin/env node
// ============================================================================
// tests/test_legal_pdf_matters.js  (Issue #9 step 2b: read the attorney PDF)
// ----------------------------------------------------------------------------
// 1) Fixture corpus (tests/fixtures/legal-invoices/*.json, SYNTHETIC replicas
//    of the RMWBH, Daughtry & Farine and Winstead layouts): every file's
//    extraction must reach the expected status, matter count, AP line →
//    matter map, service basis per matter, work types and referenced dates.
// 2) Fail-closed validation: an extraction that doesn't reconcile (to its own
//    total, to the payable, line by line) is 'needs_review', never used.
// 3) Dates (ChatGPT review): only time / expense ENTRY dates are service dates;
//    narrative and other dates never are; out-of-window entry dates ignored.
// 4) Suggestions + the server's draft save use a VALID extraction: matter
//    identity, work type, entry dates, the firm's file number, extraction_id;
//    a stale / failed / unreconciled read is shown but not used.
// 5) readInvoicePdf(): reuses a prior read of the same file, records a failed
//    read with why, refuses before migration 474, never writes elsewhere.
// Offline and deterministic (the model call is stubbed).
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://x';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const M = require('../lib/legal/pdf_matters');
const S = require('../lib/legal/review_suggest');
const R = require('../lib/legal/review_data');

let pass = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const clone = (o) => JSON.parse(JSON.stringify(o));
const DIR = path.join(__dirname, 'fixtures', 'legal-invoices');
const load = (f) => { const x = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); x.ap_lines = x.ap_lines.map((l) => Object.assign({ id: 'L' + l.line_number }, l)); return x; };

// ---- 1) corpus ----------------------------------------------------------------
for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.json')).sort()) {
  t(`corpus ${f}: status, matters, line map, service basis, work types, referenced dates`, () => {
    const fx = load(f);
    const a = M.assessExtraction(fx.raw, fx.invoice, fx.ap_lines);
    assert.strictEqual(a.status, fx.expect.status, JSON.stringify(a.problems));
    assert.strictEqual(a.matters.length, fx.expect.matters);
    const byNum = {}; Object.keys(a.line_map).forEach((id) => { byNum[id.slice(1)] = a.line_map[id]; });
    assert.deepStrictEqual(byNum, fx.expect.line_map);
    fx.expect.service_basis.forEach((b, i) => {
      const got = a.matters[i].service_basis;
      assert.strictEqual(got.source, b.source, `matter ${i + 1} source`);
      if (b.date) assert.strictEqual(got.date, b.date); else { assert.strictEqual(got.start, b.start); assert.strictEqual(got.end, b.end); assert.strictEqual(got.date, null); }
    });
    assert.deepStrictEqual(a.matters.map((m) => m.work_type), fx.expect.work_types);
    assert.deepStrictEqual(a.matters.map((m) => m.referenced_dates.length), fx.expect.referenced_dates);
  });
}

// ---- 2) fail closed -------------------------------------------------------------
const DF = () => load('df-multi-matter.json');
t('validate: matters that do not add to the PDF total → needs_review', () => {
  const fx = DF(); fx.raw.total = 999.99;
  const a = M.assessExtraction(fx.raw, fx.invoice, fx.ap_lines);
  assert.strictEqual(a.status, 'needs_review'); assert.ok(a.problems.some((p) => /PDF total/.test(p)));
});
t('validate: a PDF that does not match the payable total → needs_review', () => {
  const fx = DF(); fx.invoice.total_cents = 72007;
  assert.ok(M.assessExtraction(fx.raw, fx.invoice, fx.ap_lines).problems.some((p) => /payable total/.test(p)));
});
t('validate: a matter whose entries do not add up → needs_review', () => {
  const fx = DF(); fx.raw.matters[1].entries[0].amount = 200.00;
  const a = M.assessExtraction(fx.raw, fx.invoice, fx.ap_lines);
  assert.strictEqual(a.status, 'needs_review'); assert.ok(a.problems.some((p) => /entries add to/.test(p)));
});
t('validate: a different invoice number → needs_review', () => {
  const fx = DF(); fx.raw.invoice_number = '123';
  assert.ok(M.assessExtraction(fx.raw, fx.invoice, fx.ap_lines).problems.some((p) => /invoice number/.test(p)));
});
t('map: a payable line that cannot be tied to one matter → needs_review, named by line number', () => {
  const fx = DF(); fx.ap_lines[3].description = 'Misc'; fx.ap_lines[3].amount_cents = 6000; fx.raw.matters[2].fees = 50; fx.raw.matters[2].total = 50;
  fx.raw.matters[2].entries[0].amount = 50; fx.raw.total = 710.06; fx.invoice.total_cents = 72006;
  const a = M.assessExtraction(fx.raw, fx.invoice, fx.ap_lines);
  assert.strictEqual(a.status, 'needs_review');
});
t('map: two matters with the same fee amount are told apart by the line text', () => {
  const fx = DF(); const a = M.assessExtraction(fx.raw, fx.invoice, fx.ap_lines);
  assert.strictEqual(a.line_map.L1, 0); assert.strictEqual(a.line_map.L3, 1);
});
t('map: same amount and no telling text → not guessed (needs_review)', () => {
  const fx = DF(); fx.ap_lines[0].description = 'Fees'; fx.ap_lines[2].description = 'Fees';
  const a = M.assessExtraction(fx.raw, fx.invoice, fx.ap_lines);
  assert.strictEqual(a.status, 'needs_review'); assert.ok(a.problems.some((p) => /could not be tied/.test(p)));
});
t('normalize: malformed model output → needs_review, never a crash', () => {
  assert.strictEqual(M.assessExtraction({}, { total_cents: 100 }, [{ id: 'a', line_number: 1, amount_cents: 100 }]).status, 'needs_review');
  assert.strictEqual(M.assessExtraction(null, null, null).status, 'needs_review');
  assert.strictEqual(M.assessExtraction({ matters: [{ total: 'abc', entries: 'x' }] }, { total_cents: 1 }, []).status, 'needs_review');
});
t('normalize: parenthesized amounts are credits', () => {
  const n = M.normalize({ matters: [{ total: '(0.36)', entries: [{ date: '2026-07-23', amount: '(0.36)', description: 'late delivery credit' }] }] });
  assert.strictEqual(n.matters[0].total_cents, -36); assert.strictEqual(n.matters[0].entries[0].amount_cents, -36);
});

// ---- 3) dates -------------------------------------------------------------------
t('dates: referenced and other dates never become service dates', () => {
  const fx = load('rmwbh-single-matter.json');
  const a = M.assessExtraction(fx.raw, fx.invoice, fx.ap_lines);
  const b = a.matters[0].service_basis;
  assert.ok(b.start !== '2026-05-20' && b.date !== '2026-05-20');
  const w = load('winstead-cltn-outstanding.json');
  const wb = M.assessExtraction(w.raw, w.invoice, w.ap_lines).matters[0].service_basis;
  assert.strictEqual(wb.date, '2026-08-26');   // the entry, not the 7/13 outstanding invoice
});
t('dates: an entry dated outside the plausible window is ignored; no dated entries → none', () => {
  const m = M.normalize({ matters: [{ total: 10, entries: [{ date: '2019-01-01', amount: 10, description: 'x' }] }] }).matters[0];
  assert.strictEqual(M.matterServiceBasis(m, '2026-08-31').source, 'none');
  const m2 = M.normalize({ matters: [{ total: 10, entries: [{ amount: 10, description: 'x' }] }] }).matters[0];
  assert.strictEqual(M.matterServiceBasis(m2, '2026-08-31').source, 'none');
});

// ---- 4) suggestions + server save with a valid extraction -----------------------
const P1 = '00000000-0000-4000-8000-000000000101', P2 = '00000000-0000-4000-8000-000000000102', P3 = '00000000-0000-4000-8000-000000000103';
const baseCtx = () => ({
  properties: [
    { id: P1, street_address: '4101 Sample Meadow Dr', normalized_address: '4101 sample meadow drive' },
    { id: P2, street_address: '4202 Example Hollow Ct', normalized_address: '4202 example hollow court' },
    { id: P3, street_address: '9903 Fixture Bend Ct', normalized_address: '9903 fixture bend court' },
  ],
  tenures: [
    { id: 't1', property_id: P1, kind: 'owner', start_date: '2020-01-01', end_date: null, origin: 'transfer' },
    { id: 't2', property_id: P2, kind: 'owner', start_date: '2020-01-01', end_date: null, origin: 'transfer' },
    { id: 't3', property_id: P3, kind: 'owner', start_date: '2020-01-01', end_date: null, origin: 'transfer' },
  ],
  owners: [{ property_id: P1, tenure_id: 't1', name: 'Marigold A. Testerly' }, { property_id: P2, tenure_id: 't2', name: 'Quill O. Pemberton' }, { property_id: P3, tenure_id: 't3', name: 'Juniper Farrow' }],
  bankruptcyPropertyIds: [], legalStates: {},
});
function withExtraction(fx, id) {
  const a = M.assessExtraction(fx.raw, fx.invoice, fx.ap_lines);
  const ctx = baseCtx(); ctx.extraction = { id: id || 'x1', matters: a.matters, line_map: a.line_map };
  return ctx;
}
const invOf = (fx) => ({ total_cents: fx.invoice.total_cents, invoice_date: fx.invoice.invoice_date, service_period_start: null, service_period_end: null });

t('suggest: one item per PDF matter, with the firm file number, work type and entry dates', () => {
  const fx = DF(); const r = S.suggestReview(invOf(fx), fx.ap_lines, withExtraction(fx));
  assert.strictEqual(r.items.length, 3);
  const [dr, coll, gen] = r.items;
  assert.deepStrictEqual(dr.source_line_ids, ['L1', 'L2']); assert.strictEqual(dr.matter_ref, '9999.0004'); assert.strictEqual(dr.extraction_id, 'x1');
  assert.strictEqual(dr.service_date, '2026-08-03'); assert.strictEqual(dr.service_date_source, 'pdf_entry');
  assert.ok(/attorney’s time and expense entries/.test(dr.service_basis), dr.service_basis);
  assert.strictEqual(dr.allocations[0].property_id, P3); assert.strictEqual(dr.allocations[0].charge_category, 'attorney_fee_other');
  assert.strictEqual(dr.allocations[0].classification, 'homeowner_recoverable');
  assert.ok(dr.allocations[0].evidence.some((e) => e.kind === 'pdf_matter' && /9999\.0004/.test(e.value)));
  assert.strictEqual(coll.allocations[0].charge_category, 'attorney_fee'); assert.strictEqual(coll.service_period_start, '2026-08-10');
  assert.strictEqual(gen.allocations[0].classification, 'association_legal_expense');
  assert.strictEqual(r.reconciliation.reconciled, true);
});
t('suggest: the firm file number is never used as an owner account', () => {
  const fx = DF(); const ctx = withExtraction(fx); ctx.properties[1].trusted_account_number = '9999.0007';
  const coll = S.suggestReview(invOf(fx), fx.ap_lines, ctx).items[1];
  assert.ok(!coll.allocations[0].evidence.some((e) => e.kind === 'account'));
});
t('suggest: Winstead title with no street type + surname only → property found, medium confidence', () => {
  const fx = load('winstead-cltn-outstanding.json');
  const a = S.suggestReview(invOf(fx), fx.ap_lines, withExtraction(fx)).items[0].allocations[0];
  assert.strictEqual(a.property_id, P3); assert.strictEqual(a.confidence, 'medium');
  assert.ok(a.evidence.some((e) => e.kind === 'address' && /street type missing/.test(e.value)));
  assert.ok(a.evidence.some((e) => e.kind === 'name_check' && /surname matches/.test(e.value)));
  assert.strictEqual(a.classification, 'homeowner_recoverable');
});
t('suggest: entry dates that straddle a sale → unresolved (range-safe, not the last entry)', () => {
  const fx = load('rmwbh-single-matter.json'); const ctx = withExtraction(fx);
  ctx.tenures = [{ id: 'old', property_id: P1, kind: 'owner', start_date: '2020-01-01', end_date: '2026-06-13', origin: 'transfer' },
                 { id: 'new', property_id: P1, kind: 'owner', start_date: '2026-06-14', end_date: null, origin: 'transfer' }];
  const a = S.suggestReview(invOf(fx), fx.ap_lines, ctx).items[0].allocations[0];
  assert.strictEqual(a.tenure_match, 'unresolved'); assert.strictEqual(a.classification, 'needs_review');
});
t('suggest: a PDF bankruptcy matter is a hard stop', () => {
  const fx = load('rmwbh-single-matter.json'); fx.raw.matters[0].work_type = 'bankruptcy';
  const a = S.suggestReview(invOf(fx), fx.ap_lines, withExtraction(fx)).items[0].allocations[0];
  assert.strictEqual(a.bankruptcy_stop, true); assert.strictEqual(a.classification, 'needs_review');
});
t('suggest: with no extraction the line text is all there is (step 2 behavior unchanged)', () => {
  const fx = load('winstead-cltn-outstanding.json');
  const a = S.suggestReview(invOf(fx), fx.ap_lines, baseCtx()).items[0].allocations[0];
  assert.strictEqual(a.property_id, null); assert.strictEqual(a.classification, 'needs_review');
});

// the server's draft save (buildDraft) with the same extraction
function loaded(fx, ctx) {
  return { invoice: { id: 'inv', invoice_date: fx.invoice.invoice_date, total_cents: fx.invoice.total_cents, service_period_start: null, service_period_end: null, community_id: 'c1' },
    lines: fx.ap_lines.map((l) => ({ id: l.id, line_number: l.line_number, description: l.description, amount_cents: l.amount_cents })), ctx, readOnly: null, schemaReady: true };
}
t('save: the server rebuild agrees with the suggestion and carries extraction_id + matter_ref', () => {
  const fx = DF(); const ctx = withExtraction(fx, 'ext-1'); const d = loaded(fx, ctx);
  const sug = S.suggestReview(d.invoice, d.lines, ctx);
  const body = { base_revision: 0, items: sug.items.map((it) => ({ source_line_ids: it.source_line_ids, service_date: it.service_date, allocations: it.allocations.map((a) => ({ amount_cents: a.amount_cents, classification: a.classification, property_id: a.property_id, charge_category: a.charge_category })) })) };
  const b = R.buildDraft(d, body);
  assert.ok(!b.errors, JSON.stringify(b.errors));
  b.items.forEach((it, i) => {
    assert.strictEqual(it.extraction_id, 'ext-1'); assert.strictEqual(it.matter_ref, sug.items[i].matter_ref);
    assert.strictEqual(it.service_date_source, sug.items[i].service_date_source); assert.strictEqual(it.allocations[0].tenure_match, sug.items[i].allocations[0].tenure_match);
  });
});
t('save: lines from two PDF matters combined by staff → dates span both, noted', () => {
  const fx = DF(); const ctx = withExtraction(fx); const d = loaded(fx, ctx);
  const body = { base_revision: 0, items: [
    { source_line_ids: ['L1', 'L2', 'L3'], allocations: [{ amount_cents: 66006, classification: 'needs_review' }] },
    { source_line_ids: ['L4'], allocations: [{ amount_cents: 6000, classification: 'association_legal_expense' }] }] };
  const b = R.buildDraft(d, body);
  assert.ok(!b.errors, JSON.stringify(b.errors));
  assert.strictEqual(b.items[0].service_period_start, '2026-08-03'); assert.strictEqual(b.items[0].service_period_end, '2026-08-24');
  assert.strictEqual(b.items[0].service_date_source, 'pdf_entry');
});

// usable or not
// ---- freshness: a read is bound to the payable it was proven against -------------
const INV0 = { id: 'inv-1', invoice_date: '2026-08-31', total_cents: 10000 };
const LINES0 = [{ id: 'a', line_number: 1, description: 'Farrow - Fees', amount_cents: 10000 }, { id: 'b', line_number: 2, description: 'zero', amount_cents: 0 }];
const cur = (inv, num, lines) => { const s = R.payableSnapshot(inv, num, lines); return { snapshot: s, fingerprint: R.payableFingerprint(s), lines }; };
const readAt = (c) => ({ status: 'valid', line_map: { a: 0 }, payable_fingerprint: c.fingerprint });
t('fingerprint: covers id, number, date, total and each non-zero line (id, number, amount, text); order-independent', () => {
  const base = cur(INV0, '900', LINES0);
  assert.ok(/^[0-9a-f]{64}$/.test(base.fingerprint));
  assert.strictEqual(cur(INV0, '900', LINES0.slice().reverse()).fingerprint, base.fingerprint);
  assert.strictEqual(cur(INV0, '900', [LINES0[0]]).fingerprint, base.fingerprint);   // a zero line plays no part in the proof
  assert.deepStrictEqual(base.snapshot.lines.map((l) => l.id), ['a']);
});
t('usable: only a valid read bound to the payable as it is NOW', () => {
  const now = cur(INV0, '900', LINES0);
  assert.strictEqual(R.usableExtraction(null, now).ok, false);
  assert.strictEqual(R.usableExtraction({ status: 'failed', error: 'x' }, now).ok, false);
  assert.strictEqual(R.usableExtraction({ status: 'needs_review', line_map: { a: 0 }, payable_fingerprint: now.fingerprint }, now).ok, false);
  assert.strictEqual(R.usableExtraction(readAt(now), now).ok, true);
  assert.strictEqual(R.usableExtraction({ status: 'valid', line_map: { a: 0 } }, now).ok, false);   // an unbound read is never used
});
const SAME_ID_EDITS = [
  ['a line amount', (inv, lines) => [inv, '900', [Object.assign({}, lines[0], { amount_cents: 9999 }), lines[1]]]],
  ['a line description', (inv, lines) => [inv, '900', [Object.assign({}, lines[0], { description: 'Pemberton - Fees' }), lines[1]]]],
  ['the invoice total', (inv, lines) => [Object.assign({}, inv, { total_cents: 10001 }), '900', lines]],
  ['the invoice number', (inv, lines) => [inv, '901', lines]],
  ['the invoice date', (inv, lines) => [Object.assign({}, inv, { invoice_date: '2026-09-01' }), '900', lines]],
  ['a zero line becoming non-zero', (inv, lines) => [inv, '900', [lines[0], Object.assign({}, lines[1], { amount_cents: 5 })]]],
];
SAME_ID_EDITS.forEach(([what, edit]) => {
  t('stale: same line ids but ' + what + ' changed in place → the read is not used', () => {
    const atRead = cur(INV0, '900', LINES0);
    const args = edit(INV0, LINES0);
    const now = cur(args[0], args[1], args[2]);
    assert.notStrictEqual(now.fingerprint, atRead.fingerprint);
    const u = R.usableExtraction(readAt(atRead), now);
    assert.strictEqual(u.ok, false); assert.strictEqual(u.stale, true); assert.ok(/changed after the PDF was read/.test(u.reason));
  });
});
t('stale: loadInvoice-shaped payload shows the stale reason and suggestions fall back to line text', () => {
  const fx = DF(); const ctx = baseCtx(); const d = loaded(fx, ctx);
  const a = M.assessExtraction(fx.raw, fx.invoice, fx.ap_lines);
  const atRead = cur(d.invoice, fx.invoice.vendor_invoice_number, d.lines);
  const edited = d.lines.map((l, i) => (i === 0 ? Object.assign({}, l, { description: l.description + ' (recoded)' }) : l));
  const now = cur(d.invoice, fx.invoice.vendor_invoice_number, edited);
  const use = R.usableExtraction({ status: 'valid', line_map: a.line_map, payable_fingerprint: atRead.fingerprint }, now);
  assert.strictEqual(use.ok, false);
  const p = R.detailPayload(Object.assign({}, d, { lines: edited, extraction: { id: 'x', status: 'valid', matters: a.matters, line_map: a.line_map, problems: [] }, extractionUse: use }));
  assert.strictEqual(p.extraction.used, false); assert.ok(/changed after the PDF was read/.test(p.extraction.note));
  assert.ok(p.suggestion.items.every((it) => it.service_date_source !== 'pdf_entry'));
});

// ---- work type: the model's label is evidence, checked against the printed text ----
const wtOf = (fx) => S.suggestReview(invOf(fx), fx.ap_lines, withExtraction(fx)).items;
t('work type: a label the heading supports is suggested and says so', () => {
  const dr = wtOf(DF())[0].allocations[0];
  assert.strictEqual(dr.charge_category, 'attorney_fee_other');
  assert.ok(dr.evidence.some((e) => e.kind === 'work_type' && /supported by the heading/.test(e.value)));
});
t('work type: a label the heading CONTRADICTS gives no category and goes to review', () => {
  const fx = DF(); fx.raw.matters[0].work_type = 'collection';   // listed under "Deed Restriction Matters"
  const a = wtOf(fx)[0].allocations[0];
  assert.strictEqual(a.charge_category, null); assert.strictEqual(a.classification, 'needs_review');
  assert.ok(a.evidence.some((e) => e.kind === 'work_type' && /contradicted/.test(e.value)));
});
t('work type: a label nothing in the text supports is kept but flagged as the model’s label only', () => {
  const fx = DF(); const m = fx.raw.matters[1];
  m.section_heading = null; m.title = 'Pemberton, Quill O. - 4202 Example Hollow Ct.';
  m.entries = [{ date: '2026-08-10', kind: 'fee', description: 'Telephone conference with client.', amount: 204.00 }, { date: '2026-08-24', kind: 'fee', description: 'Review file.', amount: 120.00 }];
  const a = wtOf(fx)[1].allocations[0];
  assert.strictEqual(a.charge_category, 'attorney_fee');
  assert.ok(a.evidence.some((e) => e.kind === 'work_type' && /model’s label only/.test(e.value)));
});
t('work type: Winstead "CLTN" titles count as collection support', () => {
  const a = wtOf(load('winstead-cltn-outstanding.json'))[0].allocations[0];
  assert.ok(a.evidence.some((e) => e.kind === 'work_type' && /supported/.test(e.value) && !/contradicted/.test(e.value)));
});

// ---- 5) readInvoicePdf with a stubbed database + model --------------------------
function fakeDb({ tableMissing = false, prior = null, file = Buffer.from('%PDF-synthetic') } = {}) {
  const writes = [];
  const builder = (table) => {
    const st = { table, op: 'select', row: null, eq: {} };
    const b = {
      select() { return b; }, eq(k, v) { st.eq[k] = v; return b; }, neq() { return b; }, order() { return b; }, limit() { return b; },
      insert(row) { st.op = 'insert'; st.row = row; writes.push({ table, row }); return b; },
      single() { return Promise.resolve({ data: { id: 'new-ext', status: st.row && st.row.status }, error: null }); },
      then(res, rej) {
        if (tableMissing && table === 'legal_invoice_extractions') return Promise.resolve({ data: null, error: { code: 'PGRST205', message: 'Could not find the table legal_invoice_extractions' } }).then(res, rej);
        // A prior read is returned only when it matches every eq() filter asked for.
        const hit = prior && Object.keys(st.eq).every((k) => !(k in prior) || prior[k] === st.eq[k]);
        return Promise.resolve({ data: hit ? [prior] : [], error: null }).then(res, rej);
      },
    };
    return b;
  };
  return { writes, from: builder, storage: { from: () => ({ download: async () => ({ data: file ? { arrayBuffer: async () => file } : null, error: file ? null : { message: 'nope' } }) }) } };
}
const fxD = () => { const fx = DF(); return Object.assign(loaded(fx, baseCtx()), { sourcePath: 'invoices/x.pdf', invoiceNumber: fx.invoice.vendor_invoice_number }); };

async function asyncTests(run) {
  await run('read-pdf: before migration 474 → migration_pending, nothing written, no model call', async () => {
    const db = fakeDb({ tableMissing: true }); let called = 0;
    const out = await R.readInvoicePdf(db, fxD(), 'staff@example.test', { deps: { extractLegalInvoice: async () => { called++; }, PROMPT_VERSION: 'v', MODEL: 'm' } });
    assert.strictEqual(out.error, 'migration_pending'); assert.strictEqual(db.writes.length, 0); assert.strictEqual(called, 0);
  });
  const shaOf = (b) => require('crypto').createHash('sha256').update(b).digest('hex');
  const FILE = Buffer.from('%PDF-synthetic');
  const fpOf = (d) => R.payableFingerprint(R.payableSnapshot(d.invoice, d.invoiceNumber, d.lines));
  await run('read-pdf: a prior read of the same file, prompt AND payable is reused (no model call, no write)', async () => {
    const d = fxD();
    const db = fakeDb({ prior: { id: 'old-ext', status: 'valid', source_sha256: shaOf(FILE), prompt_version: 'v', payable_fingerprint: fpOf(d) } }); let called = 0;
    const out = await R.readInvoicePdf(db, d, 'staff@example.test', { deps: { extractLegalInvoice: async () => { called++; }, PROMPT_VERSION: 'v', MODEL: 'm' } });
    assert.deepStrictEqual(out, { extraction_id: 'old-ext', status: 'valid', reused: true }); assert.strictEqual(called, 0); assert.strictEqual(db.writes.length, 0);
  });
  await run('read-pdf: same file + prompt but the payable changed in place (same line ids) → NOT reused; a fresh read is made', async () => {
    const d = fxD(); const oldFp = fpOf(d);
    d.lines = d.lines.map((l, i) => (i === 0 ? Object.assign({}, l, { amount_cents: l.amount_cents + 1 }) : l));
    const db = fakeDb({ prior: { id: 'old-ext', status: 'valid', source_sha256: shaOf(FILE), prompt_version: 'v', payable_fingerprint: oldFp } }); let called = 0;
    const out = await R.readInvoicePdf(db, d, 'staff@example.test', { deps: { extractLegalInvoice: async () => { called++; return { raw: DF().raw, model: 'm', prompt_version: 'v' }; }, PROMPT_VERSION: 'v', MODEL: 'm' } });
    assert.strictEqual(called, 1); assert.strictEqual(out.reused, false);
    assert.strictEqual(db.writes[0].row.payable_fingerprint, fpOf(d)); assert.notStrictEqual(db.writes[0].row.payable_fingerprint, oldFp);
    assert.strictEqual(out.status, 'needs_review');   // the edited line no longer ties to its matter
  });
  await run('read-pdf: a fresh read is validated and written ONLY to legal_invoice_extractions', async () => {
    const db = fakeDb(); const raw = DF().raw;
    const out = await R.readInvoicePdf(db, fxD(), 'staff@example.test', { force: true, deps: { extractLegalInvoice: async () => ({ raw, model: 'm', prompt_version: 'v', duration_ms: 5 }), PROMPT_VERSION: 'v', MODEL: 'm' } });
    assert.strictEqual(out.status, 'valid'); assert.strictEqual(db.writes.length, 1);
    const w = db.writes[0]; assert.strictEqual(w.table, 'legal_invoice_extractions');
    assert.strictEqual(w.row.status, 'valid'); assert.strictEqual(w.row.raw, raw); assert.strictEqual(w.row.created_by, 'staff@example.test');
    assert.ok(/^[0-9a-f]{64}$/.test(w.row.source_sha256)); assert.strictEqual(Object.keys(w.row.line_map).length, 4);
    assert.ok(/^[0-9a-f]{64}$/.test(w.row.payable_fingerprint)); assert.strictEqual(w.row.payable_snapshot.total_cents, 72006);
    assert.strictEqual(w.row.payable_snapshot.lines.length, 4); assert.strictEqual(w.row.payable_snapshot.invoice_number, '900594');
  });
  await run('read-pdf: a model failure is recorded as failed with why (never swallowed)', async () => {
    const db = fakeDb();
    const out = await R.readInvoicePdf(db, fxD(), 'staff@example.test', { force: true, deps: { extractLegalInvoice: async () => { throw new Error('The invoice reader returned malformed JSON'); }, PROMPT_VERSION: 'v', MODEL: 'm' } });
    assert.strictEqual(out.status, 'failed'); assert.strictEqual(db.writes[0].row.status, 'failed'); assert.ok(/malformed JSON/.test(db.writes[0].row.error));
    assert.ok(/^[0-9a-f]{64}$/.test(db.writes[0].row.payable_fingerprint));   // even a failed read records what it was run against
  });
  await run('read-pdf: no stored file → no_invoice_file, nothing written', async () => {
    const db = fakeDb(); const d = fxD(); d.sourcePath = null;
    assert.strictEqual((await R.readInvoicePdf(db, d, 's', { deps: { PROMPT_VERSION: 'v' } })).error, 'no_invoice_file'); assert.strictEqual(db.writes.length, 0);
  });
}

(async () => {
  console.log('test_legal_pdf_matters');
  const run = async (name, fn) => { try { await fn(); pass += 1; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; } };
  for (const [name, fn] of tests) await run(name, fn);
  await asyncTests(run);
  console.log(`\n${pass} passed${process.exitCode ? ', FAILURES above' : ''}`);
})();
