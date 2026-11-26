// tests/test_amanda_conversation.js — Talk to Amanda, stage 1 (Ed 2026-11-26).
//   * Amanda's spoken prompt comes from the canon (roster + approved persona), never approves,
//     and has no dashes; history conversion, spoken-text hygiene and clause release are exact
//   * a turn streams text, runs tools through the loop, stops on barge-in, records the transcript
//   * every model call inside a conversation is attributed to it (agent_runs)
//   * the brain endpoint token is bound, signed and expires; the agent config keeps the brain ours
//   * the voice channel can authorize NOTHING (policy invariant), and instructions go through the
//     Amanda request contract on the 'voice' channel
//   * measurements roll up from the provider record, the brain and the browser
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:1';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-service-key';
process.env.AI_TELEMETRY = 'off';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../lib/amanda/conversation');
const V = require('../lib/amanda/voice_elevenlabs');
const router = require('../lib/ai/router');
const AZ = require('../lib/authorization');
const API = require('../api/amanda_voice')._test;
const ROOT = path.join(__dirname, '..');
const tests = []; const check = (n, fn) => tests.push([n, fn]);
const DASH = /[—–]/;

check('spoken prompt: canon identity, never approves, honest AI, no dashes', () => {
  const p = C.systemPrompt({ ownerName: 'Ed', channel: 'voice' });
  assert.ok(/Amanda Albright/.test(p) && /Senior Community Manager/.test(p), 'roster identity');
  assert.ok(/calm, mature, confident/.test(p), 'approved persona.v1 temperament');
  assert.ok(/Bedrock's AI/.test(p) && /that she is a human/.test(p), 'honest AI');
  assert.ok(/never approve, post, pay, release, send/.test(p) && /conversation is never an approval/.test(p), 'no authority from conversation');
  assert.ok(/start_work/.test(p) && /remember/.test(p), 'work and memory go through tools');
  assert.ok(!DASH.test(p), 'no em or en dashes');
  assert.ok(!/personality_v2|humor/i.test(p), 'the pending (unapproved) personality v2 is not used');
});

check('history: OpenAI format to Anthropic, merges roles, starts and ends with the user', () => {
  const out = C.toAnthropicMessages([{ role: 'system', content: 'x' }, { role: 'assistant', content: 'Hi Ed' }, { role: 'user', content: 'hello' }, { role: 'user', content: [{ type: 'text', text: 'are you there' }] }]);
  assert.strictEqual(out[0].role, 'user');
  assert.strictEqual(out[1].role, 'assistant');
  assert.deepStrictEqual(out[2], { role: 'user', content: 'hello\nare you there' });
  const tail = C.toAnthropicMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
  assert.strictEqual(tail[tail.length - 1].role, 'user');
});

check('spoken hygiene: dashes, markdown and claims of actions never reach the voice', () => {
  assert.strictEqual(C.cleanSpoken('Kat has it — due Friday.'), 'Kat has it, due Friday.');
  assert.strictEqual(C.cleanSpoken('**Two** items.'), 'Two items.');
  assert.strictEqual(C.cleanSpoken('I approved the invoice. Emma has the rest.').trim(), 'Emma has the rest.');
  assert.strictEqual(C.cleanSpoken('I\'ve sent it to the board.').trim(), '');
  assert.ok(/Kat posted the entry/.test(C.cleanSpoken('Kat posted the entry.')), 'a teammate\'s recorded action is not a claim');
});

check('clause release: sentences go out as soon as they end, long clauses at a comma', () => {
  assert.deepStrictEqual(C.splitReady('Hi Ed. How'), ['Hi Ed. ', 'How']);
  assert.deepStrictEqual(C.splitReady('no end yet'), ['', 'no end yet']);
  const long = 'Canyon Gate has three items waiting on the board and two waiting on vendors, and';
  assert.ok(C.splitReady(long)[0].endsWith(', '));
  assert.deepStrictEqual(C.splitReady('tail', true), ['tail', '']);
});

function fakeSupabase(log) {
  return { from(t) { return { insert(rows) { log.push({ t, rows }); return Promise.resolve({ error: null }); } }; } };
}
function streamOf(events) { return { async *[Symbol.asyncIterator]() { for (const e of events) yield e; } }; }
const textTurn = (t) => [{ type: 'message_start', message: { model: 'm', usage: {} } }, { type: 'content_block_start', index: 0, content_block: { type: 'text' } }, ...t.match(/.{1,7}/g).map((x) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: x } })), { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }];
function state() { return C.newState({ session: { id: 's1' }, owner: { user_id: 'u1', email: 'owner@example.com', name: 'Ed Owner' }, briefing: { text: 'Today is Thursday.' } }); }

