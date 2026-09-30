#!/usr/bin/env node
// ============================================================================
// tests/test_character_approval.js  (Issue #10 Phase 0A: honest canon approval)
// ----------------------------------------------------------------------------
// "Approved" must mean canonical, and owner decisions act only on the
// character in the route.
//   1) openQuestions(): declared open_questions, a not-canonical voice status,
//      and unresolved prose in immutable older specs are all caught; the real
//      seed packages are classified as a person reading them would.
//   2) reviewRelease(): per component status / open questions / what becomes
//      canonical; the whole package is blocked by any open question; the
//      VISUAL set (face, body, wardrobe, guardrails) can be approvable while
//      voice stays under evaluation.
//   3) packageBlockers(): approve-package also approves legacy releases'
//      proposed versions, so those are checked too.
//   4) api/characters.js (registry + owner gate stubbed): cross-character
//      version / release ids are refused BEFORE any registry write;
//      approving an unresolved version or package is refused (409) with the
//      reasons; a resolved version is approved; nothing else is called.
// Offline; no registry writes.
// ============================================================================
const assert = require('assert');
const Module = require('module');
const path = require('path');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://x';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const A = require('../lib/characters/approval');
const { validateSpec } = require('../lib/characters/spec');

let pass = 0;
const results = [];
const t = (name, fn) => results.push([name, fn]);
const SEED = (f) => require(path.join(__dirname, '..', 'scripts', 'character_seed', f + '.json'));
const kinds = (qs) => qs.map((q) => q.kind + ':' + q.field);

// ---- 1) open questions --------------------------------------------------------
t('seed specs: unresolved prose, not-canonical voice and clean components are told apart', () => {
  const s = SEED('amanda_albright').components;
  assert.deepStrictEqual(kinds(A.openQuestions('face', s[0].spec)), []);                                 // face v1
  assert.deepStrictEqual(kinds(A.openQuestions('face', s[1].spec)), ['text:canonical_image_notes']);    // face v2: descriptors await confirmation
  assert.deepStrictEqual(kinds(A.openQuestions('body', s[2].spec)), []);
  assert.ok(kinds(A.openQuestions('voice', s[3].spec)).includes('status:status'));                      // under evaluation
  ['wardrobe', 'persona', 'guardrails'].forEach((c, i) => assert.deepStrictEqual(kinds(A.openQuestions(c, s[4 + i].spec)), [], c));
});
t('seed specs: the other packages', () => {
  const claire = SEED('claire_bennett').components;
  assert.ok(kinds(A.openQuestions('wardrobe', claire[2].spec)).includes('text:notes'));                 // "pending a Character Bible entry"
  const paige = SEED('paige_chandler').components;
  assert.ok(kinds(A.openQuestions('face', paige[0].spec)).includes('text:canonical_image_notes'));
  SEED('phoebe_hart').components.filter((c) => c.component !== 'voice').forEach((c) => assert.deepStrictEqual(A.openQuestions(c.component, c.spec), [], c.component));
});
t('declared open_questions are the explicit form, and the validator accepts only { field, question }', () => {
  const spec = { apparent_age_range: [40, 45], hair: { color: 'dark', style: 'short' }, eyes: 'brown', skin_tone: 'medium',
    open_questions: [{ field: 'eyes', question: 'Confirm eye color against the master image.' }] };
  assert.ok(validateSpec('face', spec).ok, JSON.stringify(validateSpec('face', spec).errors));
  assert.deepStrictEqual(kinds(A.openQuestions('face', spec)), ['declared:eyes']);
  assert.ok(!validateSpec('face', Object.assign({}, spec, { open_questions: ['eyes?'] })).ok);
  assert.ok(!validateSpec('face', Object.assign({}, spec, { open_questions: [{ field: 'eyes', question: 'x', extra: 1 }] })).ok);
  assert.deepStrictEqual(A.openQuestions('face', Object.assign({}, spec, { open_questions: [] })), []);
});
t('a canonical voice is resolved; any other voice status is not', () => {
  assert.deepStrictEqual(A.openQuestions('voice', { status: 'canonical', description: 'calm, warm, measured' }), []);
  assert.ok(A.openQuestions('voice', { status: 'under_evaluation', description: 'calm' }).length);
  assert.ok(A.openQuestions('voice', { description: 'calm' }).length);
});
t('unresolved prose markers (and not ordinary words)', () => {
  ['Eye color awaits the owner’s confirmation.', 'Pending review.', 'To be decided later.', 'Not yet canonical.', 'TBD', 'placeholder image', 'Unconfirmed.']
    .forEach((s) => assert.ok(A.openQuestions('body', { height_range_in: [60, 70], build: 'x', notes: s }).length, s));
  ['Confident and composed.', 'Confirmed by the owner in September.', 'Stands straight.']
    .forEach((s) => assert.deepStrictEqual(A.openQuestions('body', { height_range_in: [60, 70], build: 'x', notes: s }), [], s));
});

