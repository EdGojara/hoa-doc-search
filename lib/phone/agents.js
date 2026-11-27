// ============================================================================
// lib/phone/agents.js  (Ed 2026-11-27, telephone decisions 1, 5, 6, 10, 12)
// ----------------------------------------------------------------------------
// Claire and Amanda on Bedrock's telephone line: two ElevenLabs phone agents
// (the same platform as Talk to Amanda). They own NO knowledge: each agent's LLM
// is "custom-llm" pointed at OUR brain (/api/phone/llm/claire|amanda), so every
// word comes from trustEd. ElevenLabs gives the phone audio, turn-taking,
// interruptions, the Claire <-> Amanda transfer (whole conversation carried
// over), recording and retention.
//
//   inbound call -> ElevenLabs (Twilio number imported, assigned to Claire)
//     -> POST /api/phone/init (conversation initiation webhook): we identify the
//        line and association and issue a signed per-call session token
//     -> every turn: POST /api/phone/llm/<persona>/chat/completions with that token
//
// SAFETY: only numbers in TEST_NUMBERS can be imported or assigned by code
// (Ed 2026-11-27 decision 12: public numbers are never redirected without his
// explicit approval). Migration 418 maps the test number to the demo community.
// Voices come only from the Character Canon (no fallback; a missing approved
// voice stops setup with a plain reason).
// ============================================================================
const crypto = require('crypto');
const V = require('../amanda/voice_elevenlabs');
const VM = require('../characters/voice_models');

const CONFIG_VERSION = '2026-11-27.1';
const AGENTS = {
  claire: { name: 'trustEd Claire (phone)', model_id: 'trusted-claire-phone' },
  amanda: { name: 'trustEd Amanda (phone)', model_id: 'trusted-amanda-phone' },
};
// The ONLY numbers code may route to these agents (migration 418: Bedrock test line -> Drama Creek demo).
const TEST_NUMBERS = Object.freeze(['+18324302956']);
const RETENTION_DAYS = 90; // Ed decision 6: 90 days initially, subject to retention requirements and legal holds.

// The disclosure is the FIRST sentence (Ed decision 5; CLAUDE.md honest-AI rule).
const CLAIRE_FIRST = 'Hi, this is Claire, Bedrock\'s AI assistant for {{community_name}}. This call is recorded. How can I help?';
const AMANDA_FIRST = 'Hi, this is Amanda, Bedrock\'s AI senior community manager. I have everything Claire went over.';
function claireFirstMessage(communityName) {
  return CLAIRE_FIRST.replace('{{community_name}}', communityName || 'your community').replace('assistant for your community', 'assistant');
}

/** A per-deploy secret header the agents send with every brain call (separate from Talk to Amanda's). */
function brainHeaderSecret() {
  const base = process.env.STAFF_GATE_SECRET || process.env.SUPABASE_KEY || '';
  return base ? crypto.createHmac('sha256', base).update('trusted-phone-brain-header-v1').digest('hex') : '';
}
/** The secret in the initiation webhook URL (ElevenLabs webhook headers live in its dashboard secrets). */
function initWebhookKey() {
  const base = process.env.STAFF_GATE_SECRET || process.env.SUPABASE_KEY || '';
  return base ? crypto.createHmac('sha256', base).update('trusted-phone-init-webhook-v1').digest('hex').slice(0, 40) : '';
}

const systemTool = (name, params, description = '') => ({ type: 'system', name, description, params: { system_tool_type: name, ...params } });

/**
 * PURE: one phone agent's configuration (tests assert on it).
 * transferTo: the other agent's id (absent on the very first create, then patched in).
 */
// Speech recognition comes from the shared Amanda agent config (one list, browser + phone).
const asrKeywords = (k) => V.asrKeywords(k);

