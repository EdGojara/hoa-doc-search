// tests/test_media_studio.js  (Issue #10 Media Studio V1) — projects, proposal, review, dry-run preview
// No network, no generation, no spend. Fake canon + fake model client only.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../lib/media/studio');
const { defineAdapter, notEnabled } = require('../lib/media/adapter');
const { effectiveCost } = require('../lib/media/cost');
const { CATALOG } = require('../lib/media/providers');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const pin = (c) => c.repeat(64);
const CANON = { amanda_albright: { ok: true, slug: 'amanda_albright', pins: { face: { version: 3, spec_sha256: pin('a') }, body: { version: 1, spec_sha256: pin('b') } }, face_sha256: pin('c'), voice_approved: false } };
const mk = (kind = 'training', over = {}) => { const p = S.createProject({ kind, title: 'Lifeguard safety seminar', brief: 'Pool vendor lifeguards learn the rescue procedure.', audience: 'pool vendor lifeguards', ...over }); S.setProposal(p, S.templateProposal(p)); return p; };
const ids = CATALOG.map((a) => a.id);

check('create: kind, title and brief are required; renderer names are refused even in the brief', () => {
  assert.throws(() => S.createProject({ kind: 'movie', title: 't', brief: 'b' }), /kind is one of/);
  assert.throws(() => S.createProject({ kind: 'brand', brief: 'b' }), /title required/);
  assert.throws(() => S.createProject({ kind: 'brand', title: 't' }), /brief required/);
  assert.throws(() => S.createProject({ kind: 'brand', title: 't', brief: 'make it with Seedance' }), /names a renderer/);
  const p = S.createProject({ kind: 'brand', title: 'Spot', brief: 'Who we are.' });
  assert.strictEqual(p.status, 'brief'); assert.strictEqual(p.production_mode, 'draft'); assert.strictEqual(p.target_seconds, 30);
});

check('proposal: every kind yields a valid treatment / script / storyboard with intent-only shots; instructional is source material', () => {
  for (const kind of Object.keys(S.KINDS)) {
    const p = mk(kind);
    assert.strictEqual(p.status, 'proposed');
    assert.ok(S.validateProposal(p.proposal).ok, kind);
    const text = JSON.stringify(p.proposal);
    for (const id of ids) assert.ok(!text.includes(id), `${kind}: canonical proposal must not mention ${id}`);
    for (const s of S.allShots(p.proposal)) {
      assert.ok(!Object.keys(s).some((k) => /provider|vendor|renderer|model/i.test(k)), `${kind}/${s.shot_key} has a renderer field`);
      if (s.segment_class === 'instructional') assert.strictEqual(s.kind, 'source_material');
    }
    assert.strictEqual(p.proposal.script.beats.length, S.allShots(p.proposal).length);
  }
});

check('shot validation: renderer names / renderer fields / generated instructional content are refused', () => {
  const p = mk();
  assert.throws(() => S.updateShot(p, 's1_hook', { intent: 'Render this on Veo at 4k' }), /names a renderer/);
  assert.throws(() => S.updateShot(p, 's2_module', { kind: 'generate' }), /never generated/);
  const bad = { ...S.allShots(p.proposal)[0], renderer_id: 'x' };
  assert.ok(S.validateShot(bad).errors.some((e) => /renderer fields/.test(e)));
  assert.throws(() => S.updateShot(p, 'nope', { title: 'x' }), /no shot/);
  const ok = S.updateShot(p, 's1_hook', { intent: 'A calm pool deck at opening time.', duration_seconds: 5 });
  assert.strictEqual(ok.duration_seconds, 5); assert.strictEqual(p.proposal.script.beats.find((b) => b.shot_key === 's1_hook').direction, 'A calm pool deck at opening time.');
});

check('review: submit -> approve by the CURRENT proposal hash; stale hash refused; flagged shots block approval', () => {
  const p = mk();
  assert.throws(() => S.review(p, 'approve', { proposal_sha256: S.proposalSha(p.proposal) }), /cannot approve from proposed/);
  S.setShotReview(p, 's1_hook', 'needs_changes', 'warmer light');
  S.review(p, 'submit');
  assert.throws(() => S.review(p, 'approve', { proposal_sha256: 'f'.repeat(64) }), (e) => e.code === 'STALE');
  assert.throws(() => S.review(p, 'approve', { proposal_sha256: S.proposalSha(p.proposal) }), /still flagged/);
  S.review(p, 'request_changes', { note: 'fix the hook' }); assert.strictEqual(p.status, 'changes_requested');
  S.setShotReview(p, 's1_hook', 'approved');
  S.review(p, 'submit');
  S.review(p, 'approve', { proposal_sha256: S.proposalSha(p.proposal) });
  assert.strictEqual(p.status, 'approved'); assert.strictEqual(p.approved_sha256, S.proposalSha(p.proposal));
});

