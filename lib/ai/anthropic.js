// ============================================================================
// lib/ai/anthropic.js  (Issue #12): the routed Anthropic client
// ----------------------------------------------------------------------------
// Drop-in for require('@anthropic-ai/sdk'): same class, same methods, same
// return shapes. messages.create / messages.stream accept model:
// route('<workflow>') and this client:
//   1. resolves the workflow to its configured model (lib/ai/router.js);
//   2. on a retired / unknown model (404 not_found_error) retries ONCE on the
//      configured fallback, but only for standard-consequence workflows, and
//      records the fallback; high-consequence workflows fail loudly instead;
//   3. records every call (requested + executed model, tokens, latency,
//      outcome, estimated cost) to the agent_runs telemetry.
// Everything else (max_tokens, tools, prompts, retries the caller does) is
// passed through untouched. Streams are returned as-is, with telemetry hooked
// on completion; streams never fall back (all streaming callers are
// high-consequence or user-facing chat that already surfaces errors).
// ============================================================================
const Sdk = require('@anthropic-ai/sdk');
const router = require('./router');

function usageFields(usage) {
  if (!usage) return {};
  return {
    input_tokens: usage.input_tokens ?? null, output_tokens: usage.output_tokens ?? null,
    cache_read_tokens: usage.cache_read_input_tokens ?? null, cache_write_tokens: usage.cache_creation_input_tokens ?? null,
  };
}

function errText(e) {
  const inner = e && e.error && e.error.error;
  return inner ? `${e.status} ${inner.type}: ${inner.message}` : String((e && e.message) || e);
}

function plan(params) {
  const wf = router.workflowOf(params && params.model);
  if (wf) return router.resolve(wf);
  // Unrouted literal (should not exist in production; scripts/check_model_ids.js
  // fails the build on one). Run it as asked, but record it as 'unrouted'.
  return { workflow: 'unrouted', primary: { alias: params && params.model, provider: 'anthropic', id: params && params.model, price_in: null, price_out: null }, fallback: null, consequence: 'high', source: 'literal' };
}

function base(p, model, extra) {
  return { workflow: p.workflow, provider: model.provider, requested_model: p.primary.id, route_source: p.source, ...extra };
}

class TrustedAnthropic extends Sdk {
  constructor(opts) {
    super(opts);
    // Wrap on a SEPARATE object that inherits from the SDK's Messages instance.
    // The SDK's own helpers (messages.stream -> create(...).withResponse())
    // must keep calling the raw methods, so the instance itself is untouched.
    const raw = this.messages;
    if (!raw) return;
    const messages = Object.create(raw);
    this.messages = messages;
    const rawCreate = typeof raw.create === 'function' ? raw.create.bind(raw) : null;
    const rawStream = typeof raw.stream === 'function' ? raw.stream.bind(raw) : null;

    if (rawCreate) messages.create = (params, options) => {
      const p = plan(params);
      const t0 = Date.now();
      const attempt = (model, fallbackInfo) => {
        const req = rawCreate(router.requestParams(params, model, p.request_defaults), options);
        if (params && params.stream) return req.then((s) => wrapRawStream(s, p, model, t0, fallbackInfo));
        return req.then((resp) => {
          router.recordCall(base(p, model, { executed_model: resp.model || model.id, ok: true, latency_ms: Date.now() - t0, ...usageFields(resp.usage), cost_usd: router.estimateCost(model, resp.usage), ...fallbackInfo }));
          return resp;
        });
      };
      return attempt(p.primary, {}).catch((err) => {
        if (router.isModelUnavailable(err) && p.fallback) {
          router.recordCall(base(p, p.primary, { executed_model: null, ok: false, latency_ms: Date.now() - t0, error: errText(err) }));
          const info = { fallback_used: true, fallback_reason: `primary ${p.primary.id} unavailable: ${errText(err)}`.slice(0, 500) };
          return attempt(p.fallback, info).catch((err2) => {
            router.recordCall(base(p, p.fallback, { executed_model: null, ok: false, latency_ms: Date.now() - t0, error: errText(err2), ...info }));
            throw err2;
          });
        }
        router.recordCall(base(p, p.primary, { executed_model: null, ok: false, latency_ms: Date.now() - t0, error: (router.isModelUnavailable(err) ? `primary model unavailable and ${p.consequence === 'high' ? 'workflow is high-consequence (no automatic fallback)' : 'no fallback configured'}: ` : '') + errText(err) }));
        throw err;
      });
    };

    if (rawStream) messages.stream = (params, options) => {
      const p = plan(params);
      const t0 = Date.now();
      const s = rawStream(router.requestParams(params, p.primary, p.request_defaults), options);
      let done = false;
      s.on('finalMessage', (m) => {
        if (done) return; done = true;
        router.recordCall(base(p, p.primary, { executed_model: (m && m.model) || p.primary.id, ok: true, latency_ms: Date.now() - t0, ...usageFields(m && m.usage), cost_usd: router.estimateCost(p.primary, m && m.usage) }));
      });
      s.on('error', (e) => {
        if (done) return; done = true;
        router.recordCall(base(p, p.primary, { executed_model: null, ok: false, latency_ms: Date.now() - t0, error: errText(e) }));
      });
      return s;
    };
  }
}

// create({stream:true}) returns an async-iterable Stream. Observe it without
// buffering: message_start carries the executed model, message_delta the usage.
function wrapRawStream(stream, p, model, t0, fallbackInfo) {
  const iterate = stream[Symbol.asyncIterator].bind(stream);
  let executed = null; const usage = {}; let recorded = false;
  const finish = (ok, err) => {
    if (recorded) return; recorded = true;
    router.recordCall(base(p, model, { executed_model: ok ? (executed || model.id) : null, ok, latency_ms: Date.now() - t0, ...usageFields(usage), cost_usd: ok ? router.estimateCost(model, usage) : null, error: err ? errText(err) : undefined, ...fallbackInfo }));
  };
  return new Proxy(stream, {
    get(target, prop, receiver) {
      if (prop === Symbol.asyncIterator) {
        return function () {
          const it = iterate();
          return {
            async next(...a) {
              try {
                const r = await it.next(...a);
                if (!r.done && r.value) {
                  const ev = r.value;
                  if (ev.type === 'message_start' && ev.message) { executed = ev.message.model; Object.assign(usage, ev.message.usage || {}); }
                  if (ev.type === 'message_delta' && ev.usage) Object.assign(usage, ev.usage);
                }
                if (r.done) finish(true);
                return r;
              } catch (e) { finish(false, e); throw e; }
            },
            async return(v) { finish(true); return it.return ? it.return(v) : { done: true, value: v }; },
            async throw(e) { finish(false, e); return it.throw ? it.throw(e) : Promise.reject(e); },
            [Symbol.asyncIterator]() { return this; },
          };
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

module.exports = TrustedAnthropic;
module.exports.default = TrustedAnthropic;
module.exports.TrustedAnthropic = TrustedAnthropic;
module.exports.route = router.route;
