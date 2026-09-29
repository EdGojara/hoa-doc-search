#!/usr/bin/env node
// ============================================================================
// tests/test_ops_overview.js  (Issue #6, Operations slice)
// ----------------------------------------------------------------------------
// Locks lib/ops/overview.js evaluateOps() + businessDaysSince():
//   - a failed read makes its areas UNKNOWN (problem row), never zero/quiet;
//   - printed letters with no mailed_at are "mailing not recorded";
//   - overdue only against stored times (respond_by_at, sla_due_at,
//     cure_period_ends_at, the community's builder ARC target in business days);
//   - leaving/prospect communities are listed but never counted or itemized;
//   - informational areas (open certified, courtesy cure ended) don't count;
//   - items with no community land in "Bedrock / no community";
//   - unknown community ids (e.g. demo) are dropped.
// Offline and deterministic.
// ============================================================================
const assert = require('assert');
const { evaluateOps, businessDaysSince } = require('../lib/ops/overview');

let pass = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; }
}
const NOW = '2026-09-29T15:00:00Z'; // Tuesday
const ok = (rows) => ({ ok: true, rows });
const comms = [
  { id: 'a', name: 'Alpha', management_status: 'active', builder_arc_sla_business_days: 5, builder_arc_fast_track_business_days: 2 },
  { id: 'l', name: 'Leaving', management_status: 'terminating', management_end_date: '2026-09-30' },
  { id: 'p', name: 'Prospect', management_status: 'prospect' },
];
const empty = () => ({ letters: ok([]), violations: ok([]), acc: ok([]), builder: ok([]), calls: ok([]), drafts: ok([]), work: ok([]), rentals: ok([]) });
const facts = (over) => Object.assign(empty(), over);
const area = (r, name, key) => (r.managed.concat(r.other).find((b) => b.community.name === name) || { areas: {} }).areas[key];

console.log('test_ops_overview');

t('business days: weekends excluded', () => {
  assert.strictEqual(businessDaysSince('2026-09-22T15:00:00Z', NOW), 5); // Tue → Tue
  assert.strictEqual(businessDaysSince('2026-09-26T15:00:00Z', NOW), 2); // Sat → Tue (Mon, Tue)
  assert.strictEqual(businessDaysSince('2026-09-29T09:00:00Z', NOW), 0);
});

t('nothing open → no items, no problems', () => {
  const r = evaluateOps(comms, empty(), NOW);
  assert.strictEqual(r.items.length, 0);
  assert.strictEqual(r.problems.length, 0);
});

t('failed read → problem + unknown areas, never quiet', () => {
  const r = evaluateOps(comms, facts({ calls: { ok: false, error: 'timeout' } }), NOW);
  assert.ok(r.problems.some((p) => p.key === 'calls'));
  assert.ok(r.areas.find((a) => a.key === 'calls_overdue').unknown);
  assert.ok(!r.quiet.some((q) => q.key === 'calls_overdue' || q.key === 'calls_open'));
});

t('letters: draft / ready to print / printed with mailing not recorded', () => {
  const r = evaluateOps(comms, facts({ letters: ok([
    { community_id: 'a', status: 'draft', created_at: '2026-09-20' },
    { community_id: 'a', status: 'approved', printed_at: null, created_at: '2026-09-21' },
    { community_id: 'a', status: 'approved', printed_at: '2026-09-28T18:00:00Z', mailed_at: null },
    { community_id: 'a', status: 'approved', printed_at: '2026-09-27T18:00:00Z', mailed_at: '2026-09-28' },
    { community_id: 'a', status: 'rejected', printed_at: '2026-09-27T18:00:00Z', mailed_at: null },
  ]) }), NOW);
  assert.strictEqual(area(r, 'Alpha', 'letters_draft').count, 1);
  assert.strictEqual(area(r, 'Alpha', 'letters_print').count, 1);
  assert.strictEqual(area(r, 'Alpha', 'letters_unrecorded').count, 1, 'mailed and rejected letters are not unrecorded');
  const item = r.items.find((i) => i.key === 'letters_unrecorded');
  assert.strictEqual(item.title, 'Printed, mailing not recorded');
});

t('callbacks: overdue only when respond_by_at has passed', () => {
  const r = evaluateOps(comms, facts({ calls: ok([
    { community_id: 'a', respond_by_at: '2026-09-28T12:00:00Z' },
    { community_id: 'a', respond_by_at: '2026-09-30T12:00:00Z' },
    { community_id: 'a', respond_by_at: null, started_at: '2026-09-29T10:00:00Z' },
  ]) }), NOW);
  assert.strictEqual(area(r, 'Alpha', 'calls_overdue').count, 1);
  assert.strictEqual(area(r, 'Alpha', 'calls_open').count, 2, 'no respond_by_at = not overdue');
});

