// ============================================================================
// api/amanda_voice.js  (Ed 2026-11-26: Talk to Amanda, stage 1)
// ----------------------------------------------------------------------------
// Owner only. The browser talks to the voice shell (ElevenLabs Agents, WebRTC);
// the shell calls OUR brain for every reply. Nothing here approves or executes
// a decision: instructions go through the Amanda request contract and
// approvals stay in the app (lib/authorization/policy.js).
//
//   GET  /api/amanda/voice/status            is everything in place (key, migration, voice)
//   POST /api/amanda/voice/session           start: conversation row + briefing + provider token
//   POST /api/amanda/voice/session/:id/connected   { conversation_id }  the provider's id
//   GET  /api/amanda/voice/session/:id/cards       on-screen cards Amanda raised (fetched on her turns)
//   POST /api/amanda/voice/session/:id/end         { client_metrics }  finish: summary, memory, measured usage
//   GET  /api/amanda/voice/metrics?days=7          measured latency, reliability and cost
//   POST /api/amanda/voice/llm/chat/completions    the BRAIN (called by the voice shell, not the
//        browser): OpenAI-compatible streaming; authenticated by the agent's header secret AND
//        a short-lived token minted for the signed-in owner's conversation.
// ============================================================================
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { requireOwner } = require('./_require_admin');
const { safeErrorMessage } = require('./_safe_error');
const C = require('../lib/amanda/conversation');
const V = require('../lib/amanda/voice_elevenlabs');
const VM = require('../lib/characters/voice_models');

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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_TTL_MS = 45 * 60 * 1000;
const fail = (res, what, err, status = 500) => { console.error(`[amanda.voice] ${what} failed:`, err.message); res.status(status).json({ ok: false, error: safeErrorMessage(err), code: err.code || null }); };

