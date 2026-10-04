// ============================================================================
// lib/media/adapter.js  (Issue #10 Media Studio) — the ONE renderer contract
// ----------------------------------------------------------------------------
// Every renderer (Seedance, Veo, Omni Flash, Kling, HeyGen, Runway, a future
// model, or a deterministic fake in tests) exposes exactly this shape:
//
//   capabilities()                 -> what it can do (declared; probe confirms access)
//   quote(shotSpec, accountCtx)    -> effective cost for ONE accepted take (lib/media/cost.js)
//   probe(env, fetch)              -> read-only reachability for OUR account (never generates)
//   compile(shotSpec, refs)        -> the provider request (pure; provider fields live HERE only)
//   submit(compiled, opts)         -> provider job id            (live; gated)
//   poll(jobId)                    -> { state, progress }        (live)
//   fetch(jobId)                   -> { bytes, metadata }        (live)
//   cancel(jobId)                  -> optional
//
// TrustEd owns the ShotSpec, character pins, references, intent, approvals, cost
// policy and provenance. Provider/model names appear only in routing decisions,
// adapter settings and take provenance; compile() never writes back into the spec.
// ============================================================================
const QUALITY = Object.freeze({ draft: 1, standard: 2, hero: 3 });
const REQUIRED = ['capabilities', 'quote', 'probe', 'compile', 'submit', 'poll', 'fetch'];

const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };

function defineAdapter(def) {
  if (!def || !/^[a-z][a-z0-9_]{1,40}$/.test(String(def.id || ''))) throw new Error('adapter id required (a-z0-9_)');
  for (const m of REQUIRED) if (typeof def[m] !== 'function') throw new Error(`adapter ${def.id}: ${m}() is required by the renderer contract`);
  if (def.cancel != null && typeof def.cancel !== 'function') throw new Error(`adapter ${def.id}: cancel must be a function when present`);
  const caps = def.capabilities();
  for (const k of ['max_seconds', 'resolutions', 'quality']) if (caps[k] == null) throw new Error(`adapter ${def.id}: capabilities().${k} is required`);
  if (!QUALITY[caps.quality.identity]) throw new Error(`adapter ${def.id}: capabilities().quality.identity must be draft | standard | hero`);
  return Object.freeze({ cancel: null, family: def.family || def.id, ...def });
}

// A take request that is not enabled yet (no live access / no owner confirm) refuses loudly.
const notEnabled = (id) => async () => { const e = new Error(`${id}: live generation is not enabled (probe our account and get the owner's Confirm first)`); e.code = 'RENDER_NOT_ENABLED'; throw e; };

module.exports = { defineAdapter, notEnabled, deepFreeze, QUALITY, REQUIRED };
