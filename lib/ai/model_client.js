// lib/ai/model_client.js — the ONLY module that knows a provider's SDK/response
// shape (requirement: provider independence — nothing downstream depends on
// Anthropic- or OpenAI-specific structures). Promoted and hardened from the eval
// harness: retries on transient failure, latency, normalized usage, empty-output
// => ERROR (never silently a valid answer), and per-call instrumentation.
//
// callModel({ provider, model, system, prompt, maxTokens, thinking, price, kind })
//   -> { ok:true, text, usage:{input,output,cache_read,cache_write}, latency_ms, provider, model }
//   -> { ok:false, error, provider, model, latency_ms }
const Anthropic = require('@anthropic-ai/sdk');
let OpenAI = null; try { OpenAI = require('openai'); } catch (_) {}
const usage = require('./usage');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = (OpenAI && process.env.OPENAI_API_KEY) ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

async function _anthropic({ model, system, prompt, maxTokens, thinking }) {
  const resp = await anthropic.messages.create({
    model, max_tokens: maxTokens || 2048,
    ...(system ? { system } : {}), ...(thinking ? { thinking } : {}),
    messages: [{ role: 'user', content: prompt }],
  });
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const u = resp.usage || {};
  const finished = resp.stop_reason;
  return { text, finished, usage: { input: u.input_tokens || 0, output: u.output_tokens || 0, cache_read: u.cache_read_input_tokens || 0, cache_write: u.cache_creation_input_tokens || 0 } };
}

async function _openai({ model, system, prompt, maxTokens }) {
  if (!openai) throw new Error('OPENAI_API_KEY not set / openai SDK missing');
  const base = { model, messages: [] };
  if (system) base.messages.push({ role: 'system', content: system });
  base.messages.push({ role: 'user', content: prompt });
  const want = { ...base, max_completion_tokens: maxTokens || 2048, reasoning_effort: 'low' };
  let resp;
  try { resp = await openai.chat.completions.create(want); }
  catch (e) {
    const m = e.message || '';
    if (/reasoning_effort|unsupported|unknown|not supported/i.test(m)) {
      const { reasoning_effort, ...noEffort } = want;
      resp = await openai.chat.completions.create(noEffort).catch(() => openai.chat.completions.create({ ...base, max_tokens: maxTokens || 2048 }));
    } else if (/max_completion_tokens/i.test(m)) {
      resp = await openai.chat.completions.create({ ...base, max_tokens: maxTokens || 2048 });
    } else throw e;
  }
  const ch = resp.choices && resp.choices[0];
  const text = (ch && ch.message && ch.message.content || '').trim();
  const u = resp.usage || {};
  return { text, finished: ch && ch.finish_reason, usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cache_read: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0, cache_write: 0 } };
}

function _transient(msg) { return /timeout|ETIMEDOUT|ECONNRESET|rate.?limit|429|5\d\d|overloaded/i.test(msg || ''); }

async function callModel(opts) {
  const { provider, model, price, kind } = opts;
  const t0 = Date.now();
  const fn = provider === 'openai' ? _openai : _anthropic;
  let retries = 0, lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fn(opts);
      // Empty output is a FAILED generation (reasoning ate the budget / truncation),
      // NEVER a valid answer — surface it as an error so it can't reach EXECUTE.
      if (!r.text) throw new Error(`empty output (finish=${r.finished || '?'}; raise maxTokens or lower reasoning)`);
      usage.record({ kind: kind || 'primary', provider, model, usage: r.usage, price, latency_ms: Date.now() - t0, retries });
      return { ok: true, text: r.text, usage: r.usage, latency_ms: Date.now() - t0, provider, model, retries };
    } catch (err) {
      lastErr = err.message || String(err);
      if (attempt === 0 && _transient(lastErr)) { retries++; continue; }
      break;
    }
  }
  usage.record({ kind: kind || 'primary', provider, model, latency_ms: Date.now() - t0, retries, error: lastErr });
  return { ok: false, error: lastErr, provider, model, latency_ms: Date.now() - t0, retries };
}

module.exports = { callModel };
