// ============================================================================
// lib/media/router.js  (Issue #10 Media Studio) — dry-run renderer planner
// ----------------------------------------------------------------------------
// plan(shotSpec, { mode, adapters, accounts, health, policy, spend }) returns a
// ranked plan WITHOUT any network or generation call. Amanda asks for an OUTCOME
// (a production mode), never a vendor. The router:
//   1. applies the mode's requirements (quality floor, resolution, capability);
//   2. drops renderers that cannot satisfy the shot (hard capability fit);
//   3. drops renderers that are unavailable (health), keeping them listed;
//   4. prices each survivor's EFFECTIVE cost (cheapest usable channel);
//   5. drops renders that would break a per-shot / project / daily / monthly cap;
//   6. ranks: cheapest first among those meeting the quality floor; on a cost tie
//      the higher quality class wins; the rest become the fallback order.
// It returns `no_eligible_renderer` (with every reason) rather than forcing a bad
// choice, and `non_generative` for instructional segments (never generated).
// The ShotSpec is deep-frozen for the whole plan: no adapter or step can mutate it.
// ============================================================================
const { QUALITY, deepFreeze } = require('./adapter');
const { effectiveCost, capBlock } = require('./cost');
const { canonicalJson, sha256 } = require('./shotspec');

const MODES = Object.freeze({
  // resolutions are in PREFERENCE order; each renderer gets the first one it supports
  // draft takes the cheapest reviewable resolution (a project can force one with `resolution`)
  draft:                        { quality_floor: 'draft',    resolutions: ['360p', '480p', '720p'], requires: 'generate', prefer: 'cheapest' },
  standard_final:               { quality_floor: 'standard', resolutions: ['1080p'],                 requires: 'generate', prefer: 'cheapest' },
  hero_final:                   { quality_floor: 'hero',     resolutions: ['1080p', '4k'],           requires: 'generate', prefer: 'cheapest' },
  talking_head:                 { quality_floor: 'standard', resolutions: ['1080p'], requires: 'talking_head', prefer: 'cheapest' },
  repair_edit:                  { quality_floor: 'standard', resolutions: ['1080p', '720p'], requires: 'edit', prefer: 'cheapest' },
  instructional_non_generative: { non_generative: true },
});

function hardFit(caps, shot, mode, resolution) {
  const r = [];
  const seconds = Number(shot.duration_seconds);
  if (seconds > Number(caps.max_seconds) && !(caps.extend_to_seconds && seconds <= Number(caps.extend_to_seconds))) r.push(`duration ${seconds}s exceeds ${caps.max_seconds}s`);
  if (!caps.resolutions.includes(resolution)) r.push(`no ${resolution}`);
  const dialogue = shot.audio && shot.audio.dialogue;
  if (dialogue && !caps.native_audio) r.push('shot has dialogue; no native audio');
  const refImgs = (shot.references || []).length;
  if (refImgs > Number(caps.max_reference_images || 0)) r.push(`${refImgs} reference images > ${caps.max_reference_images || 0}`);
  const hasIdentityRef = (shot.references || []).some((x) => x.use === 'identity');
  if (hasIdentityRef && caps.face_reference === 'refused') r.push('refuses photoreal face references');
  if (shot.first_last_frame && !caps.first_last_frame) r.push('needs first/last-frame control');
  if (mode.requires && !(caps.modes || []).includes(mode.requires)) r.push(`not a ${mode.requires} renderer`);
  if (QUALITY[caps.quality.identity] < QUALITY[mode.quality_floor]) r.push(`identity quality ${caps.quality.identity} below ${mode.quality_floor}`);
  return r;
}

function plan(shotSpec, { mode: modeName, adapters = [], accounts = {}, health = {}, policy = {}, spend = {}, resolution = null } = {}) {
  const spec = deepFreeze(JSON.parse(JSON.stringify(shotSpec)));
  const shotspec_sha256 = sha256(canonicalJson(spec));
  const mode = MODES[modeName];
  if (!mode) throw new Error(`unknown production mode ${modeName}`);
  if (mode.non_generative || spec.segment_class === 'instructional') {
    return deepFreeze({ status: 'non_generative', mode: modeName, shotspec_sha256, primary: null, fallbacks: [], rejected: [],
      note: 'instructional content is built from approved source material (SOP text, approved footage, slides, approved avatar read), never generated' });
  }
  const rejected = []; const candidates = [];
  for (const a of adapters) {
    const caps = a.capabilities();
    const res = resolution || mode.resolutions.find((r) => caps.resolutions.includes(r)) || mode.resolutions[0];
    const reasons = hardFit(caps, spec, mode, res);
    if (reasons.length) { rejected.push({ adapter: a.id, stage: 'capability', reasons }); continue; }
    const h = health[a.id] || {};
    if (h.available === false) { rejected.push({ adapter: a.id, stage: 'health', reasons: [h.reason || 'unavailable'] }); continue; }
    const q = a.quote(spec, { ...(accounts[a.id] || {}), resolution: res });
    if (!q || q.usable === false) { rejected.push({ adapter: a.id, stage: 'cost', reasons: (q && q.reasons) || ['no usable pricing channel'] }); continue; }
    const block = capBlock(q.accepted_take_cost, policy, spend);
    if (block) { rejected.push({ adapter: a.id, stage: 'policy_cap', reasons: [`${block.cap} cap $${block.cap_usd} (spent $${block.spent_usd}, needs $${block.needed_usd})`] }); continue; }
    candidates.push({ adapter: a.id, family: a.family, quality: caps.quality.identity, resolution: res, cost: q });
  }
  candidates.sort((x, y) => x.cost.accepted_take_cost - y.cost.accepted_take_cost || QUALITY[y.quality] - QUALITY[x.quality] || x.adapter.localeCompare(y.adapter));
  if (!candidates.length) return deepFreeze({ status: 'no_eligible_renderer', mode: modeName, shotspec_sha256, primary: null, fallbacks: [], rejected });
  return deepFreeze({ status: 'planned', mode: modeName, shotspec_sha256, primary: candidates[0], fallbacks: candidates.slice(1), rejected });
}

// Next renderer when the chosen one fails at submit time (unavailable / refused), recorded with why.
function nextAfter(planned, failedAdapter, why) {
  const order = [planned.primary, ...planned.fallbacks].filter(Boolean);
  const i = order.findIndex((c) => c.adapter === failedAdapter);
  const next = i >= 0 ? order[i + 1] || null : null;
  return { next, failed: { adapter: failedAdapter, why } };
}

module.exports = { MODES, plan, nextAfter, hardFit };
