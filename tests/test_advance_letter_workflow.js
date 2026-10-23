// The ONE advance-and-letter workflow (Ed 2026-10-23): a case moves up to
// Courtesy 2 / Certified only after its letter is prepared in Drafts, only when
// the earlier notice was actually mailed, never twice, and a failure leaves the
// stage unchanged with a visible reason. Runs the real _advanceWithStageLetter
// against an in-memory database; every entry point is checked to use it.
try { require('dotenv').config(); } catch (_) {}
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { _advanceWithStageLetter } = require('../api/enforcement');
const { decideReobservationOutcome } = require('../lib/enforcement/reobservation_outcome');

let passed = 0;
const at = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// ---- a small in-memory stand-in for the two tables the workflow touches
function fakeDb(seed) {
  const T = { violations: [...(seed.violations || [])], interactions: [...(seed.interactions || [])] };
  let n = 0;
  const q = (table) => {
    const st = { table, filters: [], op: 'select', patch: null, rows: null };
    const match = (r) => st.filters.every(([k, op, v]) => op === 'eq' ? r[k] === v : op === 'like' ? String(r[k] || '').startsWith(String(v).replace(/%$/, '')) : true);
    const run = () => {
      if (st.op === 'insert') { const rows = st.rows.map((r) => ({ id: 'i' + (++n), ...r })); T[table].push(...rows); return { data: rows, error: null }; }
      if (st.op === 'update') { if (st.failUpdate) return { data: null, error: { message: 'boom' } }; const hit = T[table].filter(match); hit.forEach((r) => Object.assign(r, st.patch)); return { data: hit.map((r) => ({ id: r.id })), error: null }; }
      return { data: T[table].filter(match).map((r) => ({ ...r })), error: null };
    };
    const api = {
      select() { return api; }, eq(k, v) { st.filters.push([k, 'eq', v]); return api; }, like(k, v) { st.filters.push([k, 'like', v]); return api; },
      insert(r) { st.op = 'insert'; st.rows = Array.isArray(r) ? r : [r]; return api; }, update(p) { st.op = 'update'; st.patch = p; if (seed.raceOnUpdate && table === 'violations') { st.filters.push(['id', 'eq', '__nobody__']); } return api; },
      maybeSingle() { const r = run(); return Promise.resolve({ data: (r.data || [])[0] || null, error: r.error }); },
      single() { const r = run(); return Promise.resolve({ data: (r.data || [])[0] || null, error: r.error }); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  };
  return { T, from: q };
}
const caseRow = (over) => ({ id: 'v1', property_id: 'p1', community_id: 'c1', primary_category_id: 'k1', current_stage: 'courtesy_1', current_stage_started_at: '2026-09-22T12:00:00Z', opened_at: '2026-09-22T12:00:00Z', opened_from_observation_id: 'o1', resolved_at: null, quality_status: 'verified', source: 'trustEd_native', ...over });
const c1 = (over) => ({ id: 'L1', violation_id: 'v1', type: 'letter_courtesy_1', subject: 'Violation letter (courtesy_1)', status: 'sent', printed_at: '2026-09-22T15:00:00Z', mailed_at: '2026-09-22T18:00:00Z', postmark_date: '2026-09-22', created_at: '2026-09-22T12:00:00Z', ...over });
function drafter(db, { fail = null } = {}) {
  const calls = [];
  const fn = async (v, decision, cid, opts) => {
    calls.push({ v: v.id, stage: decision.stage, mail: decision.mail_type, opts, stageAtDraft: db.T.violations.find((x) => x.id === v.id).current_stage });
    if (fail) return { error: fail };
    const id = 'D' + calls.length;
    db.T.interactions.push({ id, violation_id: v.id, type: decision.stage === 'courtesy_2' ? 'letter_courtesy_2' : 'letter_209', subject: `Violation letter (${decision.stage}) — x`, status: 'draft', created_at: new Date().toISOString() });
    return { interaction_id: id, letter_path: 'x.pdf' };
  };
  fn.calls = calls;
  return fn;
}
const notes = (db) => db.T.interactions.filter((i) => i.type === 'observation_note');

console.log('advance_letter_workflow:');
(async () => {
  await at('Courtesy 1 mailed, seen again -> Courtesy 2 letter prepared FIRST (stage still Courtesy 1 at that moment), then the stage moves; audit names who/why/letter; deadline untouched', async () => {
    const db = fakeDb({ violations: [caseRow({ cure_period_ends_at: '2026-10-07T12:00:00Z' })], interactions: [c1()] });
    const draft = drafter(db);
    const r = await _advanceWithStageLetter({ violationId: 'v1', toStage: 'courtesy_2', actor: { id: 'u1', full_name: 'Martha Bravo' }, source: 'inspection_confirm', reason: 'still there', observationId: 'o2', inspectionId: 'I2' }, { db, draft });
    assert.ok(r.ok && r.advanced && r.letter_interaction_id === 'D1', JSON.stringify(r));
    assert.strictEqual(draft.calls[0].stageAtDraft, 'courtesy_1', 'letter prepared before the stage changed');
    assert.strictEqual(draft.calls[0].mail, 'first_class_mail');
    assert.strictEqual(draft.calls[0].opts.inspectionId, 'I2');
    assert.strictEqual(db.T.violations[0].current_stage, 'courtesy_2');
    assert.strictEqual(db.T.violations[0].cure_period_ends_at, '2026-10-07T12:00:00Z', 'Courtesy 1 deadline kept');
    const a = notes(db).find((x) => x.subject === 'Stage advanced: courtesy_1 → courtesy_2');
    assert.ok(a && /Martha Bravo/.test(a.content) && /Reason: still there/.test(a.content) && /Courtesy 1 mailed 2026-09-22/.test(a.content) && a.sent_by_user_id === 'u1');
    assert.ok(db.T.interactions.some((i) => i.id === 'D1' && i.status === 'draft' && i.type === 'letter_courtesy_2'), 'the letter is a draft in the Drafts queue (status draft, letter_courtesy_2)');
  });
  await at('first notice printed but mailing NOT confirmed -> not advanced, no letter, the reason says to confirm the mailing', async () => {
    const db = fakeDb({ violations: [caseRow()], interactions: [c1({ mailed_at: null })] });
    const draft = drafter(db);
    const r = await _advanceWithStageLetter({ violationId: 'v1', toStage: 'courtesy_2', source: 'manual_advance' }, { db, draft });
    assert.strictEqual(r.code, 'prior_notice_not_mailed');
    assert.match(r.message, /Confirm its mailing in the Mail Queue/);
    assert.strictEqual(draft.calls.length, 0);
    assert.strictEqual(db.T.violations[0].current_stage, 'courtesy_1');
  });
  await at('the letter cannot be prepared -> the stage does NOT change and the case timeline says why (no falsely completed workflow)', async () => {
    const db = fakeDb({ violations: [caseRow()], interactions: [c1()] });
    const r = await _advanceWithStageLetter({ violationId: 'v1', toStage: 'courtesy_2', source: 'inspection_confirm' }, { db, draft: drafter(db, { fail: 'render failed: no owner' }) });
    assert.strictEqual(r.code, 'letter_failed');
    assert.strictEqual(db.T.violations[0].current_stage, 'courtesy_1');
    assert.ok(notes(db).some((x) => /could not be prepared/.test(x.subject) && /NOT advanced/.test(x.content) && /render failed: no owner/.test(x.content)));
  });
  await at('repeated click / duplicate photo / retry -> one stage change, one letter', async () => {
    const db = fakeDb({ violations: [caseRow()], interactions: [c1()] });
    const draft = drafter(db);
    const a1 = await _advanceWithStageLetter({ violationId: 'v1', toStage: 'courtesy_2', source: 'manual_advance' }, { db, draft });
    const a2 = await _advanceWithStageLetter({ violationId: 'v1', toStage: 'courtesy_2', source: 'manual_advance' }, { db, draft });
    assert.ok(a1.advanced && a2.ok && a2.already);
    assert.strictEqual(draft.calls.length, 1);
    assert.strictEqual(db.T.interactions.filter((i) => i.type === 'letter_courtesy_2').length, 1);
  });
  await at('two jobs racing -> the loser withdraws the letter it made (no second live letter, no double stage)', async () => {
    const db = fakeDb({ violations: [caseRow()], interactions: [c1()], raceOnUpdate: true });
    const r = await _advanceWithStageLetter({ violationId: 'v1', toStage: 'courtesy_2', source: 'reconciliation' }, { db, draft: drafter(db) });
    assert.ok(r.ok && r.raced);
    assert.strictEqual(db.T.interactions.find((i) => i.id === 'D1').status, 'rejected');
  });
  await at('recovery: a case already at Courtesy 2 with NO letter (the 9/14 Waterview gap) -> letter prepared, stage unchanged; refused if Courtesy 1 never mailed', async () => {
    const db = fakeDb({ violations: [caseRow({ current_stage: 'courtesy_2' })], interactions: [c1()] });
    const r = await _advanceWithStageLetter({ violationId: 'v1', toStage: 'courtesy_2', source: 'prepare_missing_letter', recoverOnly: true }, { db, draft: drafter(db) });
    assert.ok(r.ok && r.recovered && r.letter_interaction_id);
    assert.ok(notes(db).some((x) => x.subject === 'Courtesy 2 letter prepared (was missing)'));
    const db2 = fakeDb({ violations: [caseRow({ current_stage: 'courtesy_2' })], interactions: [] });
    const r2 = await _advanceWithStageLetter({ violationId: 'v1', toStage: 'courtesy_2', recoverOnly: true }, { db: db2, draft: drafter(db2) });
    assert.strictEqual(r2.code, 'prior_notice_not_mailed');
    assert.match(r2.message, /Reduce the case to Courtesy 1/);
  });
  await at('Certified §209 needs the Courtesy 2 letter actually mailed; then a certified draft is prepared (certified mail); a Vantaca import carries its history', async () => {
    const c2 = { id: 'L2', violation_id: 'v1', type: 'letter_courtesy_2', subject: 'Violation letter (courtesy_2)', status: 'sent', mailed_at: null, created_at: '2026-10-01' };
    const db = fakeDb({ violations: [caseRow({ current_stage: 'courtesy_2' })], interactions: [c1(), c2] });
    const r = await _advanceWithStageLetter({ violationId: 'v1', toStage: 'certified_209', source: 'manual_advance' }, { db, draft: drafter(db) });
    assert.strictEqual(r.code, 'prior_notice_not_mailed', 'Courtesy 2 printed but not mailed is not notice');
    c2.mailed_at = '2026-10-02T18:00:00Z';
    const draft = drafter(db);
    const r2 = await _advanceWithStageLetter({ violationId: 'v1', toStage: 'certified_209', source: 'manual_advance' }, { db, draft });
    assert.ok(r2.ok && r2.advanced && draft.calls[0].mail === 'certified_mail');
    const dbV = fakeDb({ violations: [caseRow({ current_stage: 'courtesy_2', source: 'vantaca_import' })], interactions: [] });
    assert.ok((await _advanceWithStageLetter({ violationId: 'v1', toStage: 'certified_209' }, { db: dbV, draft: drafter(dbV) })).ok);
  });
  await at('never skips a stage, never touches a closed case', async () => {
    const db = fakeDb({ violations: [caseRow()], interactions: [c1()] });
    assert.strictEqual((await _advanceWithStageLetter({ violationId: 'v1', toStage: 'certified_209' }, { db, draft: drafter(db) })).code, 'wrong_stage');
    const dbc = fakeDb({ violations: [caseRow({ current_stage: 'cured', resolved_at: '2026-10-01' })], interactions: [c1()] });
    assert.strictEqual((await _advanceWithStageLetter({ violationId: 'v1', toStage: 'courtesy_2' }, { db: dbc, draft: drafter(dbc) })).code, 'closed');
  });

  await at('re-observation classifier: Courtesy 1 advances only on a CONFIRMED mailing; Courtesy 2 is §209-eligible only when its letter was mailed', async () => {
    const mk = (letters) => ({ from() { const qq = { select() { return qq; }, eq() { return qq; }, like() { return qq; }, then(r) { return Promise.resolve({ data: letters, error: null }).then(r); } }; return qq; } });
    const v1 = { id: 'v1', current_stage: 'courtesy_1', current_stage_started_at: '2026-09-22T12:00:00Z' };
    assert.strictEqual((await decideReobservationOutcome(mk([c1({ mailed_at: null })]), v1)).outcome, 'awaiting_first_mail', 'queued/printed is not mailed');
    assert.strictEqual((await decideReobservationOutcome(mk([c1({ type: 'letter_209' })]), v1)).outcome, 'advance_courtesy_2', 'a Courtesy 1 typed letter_209 still counts');
    const v2 = { ...v1, current_stage: 'courtesy_2' };
    assert.strictEqual((await decideReobservationOutcome(mk([c1()]), v2)).reason, 'second_notice_missing');
    assert.strictEqual((await decideReobservationOutcome(mk([c1(), { type: 'letter_courtesy_2', subject: 'Violation letter (courtesy_2)', status: 'approved', mailed_at: null }]), v2)).reason, 'second_notice_not_mailed');
    assert.strictEqual((await decideReobservationOutcome(mk([c1(), { type: 'letter_courtesy_2', subject: 'Violation letter (courtesy_2)', status: 'sent', mailed_at: '2026-10-02' }]), v2)).outcome, 'eligible_209');
  });

  await at('wiring: every entry point that raises a case to Courtesy 2 / Certified goes through the one workflow', async () => {
    const enf = read('api/enforcement.js'); const ins = read('api/inspections.js');
    const slice = (s, start, len) => { const i = s.indexOf(start); assert.ok(i >= 0, 'missing ' + start); return s.slice(i, i + len); };
    assert.match(slice(ins, "if (outcome === 'advance_courtesy_2') {", 1500), /_advanceWithStageLetter\(\{\s*violationId: vId, toStage: 'courtesy_2'/, 'inspection confirm');
    assert.match(slice(enf, "router.post('/violations/:violationId/advance-stage'", 6000), /_advanceWithStageLetter\(\{ violationId, toStage: nextStage, actor, source: 'manual_advance'/, 'manual Advance');
    assert.match(slice(enf, "router.post('/open-violation'", 14000), /_advanceWithStageLetter\(\{ violationId: target\.id, toStage: 'courtesy_2'/, 'staff open-violation');
    assert.match(slice(enf, "router.post('/reconcile/apply'", 6000), /_advanceWithStageLetter\(\{ violationId: id, toStage: 'courtesy_2'/, 'reconciliation');
    assert.match(slice(enf, 'async function processCureLapses', 9000), /_advanceWithStageLetter\(\{ violationId: v\.id, toStage: 'courtesy_2', source: 'cure_lapse'/, 'cure lapse');
    assert.ok(!/fine_posting_queue/.test(slice(enf, 'async function processCureLapses', 9000)), 'automation never assesses a fine');
    assert.match(slice(enf, 'async function _reconcileAliasedOpenViolations', 6000), /_advanceWithStageLetter\(\{ violationId: survivor\.id, toStage: 'courtesy_2'/, 'alias merge');
    assert.match(slice(enf, "router.post('/drafts/:interactionId/fold-into'", 8000), /_advanceWithStageLetter\(\{ violationId: target\.id, toStage: adv/, 'fold into');
    assert.match(enf, /router\.post\('\/violations\/:violationId\/prepare-stage-letter'/, 'recovery endpoint');
    // the confirm path never opens a NEW case because matching the existing one failed
    assert.match(slice(ins, '} catch (contErr) {', 700), /return res\.status\(500\)\.json\(\{ error: 'continuation_check_failed'/);
    // the draft helper reports a refused insert instead of "success" with no letter
    assert.match(slice(enf, 'async function _draftLetterForBumpedViolation', 26000), /if \(insErr \|\| !inter\) \{/);
    // nothing else writes a raised stage directly
    const direct = (enf.match(/update\(\{\s*current_stage: 'courtesy_2'/g) || []).length + (ins.match(/update\(\{\s*current_stage: 'courtesy_2'/g) || []).length;
    assert.strictEqual(direct, 0, 'no direct courtesy_2 stage writes outside the workflow');
  });

  console.log(`\nadvance_letter_workflow: ${passed} passed`);
})().catch((e) => { console.error('  ✗', e.message); process.exit(1); });