check('review: any edit after approval drops the project back to proposed and clears the approval', () => {
  const p = mk(); S.review(p, 'submit'); S.review(p, 'approve', { proposal_sha256: S.proposalSha(p.proposal) });
  S.updateShot(p, 's3_recap', { duration_seconds: 9 });
  assert.strictEqual(p.status, 'proposed'); assert.strictEqual(p.approved_sha256, null);
  assert.ok(p.history.some((h) => h.event === 'shot_edited' && h.detail.review_reopened));
  S.review(p, 'submit'); S.review(p, 'approve', { proposal_sha256: S.proposalSha(p.proposal) });
  S.updateTreatment(p, { tone: 'Calm and direct.' }); assert.strictEqual(p.status, 'proposed');
});

check('preview: instructional is non-generative at $0; Amanda face shots are NOT plannable while face support is unverified', () => {
  const p = mk('brand');
  const r = S.previewPlan(p, { canon: CANON });
  const face = r.shots.filter((s) => (S.allShots(p.proposal).find((x) => x.shot_key === s.shot_key).cast || []).length);
  assert.ok(face.length >= 2);
  for (const s of face) { assert.strictEqual(s.status, 'no_eligible_renderer'); assert.match(s.explanation, /face-reference check/); assert.strictEqual(s.estimate_usd, null); }
  const t = mk('training'); const rt = S.previewPlan(t, { canon: CANON });
  const instr = rt.shots.find((s) => s.segment_class === 'instructional');
  assert.strictEqual(instr.status, 'non_generative'); assert.strictEqual(instr.estimate_usd, 0);
  const planned = rt.shots.filter((s) => s.status === 'planned');
  assert.ok(planned.length && planned.every((s) => s.estimate_usd > 0 && s.route && s.route.renderer));
  assert.strictEqual(rt.totals.estimated_usd, Math.round(planned.reduce((a, s) => a + s.estimate_usd, 0) * 100) / 100);
  assert.strictEqual(rt.live_generation, false);
  assert.ok(rt.shots.find((s) => s.shot_key === 's1_host').warnings.some((w) => /voice is not approved/.test(w)));
});

check('preview: a renderer pin is a filter only; pinning an unverified route cannot bypass the face rule', () => {
  const p = mk('brand');
  S.setRendererPin(p, 's2_close', 'veo_3_1');
  const r = S.previewPlan(p, { canon: CANON }).shots.find((s) => s.shot_key === 's2_close');
  assert.strictEqual(r.status, 'no_eligible_renderer'); assert.strictEqual(r.pinned, 'veo_3_1');
  const shotJson = JSON.stringify(S.allShots(p.proposal));
  for (const id of ids) assert.ok(!shotJson.includes(id), 'the pin lives in project.advanced, never on the shot');
  assert.throws(() => S.setRendererPin(p, 's2_close', 'made_up'), /unknown renderer/);
  S.setRendererPin(p, 's1_mood', 'kling_3');
  const m = S.previewPlan(p, { canon: CANON }).shots.find((s) => s.shot_key === 's1_mood');
  assert.strictEqual(m.status, 'planned'); assert.match(m.route.renderer, /Kling/);
  S.setRendererPin(p, 's1_mood', null); assert.ok(!('s1_mood' in p.advanced.renderer_pins));
});

check('preview: our own evidence (account face_reference) makes a face shot plannable; missing canon blocks with a reason', () => {
  const p = mk('brand');
  const accounts = { veo_3_1: { face_reference: { state: 'verified_supported', evidence: 'acceptance take reviewed', date: '2026-10-05' } } };
  p.production_mode = 'standard_final';
  const r = S.previewPlan(p, { canon: CANON, accounts }).shots.find((s) => s.shot_key === 's2_arrival');
  assert.strictEqual(r.status, 'planned'); assert.strictEqual(r.route.face_reference, 'verified_supported');
  const b = S.previewPlan(p, { canon: { amanda_albright: { ok: false, reason: 'amanda_albright: no approved face version' } } }).shots.find((s) => s.shot_key === 's2_arrival');
  assert.strictEqual(b.status, 'blocked'); assert.match(b.explanation, /no approved face/);
});

