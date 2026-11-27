// Mailing confirmation + violations work queue (Ed 2026-10-24). A letter counts as
// mailed only on staff evidence; held letters never count; the recent Still Creek
// and Waterview runs are presumed NOT mailed until staff confirm; confirming a run
// never touches letters, deadlines, stages, mail pieces or charges.
try { require('dotenv').config(); } catch (_) {}
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ME = require('../lib/enforcement/mailing_evidence');
const { _advanceWithStageLetter } = require('../api/enforcement');

let passed = 0;
const at = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const SCR = 'c-scr';
const scopes = [{ id: 's1', community_id: SCR, printed_from: '2026-10-23', printed_through: '2026-10-24', reason: 'presumed' }];
const letter = (over) => ({ id: 'L1', community_id: 'c-lopf', violation_id: 'v1', type: 'letter_209', subject: 'Violation letter (courtesy_1)', status: 'sent', printed_at: '2026-10-19T20:50:00Z', mailed_at: null, postmark_date: '2026-10-19', delivery_method: 'first_class_mail', ...over });
const ctx = (over = {}) => ({ evidence: new Map(), holds: new Map(), scopes: [], ...over });
const ev = (id, outcome, mailed_on = null, recorded_at = '2026-10-24T15:00:00Z') => ({ interaction_id: id, outcome, mailed_on, recorded_at, recorded_by_name: 'Martha Bravo' });

