// tests/test_ai_router.js — production model routing (Issue #12): resolution,
// overrides, fallback policy, telemetry and provenance through the routed
// client, plus the build check that keeps model ids out of production code.
// No network: the SDK's Messages methods are stubbed.
process.env.AI_TELEMETRY = 'off';
for (const k of Object.keys(process.env)) if (k.startsWith('AI_ROUTE') || ['KAT_REVIEW_MODEL', 'CLAIRE_LLM_MODEL'].includes(k)) delete process.env[k];
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Sdk = require('@anthropic-ai/sdk');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };

// ---- stub the SDK before the routed client binds to it -----------------------
const proto = Object.getPrototypeOf(new Sdk({ apiKey: 'x' }).messages);
const calls = [];
const paramsSeen = [];
let behavior = () => ({ model: 'echo' });
proto.create = function (params) {
  calls.push(params.model);
  paramsSeen.push(params);
  const r = behavior(params);
  if (r instanceof Error) return Promise.reject(r);
  if (params.stream) {
    const events = [{ type: 'message_start', message: { model: params.model, usage: { input_tokens: 10 } } }, { type: 'content_block_delta', delta: { text: 'hi' } }, { type: 'message_delta', usage: { output_tokens: 3 } }, { type: 'message_stop' }];
    return Promise.resolve({ controller: { abort() {} }, async *[Symbol.asyncIterator]() { for (const e of events) yield e; } });
  }
  return Promise.resolve({ model: params.model, usage: { input_tokens: 1000, output_tokens: 200 }, content: [{ type: 'text', text: 'ok' }], ...r });
};
proto.stream = function (params) {
  calls.push(params.model);
  const handlers = {};
  const s = { on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return s; }, finalMessage: () => Promise.resolve(final) };
  const final = { model: params.model, usage: { input_tokens: 50, output_tokens: 5 }, content: [] };
  setTimeout(() => (handlers.finalMessage || []).forEach((f) => f(final)), 5);
  return s;
};
const notFound = (m) => Object.assign(new Error(`404 model: ${m}`), { status: 404, error: { type: 'error', error: { type: 'not_found_error', message: `model: ${m}` } } });
const rateLimited = () => Object.assign(new Error('429 rate_limit'), { status: 429, error: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } });

const router = require('../lib/ai/router');
const Anthropic = require('../lib/ai/anthropic');
const records = [];
router.onCall((r) => records.push(r));
const client = new Anthropic({ apiKey: 'x' });
const last = () => records[records.length - 1];

