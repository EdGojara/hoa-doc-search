// ============================================================================
// api/phone.js  (Ed 2026-11-27: Claire and Amanda on Bedrock's telephone line)
// ----------------------------------------------------------------------------
// Mounted at /api/phone. The voice shell is ElevenLabs phone agents (lib/phone/
// agents.js); every word comes from trustEd's brains:
//
//   POST /api/phone/init?k=…                    ElevenLabs conversation-initiation webhook
//        (inbound Twilio call): identify the line + association, open the call,
//        return the signed per-call session token and Claire's disclosure opener.
//   POST /api/phone/llm/claire[/chat/completions]  Claire's brain (lib/voice/reason.js
//        streamTurn, the same pipeline as the portal), OpenAI-compatible SSE.
//   POST /api/phone/llm/amanda[/chat/completions]  Amanda's brain (lib/amanda/
//        conversation.js runTurn, the same engine as Talk to Amanda).
//   GET  /api/phone/status                        readiness (owner, or the ops key)
//   POST /api/phone/setup                         create/update the agents + webhook;
//        { connect_test_number: true } connects ONLY the test line (owner, or ops key)
//
// Brain requests are authenticated by the agents' header secret AND the per-call
// token. Private records open only after a code texted to the number on file
// (lib/verification -> lib/voice/private_gate), enforced by the principal in
// code (lib/lookups). A phone call never approves anything.
// ============================================================================
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { requireOwner } = require('./_require_admin');
const { safeErrorMessage } = require('./_safe_error');
const A = require('../lib/phone/agents');
const Call = require('../lib/phone/call');

const router = express.Router();
let _sb = null;
const sb = () => (_sb || (_sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)));
let _anthropic = null;
function anthropic() {
  if (_anthropic) return _anthropic;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('../lib/ai/anthropic');
  _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}
const eq = (a, b) => { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y); };

function baseUrl(req) {
  const env = (process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (env) return env;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}
// Ops key: for verification by an operator who already holds the service key (it grants nothing the
// service key does not). Owner sign-in works the same.
function opsKey() { return process.env.SUPABASE_KEY ? crypto.createHmac('sha256', process.env.SUPABASE_KEY).update('trusted-phone-ops-v1').digest('hex') : ''; }
async function requireOwnerOrOps(req, res) {
  if (eq(req.headers['x-trusted-ops'], opsKey())) return { ops: true };
  return requireOwner(req, res);
}

// ---- the initiation webhook -------------------------------------------------------------
router.post('/init', express.json({ limit: '64kb' }), async (req, res) => {
  if (!eq(req.query.k, A.initWebhookKey())) { console.warn('[phone.init] rejected: bad key'); return res.status(403).json({ error: 'forbidden' }); }
  const b = req.body || {};
  try {
    const ids = await A.resolveAgentIds();
    const persona = ids ? (b.agent_id === ids.claire_agent_id ? 'claire' : b.agent_id === ids.amanda_agent_id ? 'amanda' : null) : null;
    if (!persona) { console.warn('[phone.init] rejected: not a trustEd phone agent', JSON.stringify({ agent_id: b.agent_id || null })); return res.status(403).json({ error: 'unknown_agent' }); }
    const { token, community, st } = await Call.openCall(sb(), { conversation_id: b.conversation_id || null, call_sid: b.call_sid || null, caller_id: b.caller_id || null, called_number: b.called_number || null, agent_persona: persona });
    console.log('[phone.init] call opened', JSON.stringify({ session_id: st.sid, conversation_id: b.conversation_id || null, community: community ? community.name : null, persona }));
    finishStale().catch((e) => console.warn('[phone] stale finish failed:', e.message));
    const name = community ? community.name.replace(/\s*\(TEST\)\s*$/i, '') : null;
    res.json({
      type: 'conversation_initiation_client_data',
      dynamic_variables: { session_token: token, community_name: name || 'your community' },
      custom_llm_extra_body: { session_token: token },
      conversation_config_override: { agent: { first_message: persona === 'claire' ? A.claireFirstMessage(name) : A.AMANDA_FIRST } },
    });
  } catch (e) {
    console.error('[phone.init] failed:', e.message);
    // The call still connects; the brain answers politely without a session and opens nothing.
    res.json({ type: 'conversation_initiation_client_data', dynamic_variables: { session_token: '', community_name: 'your community' } });
  }
});

// ---- the brains -----------------------------------------------------------------------------
function sse(res, model) {
  const id = `chatcmpl-${crypto.randomBytes(8).toString('hex')}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish = null) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`); };
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  chunk({ role: 'assistant' });
  return {
    text: (t) => chunk({ content: t }),
    tool: (name, args) => { chunk({ tool_calls: [{ index: 0, id: `call_${crypto.randomBytes(6).toString('hex')}`, type: 'function', function: { name, arguments: JSON.stringify(args || {}) } }] }); chunk({}, 'tool_calls'); if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); } },
    end: () => { chunk({}, 'stop'); if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); } },
  };
}
/** PURE: the voice shell's own tools (transfer_to_agent, end_call ...) in Anthropic form, passed through. */
function shellTools(body) {
  const out = [];
  for (const t of Array.isArray(body && body.tools) ? body.tools : []) {
    if (!t || t.type !== 'function' || !t.function || !t.function.name) continue;
    out.push({ name: t.function.name, description: String(t.function.description || '').slice(0, 1000), input_schema: t.function.parameters || { type: 'object', properties: {} } });
  }
  return out;
}
/** PURE: user/assistant text turns from the shell's OpenAI-format history. */
function textTurns(messages) {
  return (Array.isArray(messages) ? messages : []).filter((m) => m && (m.role === 'user' || m.role === 'assistant')).map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((c) => (c && c.text) || '').join(' ') : '' })).filter((m) => m.content.trim());
}

