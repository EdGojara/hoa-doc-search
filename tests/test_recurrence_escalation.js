// Tests for the 6-month repeat of a movable violation (Tex. Prop. Code §209.006 repeat exception).
// POLICY (Ed 2026-10-23): a genuinely cured and closed violation resets the enforcement sequence.
// A repeat is detected and flagged for review; it never opens at certified by itself, and an
// internal stage label is never proof that a certified statutory notice was mailed.
try { require('dotenv').config(); } catch (_) {} // module load builds a Supabase client
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isRecurrence, RECURRENCE_LOOKBACK_DAYS, detectRecurrence, certifiedNoticeGiven } = require('../lib/enforcement/find_or_continue_violation');
const { letterStageOf, deliveryMismatch } = require('../lib/enforcement/letter_stage');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓', name); };
const NOW = Date.parse('2026-07-25T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 864e5).toISOString();

console.log('recurrence_escalation:');

t('lookback window is the statutory 6 months (~183 days)', () => {
  assert.ok(RECURRENCE_LOOKBACK_DAYS >= 180 && RECURRENCE_LOOKBACK_DAYS <= 184);
});
t('movable violation cured 30 days ago -> a repeat within the window', () => {
  assert.strictEqual(isRecurrence({ escalates: true, priorResolvedAt: daysAgo(30), nowMs: NOW }), true);
});
t('movable violation cured just inside 6 months -> within the window', () => {
  assert.strictEqual(isRecurrence({ escalates: true, priorResolvedAt: daysAgo(180), nowMs: NOW }), true);
});
t('movable violation cured 200 days ago (>6mo) -> outside the window', () => {
  assert.strictEqual(isRecurrence({ escalates: true, priorResolvedAt: daysAgo(200), nowMs: NOW }), false);
});
t('natural-cadence category (not flagged) is never a repeat, even 1 day ago', () => {
  assert.strictEqual(isRecurrence({ escalates: false, priorResolvedAt: daysAgo(1), nowMs: NOW }), false);
});
t('no prior cured case -> not a repeat', () => {
  assert.strictEqual(isRecurrence({ escalates: true, priorResolvedAt: null, nowMs: NOW }), false);
});
t('garbage / future prior date -> safe (not a repeat)', () => {
  assert.strictEqual(isRecurrence({ escalates: true, priorResolvedAt: 'not-a-date', nowMs: NOW }), false);
  assert.strictEqual(isRecurrence({ escalates: true, priorResolvedAt: daysAgo(-5), nowMs: NOW }), false);
});

t('certifiedNoticeGiven: only a certified §209 letter mailed by certified mail is a certified notice', () => {
  const ago = (n) => new Date(Date.now() - n * 864e5).toISOString();
  assert.strictEqual(certifiedNoticeGiven([{ stage_at_send: 'certified_209', delivery_method: 'certified_mail', status: 'submitted', mailed_at: ago(40) }]), true);
  assert.strictEqual(certifiedNoticeGiven([{ stage_at_send: 'certified_209', delivery_method: 'first_class', status: 'submitted', mailed_at: ago(40) }]), false, 'a certified LABEL on a first-class letter is not a certified notice');
  assert.strictEqual(certifiedNoticeGiven([{ stage_at_send: 'courtesy_1', delivery_method: 'first_class', status: 'delivered', delivered_at: ago(40) }]), false);
  assert.strictEqual(certifiedNoticeGiven([{ stage_at_send: 'certified_209', delivery_method: 'certified_mail', status: 'cancelled', mailed_at: ago(40) }]), false);
  assert.strictEqual(certifiedNoticeGiven([]), false);
});

t('letter stage comes from the letter itself, not its type (the Aug-Sep 2026 mismatch)', () => {
  assert.strictEqual(letterStageOf({ type: 'letter_209', subject: 'Violation letter (courtesy_1)' }), 'courtesy_1', 'a courtesy letter typed letter_209 is a courtesy letter');
  assert.strictEqual(letterStageOf({ type: 'letter_courtesy_1', subject: 'Violation letter (courtesy_2)' }), 'courtesy_2');
  assert.strictEqual(letterStageOf({ type: 'letter_209', subject: 'Violation letter (certified_209)' }), 'certified_209');
  assert.strictEqual(letterStageOf({ type: 'letter_209', subject: '10-day certified force-mow letter' }), 'certified_209', 'no stage in the subject: the type decides');
  assert.strictEqual(deliveryMismatch({ type: 'letter_209', subject: 'Violation letter (certified_209)' }, 'first_class_mail'), true, 'a certified letter is never printed in a first-class run');
  assert.strictEqual(deliveryMismatch({ type: 'letter_209', subject: 'Violation letter (courtesy_1)' }, 'first_class_mail'), false);
  assert.strictEqual(deliveryMismatch({ type: 'letter_209', subject: 'Violation letter (certified_209)' }, 'certified_mail'), false);
});

t('wiring: a repeat opens at its normal stage (never auto-certified); the print run records the actual stage and holds misrouted certified letters', () => {
  const ins = fs.readFileSync(path.join(__dirname, '..', 'api', 'inspections.js'), 'utf8');
  assert.match(ins, /const openStage = decision\.stage;/);
  assert.ok(!/isRepeat \? 'certified_209'/.test(ins), 'no automatic certified for a repeat');
  const enf = fs.readFileSync(path.join(__dirname, '..', 'api', 'enforcement.js'), 'utf8');
  assert.match(enf, /stage_at_send:\s+letterStageOf\(inter\)/);
  assert.match(enf, /deliveryMismatch\(letters\[i\], deliveryMethod\)/);
});

// ---- the two homeowner histories (Ed 2026-10-23), against a stand-in database ----
const D = (iso) => iso;
function db({ priors, pieces, piecesError = null }) {
  return { from(table) {
    const q = { _in: null, select() { return q; }, eq() { return q; }, not() { return q; }, gte() { return q; }, order() { return q; }, limit() { return q; },
      in(col, vals) { if (col === 'violation_id') q._in = vals; return q; },
      then(res, rej) {
        let out;
        if (table === 'enforcement_categories') out = { data: [{ recurrence_escalates: true }], error: null };
        else if (table === 'violations') out = { data: priors.filter((p) => Date.now() - Date.parse(p.resolved_at) <= RECURRENCE_LOOKBACK_DAYS * 864e5), error: null };
        else if (table === 'letter_mail_pieces') out = piecesError ? { data: null, error: { message: piecesError } } : { data: pieces.filter((p) => !q._in || q._in.includes(p.violation_id)), error: null };
        else out = { data: [], error: null };
        return Promise.resolve(out).then(res, rej);
      } };
    return q;
  } };
}
const shift = (iso) => new Date(Date.parse(iso) + (Date.now() - Date.parse('2026-10-23T16:00:00Z'))).toISOString(); // replay 2026-10-23 as "now"

(async () => {
  const at = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };
  await at('5326 Still Meadow Lane: storage case opened and closed 5/20 (Vantaca, no letter) -> new 10/23 case is a FIRST NOTICE, flagged as a repeat, no certified notice ever given', async () => {
    const r = await detectRecurrence({ propertyId: 'still-meadow', categoryId: 'storage' }, { db: db({
      priors: [{ id: 'may20', current_stage: 'cured', resolved_at: shift(D('2026-05-20T00:00:00Z')) }], pieces: [] }) });
    assert.ok(r && r.is_repeat === true, 'detected as a repeat for the reviewer');
    assert.strictEqual(r.escalates, false, 'never escalates by itself');
    assert.strictEqual(r.prior_certified_notice, false);
  });
  await at('7919 Caribou Valley Court: basketball goal closed 1/28 and 4/29, Aug 18 case cured 9/22 (labeled certified, mailed FIRST CLASS) -> new 10/23 case is a FIRST NOTICE; the label is not a certified notice', async () => {
    const r = await detectRecurrence({ propertyId: 'caribou', categoryId: 'goal' }, { db: db({
      priors: [
        { id: 'aug18', current_stage: 'cured', resolved_at: shift(D('2026-09-22T14:54:44Z')) },
        { id: 'apr29', current_stage: 'cured', resolved_at: shift(D('2026-04-29T00:00:00Z')) },
        { id: 'jan28', current_stage: 'cured', resolved_at: shift(D('2026-01-28T00:00:00Z')) },
      ],
      pieces: [{ violation_id: 'aug18', stage_at_send: 'certified_209', delivery_method: 'first_class', status: 'submitted', mailed_at: shift(D('2026-08-18T12:00:00Z')) }] }) });
    assert.ok(r && r.is_repeat === true && r.prior_violation_id === 'aug18');
    assert.strictEqual(r.escalates, false);
    assert.strictEqual(r.prior_certified_notice, false, 'certified_209 on a first-class mailing is not a certified notice');
  });
  await at('even after a genuinely mailed certified §209 notice, the repeat is only flagged (the exception needs a person\'s decision)', async () => {
    const r = await detectRecurrence({ propertyId: 'p', categoryId: 'c' }, { db: db({
      priors: [{ id: 'cert', current_stage: 'cured', resolved_at: new Date(Date.now() - 60 * 864e5).toISOString() }],
      pieces: [{ violation_id: 'cert', stage_at_send: 'certified_209', delivery_method: 'certified_mail', status: 'delivered', delivered_at: new Date(Date.now() - 80 * 864e5).toISOString() }] }) });
    assert.ok(r && r.prior_certified_notice === true && r.prior_certified_violation_id === 'cert');
    assert.strictEqual(r.escalates, false);
  });
  await at('a failed mailing lookup reports no certified notice (fail safe)', async () => {
    const r = await detectRecurrence({ propertyId: 'p', categoryId: 'c' }, { db: db({ priors: [{ id: 'x', current_stage: 'cured', resolved_at: new Date(Date.now() - 10 * 864e5).toISOString() }], pieces: [], piecesError: 'timeout' }) });
    assert.ok(r && r.prior_certified_notice === false && r.escalates === false);
  });
  console.log(`\nrecurrence_escalation: ${passed} passed`);
})().catch((e) => { console.error('  ✗', e.message); process.exit(1); });
