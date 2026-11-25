// ============================================================================
// tests/test_builder_arc_review.js  (Ed 2026-11-25)
// ----------------------------------------------------------------------------
// Annie's builder lot review, materials mapping, letters, deadlines and the
// decision-authority gate, on the real Still Creek Ranch cases that exposed the
// gaps (2026-11-25 investigation). Pure: no database, no model calls.
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('../lib/builder_arc/materials');
const P = require('../lib/builder_arc/packet');
const R = require('../lib/builder_arc/rules');
const DL = require('../lib/builder_arc/deadlines');
const T = require('../lib/builder_arc/tracking');
const { renderBuilderLetterHTML } = require('../lib/builder_letter');
const { validateApplicationForLetter } = require('../lib/builder_letter_validate');

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log('  ok -', name); };

// Still Creek Ranch standards as configured (Guidelines May 13, 2019 + Declaration Art. X).
const STD = {
  max_lot_coverage_pct: 80, lot_coverage_ref: 'Guidelines II.B',
  repetition: {
    same_plan_same_elevation_min_lots_between: 3, same_plan_same_elevation_requires_different_brick_and_trim: true,
    same_plan_different_elevation_min_lots_between: 2, brick_repeat_min_lots_between: 4,
    adjacent_identical_brick_prohibited: true, adjacent_trim_or_field_color_must_vary: true, ref: 'Guidelines III.B.2, III.J',
  },
  required_submittal: [{ key: 'lot_coverage', label: 'Lot coverage calculation', ref: 'Guidelines I.B.1(b)' }, { key: 'fence', label: 'Fence location, height and material', ref: 'Guidelines I.B.1(b)' }],
  required_materials: ['brick', 'paint_or_siding'],
  legal_review_days: 30, legal_review_ref: 'Declaration Art. X.B',
};

const portal = (o) => ({ trim: o.trim, brick: o.brick, paint: o.paint, stone: o.stone, siding: o.siding, shingles: o.shingles, ai_extraction_pending: true });
const app = (ref, addr, lot, plan, elev, mat, extra = {}) => ({
  id: ref, reference_number: ref, community_id: 'c6', builder_company_id: 'b1', street_address: addr, lot_number: String(lot), block_number: '1', section_number: '5',
  plan_number: plan, plan_name: 'X', elevation: elev, elevation_orientation: null, application_data: portal(mat), status: 'received',
  submitted_at: '2026-10-06T19:36:02Z', decided_at: null, master_plan_id: 'mp', fast_track: true, submitter_name: 'Richelle Hearitige', ...extra,
});
const packetFor = (a, over = {}) => ({ facts: { lot: a.lot_number, block: a.block_number, section: '5', plan_number: a.plan_number, elevation: a.elevation, orientation: null, street_address: a.street_address, impervious_coverage_pct: 52.1, fence: 'FENCE PER SPECS', document_conflicts: [], read_conflicts: [], ...over }, text_layer: { lot: a.lot_number }, model_extracted: {}, errors: [] });
const UB = 'Urbane Bronze';

console.log('test_builder_arc_review');