// ---- 2/3) release review, visual set, package blockers -------------------------
// A detail shaped like registry.getCharacterDetail(), built from a seed package.
function detailFrom(seed, statusOf = () => 'proposed') {
  const ids = {};
  const versions = seed.components.map((c, i) => {
    const key = c.component + '.v' + (c.version_no || (seed.components.slice(0, i).filter((x) => x.component === c.component).length + 1));
    const id = '00000000-0000-4000-8000-' + String(i + 1).padStart(12, '0');
    ids[key] = id;
    return { id, component: c.component, version_no: Number(key.split('.v')[1]), spec: c.spec, spec_sha256: 'a'.repeat(64), status: statusOf(c.component, key), assets: [] };
  });
  const releases = seed.releases.map((r, i) => ({ id: '00000000-0000-4000-9000-' + String(i + 1).padStart(12, '0'), release_no: i + 1, status: 'proposed', is_current: false,
    components: Object.fromEntries(Object.entries(r.components).map(([k, ref]) => [k, ids[ref]])) }));
  return { character: { character_id: 'c-1' }, versions, releases, assets: [], mappings: [], references: [], events: [] };
}
t('release review: the current candidate is blocked as a package; visual canon is blocked only by the face descriptors', () => {
  const d = detailFrom(SEED('amanda_albright'));
  const r2 = d.releases[1];
  const rev = A.reviewRelease(d, r2.id);
  assert.strictEqual(rev.package_approvable, false);
  assert.deepStrictEqual(rev.blocking.map((b) => b.component).sort(), ['face', 'voice']);
  assert.strictEqual(rev.visual.approvable, false);
  assert.deepStrictEqual(rev.visual.blocking.map((b) => b.component), ['face']);
  const byComp = Object.fromEntries(rev.components.map((c) => [c.component, c]));
  ['body', 'wardrobe', 'guardrails', 'persona'].forEach((k) => assert.strictEqual(byComp[k].approvable, true, k));
  assert.strictEqual(byComp.face.approvable, false); assert.strictEqual(byComp.voice.approvable, false);
});
t('visual canon can be approvable (and then ready) while voice stays under evaluation', () => {
  const seed = JSON.parse(JSON.stringify(SEED('amanda_albright')));
  seed.components[1].spec.canonical_image_notes = 'Landscape master; square crops are derived assets.';   // a confirmed face version
  const d = detailFrom(seed);
  const rev = A.reviewRelease(d, d.releases[1].id);
  assert.strictEqual(rev.visual.approvable, true); assert.strictEqual(rev.visual.ready, false);
  assert.strictEqual(rev.package_approvable, false);                                                        // voice still open
  const d2 = detailFrom(seed, (comp) => (['face', 'body', 'wardrobe', 'guardrails'].includes(comp) ? 'approved' : 'proposed'));
  const rev2 = A.reviewRelease(d2, d2.releases[1].id);
  assert.strictEqual(rev2.visual.ready, true); assert.strictEqual(rev2.package_approvable, false);
});
t('package blockers include the legacy release’s proposed versions', () => {
  const d = detailFrom(SEED('amanda_albright'));
  const b = A.packageBlockers(d, d.releases[1].id, [d.releases[0].id]);
  assert.ok(b.some((x) => x.component === 'face' && x.version_no === 2));
  assert.ok(b.some((x) => x.component === 'voice'));
  assert.ok(A.packageBlockers(d, 'nope', []).some((x) => /not found/.test(x.reasons[0])));
});
t('rejected / retired versions are never approvable; approved ones read as approved', () => {
  const v = { id: 'v', component: 'body', version_no: 1, spec: { height_range_in: [60, 70], build: 'x' } };
  assert.strictEqual(A.versionReview(Object.assign({}, v, { status: 'rejected' })).approvable, false);
  assert.strictEqual(A.versionReview(Object.assign({}, v, { status: 'retired' })).approvable, false);
  assert.strictEqual(A.versionReview(Object.assign({}, v, { status: 'approved' })).approved, true);
  assert.strictEqual(A.versionReview(Object.assign({}, v, { status: 'proposed' })).approvable, true);
});