function agentConfig({ persona, brainUrl, headerSecret, voiceId, ttsModel, expressive = false, transferTo = null, tuning = {}, keywords = [] }) {
  const a = AGENTS[persona];
  if (!a) throw new Error(`unknown phone persona ${persona}`);
  const isClaire = persona === 'claire';
  const builtIn = { end_call: systemTool('end_call', {}) };
  if (transferTo) {
    builtIn.transfer_to_agent = systemTool('transfer_to_agent', {
      transfers: [{
        agent_id: transferTo,
        condition: isClaire
          ? 'The caller is Ed Gojara, a Bedrock employee, a board member or a vendor, asks for Amanda or a manager, or needs an escalation.'
          : 'The caller wants homeowner help: their own account, community rules, amenities, forms, or asks for Claire.',
        delay_ms: 0,
        transfer_message: null,
        enable_transferred_agent_first_message: !isClaire,
      }],
    });
  }
  return {
    name: a.name,
    tags: ['trusted', 'phone', persona, `config:${CONFIG_VERSION}`],
    conversation_config: {
      agent: {
        first_message: isClaire ? CLAIRE_FIRST : AMANDA_FIRST,
        language: 'en',
        dynamic_variables: { dynamic_variable_placeholders: { session_token: '', community_name: 'your community' } },
        prompt: {
          // Not used for answers: our brain builds the real prompt every turn. The session token rides
          // here as a fallback in case the extra body does not arrive (decision 1).
          prompt: `You are the voice of ${isClaire ? 'Claire, Bedrock\'s AI homeowner assistant' : 'Amanda Albright, Bedrock\'s AI senior community manager'}. Every reply comes from the trustEd application.\nPHONE_SESSION={{session_token}}`,
          llm: 'custom-llm',
          temperature: null,
          custom_llm: { url: brainUrl, model_id: a.model_id, api_type: 'chat_completions', request_headers: { 'X-Trusted-Phone': headerSecret } },
          built_in_tools: builtIn,
        },
      },
      // Voice tuning comes from lib/characters/voice_models.js, the same entry Talk to Amanda uses (#503).
      tts: { model_id: ttsModel, voice_id: voiceId, ...(ttsModel === 'eleven_v4_turbo' ? { expressive_mode: !!expressive } : {}), ...(tuning.similarity_boost != null ? { similarity_boost: tuning.similarity_boost } : {}) },
      turn: { turn_timeout: 10, turn_eagerness: 'normal', ...(tuning.speculative_turn != null ? { speculative_turn: !!tuning.speculative_turn } : {}) },
      conversation: { max_duration_seconds: 1800 },
      asr: V.asrConfig(keywords),
    },
    platform_settings: {
      auth: { enable_auth: true },
      overrides: {
        enable_conversation_initiation_client_data_from_webhook: true,
        custom_llm_extra_body: true,
        conversation_config_override: { agent: { first_message: true, language: false, prompt: { prompt: false, llm: false } }, tts: { voice_id: false }, conversation: { text_only: false } },
      },
      privacy: { record_voice: true, retention_days: RETENTION_DAYS },
    },
  };
}

/** The approved Canon voice + conversation model for a persona, or { error }. */
function voiceFor(persona) {
  let id = null;
  try { id = require('../team/roster').canonicalVoiceIdFor(persona); } catch (_) { id = null; }
  if (!id) return { error: `${persona}_voice_not_approved`, detail: `${persona === 'claire' ? 'Claire' : 'Amanda'} has no approved voice in the Character Canon (/admin/characters). Phone setup will not use any other voice.` };
  const conv = VM.conversationModelFor(persona);
  return { voiceId: id, ttsModel: conv.model_id, expressive: !!conv.expressive, tuning: { similarity_boost: conv.similarity_boost, speculative_turn: conv.speculative_turn } };
}

async function findAgentId(name) {
  const { json } = await V.el('GET', `/v1/convai/agents?search=${encodeURIComponent(name)}&page_size=10`);
  const hit = ((json && json.agents) || []).find((x) => x.name === name);
  return hit ? hit.agent_id : null;
}
async function upsert(name, cfg) {
  const id = await findAgentId(name);
  if (id) { await V.el('PATCH', `/v1/convai/agents/${encodeURIComponent(id)}`, cfg); return { id, created: false }; }
  const { json } = await V.el('POST', '/v1/convai/agents/create', cfg);
  return { id: json.agent_id, created: true };
}

const _ensured = { key: null, ids: null };
/**
 * Create or update both phone agents so each points at this server's brain and can transfer to the
 * other. One provider pass per process per (base URL, voices); cached after that.
 */