// ---------------------------------------------------------------- materials
t('portal flat materials map to the letter vocabulary', () => {
  const m = M.normalizeMaterials(portal({ brick: 'Claymex - Oxford', paint: UB, trim: UB, shingles: 'Weathered Wood' }));
  assert.strictEqual(m.brick_color, 'Claymex - Oxford');
  assert.strictEqual(m.paint_color, UB);
  assert.strictEqual(m.trim_color, UB);
  assert.strictEqual(m.shingle_color, 'Weathered Wood');
  assert.ok(M.hasMaterials(portal({ brick: 'x' })));
  assert.ok(!M.hasMaterials({ ai_extraction_pending: true }));
});
t('nested extraction rows and renderer keys still map; renderer keys win', () => {
  const m = M.normalizeMaterials({ brick_color: 'Explicit', materials: { brick: { type: 'Acme', color: 'Old Francisco' }, rock: { color: 'Cream Chopped' }, trim_paint: { color: 'Thunder Gray' } } });
  assert.strictEqual(m.brick_color, 'Explicit');
  assert.strictEqual(m.brick_manufacturer, 'Acme');
  assert.strictEqual(m.stone_color, 'Cream Chopped');
  assert.strictEqual(m.trim_color, 'Thunder Gray');
  assert.strictEqual(M.colorKey('Claymex - Oxford'), M.colorKey('Claymex Oxford'));
});
t('approval letter prints the Approved Specifications table for a portal submission', () => {
  const html = renderBuilderLetterHTML({ community: 'Still Creek Ranch', builder_company_name: 'Lennar', property_address: '8003 Misty Maple Lane', lot_number: '34', plan_number: '4700', plan_name: 'Frey', elevation: 'D4', materials: portal({ brick: 'General Shale - Sheltered Bluff', paint: 'Worldly Gray', trim: 'Worldly Gray', stone: 'Blanco Chopped', shingles: 'Weathered Wood' }), reference_number: 'SCR-BLD-2026-0073', decision_type: 'approved', signer_name: 'Ed Gojara', date_str: 'November 25, 2026' });
  assert.ok(/Approved Specifications/.test(html), 'spec table missing');
  for (const v of ['Sheltered Bluff', 'Worldly Gray', 'Blanco Chopped', 'Weathered Wood']) assert.ok(html.includes(v), v);
});
t('validator no longer warns "no materials" for a portal submission', () => {
  const a = app('A', '8003 Misty Maple Lane', 34, '4700', 'D4', { brick: 'x', paint: 'y' });
  const v = validateApplicationForLetter(a, { plan_number: '4700', elevation: 'D4', status: 'approved' }, true);
  assert.ok(v.ok);
  assert.ok(!v.warnings.some((w) => /No materials/.test(w)), JSON.stringify(v.warnings));
});
t('revised submission letter names the approval it replaces', () => {
  const html = renderBuilderLetterHTML({ community: 'Still Creek Ranch', builder_company_name: 'Lennar', property_address: '8223 Misty Maple Lane', lot_number: '4', plan_number: '4777', plan_name: 'Dylan', elevation: 'C4', materials: {}, reference_number: 'SCR-BLD-2026-0081', decision_type: 'approved', signer_name: 'Ed Gojara', date_str: 'November 25, 2026', replaces: { reference_number: 'SCR-BLD-2026-0051', date_str: 'August 28, 2026', plan_label: 'Plan 4720, Elevation C4' } });
  assert.ok(/replaces the approval issued August 28, 2026 under reference SCR-BLD-2026-0051/.test(html));
});

// ------------------------------------------------------------------- packet
t('text layer reads the lot, title block and drawing label (8118 Misty Maple)', () => {
  const txt = `DATE: 8118 MISTY MAPLE LANE LOT 23, BLOCK 1, STILL CREEK RANCH, SECTION 5, PLAT NO. 20250077 PLAN: 4505_C-R LOT AREA: 6624.0 SQ.FT. 613 NORTHWEST LOOP 410 FENCE PER SPECS PROP. SLAB = 2.7' ABOVE TOC NO OPTIONS:ELEV. "F" RIGHTPLAN No. 4504CONC. = 3349`;
  const f = P.parseTextLayer(txt);
  assert.strictEqual(f.street_address, '8118 MISTY MAPLE LANE');
  assert.strictEqual(f.lot, '23'); assert.strictEqual(f.block, '1'); assert.strictEqual(f.section, '5');
  assert.strictEqual(f.title_block_plan_number, '4505'); assert.strictEqual(f.title_block_elevation, 'C');
  assert.strictEqual(f.drawing_plan_number, '4504'); assert.strictEqual(f.drawing_elevation, 'F'); assert.strictEqual(f.drawing_orientation, 'R');
  const merged = P.mergeReads(f, null);
  assert.strictEqual(merged.plan_number, '4504', 'drawing label beats a stale title block');
  assert.ok(merged.document_conflicts.some((c) => /4505 C/.test(c) && /4504 F/.test(c)));
});
t('two reads that disagree produce no value and a conflict', () => {
  const m = P.mergeReads({ lot: '35' }, { lot: '36' });
  assert.strictEqual(m.lot, null);
  assert.deepStrictEqual(m.read_conflicts[0].field, 'lot');
});
t('plan tokens parse (450N_E-L, 4700_D4-R)', () => {
  assert.deepStrictEqual(P.parsePlanToken('450N_E-L'), { plan_number: '450N', elevation: 'E', orientation: 'L' });
  assert.deepStrictEqual(P.parsePlanToken('4700_D4-R'), { plan_number: '4700', elevation: 'D4', orientation: 'R' });
});
// -------------------------------------------------------------------- rules
const nb8007 = app('SCR-BLD-2026-0069', '8007 Misty Maple Lane', 35, '4506', 'D', { brick: 'Claymex - Oxford', paint: UB, trim: UB, shingles: 'W' });
const nb8011 = app('SCR-BLD-2026-0070', '8011 Misty Maple Lane', 36, '4504', 'E', { brick: 'Claymex - Sandstone', paint: UB, trim: UB, shingles: 'Weathered Wood' });
const nb8107 = app('SCR-BLD-2026-0076', '8107 Misty Maple Lane', 41, '4504', 'E', { brick: 'Claymex - Sandstone', paint: UB, trim: UB, stone: 'Opal', shingles: 'Weathered Wood' });
const s8103 = app('SCR-BLD-2026-0075', '8103 Misty Maple Lane', 40, '4506', 'D', { brick: 'Claymex - Oxford', siding: UB, trim: UB, shingles: 'Weathered Wood' });
const ok8115 = app('SCR-BLD-2026-0078', '8115 Misty Maple Lane', 43, '4503', 'F', { brick: 'Triangle - Smokey River', paint: 'Worldly Gray', trim: 'Worldly Gray', stone: 'Aspen Blend', shingles: 'Weathered Wood' });
const letterOk = { ok: true, errors: [], warnings: [] };