async function authBrain(req, res, persona) {
  if (!eq(req.headers['x-trusted-phone'], A.brainHeaderSecret())) { console.warn(`[phone.llm.${persona}] rejected: bad agent header`); res.status(401).json({ error: 'unauthorized' }); return null; }
  const { token, via } = Call.tokenFromRequest(req.body);
  const claim = Call.verifyToken(token);
  if (!claim) return { st: null, via };
  let st = null;
  try { st = await Call.loadCall(sb(), claim.sid); } catch (e) { console.error(`[phone.llm.${persona}] session load failed:`, e.message); }
  if (st && st.via !== via) { st.via = via; console.log('[phone] session token arrives via', JSON.stringify({ session_id: st.sid, via })); }
  return { st, via };
}
const NO_SESSION = 'Sorry, I am having trouble on my end and cannot help on this call right now. Please call back in a few minutes.';
async function noteActive(st, persona) {
  if (st.active === persona) return;
  st.active = persona;
  const { error } = await sb().from('claire_sessions').update({ active_persona: persona }).eq('id', st.sid);
  if (error) console.warn('[phone] active persona write failed:', error.message);
}

// Claire: the SAME pipeline as portal Claire (lib/voice/reason.js streamTurn). Her phone tools minus
// the two that read private records the old way (superseded by the shared lookups under the principal).
const PHONE_EXCLUDED = new Set(['get_ar_for_property', 'get_homeowner_contact_history']);
router.post(['/llm/claire/chat/completions', '/llm/claire'], express.json({ limit: '512kb' }), async (req, res) => {
  const t0 = Date.now();
  const auth = await authBrain(req, res, 'claire'); if (!auth) return;
  const out = sse(res, 'trusted-claire-phone');
  const { st } = auth;
  if (!st || !anthropic()) { out.text(NO_SESSION); return out.end(); }
  noteActive(st, 'claire');
  const supabase = sb();
  const { streamTurn, PASSTHROUGH_CONTROL_MARKER } = require('../lib/voice/reason');
  const { VOICE_TOOLS, VOICE_TOOL_HANDLERS } = require('../lib/voice/tools');
  const Lookups = require('../lib/lookups');
  const gate = require('../lib/voice/private_gate');
  const turns = textTurns(req.body.messages);
  const lastUser = turns.map((m) => m.role).lastIndexOf('user');
  const utterance = lastUser >= 0 ? turns[lastUser].content : '(The caller was just handed back to you. Pick up where the conversation left off in one short sentence.)';
  const history = (lastUser >= 0 ? turns.slice(0, lastUser) : turns);
  const shell = shellTools(req.body);
  const principal = await Call.principalFor(supabase, st);
  const lookups = principal && principal.kind === 'homeowner' ? Lookups.toolsFor(principal).filter((t) => ['my_account', 'homeowner_transactions'].includes(t.name)) : [];
  const handlers = { ...VOICE_TOOL_HANDLERS, ...Call.verifyHandlers(supabase, st, 'claire') };
  for (const t of lookups) handlers[t.name] = (input) => Lookups.runLookup(t.name, principal, input || {});
  const verifiedPid = gate.phoneVerifiedPropertyId(st);
  let caller = null;
  if (verifiedPid && st.homeowner) {
    let account_context = '';
    try {
      const CC = require('../lib/claire/caller_context');
      account_context = CC.callerContextPrompt(await CC.loadCallerContext(verifiedPid, { includeBalance: principal ? principal.capabilities.has('homeowner_ledger') : false })) || '';
    } catch (e) { console.warn('[phone] caller context failed:', e.message); }
    const first = String(st.homeowner.name || '').trim().split(/\s+/)[0] || null;
    caller = { first_name: first, full_name: st.homeowner.name || null, property_address: st.homeowner.address, property_id: verifiedPid, residency_type: 'owner_occupied', account_context, property: { id: verifiedPid, community_id: st.community && st.community.id } };
  }
  const phoneDirective = verifiedPid
    ? '=== THIS CALLER IS VERIFIED ===\nThey proved they own the home in WHO\'S CALLING with a code texted to the phone on file. Their own account is open to you through my_account and homeowner_transactions. Only that home.\nWhen Ed Gojara, a Bedrock employee, a board member or a vendor is calling, or they ask for a manager or Amanda, hand the call to Amanda with transfer_to_agent after one short sentence. She sees this whole call. When they are done, say goodbye and use end_call.'
    : '=== VERIFICATION IS AVAILABLE ON THIS CALL (this replaces the line saying private information is not available on the phone) ===\nWhen the caller wants their OWN account (balance, payments, violations, ACC, letters), offer to text a one-time code to the phone number on file for the owner of their home. Ask for their street address, call verify_caller, then ask them to read the code and call check_code. Until check_code says verified, nothing private is available and you say nothing private. Never say or confirm which phone number is on file, and never repeat a code back.\nWhen Ed Gojara, a Bedrock employee, a board member or a vendor is calling, or they ask for a manager or Amanda, hand the call to Amanda with transfer_to_agent after one short sentence. She sees this whole call, so they never repeat themselves. When they are done, say goodbye and use end_call.';
  const ctrl = { aborted: false };
  res.on('close', () => { if (!res.writableEnded) ctrl.aborted = true; });
  let spoken = ''; let firstAt = null; let passthrough = null; let error = null;
  try {
    for await (const piece of streamTurn({
      utterance, history, community: st.community, caller, caller_phone: st.caller_phone, abort: ctrl, channel: 'phone',
      tools: [...VOICE_TOOLS.filter((t) => !PHONE_EXCLUDED.has(t.name)), ...Call.CLAIRE_VERIFY_TOOLS, ...lookups, ...shell],
      toolHandlers: handlers, passthroughToolNames: shell.map((t) => t.name), phone_verification: st.phone_verification || undefined, phoneDirective,
    })) {
      if (ctrl.aborted) break;
      if (piece && typeof piece === 'object' && piece[PASSTHROUGH_CONTROL_MARKER]) { passthrough = { name: piece.toolName, input: piece.toolArgs }; break; }
      if (typeof piece !== 'string' || !piece.trim()) continue;
      if (!firstAt) firstAt = Date.now();
      const text = piece.replace(/[—–]/g, ', ');
      out.text((spoken ? ' ' : '') + text); spoken += (spoken ? ' ' : '') + text;
    }
  } catch (e) { error = e.message; console.error('[phone.llm.claire] turn failed:', e.message); }
  if (!spoken && error && !passthrough) { spoken = 'Sorry, I lost that for a second. Could you say it again?'; out.text(spoken); }
  if (passthrough) out.tool(passthrough.name, passthrough.input); else out.end();
  logTurn(st, { userText: lastUser >= 0 ? utterance : null, spoken, persona: 'claire', latency: firstAt ? firstAt - t0 : null, passthrough, error });
  console.log('[phone.llm.claire] turn', JSON.stringify({ session_id: st.sid, first_text_ms: firstAt ? firstAt - t0 : null, total_ms: Date.now() - t0, verified: !!verifiedPid, passthrough: passthrough ? passthrough.name : null, error }));
});

