// =============================================================================
// tests/test_phone_private_records_gate.js — the homeowner security boundary
// =============================================================================
//
// Owner rule (Ed 2026-11-27): a caller providing a property address is not
// authentication. Caller ID is not authentication either. Public information
// and general help stay open; private records require real verification, and
// no phone verification step exists yet, so on the phone private records are
// closed (fail-closed) by CODE in lib/voice/private_gate.js.
//
// This file proves the gate runs, at the data/tool level, not in prompt prose:
//   - every private tool refuses an unverified call even with a correct
//     community + address, and touches no data before refusing
//   - the amenity check returns only the general rule: no allowed/denied for
//     a lot and no dollar amounts
//   - getCallerContext ignores a model-supplied phone and returns no private
//     fields
//   - the phone system prompt for an unverified call carries no balance,
//     attorney, bankruptcy, violation, ACC, call-summary, or owner name data,
//     even when handed a caller-ID match and a full warmup
//   - the opener never says the caller-ID name or an account hint
//   - public tools (community-facts, key-fob-info) still work
//
// Fully offline: Supabase and Express are stubbed, any other missing package
// is replaced with an inert stub, so this runs with or without node_modules.
//
// Run: node tests/test_phone_private_records_gate.js   (wired into npm test)
// =============================================================================

const assert = require('assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');

// ---- Fake Supabase: fixture rows per table + a log of every query ----------
const FIXTURES = {};
const QUERY_LOG = [];
function fakeQuery(table) {
  const entry = { table, ops: [] };
  QUERY_LOG.push(entry);
  const rows = () => (FIXTURES[table] || []);
  const q = {};
  for (const m of ['select', 'eq', 'neq', 'ilike', 'is', 'in', 'gte', 'lte', 'lt', 'gt', 'or', 'order', 'limit', 'range', 'not', 'contains', 'filter', 'match', 'update', 'upsert', 'insert', 'delete']) {
    q[m] = (...args) => { entry.ops.push([m, ...args]); return q; };
  }
  q.maybeSingle = () => Promise.resolve({ data: rows()[0] || null, error: null });
  q.single = () => Promise.resolve({ data: rows()[0] || null, error: null });
  q.then = (res, rej) => Promise.resolve({ data: rows(), error: null }).then(res, rej);
  return q;
}
const fakeSupabase = { from: (t) => fakeQuery(t), rpc: () => Promise.resolve({ data: null, error: null }) };

// ---- Fake Express: records route handlers so we can call them directly -----
const ROUTES = {};
const fakeExpress = Object.assign(() => ({}), {
  Router: () => {
    const r = {};
    for (const verb of ['get', 'post', 'put', 'patch', 'delete', 'use']) {
      r[verb] = (p, ...handlers) => { ROUTES[`${verb.toUpperCase()} ${p}`] = handlers[handlers.length - 1]; return r; };
    }
    return r;
  },
  json: () => (_req, _res, next) => next && next(),
  urlencoded: () => (_req, _res, next) => next && next(),
  static: () => (_req, _res, next) => next && next(),
});

// Inert stand-in for any package not installed in this checkout.
function inertStub() {
  const fn = function () { return proxy; };
  const proxy = new Proxy(fn, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === '__esModule') return false;
      return proxy;
    },
    apply() { return proxy; },
    construct() { return proxy; },
  });
  return proxy;
}

const STUBS = {
  '@supabase/supabase-js': { createClient: () => fakeSupabase },
  express: fakeExpress,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (STUBS[request]) return `stub:${request}`;
  try {
    return origResolve.call(this, request, parent, ...rest);
  } catch (e) {
    const bare = !request.startsWith('.') && !path.isAbsolute(request);
    if (e.code === 'MODULE_NOT_FOUND' && bare) {
      const id = `stub:${request}`;
      if (!require.cache[id]) require.cache[id] = { id, filename: id, loaded: true, exports: inertStub() };
      return id;
    }
    throw e;
  }
};
for (const [name, exp] of Object.entries(STUBS)) {
  const id = `stub:${name}`;
  require.cache[id] = { id, filename: id, loaded: true, exports: exp };
}
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://stub.invalid';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'stub';
delete process.env.VAPI_WEBHOOK_SECRET; // route auth is not what this file tests

