#!/usr/bin/env node
// ============================================================================
// tests/test_legal_review_triage.js  (Issue #9: exception-based approval)
// ----------------------------------------------------------------------------
// Ed (2026-09-29): Trusted does the review; a person sees only exceptions.
// Locks lib/legal/review_suggest.js triageItem() / summarize():
//   - an item is ACCEPTED only when every guardrail passes (high-confidence
//     owner match, owner period confirmed, category set, work type supported,
//     no bankruptcy, the split adds up);
//   - HARD reasons (needs review, bankruptcy, owner period not confirmed, no
//     property/category, split doesn't add up) are never cleared by a
//     confirmation; only changing the item clears them;
//   - SOFT reasons (medium/low match, model-only or contradicted work type)
//     are cleared only by a recorded staff confirmation;
//   - a staff-chosen property is a human decision (not a "low match");
//   - can_accept only when the invoice reconciles to the cent AND there are
//     no exceptions; money buckets add up.
// Plus the server side: buildDraft records a confirmation with the actor,
// and a confirmation on a hard stop still leaves it an exception.
// ============================================================================
const assert = require('assert');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://x';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const S = require('../lib/legal/review_suggest');
const R = require('../lib/legal/review_data');
const M = require('../lib/legal/pdf_matters');
const fs = require('fs');
const path = require('path');

let pass = 0;
function t(name, fn) { try { fn(); pass += 1; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; } }

const good = (over) => Object.assign({ amount_cents: 1000, classification: 'homeowner_recoverable', property_id: 'p1', tenure_match: 'current', confidence: 'high',
  charge_category: 'attorney_fee', bankruptcy_stop: false, suggested: true, evidence: [{ kind: 'work_type', value: 'collection work per the invoice PDF: supported by the heading / title' }] }, over || {});
const item = (allocs, amount) => ({ amount_cents: amount == null ? allocs.reduce((s, a) => s + a.amount_cents, 0) : amount, allocations: allocs });
const CONFIRMED = { kind: 'staff_confirmed', value: 'confirmed by staff@example.test on 2026-09-29' };

console.log('test_legal_review_triage');

t('accepted: high-confidence, current owner, supported work type, category, no bankruptcy', () => {
  const r = S.triageItem(item([good()]));
  assert.strictEqual(r.status, 'accepted'); assert.deepStrictEqual(r.reasons, []);
});
const assoc = (ev, over) => good(Object.assign({ classification: 'association_legal_expense', property_id: null, charge_category: null, confidence: 'medium', tenure_match: 'not_applicable', evidence: ev }, over || {}));
t('association: supported by a general-matter heading → accepted', () => {
  assert.strictEqual(S.triageItem(item([assoc([{ kind: 'work_type', value: 'general / association matter per the invoice PDF: supported by the heading / title' }])])).status, 'accepted');
  assert.strictEqual(S.triageItem(item([assoc([{ kind: 'work_type', value: 'association / corporate work, no property named: supported by the line text' }])])).status, 'accepted');
});
t('association: NOT accepted merely because no property is named (no evidence → soft exception)', () => {
  const r = S.triageItem(item([assoc([])]));
  assert.strictEqual(r.status, 'exception'); assert.strictEqual(r.confirmable, true); assert.ok(/no printed support/.test(r.reasons[0]));
});
t('association: a model-only general label → soft exception; a confirmation clears it', () => {
  const ev = [{ kind: 'work_type', value: 'general / association matter per the invoice PDF: the model’s label only; the heading and entry text don’t confirm it (confirm before any posting)' }];
  assert.strictEqual(S.triageItem(item([assoc(ev)])).status, 'exception');
  assert.strictEqual(S.triageItem(item([assoc(ev.concat([CONFIRMED]))])).status, 'accepted');
});
t('association: contradicted by the text → exception', () => {
  const r = S.triageItem(item([assoc([{ kind: 'work_type', value: 'general / association matter per the invoice PDF: contradicted by the entry text, which reads as collection work' }])]));
  assert.strictEqual(r.status, 'exception'); assert.ok(r.reasons.some((x) => /conflicts/.test(x)));
});
t('association: a confirmation never clears a hard stop on an association item', () => {
  assert.strictEqual(S.triageItem(item([assoc([CONFIRMED], { bankruptcy_stop: true })])).status, 'exception');
});
t('accepted: a staff-chosen property is a human decision, not a weak match', () => {
  assert.strictEqual(S.triageItem(item([good({ suggested: false, confidence: 'none' })])).status, 'accepted');
});