function logTurn(st, { userText, spoken, persona, latency, passthrough, error }) {
  st.conv.chain = st.conv.chain.then(async () => {
    const rows = [];
    if (userText) rows.push({ session_id: st.sid, seq: ++st.conv.seq, speaker: 'visitor', text: String(userText).slice(0, 4000) });
    rows.push({ session_id: st.sid, seq: ++st.conv.seq, speaker: 'teammate', persona, text: String(spoken || '').slice(0, 4000), latency_ms: latency, tool_calls: passthrough || error ? { passthrough: passthrough || undefined, error: error || undefined } : null });
    const { error: wErr } = await sb().from('claire_session_turns').insert(rows);
    if (wErr) console.warn('[phone] transcript write failed', JSON.stringify({ session_id: st.sid, error: wErr.message }));
  }).catch((e) => console.warn('[phone] transcript chain failed:', e.message));
}

// Amanda: the SAME engine as Talk to Amanda, with the verified caller's principal.
router.post(['/llm/amanda/chat/completions', '/llm/amanda'], express.json({ limit: '512kb' }), async (req, res) => {
  const t0 = Date.now();
  const auth = await authBrain(req, res, 'amanda'); if (!auth) return;
  const out = sse(res, 'trusted-amanda-phone');
  const { st } = auth;
  if (!st || !anthropic()) { out.text(NO_SESSION); return out.end(); }
  noteActive(st, 'amanda');
  const supabase = sb();
  const C = require('../lib/amanda/conversation');
  const shell = shellTools(req.body);
  const principal = await Call.principalFor(supabase, st);
  if (principal && principal.kind === 'homeowner' && st.homeowner) st.conv.briefing = { ...st.conv.briefing, text: `The caller is the verified owner of ${st.homeowner.address || 'their home'}${st.community ? ` in ${st.community.name}` : ''}. Claire verified them earlier on this call. You have only their own account.` };
  const messages = textTurns(req.body.messages);
  if (messages.length && messages[0].role === 'assistant') messages.unshift({ role: 'user', content: '(The call connected.)' });
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
  const expressive = !!require('../lib/characters/voice_models').conversationModelFor('amanda').expressive;
  const r = await C.runTurn({ supabase, anthropic: anthropic(), sessionId: st.sid, state: st.conv, messages, signal: ctrl.signal, channel: 'phone', expressive,
    phone: { principal, extraTools: [...Call.AMANDA_VERIFY_TOOLS, ...shell], extraHandlers: Call.verifyHandlers(supabase, st, 'amanda'), passthrough: new Set(shell.map((t) => t.name)) },
    onText: (t) => out.text(t.replace(/[—–]/g, ', ')) });
  if (r.passthrough) out.tool(r.passthrough.name, r.passthrough.input); else out.end();
  console.log('[phone.llm.amanda] turn', JSON.stringify({ session_id: st.sid, first_text_ms: r.first_text_ms, total_ms: Date.now() - t0, principal: principal ? principal.kind : null, tools: r.tools, passthrough: r.passthrough ? r.passthrough.name : null, error: r.error || null }));
});

