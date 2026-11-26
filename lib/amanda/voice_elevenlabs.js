// ============================================================================
// lib/amanda/voice_elevenlabs.js  (Ed 2026-11-26: Talk to Amanda, stage 1)
// ----------------------------------------------------------------------------
// The VOICE SHELL for Talk to Amanda: ElevenLabs Agents (full-duplex audio,
// turn-taking, barge-in, Amanda's ElevenLabs voice). It owns NO knowledge and
// makes no decisions. Its LLM is "custom-llm" pointed at OUR endpoint
// (/api/amanda/voice/llm/chat/completions), so every word Amanda speaks comes
// from trustEd's brain (lib/amanda/conversation.js). This is the rule earned
// from the GPT-Live-1 test (2026-09-12): the realtime layer is a conversation
// controller, never the knowledge authority.
//
// Uses the EXISTING ELEVENLABS_API_KEY (the key needs ElevenLabs Agents write
// permission). No dashboard setup: the agent is found by name or created, and
// its configuration is re-applied once per server process.
//
// Swappable: the brain endpoint is OpenAI-chat-completions compatible, the same
// contract Vapi's Custom LLM uses, so a different shell is configuration only.
// ============================================================================
const crypto = require('crypto');

const API = 'https://api.elevenlabs.io';
const AGENT_NAME = 'trustEd Amanda (owner conversation)';
const CONFIG_VERSION = '2026-11-26.1';
// Agents list price (elevenlabs.io/pricing/api, fetched 2026-11-26). Minutes inside the plan's
// included allowance cost nothing extra; this is the conservative marginal estimate.
const LIST_USD_PER_MIN = 0.08;

function apiKey() { return process.env.ELEVENLABS_API_KEY || ''; }
function configured() { return !!apiKey(); }

/** The static header the agent sends with every brain request (proves the call came from our agent config). */
function brainHeaderSecret() {
  const base = process.env.STAFF_GATE_SECRET || process.env.SUPABASE_KEY || '';
  if (!base) return '';
  return crypto.createHmac('sha256', base).update('amanda-voice-brain-header-v1').digest('hex');
}