async function ensureAgents({ baseUrl, keywords = [] }) {
  const cv = voiceFor('claire'); const av = voiceFor('amanda');
  if (cv.error || av.error) return { ok: false, error: (cv.error || av.error), detail: (cv.error ? cv.detail : av.detail), voices: { claire: !cv.error, amanda: !av.error } };
  const headerSecret = brainHeaderSecret();
  if (!headerSecret) return { ok: false, error: 'no_server_secret' };
  const key = JSON.stringify([baseUrl, cv, av, keywords, CONFIG_VERSION]);
  if (_ensured.key === key && _ensured.ids) return { ok: true, cached: true, ...(_ensured.ids) };
  const cfg = (persona, v, transferTo) => agentConfig({ persona, brainUrl: `${baseUrl}/api/phone/llm/${persona}`, headerSecret, voiceId: v.voiceId, ttsModel: v.ttsModel, expressive: v.expressive, tuning: v.tuning || {}, keywords, transferTo });
  // Transfers name the other agent's id, so: make sure both exist, then patch each with the other.
  let claireId = await findAgentId(AGENTS.claire.name);
  let amandaId = await findAgentId(AGENTS.amanda.name);
  if (!claireId) claireId = (await upsert(AGENTS.claire.name, cfg('claire', cv, null))).id;
  if (!amandaId) amandaId = (await upsert(AGENTS.amanda.name, cfg('amanda', av, claireId))).id;
  await V.el('PATCH', `/v1/convai/agents/${encodeURIComponent(claireId)}`, cfg('claire', cv, amandaId));
  await V.el('PATCH', `/v1/convai/agents/${encodeURIComponent(amandaId)}`, cfg('amanda', av, claireId));
  _ensured.key = key; _ensured.ids = { claire_agent_id: claireId, amanda_agent_id: amandaId };
  return { ok: true, cached: false, ..._ensured.ids };
}
/** The two agent ids (cached; found by name without changing anything when not yet cached). */
async function resolveAgentIds() {
  if (_ensured.ids) return _ensured.ids;
  const [c, a] = await Promise.all([findAgentId(AGENTS.claire.name), findAgentId(AGENTS.amanda.name)]);
  if (!c || !a) return null;
  _ensured.ids = { claire_agent_id: c, amanda_agent_id: a };
  return _ensured.ids;
}
function knownAgentIds() { return _ensured.ids ? Object.values(_ensured.ids) : []; }
function personaForAgent(agentId) {
  if (!_ensured.ids || !agentId) return null;
  if (agentId === _ensured.ids.claire_agent_id) return 'claire';
  if (agentId === _ensured.ids.amanda_agent_id) return 'amanda';
  return null;
}

/** What ElevenLabs holds for one agent (read only): voice, model, overrides, privacy, tools. */
async function liveAgent(agentId) {
  const { json } = await V.el('GET', `/v1/convai/agents/${encodeURIComponent(agentId)}`);
  const cc = (json && json.conversation_config) || {}; const ps = (json && json.platform_settings) || {};
  const prompt = (cc.agent && cc.agent.prompt) || {};
  return {
    name: json && json.name,
    tts: { model_id: cc.tts && cc.tts.model_id, voice_id: cc.tts && cc.tts.voice_id, expressive_mode: cc.tts ? cc.tts.expressive_mode : null },
    llm: prompt.llm || null, custom_llm_url: prompt.custom_llm ? prompt.custom_llm.url : null,
    tools: Object.keys(prompt.built_in_tools || {}).filter((k) => prompt.built_in_tools[k]),
    init_webhook_enabled: ps.overrides ? ps.overrides.enable_conversation_initiation_client_data_from_webhook : null,
    extra_body_enabled: ps.overrides ? ps.overrides.custom_llm_extra_body : null,
    privacy: ps.privacy || null,
  };
}

// ---- the workspace initiation webhook ----------------------------------------------
async function getSettings() { return (await V.el('GET', '/v1/convai/settings')).json || {}; }
/**
 * Point the workspace's conversation-initiation webhook at /api/phone/init. Refuses to replace a
 * DIFFERENT URL someone else configured (reports it instead).
 */