// ---- finishing (recovery on the next call, not polling) ---------------------------------------
async function finishStale() {
  const cutoff = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const { data, error } = await sb().from('claire_sessions').select('id, provider_conversation_id, staff_user_id, metrics').eq('surface', 'conversation').eq('channel', 'phone').is('finalized_at', null).lt('started_at', cutoff).order('started_at', { ascending: true }).limit(5);
  if (error) throw error;
  for (const s of data || []) await finishCall(s).catch((e) => console.warn('[phone] finish failed', JSON.stringify({ session_id: s.id, error: e.message })));
}
async function finishCall(s) {
  const V = require('../lib/amanda/voice_elevenlabs');
  let conv = null;
  if (s.provider_conversation_id) { try { conv = await V.getConversation(s.provider_conversation_id); } catch (e) { console.warn('[phone] provider record unavailable:', e.message); } }
  if (conv && conv.status && !['done', 'failed'].includes(conv.status)) return; // still in progress
  const measured = conv ? V.measuredFromConversation(conv) : null;
  const transcript = conv && Array.isArray(conv.transcript) ? conv.transcript.filter((t) => t && t.message).map((t) => `${t.role === 'user' ? 'Caller' : 'AI'}: ${t.message}`).join('\n').slice(0, 60000) : null;
  const callSid = s.metrics && s.metrics.phone && s.metrics.phone.call_sid;
  if (callSid) {
    const { error } = await sb().from('homeowner_calls').update({ status: 'completed', ended_at: new Date().toISOString(), duration_seconds: measured ? Math.round(measured.duration_seconds) : null, full_transcript: transcript, turn_count: measured ? measured.turns : null }).eq('call_sid', callSid);
    if (error) console.warn('[phone] call log finish failed:', error.message);
  }
  const C = require('../lib/amanda/conversation');
  // A verified Bedrock person: Amanda's summary + memory, exactly as after Talk to Amanda.
  if (s.staff_user_id && anthropic()) { await C.finishConversation(sb(), anthropic(), s.id, { provider: 'elevenlabs', measured, endReason: 'phone_call_ended' }); return; }
  const { error } = await sb().from('claire_sessions').update({ finalized_at: new Date().toISOString(), status: 'ended', ended_at: new Date().toISOString(), end_reason: 'phone_call_ended', audio_seconds: measured ? Math.round(measured.duration_seconds) : null, cost_usd: measured ? measured.list_cost_usd : null, metrics: { ...(s.metrics || {}), provider: measured } }).eq('id', s.id).is('finalized_at', null);
  if (error) console.warn('[phone] session finish failed:', error.message);
}