const gate = require('../lib/voice/private_gate');
const tools = require('../lib/voice/tools');
const { buildVoiceSystemPromptParts } = require('../lib/voice/reason');
const { buildIsabellaSystemPromptParts } = require('../lib/voice/reason_isabella');
const { buildOpener } = require('../lib/voice/persona');
const { buildOpener: buildIsabellaOpener } = require('../lib/voice/persona_isabella');
const voiceApi = require('../api/voice');

// ---- Test data: a real-looking caller-ID match with everything private -----
const COMMUNITY = { id: 'comm-1', name: 'Waterview Estates' };
const CALLER = {
  id: 'contact-1', contact_id: 'contact-1', full_name: 'Zebulon Quintrell', first_name: 'Zebulon',
  preferred_name: 'Zeb', primary_email: 'zeb.quintrell@example.com', property_id: 'prop-1',
  property_address: '5226 Jay Thrush Way', residency_type: 'owner',
  verified: true, // a forged flag: the phone path must ignore it
};
const WARMUP = {
  ar: { balance_total: 123456, snapshot_date: '2026-11-01', at_legal: true, in_collections: true, payment_plan_active: true, in_bankruptcy: true, pre_petition_balance_cents: 77700, post_petition_balance_cents: 8800, enforcement_stage: 'at_legal' },
  enforcement: { state: 'in_bankruptcy', attorney_name: 'Barnaby Lawfirm', bankruptcy_chapter: '13', bankruptcy_case_number: '26-99999', bankruptcy_attorney_name: 'Petra Counsel', bankruptcy_attorney_email: 'petra@example.com', payment_plan_terms_text: '$250 monthly through June' },
  v_count: 2,
  acc: [{ status: 'pending', project_type: 'fence', project_summary: 'Cedar privacy fence replacement', submitted_at: '2026-10-20' }],
  recent: [{ started_at: '2026-11-20', summary: 'asked about the late fee waiver' }],
};
const PRIVATE_MARKERS = ['Zebulon', 'Quintrell', 'Zeb ', 'zeb.quintrell', '5226 Jay Thrush', '$1234.56', '1234.56', 'Barnaby', 'Petra', '26-99999', 'Chapter 13',
  'BANKRUPTCY ON FILE', '$250 monthly', 'Cedar privacy fence', 'late fee waiver', 'open compliance item', 'CALLER CONTEXT (pre-call', '777.00', '88.00'];

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failures += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}
function assertNoPrivate(text, label) {
  for (const m of PRIVATE_MARKERS) assert.ok(!String(text).includes(m), `${label} leaked "${m}"`);
}
function unverifiedCtx() {
  // Everything a spoofed caller-ID match would produce, plus forged fields.
  return { community: COMMUNITY, caller: { ...CALLER }, caller_phone: '+18325550100', verified_property_id: 'prop-1', phone_verification: { property_id: 'prop-1', method: 'address' } };
}
function fakeRes() {
  return { body: null, statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; }, send(b) { this.body = b; return this; }, end() { return this; } };
}