t('8103: repeats 8007 plan/elevation with the same brick and trim; adjacent to 8107 with same trim + field color', () => {
  const r = R.evaluate({ app: s8103, packet: packetFor(s8103), standards: STD, neighbors: [nb8007, nb8011, nb8107, ok8115], letterCheck: letterOk });
  const codes = r.findings.map((f) => f.code);
  assert.ok(codes.includes('repeat_same_elevation_colors'), codes.join(','));
  assert.ok(codes.includes('adjacent_colors'), codes.join(','));
  assert.strictEqual(r.recommended_action, 'manual_review');
  assert.ok(r.findings.find((f) => f.code === 'repeat_same_elevation_colors').detail.includes('8007 Misty Maple Lane'));
});
t('8007: shingle "W" is not a required selection: noted, never requested', () => {
  const r = R.evaluate({ app: nb8007, packet: packetFor(nb8007), standards: STD, neighbors: [], letterCheck: letterOk });
  assert.ok(!r.findings.some((f) => f.code === 'materials_unclear'));
  assert.ok(r.findings.some((f) => f.code === 'materials_optional' && /shingle color reads "W"/.test(f.detail)));
  assert.strictEqual(r.recommended_action, 'approve');
});
t('an unreadable REQUIRED selection is requested from the builder, in plain text', () => {
  const a = app('Q', '8007 Misty Maple Lane', 35, '4506', 'D', { brick: 'W', paint: UB });
  const r = R.evaluate({ app: a, packet: packetFor(a), standards: STD, neighbors: [], letterCheck: letterOk });
  assert.ok(r.findings.some((f) => f.code === 'materials_unclear'));
  assert.strictEqual(r.recommended_action, 'request_more_info');
  const draft = R.draftInfoRequest(a, r);
  assert.ok(/8007 Misty Maple Lane/.test(draft) && /brick/.test(draft));
  assert.ok(!/\u2014/.test(draft), 'no em-dashes in builder-facing text');
});
t('model-only "contradictions" are unverified notes, never requests', () => {
  const r = R.evaluate({ app: ok8115, packet: packetFor(ok8115, { model_flags: ['Lot area 6945.5 vs 6946 sq ft'] }), standards: STD, neighbors: [], letterCheck: letterOk });
  const f = r.findings.find((x) => x.code === 'packet_observations');
  assert.ok(f && f.severity === 'note');
  assert.strictEqual(r.recommended_action, 'approve');
});
t('a scanned packet fills section "Five" as 5 and takes selections from its form', () => {
  const a = app('SCR-BLD-2026-0021', '8207 Rustic Pine Trail', 'UNKNOWN', '4730', 'C4', {}, { block_number: null, section_number: null });
  a.application_data = { ai_notes: 'page 1 only' };
  const r = R.evaluate({ app: a, packet: packetFor(a, { lot: '9', block: '2', section: 'Five', plan_number: '4730', elevation: 'C4', form: { brick: 'Smokey River', paint: 'Pure White', shingles: 'Weathered Wood' } }), standards: STD, neighbors: [], letterCheck: letterOk });
  assert.strictEqual(r.corrections.section_number, '5');
  assert.strictEqual(r.corrections.application_data.brick, 'Smokey River');
  assert.ok(r.findings.some((f) => f.code === 'fill_materials'));
  assert.strictEqual(r.recommended_action, 'approve');
});
t('8015: no materials at all -> request more info', () => {
  const a = app('SCR-BLD-2026-0071', '8015 Misty Maple Lane', 37, '4501', 'E', {});
  const r = R.evaluate({ app: a, packet: packetFor(a), standards: STD, neighbors: [], letterCheck: letterOk });
  assert.ok(r.findings.some((f) => f.code === 'materials_missing' && /brick/.test(f.detail)));
  assert.strictEqual(r.recommended_action, 'request_more_info');
});
t('8115: clean submission -> approve', () => {
  const r = R.evaluate({ app: ok8115, packet: packetFor(ok8115), standards: STD, neighbors: [nb8107], letterCheck: letterOk });
  assert.strictEqual(r.recommended_action, 'approve', JSON.stringify(r.findings.filter((f) => f.severity !== 'ok' && f.severity !== 'note')));
  assert.ok(r.findings.some((f) => f.code === 'lot_coverage_ok'));
});
t('Rustic Pine: UNKNOWN lot / plan / elevation are filled from the packet; real values are never overwritten', () => {
  const a = app('SCR-BLD-2026-0020', '8203 Rustic Pine Trail', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', { brick: 'Steel Manor', paint: 'Light French Gray', trim: 'Light French Gray', shingles: 'Weathered Wood' }, { block_number: null, section_number: null });
  const r = R.evaluate({ app: a, packet: packetFor(a, { lot: '8', block: '2', section: '5', plan_number: '4700', elevation: 'C4' }), standards: STD, neighbors: [], letterCheck: null });
  assert.deepStrictEqual(r.corrections, { lot_number: '8', block_number: '2', section_number: '5', plan_number: '4700', elevation: 'C4' });
  const b = app('X', '8207 Rustic Pine Trail', 9, '4730', 'C4', {});
  const r2 = R.evaluate({ app: b, packet: packetFor(b, { lot: '10' }), standards: STD, neighbors: [], letterCheck: null });
  assert.deepStrictEqual(r2.corrections, {});
  assert.ok(r2.findings.some((f) => f.code === 'mismatch_lot_number' && f.severity === 'needs_info'));
});
t('a packet that contradicts itself (8118) asks for a corrected plot plan', () => {
  const a = app('SCR-BLD-2026-0080', '8118 Misty Maple Lane', 23, '4504', 'F', { brick: 'Claymex - Alpine', paint: 'Foothills', trim: 'Loggia', shingles: 'Weathered Wood' });
  const r = R.evaluate({ app: a, packet: packetFor(a, { document_conflicts: ['Title block says plan 4505 C; the drawing says plan 4504 F.'] }), standards: STD, neighbors: [], letterCheck: letterOk });
  assert.strictEqual(r.recommended_action, 'request_more_info');
  assert.ok(r.asks.some((x) => /corrected plot plan/.test(x)));
});
t('a blank plan name (450N E) blocks the letter and is Bedrock\'s fix', () => {
  const a = app('SCR-BLD-2026-0074', '8023 Misty Maple Lane', 39, '450N', 'E', { brick: 'Claymex - Keystone', paint: 'Repose Gray', trim: 'Black Fox', shingles: 'Weathered Wood' }, { plan_name: null });
  const lc = validateApplicationForLetter(a, { plan_number: '450N', elevation: 'E', status: 'approved' }, true);
  const r = R.evaluate({ app: a, packet: packetFor(a), standards: STD, neighbors: [], letterCheck: lc });
  const f = r.findings.find((x) => x.code === 'plan_name_missing');
  assert.ok(f && f.severity === 'blocker' && f.fix_by === 'bedrock');
  assert.strictEqual(r.recommended_action, 'manual_review');
});
t('a revised submission notes the earlier decision and keeps it', () => {
  const a = app('SCR-BLD-2026-0081', '8223 Misty Maple Lane', 4, '4777', 'C4', { brick: 'CBC Cimmaron', paint: 'Amazing Gray', trim: 'Amazing Gray', shingles: 'Weathered Wood' }, { block_number: '4', submitted_at: '2026-11-03T16:58:34Z' });
  const prior = { id: 'p', reference_number: 'SCR-BLD-2026-0051', status: 'approved', decided_at: '2026-08-28T20:51:00Z', plan_number: '4720', elevation: 'C4', street_address: '8223 Misty Maple Lane' };
  const r = R.evaluate({ app: a, packet: packetFor(a), standards: STD, neighbors: [], priorAtAddress: [prior], letterCheck: letterOk });
  const f = r.findings.find((x) => x.code === 'revision');
  assert.ok(f && /SCR-BLD-2026-0051/.test(f.title) && /4720 C4 to 4777 C4/.test(f.detail) && /stay on file/.test(f.detail));
  assert.strictEqual(r.revision_of.reference_number, 'SCR-BLD-2026-0051');
});
t('the older submission at a revised address is not the streetscape neighbor (the newer one is)', () => {
  const old = app('OLD', '8019 Misty Maple Lane', 38, '4506', 'D', { brick: 'Claymex - Oxford', paint: UB, trim: UB }, { status: 'approved', submitted_at: '2026-08-01T00:00:00Z', decided_at: '2026-08-02T00:00:00Z' });
  const neu = app('NEW', '8019 Misty Maple Lane', 38, '4503', 'E', { brick: 'CBC - Coffeyville', paint: 'Drift of Mist', trim: 'Drift of Mist' }, { submitted_at: '2026-09-23T00:00:00Z' });
  const sc = R.streetscape(s8103, [old, neu]);
  assert.strictEqual(sc.homes.length, 1);
  assert.strictEqual(sc.homes[0].plan, '4503');
});
t('no community standards -> Annie does not pretend to review compliance', () => {
  const r = R.evaluate({ app: ok8115, packet: packetFor(ok8115), standards: null, neighbors: [], letterCheck: letterOk });
  assert.strictEqual(r.recommended_action, 'manual_review');
  assert.ok(r.findings.some((f) => f.code === 'no_standards'));
});
t('lot coverage over the limit is a guideline question for Ed, never an automatic denial', () => {
  const r = R.evaluate({ app: ok8115, packet: packetFor(ok8115, { impervious_coverage_pct: 81.2 }), standards: STD, neighbors: [], letterCheck: letterOk });
  assert.ok(r.findings.some((f) => f.code === 'lot_coverage_exceeded' && f.severity === 'guideline'));
  assert.notStrictEqual(r.recommended_action, 'deny');
});
t('precedent: approved pairs with the same pattern are cited, not used to skip the rule', () => {
  const a1 = app('P1', '8010 Misty Maple Lane', 31, '4503', 'D', { brick: 'Claymex Aspen', paint: 'Pavestone', trim: 'Pavestone' }, { status: 'approved', decided_at: '2026-08-31T00:00:00Z' });
  const a2 = app('P2', '8106 Misty Maple Lane', 26, '4503', 'D', { brick: 'Claymex Aspen', paint: 'Pavestone', trim: 'Pavestone' }, { status: 'approved', decided_at: '2026-08-31T00:00:00Z' });
  const r = R.evaluate({ app: s8103, packet: packetFor(s8103), standards: STD, neighbors: [nb8007, nb8107], approvedPool: [a1, a2], letterCheck: letterOk });
  const f = r.findings.find((x) => x.code === 'repeat_same_elevation_colors');
  assert.ok(f && /8010 Misty Maple Lane \/ 8106 Misty Maple Lane/.test(f.detail), f && f.detail);
  assert.strictEqual(f.severity, 'guideline');
});

t('a plot-plan note is never taken as a brick color (8015)', () => {
  const a = app('SCR-BLD-2026-0071', '8015 Misty Maple Lane', 37, '4501', 'E', {});
  a.application_data = { source_pdf_filename: 'x.pdf' };
  const r = R.evaluate({ app: a, packet: packetFor(a, { form: { brick: 'FULL BRICK STD.' } }), standards: STD, neighbors: [], letterCheck: letterOk });
  assert.ok(!r.corrections.application_data, JSON.stringify(r.corrections));
  assert.strictEqual(r.recommended_action, 'request_more_info');
});
t('the saved application keeps materials taken from the packet form', () => {
  const { applicationPatch } = require('../lib/builder_arc/review');
  const p = applicationPatch({ application_data: { ai_notes: 'x' } }, { lot_number: '9', application_data: { ai_notes: 'x', brick: 'Smokey River' } }, { recommended_action: 'approve' }, null);
  assert.strictEqual(p.application_data.brick, 'Smokey River');
  assert.strictEqual(p.application_data.ai_extraction_pending, false);
  assert.strictEqual(p.lot_number, '9');
  const q = applicationPatch({ application_data: { brick: 'A' } }, {}, { recommended_action: 'approve' }, null);
  assert.strictEqual(q.application_data.brick, 'A');
});

// ---------------------------------------------------------------- deadlines
t('deadlines: 9/23 submission, 30-day period, passed on 11/25', () => {
  const d = DL.computeDeadlines({ submitted_at: '2026-09-23T20:43:53Z', fast_track: true }, { builder_arc_fast_track_business_days: 2 }, { legal_review_days: 30 }, new Date('2026-11-25T18:00:00Z'));
  assert.strictEqual(d.limit_at.slice(0, 10), '2026-10-23');
  assert.strictEqual(d.target_due_at.slice(0, 10), '2026-09-25');
  assert.strictEqual(d.state, 'limit_passed');
  const d2 = DL.computeDeadlines({ submitted_at: '2026-11-03T16:58:34Z', fast_track: true }, {}, { legal_review_days: 30 }, new Date('2026-11-27T18:00:00Z'));
  assert.strictEqual(d2.limit_at.slice(0, 10), '2026-12-03');
  assert.strictEqual(d2.state, 'limit_near');
  const d3 = DL.computeDeadlines({ submitted_at: '2026-11-24T16:00:00Z', fast_track: false }, { builder_arc_sla_business_days: 5 }, {}, new Date('2026-11-25T18:00:00Z'));
  assert.strictEqual(d3.limit_at, null, 'no review period without a stated standard');
  assert.strictEqual(d3.state, 'on_track');
});
t('ownership: Ed decides, Annie chases info, Amanda gets escalations', () => {
  assert.strictEqual(T.ownerFor('approve', { state: 'on_track' }), 'Ed');
  assert.strictEqual(T.ownerFor('manual_review', { state: 'on_track' }), 'Ed');
  assert.strictEqual(T.ownerFor('request_more_info', { state: 'on_track' }), 'Annie');
  assert.strictEqual(T.ownerFor('approve', { state: 'target_missed' }), 'Amanda');
  assert.strictEqual(T.urgencyFor({ state: 'limit_near' }), 'critical');
});

// ------------------------------------------------- decision authority (static)
t('approve / deny routes require the signed-in owner; the signer is never typed in', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'builder_applications.js'), 'utf8');
  const fin = src.slice(src.indexOf("router.post('/:id/finalize'"), src.indexOf("router.post('/:id/finalize'") + 700);
  assert.ok(/builderActor\(req, res, action\)/.test(fin) && /decided_by = actor\.decided_by/.test(fin), 'finalize must gate on the owner');
  assert.ok(!/req\.body[^;]*decided_by/.test(fin), 'finalize must not take decided_by from the request');
  const batch = src.slice(src.indexOf("router.post('/batch-approve-send'"), src.indexOf("router.post('/batch-approve-send'") + 1500);
  assert.ok(/builderActor\(req, res, dryRun \? 'request_more_info' : 'approve'\)/.test(batch), 'batch approval must gate on the owner');
  assert.ok(/assessment_recommended_action !== 'approve'/.test(src), 'batch approval must skip lots Annie did not find ready');
  assert.ok(/isOwnerActor\(a\)/.test(src.slice(src.indexOf('async function builderActor'), src.indexOf('async function builderActor') + 900)));
});
t('the review never writes a decision', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'builder_arc', 'review.js'), 'utf8');
  assert.ok(!/builder_application_responses/.test(src), 'Annie must not record responses');
  assert.ok(!/status:\s*'approved/.test(src), 'Annie must not set an approved status');
});

console.log(`test_builder_arc_review: ${n} passed`);