check('turn: streams clean text, records the transcript and timings', async () => {
  const log = []; const said = []; const st = state();
  const anthropic = { messages: { create: async (p) => { assert.ok(p.stream && p.tools && p.system[1].cache_control, 'streamed, tools offered, briefing cached'); return streamOf(textTurn('Morning Ed. Two things need you — both at Canyon Gate.')); } } };
  const out = await C.runTurn({ supabase: fakeSupabase(log), anthropic, sessionId: 's1', state: st, messages: [{ role: 'user', content: 'what needs me' }], onText: (t) => said.push(t) });
  await st.chain;
  assert.ok(said.length >= 2, 'released in pieces: ' + JSON.stringify(said));
  assert.ok(!DASH.test(said.join('')));
  assert.strictEqual(out.model_calls, 1); assert.ok(out.first_text_ms != null);
  const rows = log.find((l) => l.t === 'claire_session_turns').rows;
  assert.deepStrictEqual(rows.map((r) => r.speaker), ['visitor', 'teammate']);
  assert.strictEqual(rows[1].persona, 'amanda'); assert.deepStrictEqual(rows.map((r) => r.seq), [1, 2]);
});

check('turn: a tool call runs through the loop and its result reaches the second model call', async () => {
  const st = state(); const calls = [];
  const saved = C.TOOLS.get_status;
  C.TOOLS.get_status = async (ctx, input) => { calls.push(input); ctx.card({ kind: 'status', title: 'What needs you', destination: { where: 'Payables', href: '/#tab=ap' } }); return { ok: true, answer: '2 items need you now.' }; };
  let n = 0;
  const anthropic = { messages: { create: async (p) => {
    n++;
    if (n === 1) return streamOf([{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'get_status' } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"community":"Canyon Gate"}' } }, { type: 'message_delta', delta: { stop_reason: 'tool_use' } }]);
    const last = p.messages[p.messages.length - 1];
    assert.strictEqual(last.content[0].type, 'tool_result'); assert.ok(/2 items/.test(last.content[0].content));
    return streamOf(textTurn('Two items need you now.'));
  } } };
  try {
    const out = await C.runTurn({ supabase: fakeSupabase([]), anthropic, sessionId: 's1', state: st, messages: [{ role: 'user', content: 'status at canyon gate' }], onText: () => {} });
    assert.deepStrictEqual(calls, [{ community: 'Canyon Gate' }]);
    assert.strictEqual(out.model_calls, 2); assert.strictEqual(out.tools.length, 1); assert.ok(out.tools[0].ok);
    assert.strictEqual(st.cards.length, 1); assert.strictEqual(st.counters.tool_calls, 1);
  } finally { C.TOOLS.get_status = saved; }
});

check('turn: barge-in (the shell drops the request) stops the turn and is counted', async () => {
  const st = state(); const ctrl = new AbortController();
  const anthropic = { messages: { create: async () => streamOf((function* () { yield { type: 'content_block_start', index: 0, content_block: { type: 'text' } }; yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me tell you about ' } }; ctrl.abort(); yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'everything. ' } }; })()) } };
  const out = await C.runTurn({ supabase: fakeSupabase([]), anthropic, sessionId: 's1', state: st, messages: [{ role: 'user', content: 'x' }], onText: () => {}, signal: ctrl.signal });
  assert.strictEqual(out.interrupted, true); assert.strictEqual(st.counters.interrupted, 1);
});

check('turn: a model failure is spoken as a short apology, counted, never silent', async () => {
  const st = state(); const said = [];
  const anthropic = { messages: { create: async () => { throw new Error('overloaded'); } } };
  const out = await C.runTurn({ supabase: fakeSupabase([]), anthropic, sessionId: 's1', state: st, messages: [{ role: 'user', content: 'x' }], onText: (t) => said.push(t) });
  assert.ok(out.error && said.length === 1 && /say that again/.test(said[0])); assert.strictEqual(st.counters.failed, 1);
});

check('usage: every model call inside a conversation carries its attribution', async () => {
  const seen = [];
  const off = router.onCall((r) => seen.push(r));
  try {
    await router.withAttribution({ conversation_id: 'conv-1', user_id: 'u1' }, async () => { await Promise.resolve(); router.recordCall({ workflow: C.WORKFLOW, ok: true, requested_model: 'x', latency_ms: 1 }); });
    router.recordCall({ workflow: C.WORKFLOW, ok: true, requested_model: 'x', latency_ms: 1 });
  } finally { off(); }
  assert.strictEqual(seen[0].attribution.conversation_id, 'conv-1');
  assert.ok(!seen[1].attribution, 'outside a conversation nothing is attributed');
  const cfg = require('../lib/ai/routing.config.json').workflows;
  assert.ok(cfg[C.WORKFLOW] && cfg[C.EXTRACT_WORKFLOW], 'both workflows are routed centrally');
});

check('brain token: bound to the conversation and owner, tamper-proof, expires', () => {
  const sid = '11111111-2222-3333-4444-555555555555';
  const t = API.signToken({ sid, uid: 'u1' });
  assert.strictEqual(API.verifyToken(t).sid, sid);
  assert.strictEqual(API.verifyToken(t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))), null);
  assert.strictEqual(API.verifyToken(t, Date.now() + 46 * 60 * 1000), null, 'expires');
  assert.strictEqual(API.verifyToken(''), null);
});

check('voice shell config: custom LLM is ours, auth required, header secret set, no dashes', () => {
  const cfg = V.agentConfig({ brainUrl: 'https://app.example/api/amanda/voice/llm', voiceId: 'v1', headerSecret: V.brainHeaderSecret() });
  assert.strictEqual(cfg.conversation_config.agent.prompt.llm, 'custom-llm');
  assert.strictEqual(cfg.conversation_config.agent.prompt.custom_llm.url, 'https://app.example/api/amanda/voice/llm');
  assert.ok(cfg.conversation_config.agent.prompt.custom_llm.request_headers['X-Trusted-Voice'].length >= 32);
  assert.strictEqual(cfg.platform_settings.auth.enable_auth, true);
  assert.strictEqual(cfg.platform_settings.overrides.conversation_config_override.agent.prompt.prompt, false, 'the browser cannot replace the prompt');
  assert.strictEqual(cfg.conversation_config.tts.voice_id, 'v1');
  assert.ok(!DASH.test(JSON.stringify(cfg)));
});

check('POLICY INVARIANT: the voice channel can authorize nothing; tier 3 is in-app only', () => {
  for (const t of [1, 2, 3]) assert.strictEqual(AZ.channelAllowed(t, 'voice'), false, `tier ${t}`);
  assert.deepStrictEqual(AZ.TIER_CHANNELS[3], ['in_app']);
  assert.ok(require('../lib/amanda/request').CHANNELS.includes('voice'), 'voice is a door into the request contract');
  const src = fs.readFileSync(path.join(ROOT, 'lib/amanda/conversation.js'), 'utf8');
  assert.ok(!/executeAuthorized|approveAndPost|owner_authorizations|owner_execution_grants/.test(src), 'the conversation never executes or records an approval');
});

check('measurements: provider record, brain timings and the browser roll up', () => {
  const meas = V.measuredFromConversation({ status: 'done', metadata: { call_duration_secs: 300, cost: 1200, charging: { llm_charge: 0 } }, transcript: [{ role: 'user', conversation_turn_metrics: { metrics: { convai_llm_service_ttfb: { elapsed_time: 0.9 } } } }, { role: 'agent', interrupted: true }] });
  assert.strictEqual(meas.duration_seconds, 300); assert.strictEqual(meas.list_cost_usd, 0.4); assert.strictEqual(meas.turn_metrics_ms.convai_llm_service_ttfb.p50, 900); assert.strictEqual(meas.interrupted_turns, 1);
  const agg = API.aggregateMetrics([{ audio_seconds: 300, cost_usd: 0.45, end_reason: 'user', metrics: { provider: meas, model: { cost_usd: 0.05 }, brain: { turns: 10, failed: 1, interrupted: 2, first_text_ms: { p50: 1100 }, tool_round_ms: { p50: 700 } }, client: { response_gap_ms: [1500, 1900], connect_ms: 1200 } } }]);
  assert.strictEqual(agg.minutes, 5); assert.strictEqual(agg.turn_failure_rate, 10); assert.strictEqual(agg.interruptions, 2);
  assert.strictEqual(agg.cost_usd.per_minute, 0.09); assert.strictEqual(agg.latency_ms.heard_to_amanda_speaking.n, 2);
  assert.strictEqual(API.sanitizeClientMetrics({ response_gap_ms: [1, 'x', 999999], errors: ['a'] }).response_gap_ms.length, 1);
});

check('wiring: owner-only routes, the brain is the only staff-gate exemption, shell entry is owner-only', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(server.includes("app.use('/api/amanda/voice', require('./api/amanda_voice'))"));
  assert.ok(server.indexOf("app.use('/api/amanda/voice'") < server.indexOf("app.use('/api/amanda', require('./api/amanda'))"));
  assert.ok(server.includes('/^\\/api\\/amanda\\/voice\\/llm(?:\\/chat\\/completions)?$/,'));
  const api = fs.readFileSync(path.join(ROOT, 'api/amanda_voice.js'), 'utf8');
  const owner = (api.match(/router\.(get|post)\('\/(status|session|metrics)[^']*'/g) || []).length;
  assert.strictEqual((api.match(/requireOwner\(req, res\)/g) || []).length, owner, 'every owner route checks the owner');
  const tx = fs.readFileSync(path.join(ROOT, 'public/app/tx.js'), 'utf8');
  assert.ok(/user\.is_owner \? '<a class="tx-amanda"/.test(tx));
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) {
    try { await fn(); pass++; console.log('  ✓ ' + n); }
    catch (e) { fail++; console.log('  ✗ ' + n + '\n    ' + (e && e.stack || e).split('\n').slice(0, 4).join('\n    ')); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
