// Letter mail states, stage corrections and certified-mail guards (Ed 2026-10-23).
// Generated, queued, printed and confirmed-mailed are different facts; a
// certified letter never moves as first class without an explicit correction;
// a reduction is audited and never mails anything.
try { require('dotenv').config(); } catch (_) {} // certified_fee loads the AR engine, which builds a Supabase client
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { letterMailState, letterStageOf, deliveryMismatch } = require('../lib/enforcement/letter_stage');
const { planReduction } = require('../lib/enforcement/reduce_plan');
const { partitionMailable } = require('../lib/enforcement/stale_letter_guard');
const { postCertifiedViolationFee, sweepCertifiedViolationFees } = require('../lib/enforcement/certified_fee');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓', name); };
const at = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

console.log('letter_mail_states:');

t('mail state: generated, queued, printed, mailed and held are distinct', () => {
  assert.strictEqual(letterMailState({ type: 'letter_courtesy_1', status: 'draft' }).state, 'generated');
  assert.strictEqual(letterMailState({ status: 'sent', sent_at: '2026-10-23T16:00:00Z' }).state, 'queued');
  const p = letterMailState({ status: 'sent', sent_at: '2026-10-23T16:00:00Z', printed_at: '2026-10-23T20:26:00Z', delivery_method: 'certified_mail' });
  assert.strictEqual(p.state, 'printed');
  assert.match(p.label, /mailing not confirmed/);
  assert.ok(!/^Mailed|sent/i.test(p.label), 'a printed letter is never described as sent or mailed');
  const m = letterMailState({ status: 'sent', printed_at: '2026-10-08T15:00:00Z', mailed_at: '2026-10-08T18:00:00Z', delivery_method: 'certified_mail' });
  assert.strictEqual(m.state, 'mailed');
  assert.match(m.label, /certified mail, no tracking number recorded/);
  assert.match(letterMailState({ status: 'sent', mailed_at: '2026-10-08T18:00:00Z', delivery_method: 'certified_mail', certified_tracking_number: '9407' }).label, /tracking 9407/);
  assert.strictEqual(letterMailState({ status: 'rejected', printed_at: '2026-10-23T20:26:00Z' }).state, 'held');
});

t('a certified-stage letter is a mismatch in anything but a certified run', () => {
  const cert = { type: 'letter_209', subject: 'Violation letter (certified_209)' };
  assert.strictEqual(deliveryMismatch(cert, 'first_class_mail'), true);
  assert.strictEqual(deliveryMismatch(cert, undefined), true);
  assert.strictEqual(deliveryMismatch(cert, 'certified_mail'), false);
  assert.strictEqual(deliveryMismatch({ type: 'letter_209', subject: 'Violation letter (courtesy_1)' }, 'first_class_mail'), false);
});

// ---- Reduce plans against the real 10/23 case histories ----
const STILL_MEADOW = {
  violation: { id: 'e695d44f', current_stage: 'certified_209', cure_period_ends_at: '2026-11-22T12:00:00Z' },
  letters: [{ id: '82d522d4', type: 'letter_209', subject: 'Violation letter (certified_209)', status: 'sent', sent_at: '2026-10-23T16:00:00Z', printed_at: '2026-10-23T20:26:00Z', mailed_at: null, delivery_method: 'certified_mail' }],
};
const EMORY_MILL = {
  violation: { id: 'acebe4f8', current_stage: 'certified_209', cure_period_ends_at: '2026-09-26T12:00:00Z' },
  letters: [{ id: '6d93e999', type: 'letter_209', subject: 'Violation letter (courtesy_1)', status: 'sent', printed_at: '2026-08-27T14:05:00Z', mailed_at: '2026-08-27T18:00:00Z', postmark_date: '2026-08-27', delivery_method: 'first_class_mail' }],
};