// ---- face v3 proposal + visual canon by component version ---------------------------
const PROPOSAL = require(path.join(__dirname, '..', 'scripts', 'character_seed', 'proposals', 'amanda_albright.face.v3.json'));
t('face v3 proposal: validates, has no open questions, reuses the parent’s canonical image', () => {
  assert.ok(validateSpec('face', PROPOSAL.spec).ok, JSON.stringify(validateSpec('face', PROPOSAL.spec).errors));
  assert.deepStrictEqual(A.openQuestions('face', PROPOSAL.spec), []);
  const v2 = SEED('amanda_albright').components[1];
  assert.deepStrictEqual(PROPOSAL.assets.filter((a) => a.role === 'canonical').map((a) => a.sha256), ['601c6d9229c0cab9a3f990c39c352f07b29b2b4c0e6663bc9d2b9321ad840d90']);
  const changed = A.specChanges(v2.spec, PROPOSAL.spec).map((c) => c.field).sort();
  assert.deepStrictEqual(changed, ['canonical_image_notes', 'distinguishing', 'eyes', 'skin_tone']);   // age, hair, vibe unchanged
});
t('visual canon: follows the newest APPROVED version per component, not the release', () => {
  const seed = JSON.parse(JSON.stringify(SEED('amanda_albright')));
  seed.components.splice(2, 0, { component: 'face', spec: PROPOSAL.spec });   // face v3, not in any release
  const d = detailFrom(seed);
  let vc = A.visualCanon(d);
  const face = vc.components.find((c) => c.component === 'face');
  assert.strictEqual(face.approved, null); assert.strictEqual(face.candidate.version_no, 3);    // v3 resolved; v2 is not a candidate
  assert.strictEqual(vc.ready, false);
  const d2 = detailFrom(seed, (comp, key) => (['face.v3', 'body.v1', 'wardrobe.v1', 'guardrails.v1'].includes(key) ? 'approved' : 'proposed'));
  vc = A.visualCanon(d2);
  assert.strictEqual(vc.ready, true);
  assert.deepStrictEqual(vc.components.map((c) => c.component + ' v' + c.approved.version_no), ['face v3', 'body v1', 'wardrobe v1', 'guardrails v1']);
  assert.strictEqual(A.reviewRelease(d2, d2.releases[1].id).package_approvable, false);   // voice still open; no release promoted
});

