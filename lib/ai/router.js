// ============================================================================
// lib/ai/router.js  (Issue #12): production model routing + telemetry
// ----------------------------------------------------------------------------
// The ONE place production code learns which model a workflow uses.
//
//   const { route } = require('../lib/ai/router');
//   client.messages.create({ model: route('drv.citation'), ... })
//
// route() returns a routing token; the routed client (lib/ai/anthropic.js)
// resolves it at call time, so overrides take effect without code edits:
//   - routing.config.json   (the policy: workflow -> model alias / tier)
//   - AI_ROUTE_OVERRIDES    env JSON, e.g. {"drv.citation":"sonnet-4-6","email.*":"sonnet-4-6"}
//   - AI_ROUTE__DRV__CITATION=sonnet-4-6   (per workflow; '.' -> '__')
//   - legacy per-workflow env names (KAT_REVIEW_MODEL, CLAIRE_LLM_MODEL, ...)
//   - withRouteOverrides({...}, fn)   scoped override for evals / side-by-side
// Precedence: scoped > AI_ROUTE__X > AI_ROUTE_OVERRIDES (exact > longest
// prefix*) > legacy env > config.
//
// Every call is recorded (recordCall) to agent_runs as a run_kind='model_call'
// row: workflow, provider, requested + executed model, fallback, tokens,
// latency, outcome, estimated cost. Failures to record never break a call.
// ============================================================================
const { AsyncLocalStorage } = require('async_hooks');
const cfg = require('./routing.config.json');
const tiers = require('./tiers');

const TOKEN_PREFIX = 'route:';
const scope = new AsyncLocalStorage();

function aliasToModel(ref, where) {
  if (!ref) return null;
  if (ref.startsWith('tier:')) {
    const t = tiers.tier(ref.slice(5));
    // A tier names a concrete model; the registry entry for that id carries its request_defaults.
    const reg = Object.values(cfg.models).find((v) => v.id === t.model) || {};
    return { ...reg, alias: ref, provider: t.provider, id: t.model, price_in: t.price_in ?? reg.price_in ?? null, price_out: t.price_out ?? reg.price_out ?? null, price_verified: !t.price_unverified && !!reg.price_verified };
  }
  const m = cfg.models[ref];
  if (m) return { alias: ref, ...m };
  // An emergency override may name a raw Anthropic model id directly.
  if (/^claude-[a-z0-9.-]+$/.test(ref)) {
    const known = Object.entries(cfg.models).find(([, v]) => v.id === ref);
    return known ? { alias: known[0], ...known[1] } : { alias: ref, provider: 'anthropic', id: ref, price_in: null, price_out: null, price_verified: false };
  }
  throw new Error(`ai router: unknown model reference '${ref}'${where ? ' in ' + where : ''}`);
}

// drv.vantaca_import -> AI_ROUTE__DRV__VANTACA_IMPORT ('.' becomes '__', '_' stays).
function envKey(workflow) { return 'AI_ROUTE__' + workflow.toUpperCase().split('.').map((s) => s.replace(/[^A-Z0-9_]/g, '_')).join('__'); }

let _parsedOverrides = null, _parsedFrom = null;
function envOverrides() {
  const raw = process.env.AI_ROUTE_OVERRIDES || '';
  if (raw !== _parsedFrom) {
    _parsedFrom = raw;
    try { _parsedOverrides = raw ? JSON.parse(raw) : {}; }
    catch (e) { console.error('[ai.router] AI_ROUTE_OVERRIDES is not valid JSON; ignored:', e.message); _parsedOverrides = {}; }
  }
  return _parsedOverrides;
}

function matchOverride(map, workflow) {
  if (!map) return null;
  if (map[workflow]) return map[workflow];
  let best = null, bestLen = -1;
  for (const k of Object.keys(map)) {
    if (k.endsWith('*') && workflow.startsWith(k.slice(0, -1)) && k.length > bestLen) { best = map[k]; bestLen = k.length; }
  }
  return best;
}