t('soft: a medium owner match is an exception a person can confirm', () => {
  const r = S.triageItem(item([good({ confidence: 'medium' })]));
  assert.strictEqual(r.status, 'exception'); assert.strictEqual(r.confirmable, true); assert.ok(/medium confidence/.test(r.reasons[0]));
  assert.strictEqual(S.triageItem(item([good({ confidence: 'medium', evidence: [CONFIRMED] })])).status, 'accepted');
});
t('soft: a model-only work type is an exception until confirmed', () => {
  const ev = [{ kind: 'work_type', value: 'collection work per the invoice PDF: the model’s label only; the heading and entry text don’t confirm it (confirm before any posting)' }];
  assert.strictEqual(S.triageItem(item([good({ evidence: ev })])).status, 'exception');
  assert.strictEqual(S.triageItem(item([good({ evidence: ev.concat([CONFIRMED]) })])).status, 'accepted');
});

t('hard: bankruptcy is never cleared by a confirmation', () => {
  const r = S.triageItem(item([good({ bankruptcy_stop: true, evidence: [CONFIRMED] })]));
  assert.strictEqual(r.status, 'exception'); assert.strictEqual(r.confirmable, false); assert.ok(r.hard.some((x) => /bankruptcy/.test(x)));
});
t('hard: an owner period that is former / unresolved is never cleared by a confirmation', () => {
  ['former', 'unresolved'].forEach((tm) => {
    const r = S.triageItem(item([good({ tenure_match: tm, evidence: [CONFIRMED] })]));
    assert.strictEqual(r.status, 'exception'); assert.strictEqual(r.confirmable, false);
  });
});
t('hard: needs review, no category, no property, and a split that does not add up', () => {
  assert.strictEqual(S.triageItem(item([good({ classification: 'needs_review', review_reasons: ['no property or account named on this line'] })])).hard[0], 'no property or account named on this line');
  assert.ok(S.triageItem(item([good({ charge_category: null })])).hard.includes('no charge category'));
  assert.ok(S.triageItem(item([good({ property_id: null })])).hard.includes('a homeowner charge with no property'));
  assert.ok(S.triageItem(item([good()], 1500)).hard.includes('the split does not add up to the item amount'));
  assert.ok(S.triageItem({ amount_cents: 100, allocations: [] }).hard.length);
});
t('hard + soft together: confirming clears only the soft part', () => {
  const r = S.triageItem(item([good({ confidence: 'medium', bankruptcy_stop: true, evidence: [CONFIRMED] })]));
  assert.strictEqual(r.status, 'exception'); assert.deepStrictEqual(r.soft, []); assert.ok(r.hard.length);
});

t('summarize: buckets in money; can_accept only when balanced and no exceptions', () => {
  const items = [item([good({ amount_cents: 5000 })]), item([good({ classification: 'association_legal_expense', property_id: null, charge_category: null, amount_cents: 2000, evidence: [{ kind: 'work_type', value: 'general / association matter per the invoice PDF: supported by the heading / title' }] })])];
  const s = S.summarize(7000, items);
  assert.deepStrictEqual([s.recoverable.cents, s.association.cents, s.exceptions.count, s.accepted.count, s.can_accept], [5000, 2000, 0, 2, true]);
  assert.strictEqual(S.summarize(7001, items).can_accept, false);   // off by a cent
  const withExc = items.concat([item([good({ amount_cents: 300, bankruptcy_stop: true })])]);
  const s2 = S.summarize(7300, withExc);
  assert.deepStrictEqual([s2.exceptions.count, s2.exceptions.cents, s2.recoverable.cents, s2.can_accept], [1, 300, 5000, false]);
  assert.strictEqual(S.summarize(0, []).can_accept, false);
});

