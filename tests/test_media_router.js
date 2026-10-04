// tests/test_media_router.js  (Issue #10 Media Studio) — renderer contract + dry-run router
// Deterministic fake renderers only: no network, no generation, no spend.
const assert = require('assert');
const { defineAdapter, notEnabled } = require('../lib/media/adapter');
const { effectiveCost, capBlock } = require('../lib/media/cost');
const { plan, nextAfter, MODES } = require('../lib/media/router');
const { freezeShotSpec, validateShotSpec } = require('../lib/media/shotspec');
const { CATALOG } = require('../lib/media/providers');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const pin = (c) => c.repeat(64);
const shot = (over = {}) => ({ shot_key: 'r_test', segment_class: 'brand', duration_seconds: 8, aspect: '16:9', audio: { ambient: true }, camera: { lens_mm: 50, move: 'slow push-in' },
  cast: [{ character_slug: 'amanda_albright', components: { face: { version: 3, spec_sha256: pin('a') } } }], references: [{ sha256: pin('b'), use: 'identity' }], ...over });

// A deterministic fake renderer. Provider-specific fields live ONLY in compile().
function fake(id, { quality = 'standard', rate = 0.2, max_seconds = 10, resolutions = ['720p', '1080p'], audio = true, refs = 3, face = 'verified_supported', modes = ['generate'], min_charge = 0, channels = null } = {}) {
  const ch = channels || [{ channel: `direct:${id}`, rate_per_s: Object.fromEntries(resolutions.map((r) => [r, rate])), min_charge, source: 'fixture', as_of: '2026-10-04' }];
  return defineAdapter({
    id, family: id, channels: ch,
    capabilities: () => ({ max_seconds, resolutions, native_audio: audio, max_reference_images: refs, face_reference: { state: face }, first_last_frame: true, modes, quality: { identity: quality } }),
    quote: (spec, ctx = {}) => effectiveCost(ch.map((c) => ({ ...c, ...((ctx.channels || {})[c.channel] || {}) })), { resolution: ctx.resolution, duration_seconds: spec.duration_seconds, needs_audio: true, reference_images: (spec.references || []).length, expected_attempts: ctx.expected_attempts }),
    probe: async () => ({ reachable: true }),
    compile: (spec, rs) => ({ provider: id, request: { [`${id}_prompt`]: spec.camera.move, [`${id}_model_version`]: 'v9', refs: rs.map((r) => r.sha256) } }),
    submit: notEnabled(id), poll: notEnabled(id), fetch: notEnabled(id),
  });
}