async function el(method, path, body) {
  const key = apiKey();
  if (!key) throw Object.assign(new Error('ELEVENLABS_API_KEY is not set'), { code: 'not_configured' });
  const t0 = Date.now();
  const r = await fetch(API + path, { method, headers: { 'xi-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
  if (!r.ok) {
    const detail = (json && (json.detail && (json.detail.message || json.detail.status || JSON.stringify(json.detail)))) || text.slice(0, 300);
    const err = new Error(`ElevenLabs ${method} ${path.split('?')[0]} failed (${r.status}): ${detail}`);
    err.status = r.status;
    err.code = r.status === 401 || r.status === 403 ? 'permission' : 'provider_error';
    throw err;
  }
  return { json, ms: Date.now() - t0 };
}

/** PURE: the agent configuration (also what tests assert on). */
function agentConfig({ brainUrl, voiceId, headerSecret }) {
  return {
    name: AGENT_NAME,
    tags: ['trusted', 'amanda', `config:${CONFIG_VERSION}`],
    conversation_config: {
      agent: {
        first_message: 'Hi Ed, it\'s Amanda.',
        language: 'en',
        prompt: {
          // Not used for answers: our brain builds Amanda's real prompt on every turn.
          prompt: 'You are the voice of Amanda Albright, Bedrock\'s AI senior community manager. Every reply comes from the trustEd application.',
          llm: 'custom-llm',
          temperature: null,
          custom_llm: { url: brainUrl, model_id: 'trusted-amanda', api_type: 'chat_completions', request_headers: { 'X-Trusted-Voice': headerSecret } },
        },
      },
      tts: { model_id: 'eleven_flash_v2_5', ...(voiceId ? { voice_id: voiceId } : {}) },
      turn: { turn_timeout: 10, turn_eagerness: 'normal' },
      conversation: { max_duration_seconds: 1800 },
    },
    platform_settings: {
      auth: { enable_auth: true },
      overrides: {
        conversation_config_override: { agent: { first_message: true, language: false, prompt: { prompt: false, llm: false } }, tts: { voice_id: false }, conversation: { text_only: false } },
        custom_llm_extra_body: true,
      },
    },
  };
}

let _agent = null; // { id, brainUrl, voiceId, at }
/**
 * Find or create Amanda's agent and make sure it points at this server's brain with Amanda's voice.
 * One provider round trip per process (plus one when the URL or voice changes).
 */
async function ensureAgent({ brainUrl, voiceId }) {
  if (_agent && _agent.brainUrl === brainUrl && _agent.voiceId === voiceId) return { agent_id: _agent.id, cached: true, ms: 0 };
  const t0 = Date.now();
  const headerSecret = brainHeaderSecret();
  if (!headerSecret) throw Object.assign(new Error('no server secret available to sign the voice brain header'), { code: 'not_configured' });
  const cfg = agentConfig({ brainUrl, voiceId, headerSecret });
  let id = process.env.AMANDA_VOICE_AGENT_ID || null;
  if (!id) {
    const { json } = await el('GET', `/v1/convai/agents?search=${encodeURIComponent(AGENT_NAME)}&page_size=10`);
    const hit = ((json && json.agents) || []).find((a) => a.name === AGENT_NAME);
    id = hit ? hit.agent_id : null;
  }
  if (id) await el('PATCH', `/v1/convai/agents/${encodeURIComponent(id)}`, cfg);
  else id = (await el('POST', '/v1/convai/agents/create', cfg)).json.agent_id;
  _agent = { id, brainUrl, voiceId, at: Date.now() };
  return { agent_id: id, cached: false, ms: Date.now() - t0 };
}

/** Can this key manage agents? (One cheap read; a restricted key answers 401/403 here.) */
async function checkAccess() {
  const { json, ms } = await el('GET', `/v1/convai/agents?search=${encodeURIComponent(AGENT_NAME)}&page_size=10`);
  const hit = ((json && json.agents) || []).find((a) => a.name === AGENT_NAME);
  return { ok: true, ms, agent_exists: !!hit };
}

/** A WebRTC conversation token for one conversation (short-lived, single use). */
async function conversationToken(agentId) {
  const { json, ms } = await el('GET', `/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`);
  if (!json || !json.token) throw Object.assign(new Error('ElevenLabs returned no conversation token'), { code: 'provider_error' });
  return { token: json.token, conversation_id: json.conversation_id || null, ms };
}

/** The provider's record of one conversation: status, duration, cost, per-turn metrics. */
async function getConversation(conversationId) {
  const { json } = await el('GET', `/v1/convai/conversations/${encodeURIComponent(conversationId)}`);
  return json;
}

/**
 * PURE: measured numbers from the provider's conversation record. Per-turn metric names are not
 * documented, so every elapsed_time metric is kept under its own key (seconds -> ms).
 */
function measuredFromConversation(conv) {
  if (!conv) return null;
  const md = conv.metadata || {};
  const turns = Array.isArray(conv.transcript) ? conv.transcript : [];
  const perMetric = {};
  for (const t of turns) {
    const m = t && t.conversation_turn_metrics && t.conversation_turn_metrics.metrics;
    if (!m) continue;
    for (const [k, v] of Object.entries(m)) {
      const s = v && typeof v.elapsed_time === 'number' ? v.elapsed_time : null;
      if (s == null) continue;
      (perMetric[k] = perMetric[k] || []).push(Math.round(s * 1000));
    }
  }
  const stats = {};
  for (const [k, arr] of Object.entries(perMetric)) stats[k] = summarize(arr);
  const seconds = Number(md.call_duration_secs) || 0;
  return {
    status: conv.status || null,
    duration_seconds: seconds,
    credits: md.cost == null ? null : Number(md.cost),
    charging: md.charging || null,
    termination_reason: md.termination_reason || null,
    turns: turns.length,
    agent_turns: turns.filter((t) => t.role === 'agent').length,
    interrupted_turns: turns.filter((t) => t.interrupted === true).length,
    turn_metrics_ms: stats,
    list_cost_usd: Math.round(seconds / 60 * LIST_USD_PER_MIN * 10000) / 10000,
  };
}

function summarize(arr) {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const q = (p) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))];
  return { n: a.length, p50: q(0.5), p90: q(0.9), max: a[a.length - 1], mean: Math.round(a.reduce((s, x) => s + x, 0) / a.length) };
}

function _resetForTests() { _agent = null; }

module.exports = { configured, checkAccess, ensureAgent, conversationToken, getConversation, measuredFromConversation, agentConfig, brainHeaderSecret, summarize, AGENT_NAME, CONFIG_VERSION, LIST_USD_PER_MIN, _resetForTests };
