// evals/lib/model_client.js
// ---------------------------------------------------------------------------
// The FIRST provider-agnostic model caller in trustEd. Today every caller in the
// app hits anthropic.messages.create inline (see api/vendors.js:868) and OpenAI
// is used only for embeddings/images/voice — there is no text-gen router. We
// prove the abstraction here, in the eval harness, before promoting it into
// production (lib/ai/). One function, one shape, any provider+model.
//
// callModel({ provider, model, system, prompt, maxTokens }) resolves to:
//   { text, usage: { input, output, cache_read, cache_write }, latency_ms, raw }
// It NEVER throws for a model-level failure — it returns { error } so one bad
// model can't sink a whole eval run.
// ---------------------------------------------------------------------------
const Anthropic = require('@anthropic-ai/sdk');
let OpenAI = null; try { OpenAI = require('openai'); } catch (_) { /* only needed if an openai model is enabled */ }

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = OpenAI && process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

async function _anthropic({ model, system, prompt, maxTokens, thinking }) {
  const resp = await anthropic.messages.create({
    model,
    max_tokens: maxTokens || 2048,
    ...(system ? { system } : {}),
    // Adaptive-thinking models can spend the whole max_tokens budget thinking and
    // return an empty text block. Callers that want a guaranteed text answer in a
    // modest budget (e.g. the cross-check verifier) pass thinking:{type:'disabled'}.
    ...(thinking ? { thinking } : {}),
    messages: [{ role: 'user', content: prompt }],
  });
  // Extract TEXT blocks only — adaptive-thinking models can lead with a thinking
  // block, so content[0] is not reliably the answer.
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const u = resp.usage || {};
  return {
    text,
    usage: {
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cache_read: u.cache_read_input_tokens || 0,
      cache_write: u.cache_creation_input_tokens || 0,
    },
    raw: resp,
  };
}

async function _openai({ model, system, prompt, maxTokens }) {
  if (!openai) throw new Error('OPENAI_API_KEY not set (or openai SDK missing) — cannot run an OpenAI model.');
  // chat.completions is the portable text surface. Newer OpenAI models renamed
  // max_tokens -> max_completion_tokens; try the modern field, fall back once.
  const base = { model, messages: [] };
  if (system) base.messages.push({ role: 'system', content: system });
  base.messages.push({ role: 'user', content: prompt });
  // reasoning_effort: 'low' keeps reasoning models from spending the whole
  // completion budget thinking and returning empty text (gpt-terra did exactly
  // that on the long CLMA case). Fall back gracefully if the field/param is rejected.
  const want = { ...base, max_completion_tokens: maxTokens || 2048, reasoning_effort: 'low' };
  let resp;
  try {
    resp = await openai.chat.completions.create(want);
  } catch (e) {
    const msg = e.message || '';
    if (/reasoning_effort|unsupported|unknown|not supported/i.test(msg)) {
      const { reasoning_effort, ...noEffort } = want;
      try { resp = await openai.chat.completions.create(noEffort); }
      catch (e2) {
        if (/max_completion_tokens/i.test(e2.message || '')) resp = await openai.chat.completions.create({ ...base, max_tokens: maxTokens || 2048 });
        else throw e2;
      }
    } else if (/max_completion_tokens/i.test(msg)) {
      resp = await openai.chat.completions.create({ ...base, max_tokens: maxTokens || 2048, reasoning_effort: 'low' }).catch(() => openai.chat.completions.create({ ...base, max_tokens: maxTokens || 2048 }));
    } else { throw e; }
  }
  const fin = resp.choices && resp.choices[0] && resp.choices[0].finish_reason;
  const text = (resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content || '').trim();
  if (!text && fin === 'length') throw new Error('empty output: hit the token cap during reasoning (raise maxTokens or lower reasoning)');
  const u = resp.usage || {};
  return {
    text,
    usage: {
      input: u.prompt_tokens || 0,
      output: u.completion_tokens || 0,
      cache_read: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0,
      cache_write: 0,
    },
    raw: resp,
  };
}

async function callModel({ provider, model, system, prompt, maxTokens, thinking }) {
  const t0 = Date.now();
  try {
    const fn = provider === 'openai' ? _openai : _anthropic;
    const r = await fn({ model, system, prompt, maxTokens, thinking });
    return { ...r, latency_ms: Date.now() - t0 };
  } catch (err) {
    return { error: err.message || String(err), latency_ms: Date.now() - t0 };
  }
}

module.exports = { callModel };