// ---- real engine output on the synthetic Daughtry & Farine layout ------------------
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'legal-invoices', 'df-multi-matter.json'), 'utf8'));
fx.ap_lines = fx.ap_lines.map((l) => Object.assign({ id: 'L' + l.line_number }, l));
const P2 = '00000000-0000-4000-8000-000000000102', P3 = '00000000-0000-4000-8000-000000000103';
const ctxFor = (bk) => {
  const a = M.assessExtraction(fx.raw, fx.invoice, fx.ap_lines);
  return { properties: [{ id: P2, street_address: '4202 Example Hollow Ct', normalized_address: '4202 example hollow court' }, { id: P3, street_address: '9903 Fixture Bend Ct', normalized_address: '9903 fixture bend court' }],
    tenures: [{ id: 't2', property_id: P2, kind: 'owner', start_date: '2020-01-01', end_date: null, origin: 'transfer' }, { id: 't3', property_id: P3, kind: 'owner', start_date: '2020-01-01', end_date: null, origin: 'transfer' }],
    owners: [{ property_id: P2, tenure_id: 't2', name: 'Quill O. Pemberton' }, { property_id: P3, tenure_id: 't3', name: 'Juniper Farrow' }],
    bankruptcyPropertyIds: bk ? [P2] : [], legalStates: {}, extraction: { id: 'x1', matters: a.matters, line_map: a.line_map } };
};
const inv = { total_cents: fx.invoice.total_cents, invoice_date: fx.invoice.invoice_date };
t('engine: a clean PDF-backed invoice is fully accepted (one click)', () => {
  const s = S.summarize(inv.total_cents, S.suggestReview(inv, fx.ap_lines, ctxFor(false)).items);
  assert.deepStrictEqual([s.accepted.count, s.exceptions.count, s.recoverable.cents, s.association.cents, s.can_accept], [3, 0, 66006, 6000, true]);
});
t('engine: a bankruptcy on file turns exactly that matter into an exception', () => {
  const items = S.suggestReview(inv, fx.ap_lines, ctxFor(true)).items;
  assert.deepStrictEqual(items.map((it) => S.triageItem(it).status), ['accepted', 'exception', 'accepted']);
  assert.strictEqual(S.summarize(inv.total_cents, items).can_accept, false);
});

// ---- engine: association support from the PDF ---------------------------------------
const matterOf = (over) => Object.assign({ index: 0, matter_ref: 'x', section_heading: null, title: 'Matter', parties: [], property_address: null, owner_account_number: null,
  work_type: 'general', entries: [{ description: 'Telephone conference.', amount_cents: 100 }] }, over);
const assocEvidence = (m) => {
  const a = S.itemSignals(S.buildIndex({}), { invoice_date: '2026-08-31' }, [{ id: 'L1', description: 'Fees' }], { id: 'x', matters: [m], line_map: { L1: 0 } });
  return { ev: a.match.evidence.find((e) => e.kind === 'work_type'), cls: a.cls };
};
t('engine: a "General Matters" heading supports association treatment', () => {
  const r = assocEvidence(matterOf({ section_heading: 'General Matters' }));
  assert.ok(/supported by the heading/.test(r.ev.value)); assert.strictEqual(r.cls.association, true);
});
t('engine: a general label on a matter that names a homeowner is contradicted (not association)', () => {
  const r = assocEvidence(matterOf({ parties: ['Farrow, Juniper'], property_address: '9903 Fixture Bend Ct' }));
  assert.ok(/contradicted/.test(r.ev.value)); assert.strictEqual(r.cls.association, false);
});
t('engine: a general label whose entries read as collection work is contradicted', () => {
  const r = assocEvidence(matterOf({ entries: [{ description: 'Prepare demand letter re delinquent assessments and lien.', amount_cents: 100 }] }));
  assert.ok(/contradicted by the entry text/.test(r.ev.value)); assert.strictEqual(r.cls.association, false);
});
t('engine: a general label with nothing supporting it is the model’s label only', () => {
  const r = assocEvidence(matterOf({}));
  assert.ok(/model’s label only/.test(r.ev.value)); assert.strictEqual(r.cls.association, true);
});

// ---- server: confirmations are recorded with the actor -----------------------------
const loaded = (ctx) => ({ invoice: { id: 'inv', invoice_date: inv.invoice_date, total_cents: inv.total_cents, service_period_start: null, service_period_end: null, community_id: 'c1' },
  lines: fx.ap_lines.map((l) => ({ id: l.id, line_number: l.line_number, description: l.description, amount_cents: l.amount_cents })), ctx, readOnly: null, schemaReady: true });
t('save: a confirmation is recorded with the signed-in actor and clears only soft reasons', () => {
  const d = loaded(ctxFor(true));
  const body = { base_revision: 0, items: [
    { source_line_ids: ['L1', 'L2'], allocations: [{ amount_cents: 33606, classification: 'homeowner_recoverable', property_id: P3, charge_category: 'attorney_fee_other', confirmed: true }] },
    { source_line_ids: ['L3'], allocations: [{ amount_cents: 32400, classification: 'homeowner_recoverable', property_id: P2, charge_category: 'attorney_fee', confirmed: true }] },
    { source_line_ids: ['L4'], allocations: [{ amount_cents: 6000, classification: 'association_legal_expense' }] }] };
  const b = R.buildDraft(d, body, 'ed@example.test');
  assert.ok(!b.errors, JSON.stringify(b.errors));
  const conf = b.items[0].allocations[0].evidence.find((e) => e.kind === 'staff_confirmed');
  assert.ok(conf && /confirmed by ed@example\.test on \d{4}-\d{2}-\d{2}/.test(conf.value));
  assert.strictEqual(S.triageItem(b.items[1]).status, 'exception');   // bankruptcy stays an exception even "confirmed"
  assert.ok(!b.items[2].allocations[0].evidence.some((e) => e.kind === 'staff_confirmed'));   // not confirmed → nothing recorded
});