t('reduce: a reason is always required', () => {
  const r = planReduction({ ...STILL_MEADOW, body: { override_stage: 'courtesy_1' } });
  assert.strictEqual(r.error, 'reason_required');
});
t('reduce: only downward; an override can never raise or repeat the stage', () => {
  assert.strictEqual(planReduction({ ...STILL_MEADOW, body: { note: 'x', override_stage: 'fine_assessed' } }).error, 'not_a_reduction');
  assert.strictEqual(planReduction({ ...STILL_MEADOW, body: { note: 'x', override_stage: 'certified_209' } }).error, 'not_a_reduction');
  assert.strictEqual(planReduction({ ...STILL_MEADOW, body: { note: 'x', override_stage: 'bogus' } }).error, 'not_a_reduction');
});
t('reduce: 5326 Still Meadow -> Courtesy 1 is refused until the printed certified letter is confirmed physically held', () => {
  const r = planReduction({ ...STILL_MEADOW, body: { note: 'cured case resets', override_stage: 'courtesy_1' } });
  assert.strictEqual(r.error, 'printed_letter_hold_unconfirmed');
  assert.strictEqual(r.printed_letters[0].id, '82d522d4');
  const ok = planReduction({ ...STILL_MEADOW, body: { note: 'cured case resets', override_stage: 'courtesy_1', printed_letters_held: true } });
  assert.ok(ok.ok && ok.prevStage === 'courtesy_1' && !ok.correction);
  assert.deepStrictEqual(ok.outranking.map((l) => l.id), ['82d522d4'], 'the printed certified letter becomes held');
});
t('reduce: 5115 Emory Mill "match the letter actually mailed" -> Courtesy 1, cure clock kept, nothing to hold', () => {
  const r = planReduction({ ...EMORY_MILL, body: { note: 'record showed certified; only Courtesy 1 went out', correction: 'match_mailed_letter' } });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.prevStage, 'courtesy_1');
  assert.strictEqual(r.correction, true);
  assert.strictEqual(r.mailedLetter.id, '6d93e999');
  assert.strictEqual(r.outranking.length, 0);
});
t('reduce: match-the-mailed-letter is refused when no letter was confirmed mailed', () => {
  assert.strictEqual(planReduction({ ...STILL_MEADOW, body: { note: 'x', correction: 'match_mailed_letter' } }).error, 'no_mailed_letter');
});
t('reduce: a closed case cannot be reduced', () => {
  assert.match(planReduction({ violation: { current_stage: 'cured', resolved_at: '2026-09-22' }, letters: [], body: { note: 'x' } }).error, /resolved/);
});