async function ensureInitWebhook({ baseUrl }) {
  const want = `${baseUrl}/api/phone/init?k=${initWebhookKey()}`;
  const s = await getSettings();
  const cur = s.conversation_initiation_client_data_webhook || null;
  const curUrl = cur && cur.url ? String(cur.url) : '';
  if (curUrl === want) return { ok: true, changed: false };
  if (curUrl && !curUrl.startsWith(`${baseUrl}/api/phone/init`)) return { ok: false, error: 'workspace_webhook_in_use', detail: `The ElevenLabs workspace already sends initiation data to another address (${curUrl.split('?')[0]}). Not replaced.` };
  await V.el('PATCH', '/v1/convai/settings', { conversation_initiation_client_data_webhook: { url: want, request_headers: {} } });
  const after = await getSettings();
  const ok = !!(after.conversation_initiation_client_data_webhook && after.conversation_initiation_client_data_webhook.url === want);
  return ok ? { ok: true, changed: true } : { ok: false, error: 'webhook_not_saved', detail: 'ElevenLabs accepted the update but does not show the webhook; it may need to be set in the ElevenLabs dashboard (Agents > Settings).' };
}

// ---- the telephone number ------------------------------------------------------------
async function listNumbers() {
  const { json } = await V.el('GET', '/v1/convai/phone-numbers');
  return (Array.isArray(json) ? json : (json && json.phone_numbers) || []).map((n) => ({ id: n.phone_number_id, number: n.phone_number, provider: n.provider, label: n.label, agent_id: n.assigned_agent ? n.assigned_agent.agent_id : null }));
}
/**
 * Make sure the TEST number answers with Claire. Imports it from Twilio (needs TWILIO_ACCOUNT_SID /
 * TWILIO_AUTH_TOKEN on the server; ElevenLabs then points the Twilio number at itself) or reassigns it.
 * Any number not in TEST_NUMBERS is refused.
 */
async function ensureTestNumber({ number, claireAgentId }) {
  if (!TEST_NUMBERS.includes(number)) return { ok: false, error: 'not_a_test_number', detail: 'Only the test line may be connected by code. Public numbers need Ed\'s explicit approval.' };
  const have = (await listNumbers()).find((n) => n.number === number);
  if (have) {
    if (have.agent_id === claireAgentId) return { ok: true, changed: false, phone_number_id: have.id };
    await V.el('PATCH', `/v1/convai/phone-numbers/${encodeURIComponent(have.id)}`, { agent_id: claireAgentId });
    return { ok: true, changed: true, phone_number_id: have.id, reassigned: true };
  }
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return { ok: false, error: 'twilio_credentials_missing', detail: 'The server has no TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN, so the test number cannot be connected to ElevenLabs from here.' };
  const { json } = await V.el('POST', '/v1/convai/phone-numbers', { provider: 'twilio', phone_number: number, label: 'Bedrock TEST line (Drama Creek demo)', sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN, agent_id: claireAgentId });
  return { ok: true, changed: true, phone_number_id: json && json.phone_number_id, imported: true };
}

/** Read-only: the ElevenLabs plan and usage this month (characters; agent minutes are not in this API). */
async function subscription() {
  const { json } = await V.el('GET', '/v1/user/subscription');
  const j = json || {};
  return { tier: j.tier || null, status: j.status || null, character_count: j.character_count, character_limit: j.character_limit, next_reset: j.next_character_count_reset_unix ? new Date(j.next_character_count_reset_unix * 1000).toISOString() : null, billing_period: j.billing_period || null, current_overage: j.current_overage || null };
}

function _resetForTests() { _ensured.key = null; _ensured.ids = null; }

module.exports = { asrKeywords, agentConfig, ensureAgents, resolveAgentIds, ensureInitWebhook, ensureTestNumber, listNumbers, liveAgent, getSettings, subscription, voiceFor, brainHeaderSecret, initWebhookKey, knownAgentIds, personaForAgent, claireFirstMessage, AGENTS, TEST_NUMBERS, RETENTION_DAYS, CONFIG_VERSION, CLAIRE_FIRST, AMANDA_FIRST, _resetForTests };
