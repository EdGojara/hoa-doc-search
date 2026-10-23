// Courtesy 2 is a follow-up reminder (Ed 2026-10-23): a later observation of an
// unresolved Courtesy 1 case advances it even inside the cure period, at most once
// per inspection; the Courtesy 1 deadline is neither shortened nor extended; the
// letter says it is a reminder and states that deadline; Courtesy 2 -> §209 stays a
// staff decision.
try { require('dotenv').config(); } catch (_) {}
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { renderViolationLetterBundlePdf } = require('../lib/enforcement/violation_letter');
const { decideReobservationOutcome, seenEarlierInThisInspection } = require('../lib/enforcement/reobservation_outcome');

let passed = 0;
const at = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const between = (s, start, len) => { const i = s.indexOf(start); assert.ok(i >= 0, 'missing ' + start); return s.slice(i, i + len); };
const pdfText = async (buf) => (await require('pdf-parse')(Buffer.from(buf))).text.replace(/\s+/g, ' ');

const baseCtx = (extra) => ({
  stage: 'courtesy_2',
  property: { street_address: '5326 Still Meadow Lane', city: 'Richmond', state: 'TX', zip: '77407' },
  owner: { full_name: 'Test Owner', mailing_address: '5326 Still Meadow Lane, Richmond, TX 77407' },
  community: { name: 'Still Creek Ranch', letter_cure_days_courtesy_1: 15, letter_cure_days_courtesy_2: 15 },
  letter_date: new Date('2026-10-24T12:00:00-05:00'),
  violations: [{ category_label: 'Trash bins visible', ai_description: 'Trash bins visible from the street at the front of the home.', observation_captured_at: '2026-10-23T15:00:00Z', prior_notices: [{ date: '2026-09-23', stage: 'courtesy_1', delivery_method: 'first_class_mail' }] }],
  ...extra,
});