t('review decisions: a newer face candidate outside the release is the face decision (release version kept as history)', () => {
  const seed = JSON.parse(JSON.stringify(SEED('amanda_albright')));
  seed.components.splice(2, 0, { component: 'face', spec: PROPOSAL.spec });   // face v3, in no release
  const d = detailFrom(seed, (comp, key) => (['body.v1', 'wardrobe.v1', 'guardrails.v1', 'persona.v1'].includes(key) ? 'approved' : 'proposed'));
  const face2 = d.versions.find((v) => v.component === 'face' && v.version_no === 2);
  d.versions.find((v) => v.component === 'face' && v.version_no === 3).parent_version_id = face2.id;
  const r2 = d.releases[1];
  const dec = A.decisionComponents(d, r2.id);
  const face = dec.find((c) => c.component === 'face');
  assert.strictEqual(face.version_no, 3); assert.strictEqual(face.approvable, true);
  assert.deepStrictEqual([face.replaces.release_no, face.replaces.version_no], [2, 2]);
  assert.deepStrictEqual(face.changes.fields.map((f) => f.field).sort(), ['canonical_image_notes', 'distinguishing', 'eyes', 'skin_tone']);
  assert.strictEqual(dec.find((c) => c.component === 'voice').version_no, 1);             // non-visual: the release's own version
  assert.strictEqual(dec.find((c) => c.component === 'body').approved, true);
  assert.ok(!dec.find((c) => c.component === 'body').replaces);
  assert.strictEqual(A.reviewRelease(d, r2.id).components.find((c) => c.component === 'face').version_no, 2);   // release itself unchanged
  // once face v3 is approved it is shown as approved (still replacing v2 in the review)
  const d3 = detailFrom(seed, (comp, key) => (['face.v3', 'body.v1', 'wardrobe.v1', 'guardrails.v1'].includes(key) ? 'approved' : 'proposed'));
  const f3 = A.decisionComponents(d3, d3.releases[1].id).find((c) => c.component === 'face');
  assert.strictEqual(f3.version_no, 3); assert.strictEqual(f3.approved, true);
});
t('review decisions: no newer candidate → the release’s own components, unchanged', () => {
  const d = detailFrom(SEED('amanda_albright'));
  assert.deepStrictEqual(A.decisionComponents(d, d.releases[1].id).map((c) => c.component + c.version_no), A.reviewRelease(d, d.releases[1].id).components.map((c) => c.component + c.version_no));
  assert.strictEqual(A.decisionComponents(d, 'nope'), null);
  // newest face (v2) still open, older face (v1) resolved: v1 is NOT a candidate (it is superseded)
  const face = A.visualCanon(d).components.find((c) => c.component === 'face');
  assert.strictEqual(face.candidate, null); assert.strictEqual(face.approved, null);
});

t('superseded: an older face is never approvable on its own once a newer (non-rejected) face exists', () => {
  const d = detailFrom(SEED('amanda_albright'));
  const v1 = d.versions.find((v) => v.component === 'face' && v.version_no === 1);
  assert.strictEqual(A.supersededBy(d, v1).version_no, 2);          // v2 still open, but v1 is superseded regardless
  const d2 = detailFrom(SEED('amanda_albright'), (comp, key) => (key === 'face.v2' ? 'rejected' : 'proposed'));
  assert.strictEqual(A.supersededBy(d2, d2.versions.find((v) => v.component === 'face' && v.version_no === 1)), null);   // v2 rejected → v1 not superseded
  assert.strictEqual(A.supersededBy(d, d.versions.find((v) => v.component === 'body')), null);
});

