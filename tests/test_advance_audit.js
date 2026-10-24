// Manual Advance is audited, and a questionable prior closure is a human
// decision (Ed 2026-10-23). Policy held fixed: a genuinely cured case restarts at
// Courtesy 1; an unresolved case continues its sequence; nothing advances because
// an earlier closure looks wrong.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { reasonError, stageChangeAudit } = require('../lib/enforcement/stage_audit');
const { decideEscalation } = require('../lib/enforcement/escalation');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓', name); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const between = (s, start, len) => { const i = s.indexOf(start); assert.ok(i >= 0, 'missing ' + start); return s.slice(i, i + len); };

console.log('advance_audit:');

t('a reason is required: empty and blank are refused', () => {
  assert.strictEqual(reasonError(undefined).error, 'reason_required');
  assert.strictEqual(reasonError('').error, 'reason_required');
  assert.strictEqual(reasonError('   ').error, 'reason_required');
  assert.strictEqual(reasonError('Trailer still in driveway on 10/23 drive'), null);
});

t('the audit record names the user, time, previous stage, new stage and reason', () => {
  const a = stageChangeAudit({ action: 'advanced', actor: { id: 'u1', full_name: 'Martha Bravo' }, previousStage: 'courtesy_1', newStage: 'courtesy_2', reason: '  still there 10/23 ', at: '2026-10-23T22:30:00.000Z' });
  assert.strictEqual(a.sent_by_user_id, 'u1');
  assert.strictEqual(a.sent_at, '2026-10-23T22:30:00.000Z');
  assert.strictEqual(a.subject, 'Stage advanced: courtesy_1 → courtesy_2');
  assert.match(a.content, /^Martha Bravo advanced this case from Courtesy 1 to Courtesy 2 on 2026-10-23T22:30:00.000Z\. Reason: still there 10\/23$/);
});

t('advance endpoint: actor + reason checked before any change; concurrent change refused; no stage change without its audit record', () => {
  const adv = between(read('api/enforcement.js'), "router.post('/violations/:violationId/advance-stage'", 10000);
  const iActor = adv.indexOf('requireActingUser(req, res)');
  const iReason = adv.indexOf('reasonError(req.body && req.body.note)');
  const iUpdate = adv.indexOf('.update(advPatch)');
  assert.ok(iActor > 0 && iReason > iActor && iUpdate > iReason, 'actor, then reason, then the update');
  assert.match(adv, /\.eq\('current_stage', violation\.current_stage\) \/\/ optimistic guard/);
  assert.match(adv, /stageChangeAudit\(\{ action: 'advanced', actor, previousStage: violation\.current_stage, newStage: nextStage, reason: note, at: nowTs \}\)/);
  // (Migration 545: a failed canonical audit_events write undoes it too.)
  assert.match(adv, /if \(auditErr \|\| canonErr\) \{[\s\S]*?update\(\{ current_stage: violation\.current_stage[\s\S]*?audit_failed/, 'a failed audit write undoes the advance');
  assert.ok(!/audit insert failed:', e\.message\); \}/.test(adv), 'the audit is no longer best-effort');
});

t('both Advance buttons require a reason and send the signed-in user', () => {
  const idx = read('public/index.html');
  const insp = between(idx, 'async function inspAdvanceStage(', 1600);
  assert.match(insp, /A reason is required to advance a violation/);
  assert.match(insp, /JSON\.stringify\(\{ note: note\.trim\(\) \}\)/);
  const cmap = between(idx, 'function cmapAdvanceStage(', 1800);
  assert.match(cmap, /A reason is required to advance a violation/);
  assert.match(cmap, /window\._authFetch\(`\/api\/enforcement\/violations\/\$\{encodeURIComponent\(violationId\)\}\/advance-stage`/);
});

t('a repeat after a closure asks the reviewer: genuinely corrected, or closed in error and continuously unresolved; nothing advances on its own', () => {
  const ins = read('api/inspections.js');
  assert.match(ins, /const openStage = decision\.stage;/, 'the repeat opens at its normal stage');
  const note = between(ins, 'violationRow.review_notes = `Repeat:', 1400);
  assert.match(note, /genuinely corrected and later recurred \(this first notice stands\)/);
  assert.match(note, /closed in error \(continuously unresolved: Advance, with a reason, to continue its sequence\)/);
  assert.ok(!/advance-stage|current_stage:\s*'courtesy_2'|certified_209'/.test(note), 'the note only asks; it changes no stage');
});

t('policy: a genuinely cured prior restarts at Courtesy 1; a still-open prior keeps escalating', () => {
  const cured = decideEscalation({ prior_violations: [{ opened_at: '2026-05-01', current_stage: 'cured', resolved_at: '2026-05-20' }], priority_weight: 'standard' });
  assert.strictEqual(cured.stage, 'courtesy_1');
  const closed = decideEscalation({ prior_violations: [{ opened_at: '2026-05-01', current_stage: 'closed', resolved_at: '2026-05-20' }], priority_weight: 'standard' });
  assert.strictEqual(closed.stage, 'courtesy_1');
  const open = decideEscalation({ prior_violations: [{ opened_at: '2026-05-01', current_stage: 'courtesy_1', resolved_at: null }], priority_weight: 'standard' });
  assert.strictEqual(open.stage, 'courtesy_2', 'an unresolved prior continues the sequence');
  const lapse = decideEscalation({ is_cure_lapse: true, current_stage: 'courtesy_1', priority_weight: 'standard' });
  assert.strictEqual(lapse.stage, 'courtesy_2');
});

console.log(`\nadvance_audit: ${passed} passed`);