check('contract: every renderer must implement capabilities / quote / probe / compile / submit / poll / fetch (cancel optional); the real catalog conforms', () => {
  assert.throws(() => defineAdapter({ id: 'bad', capabilities: () => ({}), quote() {}, probe() {}, compile() {} }), /submit\(\) is required/);
  for (const a of CATALOG) for (const m of ['capabilities', 'quote', 'probe', 'compile', 'submit', 'poll', 'fetch']) assert.strictEqual(typeof a[m], 'function', `${a.id}.${m}`);
});
check('the SAME ShotSpec routes to different providers without being mutated (deep-frozen; hash unchanged)', () => {
  const s = shot(); const before = JSON.stringify(s); const h = freezeShotSpec(s).shotspec_sha256;
  const A = fake('alpha', { rate: 0.10 }); const B = fake('beta', { rate: 0.30 });
  const p1 = plan(s, { mode: 'standard_final', adapters: [A, B] });
  const p2 = plan(s, { mode: 'standard_final', adapters: [B], health: {} });
  assert.strictEqual(p1.primary.adapter, 'alpha'); assert.strictEqual(p2.primary.adapter, 'beta');
  assert.strictEqual(JSON.stringify(s), before); assert.strictEqual(p1.shotspec_sha256, h); assert.strictEqual(p2.shotspec_sha256, h);
  const frozenSpec = Object.freeze(JSON.parse(JSON.stringify(s)));
  assert.doesNotThrow(() => A.compile(frozenSpec, s.references), 'compile works on a frozen spec (it never writes into it)');
});
check('provider-specific fields never leak into the ShotSpec (compile output stays outside; validator refuses them)', () => {
  const s = shot(); const A = fake('alpha');
  const c = A.compile(s, s.references);
  assert.ok(c.request.alpha_prompt && !('alpha_prompt' in s) && !JSON.stringify(s).includes('alpha_model_version'));
  assert.ok(!validateShotSpec({ ...s, veo_seed: 7 }).ok && !validateShotSpec({ ...s, camera: { model_id: 'kling-v3' } }).ok);
  for (const a of CATALOG) { const out = a.compile(s, s.references); assert.ok(out.provider === a.id && out.request && out.compiled_prompt); assert.strictEqual(JSON.stringify(s), JSON.stringify(shot())); }
});
check('cheaper wins when quality tier and capability are equivalent', () => {
  const p = plan(shot(), { mode: 'standard_final', adapters: [fake('pricey', { rate: 0.40 }), fake('cheap', { rate: 0.12 })] });
  assert.strictEqual(p.primary.adapter, 'cheap'); assert.deepStrictEqual(p.fallbacks.map((f) => f.adapter), ['pricey']);
});
check('the required higher-capability renderer wins when the cheaper one cannot satisfy the shot', () => {
  const long = shot({ duration_seconds: 20 });
  const p = plan(long, { mode: 'standard_final', adapters: [fake('cheap_short', { rate: 0.05, max_seconds: 10 }), fake('long_capable', { rate: 0.60, max_seconds: 30 })] });
  assert.strictEqual(p.primary.adapter, 'long_capable'); assert.ok(p.rejected.some((r) => r.adapter === 'cheap_short' && /exceeds/.test(r.reasons[0])));
  const hero = plan(shot(), { mode: 'hero_final', adapters: [fake('cheap_std', { rate: 0.05, quality: 'standard' }), fake('hero', { rate: 0.40, quality: 'hero' })] });
  assert.strictEqual(hero.primary.adapter, 'hero', 'the hero floor excludes a cheaper standard renderer');
  const face = plan(shot(), { mode: 'standard_final', adapters: [fake('noface', { rate: 0.01, face: 'refused' }), fake('ok', { rate: 0.30 })] });
  assert.strictEqual(face.primary.adapter, 'ok', 'a renderer that refuses photoreal face references is never chosen for an identity shot');
});
check('per-shot, project, daily and monthly caps can block a render', () => {
  const A = fake('alpha', { rate: 0.40 });   // 8s x 0.40 = $3.20
  for (const [policy, spend, cap] of [[{ per_shot_usd: 3 }, {}, 'per_shot'], [{ per_project_usd: 50 }, { project_usd: 48 }, 'project'], [{ daily_usd: 10 }, { today_usd: 9 }, 'daily'], [{ monthly_usd: 100 }, { month_usd: 99 }, 'monthly']]) {
    const p = plan(shot(), { mode: 'standard_final', adapters: [A], policy, spend });
    assert.strictEqual(p.status, 'no_eligible_renderer', cap); assert.ok(p.rejected[0].stage === 'policy_cap' && p.rejected[0].reasons[0].startsWith(cap), JSON.stringify(p.rejected));
  }
  assert.strictEqual(plan(shot(), { mode: 'standard_final', adapters: [A], policy: { per_shot_usd: 5, daily_usd: 10 }, spend: { today_usd: 2 } }).status, 'planned');
  assert.ok(capBlock(1, { monthly_usd: 10 }, { month_usd: 9.5 }));
});
check('prepaid credits lower effective cost and change the ranking; exhausted credits fall back to list price; subscription credits only count when verified for API use', () => {
  const A = fake('alpha', { rate: 0.30 }); const B = fake('beta', { rate: 0.25 });
  const withPrepaid = { alpha: { channels: { 'direct:alpha': { prepaid: { remaining_usd_list: 100, effective_discount: 0.4 } } } } };   // 0.30 -> 0.18/s
  const p = plan(shot(), { mode: 'standard_final', adapters: [A, B], accounts: withPrepaid });
  assert.strictEqual(p.primary.adapter, 'alpha'); assert.strictEqual(p.primary.cost.basis, 'prepaid'); assert.strictEqual(p.primary.cost.per_attempt, 1.44);
  const exhausted = { alpha: { channels: { 'direct:alpha': { prepaid: { remaining_usd_list: 1, effective_discount: 0.4 } } } } };
  const q = plan(shot(), { mode: 'standard_final', adapters: [A, B], accounts: exhausted });
  assert.strictEqual(q.primary.adapter, 'beta'); assert.strictEqual(q.fallbacks[0].cost.basis, 'list (prepaid exhausted)');
  const subUnverified = { alpha: { channels: { 'direct:alpha': { subscription: { applies_to_api: false, remaining_usd_list: 100, effective_discount: 0.5 } } } } };
  assert.strictEqual(plan(shot(), { mode: 'standard_final', adapters: [A, B], accounts: subUnverified }).primary.adapter, 'beta', 'consumer plan credits are ignored unless verified for API use');
  const subVerified = { alpha: { channels: { 'direct:alpha': { subscription: { applies_to_api: true, remaining_usd_list: 100, effective_discount: 0.5 } } } } };
  assert.strictEqual(plan(shot(), { mode: 'standard_final', adapters: [A, B], accounts: subVerified }).primary.adapter, 'alpha');
});
check('effective cost: minimum charge, minimum billable seconds, audio premium, reference surcharge, retry waste; cheapest channel wins', () => {
  const c = effectiveCost([{ channel: 'direct', rate_per_s: { '1080p': 0.40 }, audio_premium_per_s: { '1080p': 0.10 }, min_billable_seconds: 10, reference_surcharge_per_image: 0.05, expected_attempts: 1.5 },
    { channel: 'aggregator', rate_per_s: { '1080p': 0.45 }, min_charge: 0.8 }], { resolution: '1080p', duration_seconds: 4, needs_audio: true, reference_images: 2 });
  assert.strictEqual(c.channel, 'aggregator'); assert.strictEqual(c.accepted_take_cost, 1.8);
  assert.strictEqual(c.alternatives[0].accepted_take_cost, 7.65, 'direct: 10s billable x 0.50 + 0.10 refs = 5.10, x1.5 attempts');
});
check('fallback order works when a provider is unavailable (health) and when the chosen one fails at submit', () => {
  const A = fake('alpha', { rate: 0.10 }); const B = fake('beta', { rate: 0.20 }); const C = fake('gamma', { rate: 0.30 });
  const p = plan(shot(), { mode: 'standard_final', adapters: [A, B, C], health: { alpha: { available: false, reason: 'provider outage' } } });
  assert.strictEqual(p.primary.adapter, 'beta'); assert.ok(p.rejected.some((r) => r.adapter === 'alpha' && r.stage === 'health'));
  const n = nextAfter(p, 'beta', 'refused the reference');
  assert.strictEqual(n.next.adapter, 'gamma'); assert.deepStrictEqual(n.failed, { adapter: 'beta', why: 'refused the reference' });
  assert.strictEqual(nextAfter(p, 'gamma', 'x').next, null);
});
check('"no eligible renderer" is returned cleanly with every reason (never a forced bad choice)', () => {
  const p = plan(shot({ duration_seconds: 40, audio: { dialogue: 'Hello' } }), { mode: 'hero_final', adapters: [fake('aa', { max_seconds: 10, quality: 'standard' }), fake('bb', { audio: false, quality: 'hero', max_seconds: 60 })] });
  assert.strictEqual(p.status, 'no_eligible_renderer'); assert.strictEqual(p.primary, null);
  assert.ok(p.rejected.length === 2 && p.rejected.every((r) => r.reasons.length));
  assert.strictEqual(plan(shot(), { mode: 'draft', adapters: [] }).status, 'no_eligible_renderer');
});
check('production modes are outcomes, not vendors; instructional content is never generated', () => {
  assert.deepStrictEqual(Object.keys(MODES).sort(), ['acceptance_test', 'draft', 'hero_final', 'instructional_non_generative', 'repair_edit', 'standard_final', 'talking_head']);
  const ins = plan(shot({ segment_class: 'instructional' }), { mode: 'standard_final', adapters: [fake('alpha')] });
  assert.strictEqual(ins.status, 'non_generative'); assert.strictEqual(ins.primary, null);
  assert.strictEqual(plan(shot(), { mode: 'instructional_non_generative', adapters: [fake('alpha')] }).status, 'non_generative');
  assert.strictEqual(plan(shot(), { mode: 'talking_head', adapters: [fake('gen', { rate: 0.01 }), fake('avatar', { rate: 0.05, modes: ['talking_head'] })] }).primary.adapter, 'avatar');
  assert.strictEqual(plan(shot(), { mode: 'repair_edit', adapters: [fake('gen'), fake('fixer', { modes: ['edit'] })] }).primary.adapter, 'fixer');
  assert.strictEqual(plan(shot(), { mode: 'draft', adapters: [fake('dd', { resolutions: ['360p', '720p'], quality: 'draft', rate: 0.03 })] }).primary.resolution, '360p', 'draft takes the cheapest reviewable resolution');
  assert.strictEqual(plan(shot(), { mode: 'draft', resolution: '720p', adapters: [fake('dd', { resolutions: ['360p', '720p'], quality: 'draft' })] }).primary.resolution, '720p', 'a project can force a draft resolution');
  assert.strictEqual(plan(shot(), { mode: 'standard_final', adapters: [fake('fixonly', { modes: ['edit'], rate: 0.01 })] }).status, 'no_eligible_renderer', 'an edit-only renderer never generates a new shot');
});
check('live calls refuse until access is probed and spend confirmed (no accidental render)', async () => {
  for (const a of CATALOG) await assert.rejects(() => a.submit({}), /RENDER_NOT_ENABLED|not enabled/);
});
check('plan() refuses anything that is not a valid ShotSpec (e.g. the frozen {spec, sha} wrapper), so nothing prices as NaN or skips the face rule', () => {
  assert.throws(() => plan(freezeShotSpec(shot()), { mode: 'draft', adapters: CATALOG }), (e) => e.code === 'INVALID_SHOTSPEC');
  assert.strictEqual(plan(freezeShotSpec(shot()).spec, { mode: 'hero_final', adapters: CATALOG }).status, 'no_eligible_renderer');
});
check('face reference: UNVERIFIED support is never eligible for normal identity routing, and never a silent fallback', () => {
  const ver = fake('verified', { rate: 0.40, quality: 'hero', face: 'verified_supported' });
  const unv = fake('unverified', { rate: 0.05, quality: 'hero', face: 'unverified' });
  for (const mode of ['draft', 'standard_final', 'hero_final']) {
    const p = plan(shot(), { mode, adapters: [unv, ver], resolution: mode === 'draft' ? '720p' : undefined });
    assert.strictEqual(p.primary.adapter, 'verified', mode);
    assert.ok(!p.fallbacks.some((x) => x.adapter === 'unverified'), `${mode}: unverified must not appear as a fallback`);
    assert.ok(p.rejected.some((r) => r.adapter === 'unverified' && /unverified/.test(r.reasons.join(' '))), mode);
  }
  const none = plan(shot(), { mode: 'hero_final', adapters: [unv] });
  assert.strictEqual(none.status, 'no_eligible_renderer');
  const noIdentity = plan(shot({ references: [{ sha256: pin('c'), use: 'prop_environment' }] }), { mode: 'hero_final', adapters: [unv] });
  assert.strictEqual(noIdentity.primary.adapter, 'unverified', 'the rule applies to identity shots only (a prop-only shot is fine)');
});
check('face reference: an explicit acceptance_test may target an unverified route on purpose; refused stays excluded', () => {
  const unv = fake('unverified', { rate: 0.05, face: 'unverified', resolutions: ['480p', '720p'] });
  const ref = fake('refuser', { rate: 0.01, face: 'refused', resolutions: ['480p', '720p'] });
  const p = plan(shot(), { mode: 'acceptance_test', adapters: [unv, ref] });
  assert.strictEqual(p.primary.adapter, 'unverified'); assert.strictEqual(p.primary.face_reference.state, 'unverified');
  assert.ok(p.rejected.some((r) => r.adapter === 'refuser' && /refuses/.test(r.reasons[0])));
});
check('face reference: our own evidence promotes a route to verified_supported (account level, with evidence + date)', () => {
  const unv = fake('seedlike', { rate: 0.30, quality: 'hero', face: 'unverified' });
  const evidence = { state: 'verified_supported', evidence: 'Phase 0 acceptance take ok (identity reviewed)', date: '2026-10-05' };
  const p = plan(shot(), { mode: 'hero_final', adapters: [unv], accounts: { seedlike: { face_reference: evidence } } });
  assert.strictEqual(p.status, 'planned'); assert.deepStrictEqual(p.primary.face_reference, { state: 'verified_supported', evidence });
  const refused = plan(shot(), { mode: 'acceptance_test', adapters: [unv], resolution: '720p', accounts: { seedlike: { face_reference: { state: 'refused', evidence: 'refused at input filter', date: '2026-10-05' } } } });
  assert.strictEqual(refused.status, 'no_eligible_renderer', 'a recorded refusal excludes the route even from acceptance tests');
  const avatar = fake('avatar', { modes: ['talking_head'], face: 'not_applicable' });
  assert.strictEqual(plan(shot(), { mode: 'talking_head', adapters: [avatar] }).primary.adapter, 'avatar', 'talking head identity comes from the consented avatar');
  assert.strictEqual(plan(shot(), { mode: 'standard_final', adapters: [fake('na', { face: 'not_applicable' })] }).status, 'no_eligible_renderer');
});
check('real catalog today: every face route is unverified, so production identity routing says no_eligible_renderer; the acceptance test picks the cheapest routes', () => {
  const p = plan(shot(), { mode: 'hero_final', adapters: CATALOG });
  assert.strictEqual(p.status, 'no_eligible_renderer'); assert.ok(p.rejected.every((r) => r.reasons.length));
  const a = plan(shot({ duration_seconds: 4 }), { mode: 'acceptance_test', adapters: CATALOG });
  assert.strictEqual(a.status, 'planned'); assert.ok(a.primary.cost.accepted_take_cost <= 0.5, JSON.stringify(a.primary));
  const ok = plan(shot(), { mode: 'hero_final', adapters: CATALOG, accounts: { veo_3_1: { face_reference: { state: 'verified_supported', evidence: 'test', date: '2026-10-05' } } } });
  assert.strictEqual(ok.primary.adapter, 'veo_3_1');
});

(async () => {
  let pass = 0, fail = 0;
  console.log('Media Studio: renderer contract + dry-run router (Issue #10)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n      ')); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