(async () => {
  console.log('phone private-records gate (Ed 2026-11-27)');

  // ---------------------------------------------------------------- the gate
  await check('gate is closed on every phone call today (no ctx, forged fields, JSON look-alikes)', () => {
    assert.strictEqual(gate.phoneVerifiedPropertyId(undefined), null);
    assert.strictEqual(gate.phoneVerifiedPropertyId({}), null);
    assert.strictEqual(gate.phoneVerifiedPropertyId(unverifiedCtx()), null);
    assert.strictEqual(gate.phoneVerifiedPropertyId({ phone_verification: JSON.parse('{"property_id":"prop-1","method":"otp"}') }), null);
    assert.strictEqual(gate.phoneVerifiedPropertyId({ caller: { verified: true, property_id: 'prop-1' } }), null);
  });
  await check('no verification method exists, so nothing can mint a verification', () => {
    assert.deepStrictEqual([...gate.VERIFICATION_METHODS], []);
    for (const method of ['address', 'caller_id', 'otp', 'name', undefined]) {
      assert.throws(() => gate.createPhoneVerification({ property_id: 'prop-1', method }), /no_phone_verification_method_available/);
    }
  });

  // ------------------------------------------------------- private tools refuse
  for (const [toolName, topic] of [['get_ar_for_property', 'account_balance'], ['get_homeowner_contact_history', 'contact_history']]) {
    await check(`${toolName} refuses an unverified call even with a correct community + address, before any lookup`, async () => {
      QUERY_LOG.length = 0;
      FIXTURES.communities = [COMMUNITY];
      FIXTURES.properties = [{ id: 'prop-1', street_address: '5226 Jay Thrush Way', community_id: 'comm-1' }];
      const r = await tools.VOICE_TOOL_HANDLERS[toolName]({ community_name: 'Waterview Estates', address: '5226 Jay Thrush Way' }, unverifiedCtx());
      assert.strictEqual(r.error, 'verification_required');
      assert.strictEqual(r.verified, false);
      assert.strictEqual(r.topic, topic);
      assert.ok(Array.isArray(r.what_you_can_do) && r.what_you_can_do.some((s) => /portal/i.test(s)) && r.what_you_can_do.some((s) => /callback/i.test(s)));
      assert.ok(!('balance' in r) && !('property_address' in r) && !('summary' in r) && !('recent_interactions' in r));
      assert.strictEqual(QUERY_LOG.length, 0, `queried ${QUERY_LOG.map((q) => q.table).join(',')} before refusing`);
      assertNoPrivate(JSON.stringify(r), toolName);
    });
  }

  await check('check_amenity_access unverified: general rule only, no lot status, no dollar amounts, no lookups', async () => {
    QUERY_LOG.length = 0;
    const r = await tools.VOICE_TOOL_HANDLERS.check_amenity_access({ community_name: 'Waterview Estates', address: '5226 Jay Thrush Way' }, unverifiedCtx());
    const s = JSON.stringify(r);
    assert.strictEqual(r.lot_specific_status_available, false);
    assert.strictEqual(r.verified, false);
    assert.ok(!('allowed' in r) && !('basis' in r) && !('reason' in r) && !('enforcement_override' in r) && !('property_address' in r));
    assert.ok(!/\$\s?\d/.test(s), 'contains a dollar amount');
    assert.ok(r.general_rule && /assessments/i.test(r.general_rule));
    assert.strictEqual(QUERY_LOG.length, 0);
    assertNoPrivate(s, 'check_amenity_access');
  });

  await check('tool definitions stay available and say they require verification', () => {
    const byName = Object.fromEntries(tools.VOICE_TOOLS.map((t) => [t.name, t]));
    for (const n of ['get_ar_for_property', 'check_amenity_access', 'get_homeowner_contact_history', 'send_form_to_caller', 'send_sms_link_to_caller']) assert.ok(byName[n], `${n} missing`);
    for (const n of ['get_ar_for_property', 'check_amenity_access', 'get_homeowner_contact_history']) {
      assert.ok(/VERIFIED CALLER/.test(byName[n].description), `${n} description`);
      assert.ok(/NOT verification/.test(byName[n].description), `${n} must say an address is not verification`);
    }
  });

  await check('send_form_to_caller never uses or reads back the email on file for an unverified caller', async () => {
    const r = await tools.VOICE_TOOL_HANDLERS.send_form_to_caller({ form_type: 'key_fob_application' }, unverifiedCtx());
    assert.strictEqual(r.error, 'email_required');
    assertNoPrivate(JSON.stringify(r), 'send_form_to_caller');
    assert.ok(!/@/.test(JSON.stringify(r)));
  });
  await check('send_form_to_caller source: unverified recipient is caller-stated only, no caller-ID name, no owner attribution', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'voice', 'tools.js'), 'utf8');
    assert.ok(src.includes("const recipientEmail = statedEmail || (verifiedCaller ? (verifiedCaller.primary_email || verifiedCaller.email || null) : null);"));
    assert.ok(src.includes('const callerName = verifiedCaller'));
    assert.ok(src.includes('property_id: verifiedCaller ? verifiedPropertyId : null,'));
  });

  // ----------------------------------------------- the unverified phone prompt
  await check('phonePromptView drops the caller-ID match and the warmup when unverified (forged verified flag ignored)', () => {
    const v = gate.phonePromptView({ caller: { ...CALLER }, warmup: WARMUP, phone_verification: { property_id: 'prop-1' } });
    assert.strictEqual(v.caller, null);
    assert.strictEqual(v.warmup, null);
  });
  await check('Claire phone prompt (unverified) carries no balance/attorney/bankruptcy/violation/ACC/call-summary/name', () => {
    const view = gate.phonePromptView({ caller: { ...CALLER }, warmup: WARMUP });
    const { stable, variable } = buildVoiceSystemPromptParts(COMMUNITY, view.caller, '', 'Pool hours 6am-10pm.', '', view.warmup);
    assertNoPrivate(stable + variable, 'Claire prompt');
    assert.ok(/NOT VERIFIED/.test(stable), 'unverified caller block present');
    assert.ok(/address does NOT verify identity|stated property address does NOT verify/.test(stable));
  });
  await check('Claire builder renders no warmup for a caller without a real verified flag (defense in depth)', () => {
    const { variable } = buildVoiceSystemPromptParts(COMMUNITY, { ...CALLER, verified: false }, '', '', '', WARMUP);
    assert.ok(!variable.includes('BANKRUPTCY ON FILE') && !variable.includes('CALLER CONTEXT (pre-call'));
  });
  await check('Isabella phone prompt (unverified) carries no private data', () => {
    const view = gate.phonePromptView({ caller: { ...CALLER }, warmup: WARMUP });
    const { stable, variable } = buildIsabellaSystemPromptParts(COMMUNITY, view.caller, '', '', '');
    assertNoPrivate(stable + variable, 'Isabella prompt');
    assert.ok(/NO VERIFICADO/.test(stable));
  });
  await check('prompt no longer calls the address confirmation an identity check', () => {
    const { stable } = buildVoiceSystemPromptParts(COMMUNITY, null, '', '', '', null);
    assert.ok(!/address confirmation IS the identity check/i.test(stable));
    const es = buildIsabellaSystemPromptParts(COMMUNITY, null, '', '', '').stable;
    assert.ok(!/confirmación de dirección ES la verificación de identidad/i.test(es));
  });
  await check('streamTurn wires the gate: phone prompt uses phonePromptView, tools get phone_verification', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'voice', 'reason.js'), 'utf8');
    assert.ok(src.includes("require('./private_gate').phonePromptView({ caller, warmup, phone_verification })"));
    assert.ok(src.includes('community, promptView.caller, docContext, profileBlock, playbookContext, promptView.warmup,'));
    assert.ok(src.includes('handler(tb.input, { community, caller, caller_phone, phone_verification })'));
  });

  // ------------------------------------------------------------- the openers
  await check('openers never say the caller-ID name or an account hint, and always say AI', () => {
    const hint = 'I see we have your ARC submission for the fence project in review — calling about that?';
    for (const o of [buildOpener('Waterview Estates', 'Zebulon', hint), buildOpener(null, 'Zebulon', hint), buildOpener('Waterview Estates')]) {
      assert.ok(!o.includes('Zebulon') && !/ARC|compliance/.test(o), o);
      assert.ok(/AI assistant/.test(o), o);
    }
    for (const o of [buildIsabellaOpener('Waterview Estates', 'Zebulon'), buildIsabellaOpener(null, 'Zebulon')]) {
      assert.ok(!o.includes('Zebulon') && /inteligencia artificial/.test(o), o);
    }
  });
  await check('Twilio /incoming no longer prefetches private data or passes it to the stream', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'voice.js'), 'utf8');
    const incoming = src.slice(src.indexOf("router.post('/incoming'"), src.indexOf("router.post('/status'"));
    for (const t of ['owner_ar_snapshots', 'v_current_enforcement_state', 'arc_historical_decisions', "from('violations')", 'warmup_b64', 'warmup_opener_hint', 'caller_first_name', 'caller_property_address', 'caller_name']) {
      assert.ok(!incoming.includes(t), `/incoming still references ${t}`);
    }
    const stream = src.slice(src.indexOf('function handleWebSocketConnection'), src.indexOf("router.post('/vapi-assistant-request'"));
    assert.ok(!stream.includes('params.warmup_b64') && !stream.includes('params.caller_name') && stream.includes('warmup: null'));
  });

  // ------------------------------------------------------ Vapi caller-context
  FIXTURES.contacts = [{ id: 'contact-1', full_name: 'Zebulon Quintrell', preferred_name: 'Zeb', primary_phone: '832-555-0100', preferred_language: null }];
  FIXTURES.property_residencies = [{ property_id: 'prop-1', residency_type: 'owner', properties: { id: 'prop-1', street_address: '5226 Jay Thrush Way', community_id: 'comm-1', communities: COMMUNITY } }];
  FIXTURES.homeowner_calls = [{ id: 'call-1', started_at: new Date().toISOString(), brief: { concern: 'asked about the late fee waiver' } }];
  FIXTURES.violations = [{ id: 'v-1', current_stage: 'certified_209', enforcement_categories: { label: 'Trash cans' } }];

  await check('caller-context ignores args.caller_phone: lookup uses the actual calling number', async () => {
    QUERY_LOG.length = 0;
    const handler = ROUTES['POST /vapi-tools/caller-context'];
    assert.ok(handler, 'route registered');
    const res = fakeRes();
    await handler({ headers: {}, body: { message: { call: { customer: { number: '+17135550199' } }, toolCalls: [{ function: { arguments: JSON.stringify({ caller_phone: '+18325550100' }) } }] } } }, res);
    const contactQ = QUERY_LOG.filter((q) => q.table === 'contacts');
    assert.ok(contactQ.length >= 1, 'looked up contacts');
    const orArgs = contactQ.flatMap((q) => q.ops.filter((o) => o[0] === 'or').map((o) => o[1])).join(' ');
    assert.ok(orArgs.includes('7135550199'), 'used the actual number');
    assert.ok(!orArgs.includes('8325550100'), 'used the model-supplied number');
  });
  await check('caller-context returns no private fields even when the real number matches an owner', async () => {
    QUERY_LOG.length = 0;
    const handler = ROUTES['POST /vapi-tools/caller-context'];
    const res = fakeRes();
    await handler({ headers: {}, body: { message: { call: { customer: { number: '+18325550100' } } } } }, res);
    const r = res.body.result;
    assert.strictEqual(r.found, false);
    assert.strictEqual(r.verified, false);
    assert.deepStrictEqual(r.community, { id: 'comm-1', name: 'Waterview Estates' }, 'community kept for public facts');
    for (const k of ['caller', 'property', 'recent_activity']) assert.ok(!(k in r), `returned ${k}`);
    assert.ok(!JSON.stringify(r).includes('contact-1'));
    assertNoPrivate(JSON.stringify(r), 'caller-context');
    assert.ok(!QUERY_LOG.some((q) => ['homeowner_calls', 'violations'].includes(q.table)), 'queried call history / violations');
  });

  await check('request-callback and send-portal-link: the actual call number wins; no on-file email', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'voice.js'), 'utf8');
    assert.ok(!src.includes('args.caller_phone || msg.call?.customer?.number'), 'model-supplied phone still wins somewhere');
    assert.ok(!src.includes('deliveryEmail || caller?.primary_email'), 'on-file email fallback remains');
    assert.ok(!/firstMessage = openerBuilder\(community\?\.name \|\| null, caller\?\.first_name/.test(src));
  });

  // ------------------------------------------------------------ public tools
  await check('public: community-facts still answers (no verification needed)', async () => {
    FIXTURES.communities = [{ id: 'comm-1', name: 'Waterview Estates', trash_schedule: { trash_days: ['Tuesday', 'Friday'], recycling_days: ['Friday'] } }];
    const res = fakeRes();
    await ROUTES['POST /vapi-tools/community-facts']({ headers: {}, body: { message: { call: { customer: { number: '+17135550199' } }, toolCalls: [{ function: { arguments: JSON.stringify({ community_id: 'comm-1', topic: 'trash' }) } }] } } }, res);
    const r = res.body && res.body.result;
    assert.ok(r && typeof r.answer === 'string' && r.answer.length > 0, JSON.stringify(res.body));
    assert.ok(!/verification_required/.test(JSON.stringify(r)));
  });
  await check('public: key-fob-info still answers (no verification needed)', async () => {
    const res = fakeRes();
    await ROUTES['POST /vapi-tools/key-fob-info']({ headers: {}, body: { message: { call: { customer: { number: '+17135550199' } }, toolCalls: [{ function: { arguments: JSON.stringify({ community_id: 'comm-1', requester_type: 'owner', request_type: 'new' }) } }] } } }, res);
    const r = res.body && res.body.result;
    assert.ok(r && Object.keys(r).length > 0, JSON.stringify(res.body));
    assert.ok(!/verification_required/.test(JSON.stringify(r)));
  });
  await check('public: send_sms_link_to_caller still only needs the calling number (no verification gate)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'voice', 'tools.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function send_sms_link_to_caller_handler'), src.indexOf('// TOOL: check_amenity_access'));
    assert.ok(!fn.includes('verificationRequired'));
  });

  console.log(`\nphone private-records gate: ${failures ? failures + ' FAILED' : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})();