// ---- stale saved drafts never read as Accepted / Ready -----------------------------
// A draft saved from the engine's own output, then the world changes under it.
function savedFrom(ctx, extractionId) {
  const d = loaded(ctx);
  const sug = S.suggestReview(d.invoice, d.lines, ctx);
  const items = sug.items.map((it) => Object.assign({}, it, { extraction_id: extractionId || null, allocations: it.allocations.map((a) => Object.assign({}, a)) }));
  return { d, saved: { review: { id: 'r', revision: 1 }, items, reads: [], events: [] } };
}
const usableRead = (id) => ({ extraction: { id, status: 'valid', matters: [], line_map: {}, problems: [] }, extractionUse: { ok: true } });
const noRead = { extraction: null, extractionUse: { ok: false, reason: 'not read' } };
t('fresh: a draft that still matches the payable and the read it used is current (and acceptable)', () => {
  const { d, saved } = savedFrom(ctxFor(false), 'read-A');
  const full = Object.assign({}, d, { saved }, usableRead('read-A'));
  assert.strictEqual(R.draftFreshness(full).stale, false);
  const p = R.detailPayload(full);
  assert.strictEqual(p.draft.summary.can_accept, true); assert.ok(!p.draft.summary.stale);
});
const edits = [
  ['a line amount changed', (d) => { d.lines = d.lines.map((l, i) => (i === 0 ? Object.assign({}, l, { amount_cents: l.amount_cents + 1 }) : l)); }],
  ['a line description changed', (d) => { d.lines = d.lines.map((l, i) => (i === 0 ? Object.assign({}, l, { description: l.description + ' (recoded)' }) : l)); }],
  ['a line added', (d) => { d.lines = d.lines.concat([{ id: 'L9', line_number: 9, description: 'New', amount_cents: 100 }]); }],
  ['a line removed', (d) => { d.lines = d.lines.slice(1); }],
];
edits.forEach(([what, edit]) => {
  t('stale: ' + what + ' after the draft was saved → out of date, never acceptable', () => {
    const { d, saved } = savedFrom(ctxFor(false), null);
    edit(d);
    const full = Object.assign({}, d, { saved }, noRead);
    const f = R.draftFreshness(full);
    assert.strictEqual(f.stale, true); assert.ok(/payable changed/.test(f.reasons[0]));
    const p = R.detailPayload(full);
    assert.strictEqual(p.draft.summary.can_accept, false); assert.strictEqual(p.draft.summary.stale, true);
  });
});
t('stale: the draft relied on read A but read B is now current → out of date', () => {
  const { d, saved } = savedFrom(ctxFor(false), 'read-A');
  const f = R.draftFreshness(Object.assign({}, d, { saved }, usableRead('read-B')));
  assert.strictEqual(f.stale, true); assert.ok(/read again/.test(f.reasons[0]));
});
t('stale: the read the draft relied on no longer describes the payable → out of date', () => {
  const { d, saved } = savedFrom(ctxFor(false), 'read-A');
  const f = R.draftFreshness(Object.assign({}, d, { saved }, { extraction: { id: 'read-A', status: 'valid' }, extractionUse: { ok: false, stale: true } }));
  assert.strictEqual(f.stale, true); assert.ok(/no longer describes/.test(f.reasons[0]));
});
t('stale: a draft made without the PDF, now that a usable read exists → re-review', () => {
  const { d, saved } = savedFrom(ctxFor(false), null);
  const f = R.draftFreshness(Object.assign({}, d, { saved }, usableRead('read-A')));
  assert.strictEqual(f.stale, true); assert.ok(/has been read since/.test(f.reasons[0]));
});
t('list: a stale draft reports stale (the badge can never say Accepted / Ready)', () => {
  const { d, saved } = savedFrom(ctxFor(false), null);
  d.lines = d.lines.map((l, i) => (i === 0 ? Object.assign({}, l, { amount_cents: l.amount_cents + 1 }) : l));
  const p = R.detailPayload(Object.assign({}, d, { saved }, noRead));
  assert.strictEqual(p.draft.freshness.stale, true); assert.strictEqual(p.draft.summary.can_accept, false);
});

console.log(`\n${pass} passed${process.exitCode ? ', FAILURES above' : ''}`);