// ---- readiness and setup --------------------------------------------------------------------
router.get('/status', async (req, res) => {
  const who = await requireOwnerOrOps(req, res); if (!who) return;
  const out = { ok: true, base_url: baseUrl(req), elevenlabs: { key: !!process.env.ELEVENLABS_API_KEY }, twilio: null, voices: { claire: !A.voiceFor('claire').error, amanda: !A.voiceFor('amanda').error }, agents: null, numbers: null, init_webhook: null, subscription: null, routes: null };
  out.twilio = await require('../lib/verification').readiness().catch((e) => ({ ok: false, error: e.message }));
  out.env = { TWILIO_ACCOUNT_SID: !!process.env.TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN: !!process.env.TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID: !!process.env.TWILIO_VERIFY_SERVICE_SID, OWNER_MOBILE: !!process.env.OWNER_MOBILE, APP_BASE_URL: !!process.env.APP_BASE_URL, VAPI_WEBHOOK_SECRET: !!process.env.VAPI_WEBHOOK_SECRET };
  if (out.elevenlabs.key) {
    const safe = async (f) => { try { return await f(); } catch (e) { return { error: e.message }; } };
    out.subscription = await safe(() => A.subscription());
    out.agents = await safe(async () => { const ids = await A.resolveAgentIds(); if (!ids) return { exist: false }; return { exist: true, claire: await A.liveAgent(ids.claire_agent_id), amanda: await A.liveAgent(ids.amanda_agent_id), ids }; });
    out.numbers = await safe(() => A.listNumbers());
    out.init_webhook = await safe(async () => { const s = await A.getSettings(); const w = s.conversation_initiation_client_data_webhook; return { url: w && w.url ? String(w.url).split('?')[0] : null, ours: !!(w && w.url && String(w.url).startsWith(`${baseUrl(req)}/api/phone/init`)) }; });
  }
  const { data: routes, error } = await sb().from('voice_phone_routes').select('inbound_phone_number, community_display_name, enabled').limit(50);
  out.routes = error ? { error: error.message } : routes;
  const { data: calls } = await sb().from('claire_sessions').select('id, started_at, active_persona, status, staff_user_id, property_id, metrics').eq('channel', 'phone').eq('surface', 'conversation').order('started_at', { ascending: false }).limit(5);
  out.recent_calls = (calls || []).map((c) => ({ id: c.id, started_at: c.started_at, persona: c.active_persona, status: c.status, verified: c.metrics && c.metrics.phone && c.metrics.phone.verified ? c.metrics.phone.verified.kind : null }));
  res.json(out);
});

router.post('/setup', express.json({ limit: '8kb' }), async (req, res) => {
  const who = await requireOwnerOrOps(req, res); if (!who) return;
  try {
    const base = baseUrl(req);
    const { data: comms, error: cErr } = await sb().from('communities').select('name').order('name').limit(200);
    if (cErr) console.warn('[phone.setup] community names unavailable:', cErr.message);
    const agents = await A.ensureAgents({ baseUrl: base, keywords: (comms || []).map((c) => c.name) });
    if (!agents.ok) return res.status(409).json({ ok: false, step: 'agents', ...agents });
    const webhook = await A.ensureInitWebhook({ baseUrl: base });
    let number = null;
    if ((req.body || {}).connect_test_number) number = await A.ensureTestNumber({ number: A.TEST_NUMBERS[0], claireAgentId: agents.claire_agent_id });
    console.log('[phone.setup]', JSON.stringify({ by: who.ops ? 'ops_key' : 'owner', agents: { ...agents }, webhook, number }));
    res.json({ ok: !!(webhook.ok && (!number || number.ok)), agents, webhook, number });
  } catch (e) {
    console.error('[phone.setup] failed:', e.message);
    res.status(e.code === 'permission' ? 502 : 500).json({ ok: false, error: safeErrorMessage(e) });
  }
});

module.exports = router;
module.exports._test = { shellTools, textTurns, opsKey, finishCall };