check('interchangeable: a new renderer is one adapter + metadata; the studio routes to it with no studio change', () => {
  const ch = [{ channel: 'direct:newco', rate_per_s: { '360p': 0.001, '720p': 0.002 }, source: 'fixture', as_of: '2026-10-04' }];
  const newco = defineAdapter({ id: 'newco_v1', family: 'newco', label: 'NewCo v1', channels: ch,
    capabilities: () => ({ max_seconds: 20, resolutions: ['360p', '720p'], native_audio: true, max_reference_images: 4, face_reference: { state: 'unverified' }, first_last_frame: true, modes: ['generate'], quality: { identity: 'standard' } }),
    quote: (spec, ctx = {}) => effectiveCost(ch, { resolution: ctx.resolution, duration_seconds: spec.duration_seconds, needs_audio: false, reference_images: 0 }),
    probe: async () => ({ reachable: true }), compile: () => ({}), submit: notEnabled('newco_v1'), poll: notEnabled('newco_v1'), fetch: notEnabled('newco_v1') });
  const p = mk('brand');
  const r = S.previewPlan(p, { canon: CANON, adapters: [...CATALOG, newco] });
  assert.strictEqual(r.shots.find((s) => s.shot_key === 's1_mood').route.renderer, 'newco_v1', 'cheapest new route wins (label falls back to id outside the catalog)');
  assert.strictEqual(r.shots.find((s) => s.shot_key === 's2_close').status, 'no_eligible_renderer', 'and it inherits the unverified face rule');
});

check('live generation is disabled', () => {
  assert.throws(() => S.render(), (e) => e.code === 'RENDER_NOT_ENABLED');
});

check('Amanda draft: only creative text changes; instructional untouched; a renderer name in the draft falls back to the template', async () => {
  const { draftProposal } = require('../lib/media/proposal_ai');
  const p = S.createProject({ kind: 'training', title: 'Lifeguard safety seminar', brief: 'Rescue procedure.' });
  const reply = (obj) => ({ messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] }) } });
  const good = await draftProposal(p, reply({ logline: 'Ready on the deck.', tone: 'Calm.', shots: [{ shot_key: 's1_hook', title: 'Morning deck', intent: 'Quiet pool at opening.' }, { shot_key: 's2_module', intent: 'invented procedure' }] }));
  assert.strictEqual(good.fallback_reason, null); assert.strictEqual(good.proposal.source, 'amanda_draft');
  assert.strictEqual(good.proposal.treatment.logline, 'Ready on the deck.');
  const instr = S.allShots(good.proposal).find((s) => s.shot_key === 's2_module');
  assert.ok(!/invented/.test(instr.intent), 'instructional text is never model-written');
  assert.strictEqual(S.allShots(good.proposal).length, S.allShots(S.templateProposal(p)).length);
  const bad = await draftProposal(p, reply({ logline: 'Shot on Kling for realism.', shots: [] }));
  assert.match(bad.fallback_reason, /failed validation/); assert.strictEqual(bad.proposal.source, 'template');
  const broken = await draftProposal(p, { messages: { create: async () => { throw new Error('offline'); } } });
  assert.match(broken.fallback_reason, /unavailable/);
});

check('store: save / get / list round-trip; bad ids refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstudio-'));
  process.env.MEDIA_STUDIO_DIR = dir;
  const store = require('../lib/media/studio_store');
  const p = mk(); store.save(p);
  assert.deepStrictEqual(store.get(p.id), JSON.parse(JSON.stringify(p)));
  assert.strictEqual(store.list()[0].id, p.id);
  assert.throws(() => store.get('../etc/passwd'), /bad project id/);
  assert.throws(() => store.get('0123456789ab'), /not found/);
  fs.rmSync(dir, { recursive: true, force: true }); delete process.env.MEDIA_STUDIO_DIR;
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) {
    try { await fn(); pass += 1; console.log(`  ✓ ${n}`); } catch (e) { fail += 1; console.log(`  ✗ ${n}\n    ${e.stack.split('\n').slice(0, 3).join('\n    ')}`); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