// ---- conversation token (binds a brain request to the owner's conversation) ----------
function secret() { return process.env.STAFF_GATE_SECRET || process.env.SUPABASE_KEY || ''; }
// ex: 1 marks an expressive voice audition, so the brain adds expressive cues for this
// conversation only (signed, so the browser cannot turn it on for a normal session).
function signToken({ sid, uid, ex = false, now = Date.now() }) {
  const body = Buffer.from(JSON.stringify({ sid, uid, exp: now + TOKEN_TTL_MS, ...(ex ? { ex: 1 } : {}) })).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update('amanda-voice-session:' + body).digest('base64url');
  return `${body}.${mac}`;
}
function verifyToken(tok, now = Date.now()) {
  const [body, mac] = String(tok || '').split('.');
  if (!body || !mac || !secret()) return null;
  const want = crypto.createHmac('sha256', secret()).update('amanda-voice-session:' + body).digest('base64url');
  const a = Buffer.from(mac); const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let j; try { j = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { return null; }
  if (!j || !UUID.test(j.sid) || !j.exp || j.exp < now) return null;
  return j;
}
function headerOk(req) {
  const want = V.brainHeaderSecret();
  const got = String(req.headers['x-trusted-voice'] || '');
  if (!want || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

function baseUrl(req) {
  const env = (process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (env) return env;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}
// Amanda's approved canonical voice from the Character Canon, and nothing else:
// never another teammate's voice (Ed 2026-11-26). Null = no approved voice.
function amandaVoiceId() {
  try { return require('../lib/team/roster').canonicalVoiceIdFor('amanda'); } catch (_) { return null; }
}
// Amanda's conversation model for her canonical voice (Ed 2026-11-27: Harper on Eleven v4 Turbo,
// expressive, exactly as auditioned on 2026-11-26). lib/characters/voice_models.js is the one place.
function amandaConversationModel() { return VM.conversationModelFor('amanda'); }
// Owner voice auditions (Ed 2026-11-26): before choosing a permanent voice, Ed tests a candidate
// in a live conversation. Opt-in per session (?audition=<key> on /app/amanda), owner only, closed
// allowlist, never written to the Character Canon. An audition runs on its own ElevenLabs agent
// (V.AUDITION_AGENT_NAME); the shared agent stays on the Canon voice. Empty while no audition runs.
const AUDITION_VOICES = {};
// Auditions that ended because Ed adopted the voice: an old link opens the normal session.
const ADOPTED_AUDITIONS = { harper: 'Harper became the Canon voice for Amanda (Ed 2026-11-27)' };
/** PURE: resolve the session voice. Returns { voiceId, ttsModel, expressive, audition } or { error }. */
function sessionVoice(auditionKey, canonicalId, conv = amandaConversationModel()) {
  let key = String(auditionKey || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(ADOPTED_AUDITIONS, key)) key = '';
  if (!key) return canonicalId ? { voiceId: canonicalId, ttsModel: conv.model_id, expressive: !!conv.expressive, audition: null } : { error: 'voice_not_approved' };
  const a = Object.prototype.hasOwnProperty.call(AUDITION_VOICES, key) ? AUDITION_VOICES[key] : null;
  if (!a) return { error: 'unknown_audition' };
  return { voiceId: a.voice_id, ttsModel: a.tts_model, expressive: !!a.expressive, audition: { key, name: a.name, tts_model: a.tts_model, expressive: !!a.expressive } };
}
// Community names for the recognizer (lib/amanda/voice_elevenlabs asrKeywords), read once per 10 minutes.
let _names = { at: 0, list: [] };
async function communityNames(supabase) {
  if (Date.now() - _names.at < 10 * 60 * 1000) return _names.list;
  const { data, error } = await supabase.from('communities').select('name').order('name').limit(200);
  if (error) { console.warn('[amanda.voice] community names unavailable:', error.message); return _names.list; }
  _names = { at: Date.now(), list: (data || []).map((c) => c.name) };
  return _names.list;
}
function ownerOf(u) { return { user_id: u.user.id, email: u.email, name: u.full_name || null }; }

// The greeting is deterministic (no model call): what changed since last time, from the briefing.
function greeting(st) {
  const first = String((st.owner.name || 'Ed').split(' ')[0]);
  const b = st.briefing.text || '';
  const m = /FINISHED WORK YOU HAVE NOT REPORTED TO HIM YET: (\d+)/.exec(b);
  if (m && Number(m[1]) > 0) return `Hi ${first}. ${Number(m[1]) === 1 ? 'One thing' : 'A few things'} finished since we last talked. Want the rundown, or something else first?`;
  return `Hi ${first}, it's Amanda. What's on your mind?`;
}

// ---- owner routes -------------------------------------------------------------------
router.get('/status', express.json(), async (req, res) => {
  const u = await requireOwner(req, res); if (!u) return;
  const out = { ok: true, provider: 'elevenlabs', key: V.configured(), voice_id: !!amandaVoiceId(), migration: null, agent: null };
  const probe = await sb().from('amanda_memory').select('id').limit(1);
  out.migration = probe.error ? (/amanda_memory|does not exist|schema cache/i.test(probe.error.message) ? 'pending' : probe.error.message) : 'applied';
  if (out.key) { try { out.agent = await V.checkAccess(); } catch (e) { out.agent = { ok: false, code: e.code || null, error: e.message }; } }
  // What ElevenLabs actually holds for the shared agent (voice, model, expressive mode), read only.
  const conv = amandaConversationModel();
  out.conversation_model = { model_id: conv.model_id, expressive: !!conv.expressive };
  if (out.agent && out.agent.agent_id) { try { out.agent.live = await V.getAgentTts(out.agent.agent_id); } catch (e) { out.agent.live = { error: e.message }; } }
  // ?audition=<key>: prepare the separate audition agent and report what ElevenLabs actually holds
  // for it (model, voice, expressive mode). Touches only the audition agent.
  if (out.key && req.query && req.query.audition) {
    const sv = sessionVoice(req.query.audition, null);
    if (sv.error) out.audition = { ok: false, error: sv.error };
    else {
      try {
        const a = await V.ensureAgent({ brainUrl: `${baseUrl(req)}/api/amanda/voice/llm`, voiceId: sv.voiceId, ttsModel: sv.ttsModel, audition: true, expressive: !!sv.expressive });
        const live = await V.getAgentTts(a.agent_id);
        out.audition = { ok: true, key: sv.audition.key, agent_id: a.agent_id, requested: { voice_id: sv.voiceId, tts_model: sv.ttsModel }, live };
      } catch (e) { out.audition = { ok: false, code: e.code || null, error: e.message }; }
    }
  }
  // ?compare=1: the shared agent's and the (retired) audition agent's full voice settings, read only.
  if (out.key && req.query && req.query.compare) {
    try { out.compare = await Promise.all([V.AGENT_NAME, V.AUDITION_AGENT_NAME].map((n) => V.describeAgentByName(n))); } catch (e) { out.compare = { error: e.message }; }
  }
  res.json(out);
});

router.post('/session', express.json({ limit: '16kb' }), async (req, res) => {
  const u = await requireOwner(req, res); if (!u) return;
  const t0 = Date.now(); const timings = {};
  try {
    if (!V.configured()) return res.status(503).json({ ok: false, code: 'not_configured', error: 'The ElevenLabs key is not set on the server.' });
    if (!anthropic()) return res.status(503).json({ ok: false, code: 'not_configured', error: 'The model key is not set on the server.' });
    const supabase = sb(); const owner = ownerOf(u);
    // Recovery, not polling: a conversation left open by a closed tab is finished when the next one starts.
    finishAbandoned(supabase, owner.user_id).catch((e) => console.warn('[amanda.voice] abandoned cleanup failed:', e.message));
    const sv = sessionVoice((req.body || {}).audition, amandaVoiceId());
    if (sv.error === 'unknown_audition') return res.status(400).json({ ok: false, code: 'unknown_audition', error: `No voice audition is set up under that name. Available: ${Object.keys(AUDITION_VOICES).join(', ') || 'none'}.` });
    if (sv.error) return res.status(409).json({ ok: false, code: 'voice_not_approved', error: 'Amanda has no approved voice in the Character Canon (/admin/characters).' });
    const { voiceId, ttsModel, expressive, audition } = sv;
    if (audition) console.log('[amanda.voice] voice audition session', JSON.stringify({ audition: audition.key, tts_model: ttsModel }));
    const brainUrl = `${baseUrl(req)}/api/amanda/voice/llm`;
    const [agent, started] = await Promise.all([
      communityNames(supabase).then((keywords) => V.ensureAgent({ brainUrl, voiceId, ttsModel, audition: !!audition, expressive: !!expressive, keywords, tuning: audition ? {} : { similarity_boost: amandaConversationModel().similarity_boost, speculative_turn: amandaConversationModel().speculative_turn } })).then((a) => { timings.agent_ms = a.ms; return a; }),
      C.startConversation(supabase, { owner, channel: 'voice', provider: 'elevenlabs' }).then((s) => { timings.briefing_ms = s.briefing_ms; return s; }),
    ]);
    const tok = await V.conversationToken(agent.agent_id);
    timings.token_ms = tok.ms;
    if (tok.conversation_id) await supabase.from('claire_sessions').update({ provider_conversation_id: tok.conversation_id }).eq('id', started.session.id);
    const st = C.peekState(started.session.id);
    timings.total_ms = Date.now() - t0;
    st.startTimings = timings;
    console.log('[amanda.voice] session started', JSON.stringify({ session_id: started.session.id, ...timings, briefing_errors: Object.keys(started.briefing_errors || {}) }));
    res.json({ ok: true, audition, voice: { tts_model: ttsModel, expressive: !!expressive }, session_id: started.session.id, conversation_token: tok.token, session_token: signToken({ sid: started.session.id, uid: owner.user_id, ex: !!expressive }), first_message: greeting(st), timings, briefing_incomplete: Object.keys(started.briefing_errors || {}) });
  } catch (e) {
    const code = e.code === 'migration_pending' ? 409 : e.code === 'permission' ? 502 : e.code === 'not_configured' ? 503 : 500;
    if (e.code === 'permission') e.message = `ElevenLabs refused the request. The server's ElevenLabs key needs the "ElevenLabs Agents" write permission. (${e.message})`;
    if (e.code === 'migration_pending') e.message = 'Talk to Amanda needs migration 578 applied on the Systems page.';
    fail(res, 'session start', e, code);
  }
});

router.post('/session/:id/connected', express.json({ limit: '8kb' }), async (req, res) => {
  const u = await requireOwner(req, res); if (!u) return;
  if (!UUID.test(req.params.id)) return res.status(400).json({ ok: false, error: 'bad_id' });
  const cid = String((req.body || {}).conversation_id || '').slice(0, 120);
  if (!cid) return res.status(400).json({ ok: false, error: 'conversation_id_required' });
  const { error } = await sb().from('claire_sessions').update({ provider_conversation_id: cid }).eq('id', req.params.id).eq('staff_user_id', u.user.id).eq('surface', 'conversation');
  if (error) return fail(res, 'connected', error);
  res.json({ ok: true });
});

router.get('/session/:id/cards', async (req, res) => {
  const u = await requireOwner(req, res); if (!u) return;
  const st = C.peekState(req.params.id);
  if (!st || st.owner.user_id !== u.user.id) return res.json({ ok: true, cards: [] });
  res.json({ ok: true, cards: st.cards.slice(-12) });
});

router.post('/session/:id/end', express.json({ limit: '32kb' }), async (req, res) => {
  const u = await requireOwner(req, res); if (!u) return;
  if (!UUID.test(req.params.id)) return res.status(400).json({ ok: false, error: 'bad_id' });
  const { data: s, error } = await sb().from('claire_sessions').select('id, staff_user_id, provider_conversation_id, finalized_at').eq('id', req.params.id).eq('surface', 'conversation').maybeSingle();
  if (error) return fail(res, 'end lookup', error);
  if (!s || s.staff_user_id !== u.user.id) return res.status(404).json({ ok: false, error: 'not_found' });
  if (s.finalized_at) return res.json({ ok: true, already: true });
  const client = sanitizeClientMetrics((req.body || {}).client_metrics);
  const cid = String((req.body || {}).conversation_id || '').slice(0, 120) || s.provider_conversation_id;
  if (cid && cid !== s.provider_conversation_id) await sb().from('claire_sessions').update({ provider_conversation_id: cid }).eq('id', s.id);
  res.status(202).json({ ok: true, finishing: true });
  finishWithProvider(s.id, cid, { client, endReason: String((req.body || {}).reason || 'ended').slice(0, 40) }).catch((e) => console.error('[amanda.voice] finish failed:', e.message));
});

router.get('/metrics', async (req, res) => {
  const u = await requireOwner(req, res); if (!u) return;
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    const since = new Date(Date.now() - days * 86400e3).toISOString();
    const { data, error } = await sb().from('claire_sessions').select('id, started_at, ended_at, status, end_reason, audio_seconds, cost_usd, metrics, summary').eq('surface', 'conversation').eq('staff_user_id', u.user.id).gte('started_at', since).order('started_at', { ascending: false }).limit(200);
    if (error) throw error;
    res.json({ ok: true, days, ...aggregateMetrics(data || []) });
  } catch (e) { fail(res, 'metrics', e); }
});

// ---- the brain ----------------------------------------------------------------------
router.post(['/llm/chat/completions', '/llm'], express.json({ limit: '512kb' }), async (req, res) => {
  const t0 = Date.now();
  if (!headerOk(req)) { console.warn('[amanda.voice.llm] rejected: bad agent header'); return res.status(401).json({ error: 'unauthorized' }); }
  const body = req.body || {};
  const extra = body.elevenlabs_extra_body || body.custom_llm_extra_body || {};
  const claim = verifyToken(extra.session_token);
  if (!claim) { console.warn('[amanda.voice.llm] rejected: missing or expired conversation token'); return res.status(401).json({ error: 'conversation_token_invalid' }); }
  let state;
  try { state = await C.loadState(sb(), claim.sid); } catch (e) { return fail(res, 'brain state', e); }
  if (!state || state.owner.user_id !== claim.uid) return res.status(404).json({ error: 'conversation_not_found' });
  const ai = anthropic();
  if (!ai) return res.status(503).json({ error: 'model_unavailable' });

  const stream = body.stream !== false;
  const id = `chatcmpl-${crypto.randomBytes(8).toString('hex')}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'trusted-amanda', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
  if (stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(chunk({ role: 'assistant' }));
  }
  let full = '';
  const out = await C.runTurn({ supabase: sb(), anthropic: ai, sessionId: claim.sid, state, messages: body.messages, signal: ctrl.signal, channel: 'voice', expressive: claim.ex === 1,
    onText: (t) => { full += t; if (stream && !res.writableEnded) res.write(chunk({ content: t })); } });
  if (stream) { if (!res.writableEnded) { res.write(chunk({}, 'stop')); res.write('data: [DONE]\n\n'); res.end(); } }
  else res.json({ id, object: 'chat.completion', created, model: 'trusted-amanda', choices: [{ index: 0, message: { role: 'assistant', content: full }, finish_reason: 'stop' }] });
  console.log('[amanda.voice.llm] turn', JSON.stringify({ session_id: claim.sid, first_text_ms: out.first_text_ms, total_ms: out.total_ms, handler_ms: Date.now() - t0, tools: out.tools, model_calls: out.model_calls, interrupted: out.interrupted, error: out.error || null }));
});

// ---- finishing ----------------------------------------------------------------------
const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
/** Bounded: the provider's record is usually ready within seconds of hang-up; three tries, then finish without it. */
async function finishWithProvider(sessionId, conversationId, { client = null, endReason = 'ended' } = {}) {
  let measured = null; let providerError = null;
  if (conversationId && V.configured()) {
    for (const delay of [2500, 6000, 15000]) {
      await waitMs(delay);
      try {
        const conv = await V.getConversation(conversationId);
        measured = V.measuredFromConversation(conv);
        if (conv && (conv.status === 'done' || conv.status === 'failed')) break;
      } catch (e) { providerError = e.message; }
    }
  }
  if (providerError && !measured) console.warn('[amanda.voice] provider record unavailable', JSON.stringify({ session_id: sessionId, error: providerError }));
  return C.finishConversation(sb(), anthropic(), sessionId, { provider: 'elevenlabs', measured: measured || (providerError ? { error: providerError } : null), endReason, clientMetrics: client });
}

async function finishAbandoned(supabase, ownerUserId) {
  const cutoff = new Date(Date.now() - 35 * 60 * 1000).toISOString();
  const { data, error } = await supabase.from('claire_sessions').select('id, provider_conversation_id').eq('surface', 'conversation').eq('staff_user_id', ownerUserId).is('finalized_at', null).lt('started_at', cutoff).limit(5);
  if (error) throw error;
  for (const s of data || []) await finishWithProvider(s.id, s.provider_conversation_id, { endReason: 'abandoned' });
}

// ---- measurements -------------------------------------------------------------------
function sanitizeClientMetrics(m) {
  if (!m || typeof m !== 'object') return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  const arr = (v) => (Array.isArray(v) ? v.slice(0, 200).map(num).filter((x) => x != null && x >= 0 && x < 120000) : []);
  return { connect_ms: num(m.connect_ms), session_api_ms: num(m.session_api_ms), response_gap_ms: arr(m.response_gap_ms), interruptions: num(m.interruptions), errors: Array.isArray(m.errors) ? m.errors.slice(0, 10).map((e) => String(e).slice(0, 200)) : [], disconnect_reason: m.disconnect_reason ? String(m.disconnect_reason).slice(0, 40) : null, user_agent_mobile: !!m.mobile };
}

/** PURE: roll conversations up into the measured numbers the owner asked for. */
function aggregateMetrics(rows) {
  const S = V.summarize;
  const fin = rows.filter((r) => r.metrics);
  const pick = (f) => fin.flatMap((r) => { try { return f(r.metrics) || []; } catch (_) { return []; } });
  const brainTurns = fin.reduce((s, r) => s + ((r.metrics.brain && r.metrics.brain.turns) || 0), 0);
  const brainFailed = fin.reduce((s, r) => s + ((r.metrics.brain && r.metrics.brain.failed) || 0), 0);
  const minutes = rows.reduce((s, r) => s + (Number(r.audio_seconds) || 0), 0) / 60;
  const cost = rows.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
  const modelCost = fin.reduce((s, r) => s + ((r.metrics.model && Number(r.metrics.model.cost_usd)) || 0), 0);
  const providerMetricKeys = new Set(pick((m) => Object.keys((m.provider && m.provider.turn_metrics_ms) || {})));
  const providerTurn = {};
  for (const k of providerMetricKeys) providerTurn[k] = S(pick((m) => { const x = m.provider && m.provider.turn_metrics_ms && m.provider.turn_metrics_ms[k]; return x ? [x.p50] : []; }));
  return {
    conversations: rows.length, finished: fin.length, failed_to_connect: rows.filter((r) => r.end_reason === 'connect_failed').length, abandoned: rows.filter((r) => r.end_reason === 'abandoned').length,
    minutes: Math.round(minutes * 10) / 10,
    turns: brainTurns, failed_turns: brainFailed, turn_failure_rate: brainTurns ? Math.round(brainFailed / brainTurns * 1000) / 10 : null,
    interruptions: fin.reduce((s, r) => s + ((r.metrics.brain && r.metrics.brain.interrupted) || 0), 0),
    latency_ms: {
      heard_to_amanda_speaking: S(pick((m) => (m.client && m.client.response_gap_ms) || [])),
      brain_first_words: S(pick((m) => (m.brain && m.brain.first_text_ms ? [m.brain.first_text_ms.p50] : []))),
      brain_first_words_no_tools: S(pick((m) => (m.brain && m.brain.first_text_no_tools_ms ? [m.brain.first_text_no_tools_ms.p50] : []))),
      tool_round: S(pick((m) => (m.brain && m.brain.tool_round_ms ? [m.brain.tool_round_ms.p50] : []))),
      connect: S(pick((m) => (m.client && m.client.connect_ms != null ? [m.client.connect_ms] : []))),
      provider_turn_metrics_p50: providerTurn,
    },
    cost_usd: { total: Math.round(cost * 10000) / 10000, model: Math.round(modelCost * 10000) / 10000, voice_at_list_price: Math.round((cost - modelCost) * 10000) / 10000, per_minute: minutes ? Math.round(cost / minutes * 10000) / 10000 : null },
    provider_credits: fin.reduce((s, r) => s + ((r.metrics.provider && Number(r.metrics.provider.credits)) || 0), 0),
    recent: rows.slice(0, 10).map((r) => ({ started_at: r.started_at, minutes: r.audio_seconds ? Math.round(r.audio_seconds / 6) / 10 : null, cost_usd: r.cost_usd, end_reason: r.end_reason, summary: r.summary ? String(r.summary).slice(0, 200) : null })),
  };
}

module.exports = router;
module.exports._test = { signToken, verifyToken, aggregateMetrics, sanitizeClientMetrics, greeting, sessionVoice, AUDITION_VOICES, ADOPTED_AUDITIONS };