console.log('mailing_evidence:');
(async () => {
  await at('printed and never confirmed -> printed_unconfirmed (not mailed)', async () => {
    assert.strictEqual(ME.effectiveMailing(letter(), ctx()).state, 'printed_unconfirmed');
  });
  await at('a confirm click inside a presumed-not-mailed window does NOT count as mailed', async () => {
    const l = letter({ community_id: SCR, printed_at: '2026-10-23T20:26:00Z', mailed_at: '2026-10-23T20:29:00Z' });
    const e = ME.effectiveMailing(l, ctx({ scopes }));
    assert.strictEqual(e.state, 'presumed_not_mailed');
    assert.ok(!ME.isMailed(l, ctx({ scopes })));
  });
  await at('the same window does not reach other communities or other dates', async () => {
    assert.strictEqual(ME.effectiveMailing(letter({ printed_at: '2026-10-23T20:26:00Z', mailed_at: '2026-10-23T20:29:00Z' }), ctx({ scopes })).state, 'mailed');
    assert.strictEqual(ME.effectiveMailing(letter({ community_id: SCR, printed_at: '2026-09-22T20:00:00Z', mailed_at: '2026-09-22T22:00:00Z' }), ctx({ scopes })).state, 'mailed');
  });
  await at('staff evidence wins: mailed on the date staff entered, verified', async () => {
    const l = letter({ community_id: SCR, printed_at: '2026-10-23T20:26:00Z', mailed_at: '2026-10-23T20:29:00Z' });
    const e = ME.effectiveMailing(l, ctx({ scopes, evidence: new Map([['L1', ev('L1', 'mailed', '2026-10-26')]]) }));
    assert.deepStrictEqual([e.state, e.mailed_on, e.verified], ['mailed', '2026-10-26', true]);
  });
  await at('newest evidence supersedes older evidence', async () => {
    const m = ME.latestEvidenceByLetter([ev('L1', 'not_mailed', null, '2026-10-24T10:00:00Z'), ev('L1', 'mailed', '2026-10-27', '2026-10-27T10:00:00Z')]);
    assert.strictEqual(m.get('L1').outcome, 'mailed');
  });
  await at('a mail hold beats everything, including a recorded mailed_at', async () => {
    const l = letter({ mailed_at: '2026-10-23T20:29:00Z', delivery_method: 'certified_mail' });
    const holds = ME.activeHoldsByLetter([{ id: 'h1', interaction_id: 'L1', reason: 'Held by Ed', released_at: null }]);
    assert.strictEqual(ME.effectiveMailing(l, ctx({ holds })).state, 'on_hold');
    const released = ME.activeHoldsByLetter([{ id: 'h1', interaction_id: 'L1', reason: 'x', released_at: '2026-10-25T00:00:00Z' }]);
    assert.strictEqual(ME.effectiveMailing(l, ctx({ holds: released })).state, 'mailed');
  });

  await at('confirmation validation: needs a date, never in the future, never before printing', async () => {
    const batch = [letter()];
    assert.ok(!ME.validateBatchConfirmation({ batchLetters: batch, outcomes: { L1: 'mailed' }, mailedOn: '', today: '2026-10-24', ctx: ctx() }).ok);
    assert.ok(!ME.validateBatchConfirmation({ batchLetters: batch, outcomes: { L1: 'mailed' }, mailedOn: '2026-10-25', today: '2026-10-24', ctx: ctx() }).ok);
    assert.ok(!ME.validateBatchConfirmation({ batchLetters: batch, outcomes: { L1: 'mailed' }, mailedOn: '2026-10-18', today: '2026-10-24', ctx: ctx() }).ok);
    assert.ok(ME.validateBatchConfirmation({ batchLetters: batch, outcomes: { L1: 'mailed' }, mailedOn: '2026-10-20', today: '2026-10-24', ctx: ctx() }).ok);
    assert.ok(ME.validateBatchConfirmation({ batchLetters: batch, outcomes: { L1: 'not_mailed' }, mailedOn: '', today: '2026-10-24', ctx: ctx() }).ok, 'no date needed when nothing was mailed');
  });
  await at('confirmation validation: a held letter cannot be confirmed mailed; a letter from another run is refused', async () => {
    const holds = ME.activeHoldsByLetter([{ id: 'h1', interaction_id: 'L1', reason: 'Held by Ed', released_at: null }]);
    const r = ME.validateBatchConfirmation({ batchLetters: [letter()], outcomes: { L1: 'mailed' }, mailedOn: '2026-10-20', today: '2026-10-24', ctx: ctx({ holds }) });
    assert.ok(!r.ok && /on hold/.test(r.errors.join(' ')));
    assert.ok(ME.validateBatchConfirmation({ batchLetters: [letter()], outcomes: { L1: 'held' }, mailedOn: '', today: '2026-10-24', ctx: ctx({ holds }) }).ok);
    assert.ok(!ME.validateBatchConfirmation({ batchLetters: [letter()], outcomes: { L9: 'mailed' }, mailedOn: '2026-10-20', today: '2026-10-24', ctx: ctx() }).ok);
  });

  await at('every state falls in exactly one of the categories staff see (mailed / needs date confirmation / printed not mailed / not yet printed / held)', async () => {
    const want = { mailed: 'mailed', printed_unconfirmed: 'needs_date_confirmation', presumed_not_mailed: 'printed_not_mailed', not_mailed: 'printed_not_mailed', draft: 'not_yet_printed', approved: 'not_yet_printed', queued: 'not_yet_printed', on_hold: 'held', held: 'held', excluded: 'held' };
    for (const [s, c] of Object.entries(want)) assert.strictEqual(ME.mailingCategory(s), c, s);
    assert.strictEqual(ME.CATEGORY_LABEL.held, 'Held, must not be mailed');
    const l = letter({ community_id: SCR, printed_at: '2026-10-23T20:26:00Z', mailed_at: '2026-10-23T20:29:00Z' });
    assert.strictEqual(ME.mailingCategory(ME.effectiveMailing(l, ctx({ scopes })).state), 'printed_not_mailed', 'recent Still Creek run: printed but not mailed');
    assert.strictEqual(ME.mailingCategory(ME.effectiveMailing(letter(), ctx()).state), 'needs_date_confirmation', 'older printed run: already mailed, needs date confirmation');
  });

  const owners = [
    { community_id: null, bucket: 'confirm_mailing', user_id: 'm', name: 'Martha Bravo' },
    { community_id: null, bucket: 'ready_to_mail', user_id: 'm', name: 'Martha Bravo' },
    { community_id: null, bucket: 'missing_notice', user_id: 'm', name: 'Martha Bravo' },
    { community_id: null, bucket: 'held_correction', user_id: 'e', name: 'Ed Gojara' },
  ];
  const vio = (over) => ({ id: 'v1', community_id: 'c-lopf', current_stage: 'courtesy_1', source: 'trustEd_native', street_address: '1 Main', ...over });

  await at('work queue: an unconfirmed print run is ONE "confirm mailing" item owned by Martha', async () => {
    const letters = [letter({ id: 'A', violation_id: 'v1' }), letter({ id: 'B', violation_id: 'v2' })];
    const q = ME.buildWorkQueue({ letters, violations: [vio(), vio({ id: 'v2' })], ctx: ctx(), owners });
    const b = q.items.filter((i) => i.kind === 'batch');
    assert.strictEqual(b.length, 1); assert.strictEqual(b[0].bucket, 'confirm_mailing'); assert.strictEqual(b[0].count, 2);
    assert.strictEqual(b[0].owner.name, 'Martha Bravo');
    assert.strictEqual(q.counts.missing_notice, 0, 'a Courtesy 1 case with its letter printed is not a missing-notice item');
  });
  await at('work queue: after staff confirm the run, it clears; nothing else is left', async () => {
    const letters = [letter({ id: 'A', violation_id: 'v1' })];
    const q = ME.buildWorkQueue({ letters, violations: [vio()], ctx: ctx({ evidence: new Map([['A', ev('A', 'mailed', '2026-10-20')]]) }), owners });
    assert.strictEqual(q.items.length, 0, JSON.stringify(q.items));
  });
  await at('work queue: a run staff marked "not mailed yet" becomes ready to mail', async () => {
    const letters = [letter({ id: 'A', violation_id: 'v1' })];
    const q = ME.buildWorkQueue({ letters, violations: [vio()], ctx: ctx({ evidence: new Map([['A', ev('A', 'not_mailed')]]) }), owners });
    assert.strictEqual(q.items[0].bucket, 'ready_to_mail');
  });
  await at('work queue: drafts and approved letters are ready to mail (subject to approval)', async () => {
    const letters = [letter({ id: 'D', status: 'draft', printed_at: null, sent_at: null }), letter({ id: 'P', violation_id: 'v2', status: 'approved', printed_at: null, sent_at: null })];
    const q = ME.buildWorkQueue({ letters, violations: [vio(), vio({ id: 'v2' })], ctx: ctx(), owners });
    assert.deepStrictEqual(q.items.map((i) => i.bucket), ['ready_to_mail', 'ready_to_mail']);
    assert.match(q.items[0].action, /approve/i);
  });
  await at('work queue: a held certified letter is a correction item owned by Ed', async () => {
    const letters = [letter({ id: 'H', violation_id: 'v1', delivery_method: 'certified_mail', subject: 'Violation letter (certified_209)' })];
    const holds = ME.activeHoldsByLetter([{ id: 'h1', interaction_id: 'H', reason: 'Held by Ed', released_at: null }]);
    const q = ME.buildWorkQueue({ letters, violations: [vio({ current_stage: 'certified_209' })], ctx: ctx({ holds }), owners });
    const h = q.items.find((i) => i.bucket === 'held_correction');
    assert.ok(h && h.owner.name === 'Ed Gojara' && /do not mail/i.test(h.action));
    assert.ok(!q.items.some((i) => i.kind === 'batch'), 'a held letter is not something to confirm');
  });
  await at('work queue: a Courtesy 2 case with no Courtesy 1 on file is a missing-notice item; a Vantaca carry-in is not', async () => {
    const letters = [letter({ id: 'C2', subject: 'Violation letter (courtesy_2)', mailed_at: '2026-10-20T12:00:00Z' })];
    const q = ME.buildWorkQueue({ letters, violations: [vio({ current_stage: 'courtesy_2' })], ctx: ctx(), owners });
    assert.strictEqual(q.counts.missing_notice, 1);
    const q2 = ME.buildWorkQueue({ letters: [], violations: [vio({ current_stage: 'courtesy_2', source: 'vantaca_import' })], ctx: ctx(), owners });
    assert.strictEqual(q2.counts.missing_notice, 0);
  });
  await at('work queue: a case whose earlier notice is only waiting on a run confirmation is NOT double-listed', async () => {
    const letters = [letter({ id: 'C1' }), letter({ id: 'C2', subject: 'Violation letter (courtesy_2)', status: 'draft', printed_at: null })];
    const q = ME.buildWorkQueue({ letters, violations: [vio({ current_stage: 'courtesy_2' })], ctx: ctx(), owners });
    assert.strictEqual(q.counts.missing_notice, 0);
    assert.strictEqual(q.counts.confirm_mailing, 1);
  });

  // ---- the advance workflow honours the evidence
  function fakeDb(seed) {
    const T = { violations: [...seed.violations], interactions: [...seed.interactions] }; let n = 0;
    const q = (table) => {
      const st = { filters: [], op: 'select' };
      const match = (r) => st.filters.every(([k, op, v]) => op === 'eq' ? r[k] === v : op === 'like' ? String(r[k] || '').startsWith(String(v).replace(/%$/, '')) : true);
      const run = () => {
        if (st.op === 'insert') { const rows = st.rows.map((r) => ({ id: 'i' + (++n), ...r })); T[table].push(...rows); return { data: rows, error: null }; }
        if (st.op === 'update') { const hit = T[table].filter(match); hit.forEach((r) => Object.assign(r, st.patch)); return { data: hit.map((r) => ({ id: r.id })), error: null }; }
        return { data: T[table].filter(match).map((r) => ({ ...r })), error: null };
      };
      const api = { select() { return api; }, eq(k, v) { st.filters.push([k, 'eq', v]); return api; }, like(k, v) { st.filters.push([k, 'like', v]); return api; },
        insert(r) { st.op = 'insert'; st.rows = Array.isArray(r) ? r : [r]; return api; }, update(p) { st.op = 'update'; st.patch = p; return api; },
        maybeSingle() { const r = run(); return Promise.resolve({ data: (r.data || [])[0] || null, error: r.error }); },
        single() { const r = run(); return Promise.resolve({ data: (r.data || [])[0] || null, error: r.error }); },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); } };
      return api;
    };
    return { T, from: q };
  }
  const caseRow = { id: 'v1', property_id: 'p1', community_id: SCR, primary_category_id: 'k1', current_stage: 'courtesy_1', current_stage_started_at: '2026-10-23T12:00:00Z', opened_at: '2026-10-23T12:00:00Z', resolved_at: null, quality_status: 'verified', source: 'trustEd_native' };
  const c1 = { id: 'L1', violation_id: 'v1', type: 'letter_209', subject: 'Violation letter (courtesy_1)', status: 'sent', printed_at: '2026-10-23T18:54:00Z', mailed_at: '2026-10-23T20:29:00Z', postmark_date: '2026-10-23', created_at: '2026-10-23T12:00:00Z' };
  const drafter = () => async () => ({ interaction_id: 'D1', letter_path: 'x.pdf' });

  await at('advance: a Courtesy 1 "confirmed" by click inside the presumed-not-mailed window does not allow Courtesy 2', async () => {
    const db = fakeDb({ violations: [{ ...caseRow }], interactions: [{ ...c1 }] });
    const r = await _advanceWithStageLetter({ violationId: 'v1', toStage: 'courtesy_2', source: 'manual_advance' }, { db, draft: drafter(), mailCtx: ctx({ scopes }) });
    assert.strictEqual(r.code, 'prior_notice_not_mailed');
    assert.match(r.message, /presumed not mailed/);
    assert.strictEqual(db.T.violations[0].current_stage, 'courtesy_1');
  });
  await at('advance: once staff confirm the Courtesy 1 mailing date, Courtesy 2 is allowed and the audit cites the confirmed date', async () => {
    const db = fakeDb({ violations: [{ ...caseRow }], interactions: [{ ...c1 }] });
    const r = await _advanceWithStageLetter({ violationId: 'v1', toStage: 'courtesy_2', source: 'manual_advance', actor: { id: 'u', full_name: 'Martha Bravo' } }, { db, draft: drafter(), mailCtx: ctx({ scopes, evidence: new Map([['L1', ev('L1', 'mailed', '2026-10-26')]]) }) });
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(db.T.interactions.some((i) => i.type === 'observation_note' && /Courtesy 1 mailed 2026-10-26/.test(i.content || '')));
  });
  await at('advance: a held earlier notice never counts', async () => {
    const db = fakeDb({ violations: [{ ...caseRow, community_id: 'c-other' }], interactions: [{ ...c1 }] });
    const holds = ME.activeHoldsByLetter([{ id: 'h', interaction_id: 'L1', reason: 'Held', released_at: null }]);
    const r = await _advanceWithStageLetter({ violationId: 'v1', toStage: 'courtesy_2', source: 'manual_advance' }, { db, draft: drafter(), mailCtx: ctx({ holds }) });
    assert.strictEqual(r.code, 'prior_notice_not_mailed');
  });

  const src = read('api/mailing_confirmation.js');
  await at('cure-deadline safeguard: a letter confirmed mailed AFTER its letter date flags the open case; same-day does not; closed cases are not flagged', async () => {
    const ls = [letter({ id: 'A', violation_id: 'v1', postmark_date: '2026-10-19' }), letter({ id: 'B', violation_id: 'v2', postmark_date: '2026-10-19' }), letter({ id: 'C', violation_id: 'v3', postmark_date: '2026-10-19' })];
    const f = ME.cureDeadlineFlags({ letters: ls, mailedOn: '2026-10-22', openViolationIds: ['v1', 'v2'] });
    assert.deepStrictEqual(f.map((x) => x.violation_id), ['v1', 'v2']);
    assert.match(f[0].reason, /dated 2026-10-19 was confirmed mailed on 2026-10-22/);
    assert.strictEqual(ME.cureDeadlineFlags({ letters: ls, mailedOn: '2026-10-19', openViolationIds: ['v1', 'v2'] }).length, 0);
    assert.strictEqual(ME.cureDeadlineFlags({ letters: [letter({ id: 'D', violation_id: 'v1', postmark_date: null, printed_at: '2026-10-23T20:26:00Z' })], mailedOn: '2026-10-26', openViolationIds: ['v1'] })[0].basis_date, '2026-10-23', 'falls back to the print day');
  });
  await at('a case under cure-deadline review is a correction item for Ed, and its print run no longer needs confirmation', async () => {
    const q = ME.buildWorkQueue({ letters: [letter({ id: 'A', violation_id: 'v1' })], violations: [vio()], ctx: ctx({ evidence: new Map([['A', ev('A', 'mailed', '2026-10-22')]]), reviewHolds: [{ id: 'r1', violation_id: 'v1', community_id: 'c-lopf', reason: 'late', resolved_at: null }] }), owners });
    const h = q.items.find((i) => i.kind === 'review_hold');
    assert.ok(h && h.bucket === 'held_correction' && h.owner.name === 'Ed Gojara' && /Escalation is on hold/.test(h.action));
    assert.ok(!q.items.some((i) => i.kind === 'batch'));
  });
  await at('printed letters confirmed NOT mailed tell staff to review the dates before mailing (nothing is resent automatically)', async () => {
    const q = ME.buildWorkQueue({ letters: [letter({ id: 'A', violation_id: 'v1' })], violations: [vio()], ctx: ctx({ evidence: new Map([['A', ev('A', 'not_mailed')]]) }), owners });
    assert.match(q.items[0].action, /check whether the letter date and cure deadline still give the owner the full cure period/);
    assert.match(q.items[0].action, /Nothing is resent or regenerated automatically/);
  });
  await at('advance: an open cure-deadline review holds escalation even when the earlier letter is confirmed mailed', async () => {
    const db = fakeDb({ violations: [{ ...caseRow }], interactions: [{ ...c1 }] });
    const r = await _advanceWithStageLetter({ violationId: 'v1', toStage: 'courtesy_2', source: 'cure_lapse' }, { db, draft: drafter(), mailCtx: ctx({ scopes, evidence: new Map([['L1', ev('L1', 'mailed', '2026-10-26')]]) }), reviewHolds: [{ violation_id: 'v1', resolved_at: null }] });
    assert.strictEqual(r.code, 'cure_deadline_review_pending');
    assert.strictEqual(db.T.violations[0].current_stage, 'courtesy_1');
  });
  await at('resolving a cure-deadline review: admin only, needs a reason, a correction changes only the deadline and leaves a timeline note', async () => {
    const r = src.slice(src.indexOf("router.post('/review-holds/:id/resolve'"), src.indexOf("router.get('/queue'"));
    assert.ok(r.includes('requireAdmin(req, res)') && r.includes('reason_required') && r.includes('new_deadline_required'));
    assert.ok(r.includes("from('violations').update({ cure_period_ends_at: newIso })"), 'only the deadline column changes');
    assert.ok(/Cure deadline review resolved/.test(r));
    const m = read('migrations/544_letter_mailing_evidence.sql');
    assert.ok(/BEFORE UPDATE OR DELETE ON enforcement_review_holds/.test(m) && /cure_period_ends_at_flagged/.test(m), 'the deadline as flagged is kept; only the resolution can be recorded');
  });

  await at('a click-time stamp from the old Mail Queue button after 544 still needs its real date; earlier stamps and evidence-backed ones do not', async () => {
    const stamp = '2026-10-26T18:57:27.123+00:00';
    const clicked = letter({ printed_at: '2026-09-28T21:24:37Z', mailed_at: stamp, sent_at: stamp });
    const e = ME.effectiveMailing(clicked, ctx());
    assert.strictEqual(e.state, 'printed_unconfirmed');
    assert.strictEqual(ME.mailingCategory(e.state), 'needs_date_confirmation');
    const before = letter({ printed_at: '2026-09-22T20:00:00Z', mailed_at: '2026-09-22T22:09:52Z', sent_at: '2026-09-22T22:09:52Z' });
    assert.strictEqual(ME.effectiveMailing(before, ctx()).state, 'mailed', 'pre-544 confirmations are not reopened');
    const recorded = letter({ printed_at: '2026-10-26T12:00:00+00:00', mailed_at: '2026-10-26T12:00:00+00:00', sent_at: '2026-10-26T12:00:00+00:00' });
    assert.strictEqual(ME.effectiveMailing(recorded, ctx()).state, 'mailed', 'an admin record-mailing (printed = mailed) is not a click stamp');
    const confirmed = ME.effectiveMailing(clicked, ctx({ evidence: new Map([['L1', ev('L1', 'mailed', '2026-09-29')]]) }));
    assert.deepStrictEqual([confirmed.state, confirmed.mailed_on], ['mailed', '2026-09-29']);
  });
  await at('one recording path: the Mail Queue button needs the login and the real date and records through record_mailing; the click time is never the mailing date', async () => {
    const enf = read('api/enforcement.js');
    const cm = enf.slice(enf.indexOf("router.post('/mail-queue/confirm-mailed'"), enf.indexOf("router.post('/mail-queue/cancel'"));
    assert.ok(cm.includes('requireStaff(req, res)') && cm.includes('mailed_on_required') && cm.includes('mailed_before_print') && cm.includes('recordRunConfirmation('));
    assert.ok(!/mailed_at: now/.test(cm), 'never stamps the click time as mailed_at');
    assert.ok(src.includes('recordRunConfirmation('), 'the screen uses the same recorder');
    const lib = read('lib/enforcement/record_mailing.js');
    assert.ok(!/from\('violations'\)[^;]*\.update\(/.test(lib), 'recording never updates a case');
    for (const forbidden of ['letter_mail_pieces', 'ar_charges', 'sweepCertifiedViolationFees', 'createCharge', 'current_stage', 'cure_period_ends_at:']) assert.ok(!lib.includes(forbidden), `record_mailing must not touch ${forbidden}`);
    assert.ok(lib.includes(".is('mailed_at', null)"), 'mailed_at is only filled where empty');
    const page = read('public/index.html');
    assert.ok(page.includes('function inspMailQueueAskMailedOn(') && (page.match(/mailed_on: mailedOn/g) || []).length >= 2, 'both Mail Queue buttons send the real date');
  });

  // ---- static guarantees on the confirmation route and the migration
  const confirmBody = src.slice(src.indexOf("router.post('/batches/confirm'"), src.indexOf("router.post('/holds/"));
  await at('confirming a run never touches deadlines, stages, letters, mail pieces or charges', async () => {
    assert.ok(!/from\('violations'\)[^;]*\.update\(/.test(confirmBody), 'confirm never updates a case');
    assert.ok(!/update\(\{[^}]*cure_period_ends_at/.test(confirmBody), 'confirm never changes a cure deadline');
    for (const forbidden of ['current_stage', 'postmark_date:', 'letter_mail_pieces', 'ar_charges', 'sweepCertifiedViolationFees', 'createCharge', '_assembleBundlePdf', '_sealSentLetter']) {
      assert.ok(!confirmBody.includes(forbidden), `confirm route must not use ${forbidden}`);
    }
    assert.ok(confirmBody.includes('recordRunConfirmation(') && read('lib/enforcement/record_mailing.js').includes(".is('mailed_at', null)"), 'mailed_at is only filled where empty (shared recorder)');
  });
  await at('every route uses the employee login; no name is taken from the request', async () => {
    const routes = src.split(/router\.(?:get|post)\(/).slice(1);
    assert.strictEqual(routes.length, 5);
    routes.forEach((r) => assert.ok(/require(Staff|Admin)\(req, res\)/.test(r.slice(0, 400)), 'route checks the login first'));
    assert.ok(!/user_name/.test(src));
    assert.ok(/holds\/:id\/release[\s\S]{0,200}requireAdmin/.test(src), 'only an admin releases a hold');
  });
  await at('the Mail Queue confirm button skips letters under a hold', async () => {
    const enf = read('api/enforcement.js');
    const cm = enf.slice(enf.indexOf("router.post('/mail-queue/confirm-mailed'"), enf.indexOf("router.post('/mail-queue/cancel'"));
    assert.ok(/holdCtx\.holds\.has\(l\.id\)/.test(cm) && /const mailable = _cleared\.filter\(\(l\) => !holdCtx\.holds\.has/.test(cm));
  });
  await at('migration 544: evidence is append-only, holds only release once, grants are explicit, seeds are idempotent', async () => {
    const m = read('migrations/544_letter_mailing_evidence.sql');
    assert.ok(/BEFORE UPDATE OR DELETE ON letter_mailing_evidence/.test(m) && /BEFORE UPDATE OR DELETE ON mailing_batch_confirmations/.test(m));
    assert.ok(/BEFORE UPDATE OR DELETE ON letter_mail_holds/.test(m));
    assert.ok(/GRANT SELECT, INSERT ON letter_mailing_evidence TO service_role/.test(m) && !/GRANT[^;]*UPDATE[^;]*ON letter_mailing_evidence/.test(m));
    assert.ok(/NOT EXISTS \(SELECT 1 FROM letter_mail_holds/.test(m) && /ON CONFLICT \(community_id, printed_from, printed_through\) DO NOTHING/.test(m));
    assert.ok(/^BEGIN;/m.test(m) && /^COMMIT;/m.test(m));
    const chk = JSON.parse(read('migrations/checks/544_letter_mailing_evidence.json'));
    assert.strictEqual(chk.migration, '544_letter_mailing_evidence.sql');
  });
  await at('the confirmation page loads its data with the employee token and is linked from the Mail Queue', async () => {
    const page = read('public/mailing.html');
    assert.ok(/Authorization: 'Bearer ' \+ token/.test(page));
    assert.ok(/\/api\/mailing\/batches\/confirm/.test(page));
    assert.ok(read('public/index.html').includes('href="/admin/mailing"'));
    assert.ok(read('server.js').includes("app.use('/api/mailing', mailingConfirmationRouter)"));
  });

  console.log(`mailing_evidence: ${passed} passed`);
})().catch((e) => { console.error('  ✗', e.message); process.exit(1); });