function workflowConfig(workflow) {
  const w = cfg.workflows[workflow];
  if (!w) throw new Error(`ai router: unknown workflow '${workflow}' (add it to lib/ai/routing.config.json)`);
  return w;
}

// Resolve a workflow to { workflow, primary, fallback, consequence, source }.
function resolve(workflow) {
  const w = workflowConfig(workflow);
  let ref = w.model, source = 'config';
  if (w.legacy_env && process.env[w.legacy_env]) { ref = process.env[w.legacy_env]; source = 'env:' + w.legacy_env; }
  const o = matchOverride(envOverrides(), workflow);
  if (o) { ref = o; source = 'env:AI_ROUTE_OVERRIDES'; }
  if (process.env[envKey(workflow)]) { ref = process.env[envKey(workflow)]; source = 'env:' + envKey(workflow); }
  const s = matchOverride(scope.getStore(), workflow);
  if (s) { ref = s; source = 'scoped'; }
  const primary = aliasToModel(ref, workflow);
  // High-consequence workflows never fall back automatically (Ed, Issue #12):
  // an unavailable primary fails loudly instead of silently changing models.
  const fallback = w.consequence === 'high' ? null : aliasToModel(w.fallback, workflow + '.fallback');
  return { workflow, primary, fallback: fallback && fallback.id !== primary.id ? fallback : null, consequence: w.consequence, prior: w.prior || null, source, request_defaults: w.request_defaults || null };
}

function route(workflow) { workflowConfig(workflow); return TOKEN_PREFIX + workflow; }
function isRouteToken(v) { return typeof v === 'string' && v.startsWith(TOKEN_PREFIX); }
function workflowOf(token) { return isRouteToken(token) ? token.slice(TOKEN_PREFIX.length) : null; }
// The concrete model id a workflow resolves to right now (for UI metadata only;
// provenance must use the EXECUTED model from the response).
function modelId(workflow) { return resolve(workflow).primary.id; }

// Request parameters for a model: model defaults, then workflow defaults, then
// whatever the caller set (caller always wins). Never touches prompts/tools.
function requestParams(params, model, workflowDefaults) {
  const out = { ...params, model: model.id };
  for (const defs of [model.request_defaults, workflowDefaults]) {
    if (!defs) continue;
    for (const [k, v] of Object.entries(defs)) if (params[k] === undefined && (defs === workflowDefaults || out[k] === undefined || out[k] === (model.request_defaults || {})[k])) out[k] = v;
  }
  return out;
}

// Provenance: the model that ACTUALLY executed (the API echoes it on every
// response). Falls back to what the workflow resolves to only when no response
// is in hand (e.g. a save of data extracted in an earlier request that did not
// carry the model through).
function executedModel(resp, workflow) {
  if (resp && typeof resp.model === 'string' && resp.model) return resp.model;
  return workflow ? modelId(workflow) : null;
}

// Human/log label for a model value that may be a routing token.
function labelFor(v) { return isRouteToken(v) ? modelId(workflowOf(v)) : v; }

function withRouteOverrides(map, fn) { return scope.run({ ...(scope.getStore() || {}), ...map }, fn); }

// A retired / unknown model: 404 not_found_error whose message names the model.
function isModelUnavailable(err) {
  if (!err) return false;
  const status = err.status;
  const type = err.error && err.error.error && err.error.error.type;
  const msg = (err.error && err.error.error && err.error.error.message) || err.message || '';
  return status === 404 && type === 'not_found_error' && /model/i.test(msg);
}

function estimateCost(model, usage) {
  if (!usage || model.price_in == null || model.price_out == null) return null;
  const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1;
  return Math.round(((inTok * model.price_in + (usage.output_tokens || 0) * model.price_out) / 1e6) * 1e6) / 1e6;
}