// ---- 4) the API --------------------------------------------------------------------
async function apiTests(run) {
  const seed = SEED('amanda_albright');
  const mine = detailFrom(seed);
  const other = detailFrom(SEED('paige_chandler'));
  other.versions.forEach((v) => { v.id = v.id.replace('4000-8000', '4000-a000'); });
  other.releases.forEach((r) => { r.id = r.id.replace('4000-9000', '4000-b000'); });
  const CHAR = '11111111-1111-4111-8111-111111111111';
  const calls = [];
  const stubRegistry = {
    getCharacterDetail: async (id) => (id === CHAR ? mine : null),
    setComponentStatus: async (a) => { calls.push(['setComponentStatus', a]); },
    promoteRelease: async (a) => { calls.push(['promoteRelease', a]); },
    approvePackage: async (a) => { calls.push(['approvePackage', a]); },
  };
  const orig = Module._load;
  Module._load = function (req) {
    if (req === '../lib/characters/registry') return stubRegistry;
    if (req === './_require_admin') return { requireOwner: async () => ({ email: 'owner@example.test' }) };
    return orig.apply(this, arguments);
  };
  const express = require('express');
  const app = express();
  app.use('/api/characters', require('../api/characters').router);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/characters/${CHAR}`;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const vid = (comp, n) => mine.versions.find((v) => v.component === comp && v.version_no === n).id;
  try {
    await run('api: a component version of ANOTHER character is refused before any write', async () => {
      calls.length = 0;
      const r = await post(`/components/${other.versions[0].id}/status`, { event: 'approved', reason: 'x' });
      assert.strictEqual(r.status, 404); assert.strictEqual(r.body.error, 'version_not_for_character'); assert.strictEqual(calls.length, 0);
    });
    await run('api: a release of ANOTHER character cannot be promoted', async () => {
      calls.length = 0;
      const r = await post(`/releases/${other.releases[0].id}/promote`, { reason: 'x' });
      assert.strictEqual(r.status, 404); assert.strictEqual(calls.length, 0);
    });
    await run('api: approve-package with a foreign legacy release is refused', async () => {
      calls.length = 0;
      const r = await post('/approve-package', { current_release_id: mine.releases[1].id, legacy_release_ids: [other.releases[0].id], reason: 'x' });
      assert.strictEqual(r.status, 404); assert.strictEqual(r.body.error, 'release_not_for_character'); assert.strictEqual(calls.length, 0);
    });
    await run('api: approving an unresolved version (face with open descriptors) is refused with the reasons', async () => {
      calls.length = 0;
      const r = await post(`/components/${vid('face', 2)}/status`, { event: 'approved', reason: 'x' });
      assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'unresolved_canon');
      assert.ok(r.body.open_questions.some((q) => q.field === 'canonical_image_notes')); assert.strictEqual(calls.length, 0);
    });
    await run('api: approving a voice under evaluation is refused', async () => {
      calls.length = 0;
      const r = await post(`/components/${vid('voice', 1)}/status`, { event: 'approved', reason: 'x' });
      assert.strictEqual(r.status, 409); assert.strictEqual(calls.length, 0);
    });
    await run('api: approving the whole unresolved package is refused with its blockers', async () => {
      calls.length = 0;
      const r = await post('/approve-package', { current_release_id: mine.releases[1].id, legacy_release_ids: [mine.releases[0].id], reason: 'x' });
      assert.strictEqual(r.status, 409); assert.ok(r.body.blockers.length); assert.strictEqual(calls.length, 0);
    });
    await run('api: a resolved version (body) is approved, recorded against the owner', async () => {
      calls.length = 0;
      const r = await post(`/components/${vid('body', 1)}/status`, { event: 'approved', reason: 'Matches the master image' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(calls.map((c) => c[0]), ['setComponentStatus']);
      assert.strictEqual(calls[0][1].versionId, vid('body', 1)); assert.strictEqual(calls[0][1].actor, 'owner@example.test');
    });
    await run('api: approving a superseded (legacy) face is refused', async () => {
      calls.length = 0;
      const r = await post(`/components/${vid('face', 1)}/status`, { event: 'approved', reason: 'x' });
      assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'superseded'); assert.strictEqual(r.body.superseded_by.version_no, 2); assert.strictEqual(calls.length, 0);
    });
    await run('api: rejecting an unresolved version is allowed (only approval requires resolution)', async () => {
      calls.length = 0;
      const r = await post(`/components/${vid('face', 2)}/status`, { event: 'rejected', reason: 'x' });
      assert.strictEqual(r.status, 200); assert.strictEqual(calls.length, 1);
    });
    await run('api: an unknown character → 404 with no write', async () => {
      calls.length = 0;
      const r = await fetch(base.replace(CHAR, '22222222-2222-4222-8222-222222222222') + `/components/${vid('body', 1)}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'approved', reason: 'x' }) });
      assert.strictEqual(r.status, 404); assert.strictEqual(calls.length, 0);
    });
  } finally { server.close(); Module._load = orig; }
}

(async () => {
  console.log('test_character_approval');
  const run = async (name, fn) => { try { await fn(); pass += 1; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; } };
  for (const [name, fn] of results) await run(name, fn);
  await apiTests(run);
  console.log(`\n${pass} passed${process.exitCode ? ', FAILURES above' : ''}`);
})();
