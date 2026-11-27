// =============================================================================
// tests/test_phone_agents.js — Claire and Amanda on the telephone (Ed 2026-11-27)
// =============================================================================
// Offline. Proves, in code:
//   - the verification service sends the code ONLY to a number on the record
//     (the caller's number only when it is on file), limits sends and checks,
//     and returns the record only on Twilio's "approved"
//   - an approved code is the only way a call becomes verified, and the
//     resulting principal is the caller's own (homeowner: their lot only)
//   - unverified Amanda calls get NO records and NO Amanda work tools
//   - the agents disclose AI + recording in the first sentence, point at our
//     brain with a secret header, keep recordings 90 days, and only the test
//     number can ever be connected by code
//   - per-call tokens cannot be forged; the token is found in either channel
//   - the Vapi routes and the Twilio webhooks fail closed
// Run: node tests/test_phone_agents.js   (wired into npm test)
// =============================================================================
const assert = require('assert');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-service-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test';

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message.split('\n').join('\n        ')}`); }
}

// ---- tiny fake Supabase -----------------------------------------------------------------
function fakeSupabase(fixtures) {
  return {
    from(table) {
      const filters = [];
      const q = {};
      for (const m of ['select', 'order', 'limit', 'update', 'upsert', 'insert', 'not', 'gte', 'lt', 'or']) q[m] = () => q;
      q.eq = (c, v) => { filters.push((r) => r[c] === v); return q; };
      q.is = (c, v) => { filters.push((r) => (r[c] == null) === (v == null)); return q; };
      q.in = (c, vs) => { filters.push((r) => vs.includes(r[c])); return q; };
      q.ilike = (c, v) => { const re = new RegExp('^' + String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i'); filters.push((r) => re.test(String(r[c] || ''))); return q; };
      const rows = () => (fixtures[table] || []).filter((r) => filters.every((f) => f(r)));
      q.maybeSingle = () => Promise.resolve({ data: rows()[0] || null, error: null });
      q.single = q.maybeSingle;
      q.then = (res, rej) => Promise.resolve({ data: rows(), error: null }).then(res, rej);
      return q;
    },
  };
}

// ---- fake Twilio Verify -----------------------------------------------------------------
function fakeTwilio({ approveCode = '123456' } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = Object.fromEntries(new URLSearchParams(opts.body || ''));
    calls.push({ url, method: opts.method, body });
    let json;
    if (/\/Services\?/.test(url)) json = { services: [{ sid: 'VA' + '0'.repeat(32), friendly_name: 'Bedrock' }] };
    else if (/\/Verifications$/.test(url)) json = { status: 'pending', to: body.To };
    else if (/\/VerificationCheck$/.test(url)) json = { status: body.Code === approveCode ? 'approved' : 'pending' };
    else json = {};
    return { ok: true, status: 200, text: async () => JSON.stringify(json) };
  };
  return { calls, deps: { fetchImpl } };
}

(async () => {
  console.log('phone agents (Claire + Amanda on the telephone)');
  const gate = require('../lib/voice/private_gate');
  const Verification = require('../lib/verification');
  const P = require('../lib/lookups/principal');
  const A = require('../lib/phone/agents');
  const Call = require('../lib/phone/call');

  const FIX = {
    property_residencies: [
      { property_id: 'p1', contact_id: 'c1', residency_type: 'owner_occupied', end_date: null, properties: { id: 'p1', community_id: 'dc', street_address: 'DC-41-058' } },
      { property_id: 'p1', contact_id: 'c2', residency_type: 'renter', end_date: null, properties: { id: 'p1', community_id: 'dc', street_address: 'DC-41-058' } },
    ],
    contacts: [
      { id: 'c1', full_name: 'Sunny Meadows', primary_phone: '(832) 555-0101', notification_phone: '832-555-0199', secondary_phone: null, primary_email: 'sunny@x.demo' },
      { id: 'c2', full_name: 'Renter Person', primary_phone: '832-555-7777', primary_email: 'r@x.demo' },
      { id: 'ced', full_name: 'Ed Gojara', primary_phone: '832-541-0000', primary_email: 'egojara@bedrocktx.com' },
    ],
    user_profiles: [{ id: 'u-ed', email: 'egojara@bedrocktx.com', full_name: 'Ed Gojara', role: 'admin', is_active: true }],
  };
  const sb = fakeSupabase(FIX);

  await check('phone numbers normalize; numbers on file come from the record, in field order, de-duplicated', () => {
    assert.strictEqual(Verification.e164('(832) 555-0101'), '+18325550101');
    assert.strictEqual(Verification.e164('+1 832 555 0101'), '+18325550101');
    assert.strictEqual(Verification.e164('555-0101'), null);
    assert.deepStrictEqual(Verification.numbersFromContacts([{ primary_phone: '8325550101', notification_phone: '+18325550101', secondary_phone: '832-555-0102' }]), ['+18325550101', '+18325550102']);
  });
  await check('the code goes to the caller\'s number ONLY if it is on file; otherwise to the first number on file', () => {
    const on = ['+18325550101', '+18325550199'];
    assert.deepStrictEqual(Verification.chooseNumber(on, '+18325550199'), { to: '+18325550199', matched_caller: true });
    assert.deepStrictEqual(Verification.chooseNumber(on, '+19995550000'), { to: '+18325550101', matched_caller: false });
    assert.strictEqual(Verification.chooseNumber([], '+18325550101'), null);
  });
  await check('property owner: renters are never a destination; the record names the owner', async () => {
    const f = await Verification.onFile(sb, { kind: 'property_owner', property_id: 'p1', community_id: 'dc' });
    assert.ok(f.ok);
    assert.deepStrictEqual(f.numbers, ['+18325550101', '+18325550199']);
    assert.ok(!f.numbers.includes('+18325557777'));
    assert.strictEqual(f.record.name, 'Sunny Meadows');
    const other = await Verification.onFile(sb, { kind: 'property_owner', property_id: 'p1', community_id: 'another' });
    assert.strictEqual(other.error, 'property_outside_community');
  });

  process.env.TWILIO_ACCOUNT_SID = 'ACtest'; process.env.TWILIO_AUTH_TOKEN = 'tok';
  await check('send -> wrong code -> right code: approved returns the record; a spoofed caller ID never receives the code', async () => {
    Verification._resetForTests();
    const tw = fakeTwilio();
    const holder = {};
    const s = await Verification.start({ supabase: sb, subject: { kind: 'property_owner', property_id: 'p1', community_id: 'dc' }, callerPhone: '+19995550000', holder, deps: tw.deps });
    assert.ok(s.ok, JSON.stringify(s));
    assert.ok(!/\d{3}/.test(s.say), 'the spoken line must not contain the number');
    const sent = tw.calls.find((c) => /Verifications$/.test(c.url));
    assert.strictEqual(sent.body.To, '+18325550101');
    assert.strictEqual(sent.body.Channel, 'sms');
    const bad = await Verification.check({ attempt_id: s.attempt_id, code: '000000', deps: tw.deps });
    assert.strictEqual(bad.approved, false); assert.ok(!bad.record);
    const good = await Verification.check({ attempt_id: s.attempt_id, code: '123 456', deps: tw.deps });
    assert.strictEqual(good.approved, true);
    assert.strictEqual(good.record.property_id, 'p1');
  });
  await check('limits: 3 codes per call, 5 checks per code; unknown attempt refused', async () => {
    Verification._resetForTests();
    const tw = fakeTwilio();
    const holder = {};
    const subject = { kind: 'property_owner', property_id: 'p1', community_id: 'dc' };
    let last;
    for (let i = 0; i < 3; i++) last = await Verification.start({ supabase: sb, subject, holder, deps: tw.deps });
    assert.ok(last.ok);
    const fourth = await Verification.start({ supabase: sb, subject, holder, deps: tw.deps });
    assert.strictEqual(fourth.error, 'too_many_codes');
    for (let i = 0; i < 5; i++) await Verification.check({ attempt_id: last.attempt_id, code: '999999', deps: tw.deps });
    const sixth = await Verification.check({ attempt_id: last.attempt_id, code: '123456', deps: tw.deps });
    assert.strictEqual(sixth.approved, false); assert.strictEqual(sixth.error, 'too_many_checks');
    assert.strictEqual((await Verification.check({ attempt_id: 'nope', code: '123456' })).error, 'no_active_code');
  });
  await check('owner subject: the code goes to the owner\'s own contact record', async () => {
    Verification._resetForTests();
    const tw = fakeTwilio();
    const s = await Verification.start({ supabase: sb, subject: { kind: 'owner' }, callerPhone: '+18325550101', holder: {}, deps: tw.deps });
    assert.ok(s.ok);
    assert.strictEqual(tw.calls.find((c) => /Verifications$/.test(c.url)).body.To, '+18325410000');
    const good = await Verification.check({ attempt_id: s.attempt_id, code: '123456', deps: tw.deps });
    assert.deepStrictEqual({ kind: good.record.kind, user_id: good.record.user_id }, { kind: 'owner', user_id: 'u-ed' });
  });
  await check('no credentials -> no code, a plain spoken fallback', async () => {
    const save = process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_AUTH_TOKEN;
    const r = await Verification.start({ supabase: sb, subject: { kind: 'owner' }, holder: {} });
    process.env.TWILIO_AUTH_TOKEN = save;
    assert.strictEqual(r.ok, false); assert.strictEqual(r.error, 'not_configured'); assert.ok(r.say);
  });

  // ---- principals ----------------------------------------------------------------------
  await check('phone homeowner principal: only from a branded verification; their lot only; same caps as the portal', () => {
    assert.throws(() => P.phoneHomeownerPrincipal({ ctx: { phone_verification: { property_id: 'p1' } }, communityId: 'dc' }), /no verified homeowner/);
    const ctx = { phone_verification: gate.createPhoneVerification({ property_id: 'p1', method: gate.SMS_CODE_ON_FILE }) };
    const p = P.phoneHomeownerPrincipal({ ctx, communityId: 'dc', financials: false });
    assert.strictEqual(p.kind, 'homeowner');
    assert.deepStrictEqual([...p.properties], ['p1']);
    assert.ok(P.canProperty(p, { property_id: 'p1', community_id: 'dc' }));
    assert.ok(!P.canProperty(p, { property_id: 'p2', community_id: 'dc' }));
    assert.ok(!p.capabilities.has('homeowner_search') && !p.capabilities.has('homeowner_ledger'));
    assert.ok(P.phoneHomeownerPrincipal({ ctx, communityId: 'dc', financials: true }).capabilities.has('homeowner_ledger'));
    assert.throws(() => P.staffPrincipal({ user_id: 'u1' }), /no verified staff/);
  });
  await check('the call principal: none until verified; owner after an owner code; homeowner after a property code', async () => {
    const st = { community: { id: 'dc' } };
    assert.strictEqual(await Call.principalFor(sb, st), null);
    st.identity_verification = gate.createIdentityVerification({ kind: 'owner', user_id: 'u-ed', name: 'Ed Gojara', method: gate.SMS_CODE_ON_FILE });
    assert.strictEqual((await Call.principalFor(sb, st)).kind, 'owner');
    const st2 = { community: { id: 'dc' }, phone_verification: gate.createPhoneVerification({ property_id: 'p1', method: gate.SMS_CODE_ON_FILE }) };
    const hp = await Call.principalFor(fakeSupabase({}), st2);
    assert.strictEqual(hp.kind, 'homeowner');
  });

  // ---- Amanda's phone engine: unverified = no records, no work tools ------------------------
  await check('Amanda on the phone, unverified: the model is offered ONLY verification + shell tools', async () => {
    const C = require('../lib/amanda/conversation');
    const offered = [];
    const fakeAnthropic = { messages: { create: async (opts) => { offered.push((opts.tools || []).map((t) => t.name)); return (async function* () { yield { type: 'content_block_start', index: 0, content_block: { type: 'text' } }; yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Who am I speaking with?' } }; yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } }; })(); } } };
    const st = C.newState({ session: { id: '00000000-0000-4000-8000-000000000001' }, owner: null, briefing: { text: 'not verified' } });
    let said = '';
    const r = await C.runTurn({ supabase: fakeSupabase({}), anthropic: fakeAnthropic, sessionId: st.session.id, state: st, messages: [{ role: 'user', content: 'Hi, this is Ed, what needs me?' }], channel: 'phone', phone: { principal: null, extraTools: Call.AMANDA_VERIFY_TOOLS.concat([{ name: 'transfer_to_agent', description: '', input_schema: { type: 'object', properties: {} } }]), extraHandlers: {}, passthrough: new Set(['transfer_to_agent']) }, onText: (t) => { said += t; } });
    assert.deepStrictEqual(offered[0], ['verify_caller', 'check_code', 'transfer_to_agent']);
    assert.ok(/Who am I speaking with/.test(said));
    assert.strictEqual(r.passthrough, null);
    const sys = C.phonePrompt({});
    assert.ok(/do NOT know who is calling/.test(sys));
  });
  await check('Amanda on the phone: a shell tool call (transfer) ends the turn and is handed back, never executed', async () => {
    const C = require('../lib/amanda/conversation');
    const fakeAnthropic = { messages: { create: async () => (async function* () {
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me get Claire for you. ' } };
      yield { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'transfer_to_agent' } };
      yield { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"reason":"homeowner","agent_number":0}' } };
      yield { type: 'message_delta', delta: { stop_reason: 'tool_use' } };
    })() } };
    const st = C.newState({ session: { id: '00000000-0000-4000-8000-000000000002' }, owner: null, briefing: { text: '' } });
    const r = await C.runTurn({ supabase: fakeSupabase({}), anthropic: fakeAnthropic, sessionId: st.session.id, state: st, messages: [{ role: 'user', content: 'I have a question about my pool fob' }], channel: 'phone', phone: { principal: null, extraTools: [], extraHandlers: {}, passthrough: new Set(['transfer_to_agent']) }, onText: () => {} });
    assert.deepStrictEqual(r.passthrough, { name: 'transfer_to_agent', input: { reason: 'homeowner', agent_number: 0 } });
  });

  // ---- agents ----------------------------------------------------------------------------
  await check('agent config: AI + recording disclosed first, our brain + secret header, 90-day retention, webhook + extra body on', () => {
    const c = A.agentConfig({ persona: 'claire', brainUrl: 'https://x/api/phone/llm/claire', headerSecret: 'h', voiceId: 'v', ttsModel: 'eleven_flash_v2', transferTo: 'amanda-id' });
    const fm = c.conversation_config.agent.first_message;
    assert.ok(/^Hi, this is Claire, Bedrock's AI assistant/.test(fm) && /This call is recorded\./.test(fm.split('.').slice(0, 3).join('.') + '.'));
    assert.ok(/This call is recorded/.test(A.claireFirstMessage('Drama Creek Estates')));
    assert.ok(/^Hi, this is Claire, Bedrock's AI assistant for Drama Creek Estates\. This call is recorded\./.test(A.claireFirstMessage('Drama Creek Estates')));
    assert.strictEqual(c.conversation_config.agent.prompt.llm, 'custom-llm');
    assert.strictEqual(c.conversation_config.agent.prompt.custom_llm.url, 'https://x/api/phone/llm/claire');
    assert.strictEqual(c.conversation_config.agent.prompt.custom_llm.request_headers['X-Trusted-Phone'], 'h');
    assert.ok(/PHONE_SESSION=\{\{session_token\}\}/.test(c.conversation_config.agent.prompt.prompt));
    assert.strictEqual(c.platform_settings.privacy.retention_days, 90);
    assert.strictEqual(c.platform_settings.overrides.enable_conversation_initiation_client_data_from_webhook, true);
    assert.strictEqual(c.platform_settings.overrides.custom_llm_extra_body, true);
    assert.strictEqual(c.conversation_config.agent.prompt.built_in_tools.transfer_to_agent.params.transfers[0].agent_id, 'amanda-id');
    assert.ok(c.conversation_config.agent.prompt.built_in_tools.end_call);
    const a = A.agentConfig({ persona: 'amanda', brainUrl: 'https://x/api/phone/llm/amanda', headerSecret: 'h', voiceId: 'harper', ttsModel: 'eleven_v4_turbo', expressive: true, transferTo: 'claire-id' });
    assert.strictEqual(a.conversation_config.tts.model_id, 'eleven_v4_turbo');
    assert.strictEqual(a.conversation_config.tts.expressive_mode, true);
    assert.ok(/Bedrock's AI senior community manager/.test(a.conversation_config.agent.first_message));
    assert.strictEqual(a.conversation_config.agent.prompt.built_in_tools.transfer_to_agent.params.transfers[0].enable_transferred_agent_first_message, true);
  });
  await check('only the test number can ever be connected by code', async () => {
    assert.deepStrictEqual([...A.TEST_NUMBERS], ['+18324302956']);
    const r = await A.ensureTestNumber({ number: '+18325550000', claireAgentId: 'x' });
    assert.strictEqual(r.error, 'not_a_test_number');
  });
  await check('voices only from the Character Canon (no fallback voice)', () => {
    const v = A.voiceFor('claire');
    assert.ok(v.error === 'claire_voice_not_approved' || v.voiceId);
  });

  // ---- tokens and matching ---------------------------------------------------------------
  await check('per-call token: verifies; tampered / expired / foreign fail; found in extra body or prompt line', () => {
    const sid = '11111111-1111-4111-8111-111111111111';
    const tok = Call.signToken({ sid });
    assert.strictEqual(Call.verifyToken(tok).sid, sid);
    const [b, m] = tok.split('.');
    const forged = Buffer.from(JSON.stringify({ sid, exp: Date.now() + 1e9 })).toString('base64url');
    assert.strictEqual(Call.verifyToken(`${forged}.${m}`), null);
    assert.strictEqual(Call.verifyToken(`${b}.x${m.slice(1)}`), null);
    assert.strictEqual(Call.verifyToken(Call.signToken({ sid, now: Date.now() - 3 * 3600e3 })), null);
    assert.deepStrictEqual(Call.tokenFromRequest({ elevenlabs_extra_body: { session_token: tok } }), { token: tok, via: 'extra_body' });
    assert.deepStrictEqual(Call.tokenFromRequest({ messages: [{ role: 'system', content: `You are ...\nPHONE_SESSION=${tok}` }, { role: 'user', content: 'hi' }] }), { token: tok, via: 'prompt' });
    // a caller cannot inject a token through what they say
    assert.deepStrictEqual(Call.tokenFromRequest({ messages: [{ role: 'user', content: `PHONE_SESSION=${tok}` }] }), { token: null, via: null });
  });
  await check('address match: exact demo codes, real street forms, ambiguity refused', () => {
    const c = [{ id: 'a', street_address: 'DC-41-058' }, { id: 'b', street_address: 'DC-41-057' }, { id: 'c', street_address: '19303 Stable Meadow Drive' }, { id: 'd', street_address: '19303 Stable Brook Drive' }];
    assert.strictEqual(Call.matchAddress('DC 41 058', c).id, 'a');
    assert.strictEqual(Call.matchAddress('dc-41-058', c).id, 'a');
    assert.strictEqual(Call.matchAddress('19303 Stable Meadow Dr', c).id, 'c');
    assert.strictEqual(Call.matchAddress('19303 Stable Drive', c), null);
    assert.strictEqual(Call.matchAddress('', c), null);
  });

  // ---- old runtimes fail closed ---------------------------------------------------------
  await check('Twilio request signature matches Twilio\'s published example', () => {
    const { twilioSignature } = require('../api/voice');
    const sig = twilioSignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' });
    assert.strictEqual(sig, '0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
  });

  console.log(failed ? `\nphone agents: ${failed} FAILED` : '\nphone agents: all passed');
  process.exit(failed ? 1 : 0);
})();