console.log('courtesy2_reminder:');
(async () => {
  await at('letter: deadline still ahead -> says it is a reminder and prints the ORIGINAL date, not letter date + 15', async () => {
    const t = await pdfText(await renderViolationLetterBundlePdf(baseCtx({ fixed_cure_by: '2026-11-05T12:00:00-06:00' })));
    assert.match(t, /This is a follow-up reminder\. The deadline in our earlier notice still applies: please correct the matter on or before Thursday, November 5, 2026\./);
    assert.ok(!/November 8, 2026/.test(t), 'no new deadline of letter date + 15');
  });
  await at('letter: deadline already passed -> says so, sets no new date, and states no other deadline', async () => {
    const t = await pdfText(await renderViolationLetterBundlePdf(baseCtx({ fixed_cure_by: '2026-10-08T12:00:00-05:00' })));
    assert.match(t, /The deadline in our earlier notice was Thursday, October 8, 2026, and it has passed\. Please correct the matter as soon as possible\./);
    assert.ok(!/November 8, 2026/.test(t));
  });
  await at('letter: no kept deadline (extra time granted, or none on the case) -> the normal Courtesy 2 deadline sentence', async () => {
    const t = await pdfText(await renderViolationLetterBundlePdf(baseCtx({})));
    assert.match(t, /Please correct the matter on or before Sunday, November 8, 2026\./);
    assert.ok(!/follow-up reminder\. The deadline/.test(t));
  });

  await at('classifier: a second observation of the same case on the same inspection never advances it (Courtesy 1 or 2)', async () => {
    const db = { from() { const q = { select() { return q; }, eq() { return q; }, like() { return q; }, then(r) { return Promise.resolve({ data: [{ type: 'letter_courtesy_1', subject: 'Violation letter (courtesy_1)', status: 'sent', mailed_at: '2026-09-23T12:00:00Z' }, { type: 'letter_courtesy_2', subject: 'Violation letter (courtesy_2)', status: 'sent', mailed_at: '2026-10-05T12:00:00Z' }], error: null }).then(r); } }; return q; } };
    const c1 = { id: 'v', current_stage: 'courtesy_1', current_stage_started_at: '2026-09-22T12:00:00Z' };
    assert.strictEqual((await decideReobservationOutcome(db, c1, { sameInspection: true })).reason, 'same_inspection');
    assert.strictEqual((await decideReobservationOutcome(db, c1, {})).outcome, 'advance_courtesy_2', 'a later inspection advances, cure period or not');
    assert.strictEqual((await decideReobservationOutcome(db, { ...c1, current_stage: 'courtesy_2' }, { sameInspection: true })).outcome, 'continuation');
    assert.strictEqual((await decideReobservationOutcome(db, { ...c1, current_stage: 'courtesy_2' }, {})).outcome, 'eligible_209', 'Courtesy 2 is only flagged, never advanced');
  });
  await at('same-inspection lookup: opened on this inspection or already continued on it -> true; a lookup error -> true (no extra advance)', async () => {
    const mk = (obsInsp, contRows, err) => ({ from(t) { const q = { select() { return q; }, eq() { return q; }, neq() { return q; }, maybeSingle() { return Promise.resolve(err ? { data: null, error: { message: 'x' } } : { data: { inspection_id: obsInsp }, error: null }); }, limit() { return Promise.resolve(err ? { data: null, error: { message: 'x' } } : { data: contRows, error: null }); } }; return q; } });
    assert.strictEqual(await seenEarlierInThisInspection(mk('I1', []), { violationId: 'v', openedFromObservationId: 'o', inspectionId: 'I1' }), true);
    assert.strictEqual(await seenEarlierInThisInspection(mk('I0', [{ id: 'c' }]), { violationId: 'v', openedFromObservationId: 'o', inspectionId: 'I1' }), true);
    assert.strictEqual(await seenEarlierInThisInspection(mk('I0', []), { violationId: 'v', openedFromObservationId: 'o', inspectionId: 'I1' }), false);
    assert.strictEqual(await seenEarlierInThisInspection(mk('I0', [], true), { violationId: 'v', openedFromObservationId: 'o', inspectionId: 'I1' }), true);
  });

  await at('wiring: both advance paths keep the deadline; the staff path has no 10-day wait for Courtesy 1; print keeps a Courtesy 2 deadline', async () => {
    const ins = between(read('api/inspections.js'), "if (outcome === 'advance_courtesy_2') {", 900);
    assert.ok(!/cure_period_ends_at/.test(ins), 'confirm advance does not touch the deadline');
    assert.match(read('api/inspections.js'), /seenEarlierInThisInspection\(supabase, \{\s*violationId: vId/);
    const enf = read('api/enforcement.js');
    const staff = between(enf, "router.post('/open-violation'", 12000);
    const _a = between(staff, "if (target.current_stage === 'courtesy_1') {", 1200); const adv = _a.slice(0, _a.indexOf('} else if'));
    assert.match(adv, /decideReobservationOutcome\(supabase, target, \{ sameInspection \}\)/);
    assert.ok(!/readyToEscalate/.test(adv), 'no 10-day wait on Courtesy 1');
    assert.ok(!/cure_period_ends_at/.test(adv), 'staff advance does not touch the deadline');
    assert.match(staff, /readyToEscalate && !sameInspection && target\.current_stage === 'courtesy_2'/, 'Courtesy 2 -> §209 stays a flag with its existing wait');
    assert.match(enf, /const _c2KeepsDeadline = renderStage === 'courtesy_2' && !\(Number\(vio\.cure_days_override\) > 0\) && !!vio\.cure_period_ends_at;/);
    assert.match(enf, /fixed_cure_by: _c2KeepsDeadline \? cureBy : null/);
  });

  console.log(`\ncourtesy2_reminder: ${passed} passed`);
})().catch((e) => { console.error('  ✗', e.message); process.exit(1); });