t('builder ARC: overdue against the stored target, fast track uses its own target', () => {
  const r = evaluateOps(comms, facts({ builder: ok([
    { community_id: 'a', submitted_at: '2026-09-21T15:00:00Z', fast_track: false }, // 6 business days > 5
    { community_id: 'a', submitted_at: '2026-09-23T15:00:00Z', fast_track: false }, // 4 ≤ 5
    { community_id: 'a', submitted_at: '2026-09-24T15:00:00Z', fast_track: true },  // 3 > 2
  ]) }), NOW);
  assert.strictEqual(area(r, 'Alpha', 'builder_overdue').count, 2);
  assert.strictEqual(area(r, 'Alpha', 'builder_open').count, 1);
});

t('builder ARC with no stored target is never overdue', () => {
  const r = evaluateOps([{ id: 'n', name: 'NoTarget', management_status: 'active' }], facts({ builder: ok([{ community_id: 'n', submitted_at: '2026-01-01T15:00:00Z' }]) }), NOW);
  assert.strictEqual(area(r, 'NoTarget', 'builder_overdue').count, 0);
  assert.strictEqual(area(r, 'NoTarget', 'builder_open').count, 1);
});

t('violations: certified cure ended itemized (human-only); open certified and courtesy lapses informational', () => {
  const r = evaluateOps(comms, facts({ violations: ok([
    { community_id: 'a', current_stage: 'certified_209', cure_period_ends_at: '2026-09-01T00:00:00Z' },
    { community_id: 'a', current_stage: 'certified_209', cure_period_ends_at: '2026-10-15T00:00:00Z' },
    { community_id: 'a', current_stage: 'courtesy_1', cure_period_ends_at: '2026-09-10T00:00:00Z' },
  ]) }), NOW);
  assert.strictEqual(area(r, 'Alpha', 'certified_open').count, 2);
  assert.strictEqual(area(r, 'Alpha', 'certified_cure_ended').count, 1);
  assert.strictEqual(area(r, 'Alpha', 'courtesy_cure_ended').count, 1);
  const cert = r.items.find((i) => i.key === 'certified_cure_ended');
  assert.ok(cert && cert.humanOnly);
  assert.ok(!r.items.some((i) => i.key === 'certified_open' || i.key === 'courtesy_cure_ended'), 'informational areas are not itemized');
  assert.strictEqual(r.managed.find((b) => b.community.name === 'Alpha').needs_action, 1, 'only the certified cure-ended counts');
});

t('leaving and prospect communities are listed but never itemized or counted', () => {
  const r = evaluateOps(comms, facts({ letters: ok([
    { community_id: 'l', status: 'approved', printed_at: '2026-08-01T18:00:00Z', mailed_at: null },
    { community_id: 'p', status: 'draft', created_at: '2026-09-20' },
  ]) }), NOW);
  assert.strictEqual(r.items.length, 0);
  assert.strictEqual(area(r, 'Leaving', 'letters_unrecorded').count, 1);
  assert.deepStrictEqual(r.other.map((b) => b.group).sort(), ['leaving', 'prospect']);
  assert.ok(!r.managed.some((b) => b.community.name === 'Leaving'));
});

t('no community → Bedrock bucket; unknown community id (demo) dropped', () => {
  const r = evaluateOps(comms, facts({ drafts: ok([{ community_id: null, created_at: '2026-09-25' }, { community_id: 'demo-x', created_at: '2026-09-25' }]) }), NOW);
  const item = r.items.find((i) => i.key === 'email_drafts');
  assert.strictEqual(item.count, 1);
  assert.strictEqual(item.communities[0].name, 'Bedrock / no community');
});

t('work items: overdue only past sla_due_at', () => {
  const r = evaluateOps(comms, facts({ work: ok([{ community_id: 'a', sla_due_at: '2026-09-29T10:00:00Z' }, { community_id: 'a', sla_due_at: '2026-09-30T10:00:00Z' }]) }), NOW);
  assert.strictEqual(area(r, 'Alpha', 'work_overdue').count, 1);
  assert.strictEqual(area(r, 'Alpha', 'work_open').count, 1);
});

t('not-yet-due work (open callbacks, builder in review, open tasks) is not itemized or counted', () => {
  const r = evaluateOps(comms, facts({
    calls: ok([{ community_id: 'a', respond_by_at: '2026-10-05T00:00:00Z' }]),
    builder: ok([{ community_id: 'a', submitted_at: '2026-09-28T15:00:00Z' }]),
    work: ok([{ community_id: 'a', sla_due_at: '2026-10-05T00:00:00Z' }]),
  }), NOW);
  assert.strictEqual(r.items.length, 0);
  assert.strictEqual(r.managed.find((b) => b.community.name === 'Alpha').needs_action, 0);
  assert.strictEqual(area(r, 'Alpha', 'calls_open').count, 1);
});

t('items are ordered worst area first and name the communities', () => {
  const r = evaluateOps(comms, facts({
    calls: ok([{ community_id: 'a', respond_by_at: '2026-09-01T00:00:00Z' }]),
    drafts: ok([{ community_id: 'a', created_at: '2026-09-25' }]),
  }), NOW);
  assert.deepStrictEqual(r.items.map((i) => i.key), ['calls_overdue', 'email_drafts']);
  assert.deepStrictEqual(r.items[0].communities, [{ name: 'Alpha', count: 1 }]);
});

console.log(`\n${pass} passed${process.exitCode ? ', FAILURES above' : ''}`);