// ---- telemetry -------------------------------------------------------------
let _sb = null, _sbDisabled = false, _sbRetryAt = 0;
const TELEMETRY_RETRY_MS = 10 * 60 * 1000;
function telemetryClient() {
  if (_sbRetryAt && Date.now() >= _sbRetryAt) _sbRetryAt = 0; // retry after a schema-not-ready pause
  if (_sbDisabled || _sbRetryAt) return null;
  if (_sb) return _sb;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY || process.env.AI_TELEMETRY === 'off') { _sbDisabled = true; return null; }
  _sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  return _sb;
}
const _sinks = []; // test hook
function onCall(fn) { _sinks.push(fn); return () => _sinks.splice(_sinks.indexOf(fn), 1); }

function recordCall(rec) {
  for (const s of _sinks) { try { s(rec); } catch (_) {} }
  const line = `[ai] ${rec.workflow} ${rec.ok ? 'ok' : 'ERR'} req=${rec.requested_model} exec=${rec.executed_model || '-'}${rec.fallback_used ? ' FALLBACK(' + rec.fallback_reason + ')' : ''} ${rec.latency_ms}ms in=${rec.input_tokens ?? '-'} out=${rec.output_tokens ?? '-'}${rec.error ? ' err=' + String(rec.error).slice(0, 160) : ''}`;
  if (!rec.ok || rec.fallback_used) console.warn(line); else if (process.env.AI_TELEMETRY_VERBOSE) console.log(line);
  const sb = telemetryClient();
  if (!sb) return;
  let mgmt = null;
  try { mgmt = require('../company').BEDROCK_MGMT_CO_ID; } catch (_) {}
  sb.from('agent_runs').insert({
    management_company_id: mgmt, module: rec.workflow.split('.')[0], endpoint: rec.workflow,
    run_kind: 'model_call', workflow: rec.workflow, provider: rec.provider,
    requested_model: rec.requested_model, model: rec.executed_model || null,
    fallback_used: !!rec.fallback_used, fallback_reason: rec.fallback_reason || null,
    route_source: rec.route_source || null, ok: rec.ok,
    input_tokens: rec.input_tokens ?? null, output_tokens: rec.output_tokens ?? null,
    cache_read_tokens: rec.cache_read_tokens ?? null, cache_write_tokens: rec.cache_write_tokens ?? null,
    cost_usd: rec.cost_usd ?? null, duration_ms: rec.latency_ms ?? null,
    error: rec.error ? String(rec.error).slice(0, 2000) : null, prompt_version: cfg.policy_version,
  }).then(({ error }) => {
    if (error && /column|relation|schema cache/i.test(error.message || '')) {
      if (!_sbRetryAt) console.warn('[ai.router] telemetry table not ready (apply migration 476); console only, retrying in 10 min:', error.message);
      _sbRetryAt = Date.now() + TELEMETRY_RETRY_MS;
    } else if (error) console.warn('[ai.router] telemetry insert failed:', error.message);
  }, (e) => console.warn('[ai.router] telemetry insert threw:', e.message));
}

function validateConfig() {
  const problems = [];
  for (const [wf, w] of Object.entries(cfg.workflows)) {
    try { aliasToModel(w.model, wf); } catch (e) { problems.push(e.message); }
    if (w.fallback) { try { aliasToModel(w.fallback, wf); } catch (e) { problems.push(e.message); } }
    if (!['high', 'standard'].includes(w.consequence)) problems.push(`${wf}: consequence must be high|standard`);
    if (w.consequence === 'high' && w.fallback) problems.push(`${wf}: high-consequence workflows must not configure a fallback`);
    if (w.prior && !cfg.models[w.prior]) problems.push(`${wf}: prior '${w.prior}' is not a known model alias`);
  }
  for (const [a, m] of Object.entries(cfg.models)) if (m.provider !== 'anthropic') problems.push(`${a}: provider '${m.provider}' has no production adapter yet`);
  return problems;
}

module.exports = {
  route, resolve, modelId, executedModel, labelFor, requestParams, isRouteToken, workflowOf, withRouteOverrides, isModelUnavailable,
  estimateCost, recordCall, onCall, validateConfig, envKey, policyVersion: () => cfg.policy_version,
  workflows: () => Object.keys(cfg.workflows),
};