(async () => {
  // ---- resolution -------------------------------------------------------------
  check('config validates', router.validateConfig().length === 0, JSON.stringify(router.validateConfig()));
  let r = router.resolve('drv.citation');
  check('drv.citation -> Sonnet 5 via tier:standard, high-consequence, no fallback', r.primary.id === 'claude-sonnet-5' && r.fallback === null && r.consequence === 'high' && r.prior === 'sonnet-4-5', JSON.stringify(r));
  r = router.resolve('email.draft_reply');
  check('email.draft_reply -> Sonnet 5 with logged fallback to Sonnet 4.6', r.primary.id === 'claude-sonnet-5' && r.fallback.id === 'claude-sonnet-4-6');
  check('preserved assignments: asked.chat 4.6, voice.llm Haiku, acc.vision_extract Opus 4.7',
    router.modelId('asked.chat') === 'claude-sonnet-4-6' && router.modelId('voice.llm') === 'claude-haiku-4-5-20251001' && router.modelId('acc.vision_extract') === 'claude-opus-4-7');
  let threw = null; try { router.route('no.such.workflow'); } catch (e) { threw = e.message; }
  check('an unknown workflow throws at route() time (fails at module load, not mid-request)', /unknown workflow/.test(threw || ''));
  check('route() returns a token, labelFor turns it into the model id', router.labelFor(router.route('drv.vision')) === 'claude-sonnet-5' && router.labelFor('claude-x') === 'claude-x');

  // ---- overrides / rollback ------------------------------------------------
  process.env.AI_ROUTE_OVERRIDES = JSON.stringify({ 'drv.*': 'sonnet-4-5', 'drv.vision': 'sonnet-4-6' });
  check('rollback by env JSON: prefix wildcard', router.modelId('drv.citation') === 'claude-sonnet-4-5' && router.resolve('drv.citation').source === 'env:AI_ROUTE_OVERRIDES');
  check('rollback by env JSON: exact key beats the wildcard', router.modelId('drv.vision') === 'claude-sonnet-4-6');
  process.env[router.envKey('drv.citation')] = 'sonnet-4-6';
  check('per-workflow env AI_ROUTE__DRV__CITATION beats AI_ROUTE_OVERRIDES', router.modelId('drv.citation') === 'claude-sonnet-4-6' && router.envKey('drv.citation') === 'AI_ROUTE__DRV__CITATION' && router.envKey('drv.vantaca_import') === 'AI_ROUTE__DRV__VANTACA_IMPORT');
  await router.withRouteOverrides({ 'drv.citation': 'opus-5' }, async () => {
    check('scoped override (evals / side-by-side) beats env', router.modelId('drv.citation') === 'claude-opus-5');
  });
  check('scoped override does not leak outside its scope', router.modelId('drv.citation') === 'claude-sonnet-4-6');
  delete process.env[router.envKey('drv.citation')]; delete process.env.AI_ROUTE_OVERRIDES;
  process.env.KAT_REVIEW_MODEL = 'claude-sonnet-4-5';
  check('legacy per-workflow env names still work (KAT_REVIEW_MODEL)', router.modelId('accounting.kat_review') === 'claude-sonnet-4-5' && router.resolve('accounting.kat_review').source === 'env:KAT_REVIEW_MODEL');
  delete process.env.KAT_REVIEW_MODEL;
  process.env.AI_ROUTE_OVERRIDES = '{not json';
  check('a malformed override is ignored (config wins), never crashes', router.modelId('drv.citation') === 'claude-sonnet-5');
  delete process.env.AI_ROUTE_OVERRIDES;
  threw = null; process.env.AI_ROUTE__DRV__CITATION = 'gpt-nonsense'; try { router.resolve('drv.citation'); } catch (e) { threw = e.message; } delete process.env.AI_ROUTE__DRV__CITATION;
  check('an override naming an unknown model fails loudly', /unknown model reference/.test(threw || ''));

  // ---- routed client: normal call -----------------------------------------
  calls.length = 0; behavior = () => ({});
  let resp = await client.messages.create({ model: router.route('ap.invoice_extract'), max_tokens: 4000, messages: [{ role: 'user', content: 'x' }] });
  check('the SDK receives the resolved model id, everything else untouched', calls[0] === 'claude-sonnet-5' && resp.content[0].text === 'ok');
  let rec = last();
  check('telemetry: workflow, provider, requested + executed model, tokens, latency, ok, cost',
    rec.workflow === 'ap.invoice_extract' && rec.provider === 'anthropic' && rec.requested_model === 'claude-sonnet-5' && rec.executed_model === 'claude-sonnet-5' && rec.ok === true
    && rec.input_tokens === 1000 && rec.output_tokens === 200 && typeof rec.latency_ms === 'number' && rec.cost_usd === 0.004 && !rec.fallback_used && rec.route_source === 'config', JSON.stringify(rec));
  check('provenance: executedModel(resp) is the model that ran', router.executedModel(resp, 'ap.invoice_extract') === 'claude-sonnet-5' && router.executedModel(null, 'asked.chat') === 'claude-sonnet-4-6');

  // ---- request defaults: Sonnet 5 thinks adaptively; keep the 4.5 response shape ----
  paramsSeen.length = 0; behavior = () => ({});
  await client.messages.create({ model: router.route('drv.citation'), max_tokens: 800, messages: [] });
  await client.messages.create({ model: router.route('drv.citation'), max_tokens: 8000, thinking: { type: 'enabled', budget_tokens: 4000 }, messages: [] });
  await client.messages.create({ model: router.route('asked.chat'), max_tokens: 800, messages: [] });
  check('Sonnet 5 calls get thinking disabled by default (text stays content[0], like 4.5)', paramsSeen[0].thinking && paramsSeen[0].thinking.type === 'disabled' && paramsSeen[0].max_tokens === 800);
  check('a caller that asks for thinking keeps it', paramsSeen[1].thinking.type === 'enabled' && paramsSeen[1].thinking.budget_tokens === 4000);
  check('models without request defaults get no extra parameters (Sonnet 4.6 unchanged)', !('thinking' in paramsSeen[2]) && Object.keys(paramsSeen[2]).sort().join(',') === 'max_tokens,messages,model');

  // ---- fallback policy -----------------------------------------------------
  calls.length = 0; records.length = 0;
  behavior = (p) => (p.model === 'claude-sonnet-5' ? notFound(p.model) : {});
  resp = await client.messages.create({ model: router.route('email.draft_reply'), max_tokens: 100, messages: [] });
  check('standard workflow: primary unavailable -> ONE retry on the configured fallback', calls.join(',') === 'claude-sonnet-5,claude-sonnet-4-6' && resp.model === 'claude-sonnet-4-6');
  check('the fallback is never silent: the failed primary AND the fallback are both recorded, with the reason',
    records.length === 2 && records[0].ok === false && /not_found_error/.test(records[0].error) && records[1].ok === true && records[1].fallback_used === true && /primary claude-sonnet-5 unavailable/.test(records[1].fallback_reason) && records[1].executed_model === 'claude-sonnet-4-6', JSON.stringify(records));
  check('provenance after a fallback records the model that actually ran', router.executedModel(resp, 'email.draft_reply') === 'claude-sonnet-4-6');

  calls.length = 0; records.length = 0; let err = null;
  try { await client.messages.create({ model: router.route('drv.citation'), max_tokens: 100, messages: [] }); } catch (e) { err = e; }
  check('high-consequence workflow: primary unavailable -> fails loudly, never switches models', err && err.status === 404 && calls.length === 1 && records.length === 1 && records[0].ok === false && /high-consequence/.test(records[0].error), JSON.stringify(records));

  calls.length = 0; records.length = 0; err = null; behavior = () => rateLimited();
  try { await client.messages.create({ model: router.route('email.draft_reply'), max_tokens: 100, messages: [] }); } catch (e) { err = e; }
  check('a rate limit is NOT a fallback trigger (caller retry semantics preserved)', err && err.status === 429 && calls.length === 1 && records[0].ok === false);

  calls.length = 0; records.length = 0; err = null; behavior = () => notFound('x');
  try { await client.messages.create({ model: router.route('email.draft_reply'), max_tokens: 100, messages: [] }); } catch (e) { err = e; }
  check('if the fallback is ALSO unavailable, the error surfaces and both failures are recorded', err && calls.length === 2 && records.length === 2 && records.every((x) => !x.ok) && records[1].fallback_used === true);

  // ---- streams ---------------------------------------------------------------
  behavior = () => ({}); calls.length = 0; records.length = 0;
  const s = client.messages.stream({ model: router.route('drv.vantaca_import'), max_tokens: 32000, messages: [] });
  const fm = await s.finalMessage();
  await new Promise((res) => setTimeout(res, 20));
  check('messages.stream: resolved model, stream returned as-is, telemetry on completion', calls[0] === 'claude-sonnet-5' && fm.model === 'claude-sonnet-5' && records.length === 1 && records[0].ok && records[0].output_tokens === 5);

  calls.length = 0; records.length = 0;
  const raw = await client.messages.create({ model: router.route('asked.chat'), stream: true, max_tokens: 100, messages: [] });
  const seen = []; for await (const ev of raw) seen.push(ev.type);
  check('create({stream:true}): events pass through unchanged and unbuffered', seen.join(',') === 'message_start,content_block_delta,message_delta,message_stop' && typeof raw.controller.abort === 'function');
  check('create({stream:true}): telemetry records the executed model and usage from the stream', records.length === 1 && records[0].executed_model === 'claude-sonnet-4-6' && records[0].input_tokens === 10 && records[0].output_tokens === 3, JSON.stringify(records));

  // ---- unrouted literal (should never exist in production) ------------------
  records.length = 0;
  await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 5, messages: [] });
  check('an unrouted literal still runs but is recorded as workflow "unrouted"', records[0].workflow === 'unrouted' && records[0].requested_model === 'claude-sonnet-4-6');

  // ---- the build check catches a deliberately introduced hard-coded id -------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-ids-'));
  fs.mkdirSync(path.join(tmp, 'lib', 'ai'), { recursive: true }); fs.mkdirSync(path.join(tmp, 'api'));
  fs.copyFileSync(path.join(__dirname, '..', 'lib', 'ai', 'routing.config.json'), path.join(tmp, 'lib', 'ai', 'routing.config.json'));
  const runCheck = () => { try { execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'check_model_ids.js'), tmp], { stdio: 'pipe' }); return { code: 0, out: '' }; } catch (e) { return { code: e.status, out: String(e.stderr) }; } };
  fs.writeFileSync(path.join(tmp, 'api', 'ok.js'), "const { route: aiRoute } = require('../lib/ai/router');\nconst m = aiRoute('drv.citation');\n");
  check('build check: clean routed code passes', runCheck().code === 0);
  fs.writeFileSync(path.join(tmp, 'api', 'bad.js'), "client.messages.create({ model: 'claude-sonnet-5', max_tokens: 10 });\n");
  let res = runCheck();
  check('build check: a deliberately hard-coded model id FAILS the build', res.code === 1 && /hard-coded model id/.test(res.out) && /api\/bad\.js:1/.test(res.out), res.out);
  fs.writeFileSync(path.join(tmp, 'api', 'bad.js'), "const Anthropic = require('@anthropic-ai/sdk');\n");
  res = runCheck();
  check('build check: a raw SDK client (no routing, no telemetry) FAILS the build', res.code === 1 && /raw @anthropic-ai\/sdk/.test(res.out));
  fs.writeFileSync(path.join(tmp, 'api', 'bad.js'), "const { route: aiRoute } = require('../lib/ai/router');\naiRoute('drv.typo');\n");
  res = runCheck();
  check('build check: an unknown workflow key FAILS the build', res.code === 1 && /unknown workflow 'drv.typo'/.test(res.out));
  fs.writeFileSync(path.join(tmp, 'api', 'bad.js'), "// claude-sonnet-4-5 is retired  model-id-ok: historical note\n");
  check('build check: an explicitly annotated line is allowed', runCheck().code === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