// ---- Stale guard ranks by the letter's actual stage ----
const stubDb = (vios) => ({ from() { const q = { select() { return q; }, in() { return Promise.resolve({ data: vios, error: null }); } }; return q; } });
(async () => {
  await at('stale guard: a Courtesy 1 letter typed letter_209 on a Courtesy 1 case mails; a certified letter on a reduced case is held', async () => {
    const { mailable, stale } = await partitionMailable(stubDb([{ id: 'v1', current_stage: 'courtesy_1' }, { id: 'v2', current_stage: 'courtesy_1' }]), [
      { id: 'a', type: 'letter_209', subject: 'Violation letter (courtesy_1)', violation_id: 'v1', status: 'sent' },
      { id: 'b', type: 'letter_209', subject: 'Violation letter (certified_209)', violation_id: 'v2', status: 'sent' },
    ]);
    assert.deepStrictEqual(mailable.map((l) => l.id), ['a']);
    assert.deepStrictEqual(stale.map((l) => l.id), ['b']);
  });

  // ---- Certified fee: only a confirmed certified mailing is billed ----
  await at('fee: a first-class letter, a printed-but-unconfirmed letter, and a held letter are never charged', async () => {
    const base = { id: 'p', community_id: 'c', property_id: 'h', interaction_id: 'i', stage_at_send: 'certified_209', created_at: '2026-10-23' };
    assert.strictEqual((await postCertifiedViolationFee(null, { ...base, delivery_method: 'first_class', status: 'submitted', mailed_at: '2026-08-27' })).reason, 'not_certified_mail');
    assert.strictEqual((await postCertifiedViolationFee(null, { ...base, delivery_method: 'certified_mail', status: 'queued', mailed_at: null })).reason, 'not_confirmed_mailed');
    assert.strictEqual((await postCertifiedViolationFee(null, { ...base, delivery_method: 'certified_mail', status: 'cancelled', mailed_at: null })).reason, 'not_confirmed_mailed');
    assert.strictEqual((await postCertifiedViolationFee(null, { ...base, delivery_method: 'certified_mail', status: 'submitted', mailed_at: null })).reason, 'not_confirmed_mailed');
    assert.strictEqual((await postCertifiedViolationFee(null, { ...base, stage_at_send: 'courtesy_1', delivery_method: 'first_class', status: 'submitted', mailed_at: '2026-08-27' })).reason, 'not_certified_stage');
  });
  await at('fee: two sweeps started together run one after the other (the 10/23 double charge)', async () => {
    let active = 0; let maxActive = 0;
    const db = { from() { const q = { select() { return q; }, eq() {
      active++; maxActive = Math.max(maxActive, active);
      return new Promise((r) => setTimeout(() => { active--; r({ data: [], error: null }); }, 30));
    } }; return q; } };
    await Promise.all([sweepCertifiedViolationFees(db, { dryRun: true }), sweepCertifiedViolationFees(db, { dryRun: true })]);
    assert.strictEqual(maxActive, 1);
  });

  // ---- Wiring: every path that moves or records mail honors the rules ----
  t('wiring: printing is not mailing; mail is confirmed, guarded and billed only at confirmation', () => {
    const enf = read('api/enforcement.js');
    assert.ok(!/_mapInteractionTypeToStage\(inter\.type\)/.test(enf), 'no mail record takes its stage from the letter type');
    const lock = enf.slice(enf.indexOf("router.post('/mail-queue/lock-and-batch'"), enf.indexOf("router.post('/mail-queue/lock-and-batch'") + 40000);
    assert.match(lock, /status:\s+'queued',\s*\n\s*submitted_at:\s+null,\s*\n\s*mailed_at:\s+null/);
    assert.ok(!/sweepCertifiedViolationFees\(/.test(lock.slice(0, lock.indexOf('const mergedBytes'))), 'no fee at print');
    const conf = enf.slice(enf.indexOf("router.post('/mail-queue/confirm-mailed'"), enf.indexOf("router.post('/mail-queue/confirm-mailed'") + 9000);
    assert.match(conf, /deliveryMismatch\(l, deliveryMethod\)/);
    assert.match(conf, /type: 'mailing_confirmed'/);
    assert.match(conf, /sweepCertifiedViolationFees/);
    const rec = enf.slice(enf.indexOf("router.post('/interactions/:id/record-mailing'"), enf.indexOf("router.post('/interactions/:id/record-mailing'") + 9000);
    assert.match(rec, /correction_reason_required/);
    assert.match(rec, /type: 'mailing_recorded'/);
    const lob = enf.slice(enf.indexOf("router.post('/mail/send-via-lob'"), enf.indexOf("router.post('/mail/send-via-lob'") + 9000);
    assert.match(lob, /deliveryMismatch\(inter, inter\.delivery_method\)/);
    const man = enf.slice(enf.indexOf("router.post('/mail/log-manual-tracking'"), enf.indexOf("router.post('/mail/log-manual-tracking'") + 3000);
    assert.match(man, /correction_reason_required/);
    const red = enf.slice(enf.indexOf("router.post('/violations/:violationId/reduce-stage'"), enf.indexOf("router.post('/violations/:violationId/reduce-stage'") + 9000);
    assert.match(red, /planReduction\(/);
    assert.match(red, /requireActingUser/);
    assert.match(red, /update\(\{ status: 'rejected' \}\)/, 'held letters are marked, never deleted');
    assert.ok(!/\.delete\(\)/.test(red), 'a reduction deletes nothing');
  });
  t('wiring: homeowner screens show the mail state, never "sent" for a queued or printed letter', () => {
    const idx = read('public/index.html');
    assert.ok(!idx.includes('>📄 Sent ${'), 'no bare "Sent" chip');
    assert.match(idx, /x\.mail_state && x\.mail_state\.state/);
    assert.match(read('api/inspections.js'), /mail_state:\s+\/\^letter_\/\.test\(i\.type \|\| ''\) \? letterMailState\(i\) : null/);
    const ho = read('public/homeowner.html');
    assert.ok(!ho.includes("' sent '+d10(L.sent_at)"), 'Homeowner 360 no longer says "Letter sent" from the queue date');
    assert.match(read('api/homeowner_360.js'), /mail_state: letterMailState\(it\)/);
  });

  console.log(`\nletter_mail_states: ${passed} passed`);
})().catch((e) => { console.error('  ✗', e.message); process.exit(1); });
