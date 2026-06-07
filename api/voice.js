// ============================================================================
// api/voice.js — Twilio voice webhook + WebSocket bridge entry point
// ----------------------------------------------------------------------------
// Mounted at /api/voice.
//
// Endpoints:
//   POST /api/voice/incoming        Twilio webhook — incoming call. Returns
//                                   TwiML with <Connect><Stream> pointing at
//                                   our WebSocket bridge.
//   POST /api/voice/status          Twilio webhook — call status updates
//                                   (ringing → in-progress → completed).
//                                   Used to keep homeowner_calls in sync.
//   WS   /api/voice/stream          WebSocket endpoint Twilio Media Streams
//                                   connects to. Bridged to lib/voice/bridge.js.
//
// The WebSocket upgrade is wired in server.js — see the
// `server.on('upgrade', ...)` block — because attaching to the same HTTP
// server keeps everything on one port.
// ============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { CallBridge } = require('../lib/voice/bridge');
const { streamTurn, PASSTHROUGH_CONTROL_MARKER } = require('../lib/voice/reason');
const { VOICE_TOOLS, VOICE_TOOL_HANDLERS } = require('../lib/voice/tools');
const { buildOpener } = require('../lib/voice/persona');
const { buildIsabellaSystemPromptParts } = require('../lib/voice/reason_isabella');
const {
  buildOpener: buildIsabellaOpener,
  BANNED_PATTERNS: ISABELLA_BANNED_PATTERNS,
} = require('../lib/voice/persona_isabella');
const { resolveCallerByPhone } = require('../lib/voice/caller_lookup');

// Isabella's persona pack — passed into streamTurn to swap the system prompt
// builder + the language-specific banned-phrase list. Claire is the implicit
// default when no personaPack is supplied. See lib/voice/reason.js streamTurn
// and project_multilingual_voice_architecture.md.
const ISABELLA_PERSONA_PACK = {
  buildSystemPromptParts: buildIsabellaSystemPromptParts,
  bannedPatterns: ISABELLA_BANNED_PATTERNS,
};
const { buildCommunityContextBlock } = require('./communities');
const { getCall: cacheGet, setCall: cacheSet, clearCall: cacheClear } = require('../lib/voice/call_cache');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

// Twilio sends webhooks as application/x-www-form-urlencoded by default.
// We need this parser specifically for the voice routes.
router.use(express.urlencoded({ extended: false, limit: '64kb' }));

// ----------------------------------------------------------------------------
// POST /api/voice/incoming — Twilio webhook for a new inbound call
// ----------------------------------------------------------------------------
// Returns TwiML that opens a bidirectional Media Stream to our WebSocket.
// Custom parameters (call_sid, to_phone) ride along so the bridge knows
// which community to scope to.
// ----------------------------------------------------------------------------
router.post('/incoming', async (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const fromPhone = req.body.From;
    const toPhone = req.body.To;

    console.log(`[voice/incoming] call ${callSid} from ${fromPhone} to ${toPhone}`);

    // PREREQUISITES CHECK — Claire needs Deepgram (STT) + ElevenLabs (TTS) +
    // Anthropic (reasoning) all configured to hold a real conversation.
    // If any are missing, we play a clear "under construction" message via
    // Twilio's built-in TTS rather than opening a WebSocket that will
    // immediately close and drop the caller — which is what's confusingly
    // sounds like "the call just disconnects."
    const haveDeepgram = !!process.env.DEEPGRAM_API_KEY;
    const haveElevenLabs = !!process.env.ELEVENLABS_API_KEY;
    const haveAnthropic = !!process.env.ANTHROPIC_API_KEY;

    if (!haveDeepgram || !haveElevenLabs || !haveAnthropic) {
      const missing = [];
      if (!haveDeepgram) missing.push('Deepgram');
      if (!haveElevenLabs) missing.push('ElevenLabs');
      if (!haveAnthropic) missing.push('Anthropic');
      console.log(`[voice/incoming] dev fallback — missing: ${missing.join(', ')}`);

      // Friendly TwiML using Twilio's built-in Polly TTS. Doesn't open the
      // Media Stream, just speaks and hangs up gracefully.
      const fallbackTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">Hey, this is Claire from Bedrock. The voice system is still being set up, so I'm not able to take a real call yet. Please try again in a day or two, or email info at bedrock t x dot com. Thanks for your patience.</Say>
  <Hangup/>
</Response>`;
      return res.set('Content-Type', 'text/xml').send(fallbackTwiml);
    }

    // STEP 1 — voice_phone_routes lookup (Model B: dedicated number per
    // community). If no route is configured for this number, fall back to
    // the caller-ID lookup below.
    let route = null;
    try {
      const { data } = await supabase
        .from('voice_phone_routes')
        .select('*')
        .eq('inbound_phone_number', toPhone)
        .eq('enabled', true)
        .maybeSingle();
      route = data || null;
    } catch (e) {
      console.warn('[voice/incoming] route lookup failed:', e.message);
    }

    // STEP 2 — caller-ID lookup against contacts table (Model A: one Bedrock
    // number, identify who's calling by their phone). This is the killer
    // feature — Claire greets by first name and already knows their
    // community + property without the caller saying a word.
    //
    // Privacy/security note: caller ID can be spoofed. We use this match
    // for *context* (greeting, community routing) but Claire still verifies
    // identity before sharing sensitive info (AR balance, payment info,
    // ARC outcomes). Handled in the system prompt, not here.
    let callerContact = null;
    let callerProperty = null;
    let callerCommunity = null;
    if (fromPhone) {
      try {
        // Normalize Twilio's E.164 (e.g., "+18324302956") → last 10 digits
        const digits = String(fromPhone).replace(/\D/g, '');
        const last10 = digits.length === 11 && digits.startsWith('1')
          ? digits.slice(1)
          : (digits.length === 10 ? digits : null);

        if (last10) {
          // ILIKE %last10% catches all common phone formats stored in the DB:
          //   "832-430-2956", "(832) 430-2956", "+18324302956", "8324302956"
          const { data: candidates } = await supabase
            .from('contacts')
            .select('id, full_name, preferred_name, primary_phone, secondary_phone, notification_phone')
            .or(`primary_phone.ilike.%${last10}%,secondary_phone.ilike.%${last10}%,notification_phone.ilike.%${last10}%`)
            .limit(5);

          // Filter to EXACT match — guard against coincidental substring
          // collisions (e.g., last10="1234567890" matching "+15551234567890").
          callerContact = (candidates || []).find((c) => {
            for (const f of ['primary_phone', 'secondary_phone', 'notification_phone']) {
              const d = String(c[f] || '').replace(/\D/g, '').slice(-10);
              if (d === last10) return true;
            }
            return false;
          }) || null;

          if (callerContact) {
            console.log(`[voice/incoming] caller-ID match: ${callerContact.preferred_name || callerContact.full_name} (id=${callerContact.id})`);

            // Look up their primary property + community via property_residencies
            const { data: residency } = await supabase
              .from('property_residencies')
              .select('property_id, residency_type, properties:property_id(id, street_address, community_id, communities:community_id(id, name))')
              .eq('contact_id', callerContact.id)
              .is('end_date', null)  // current residencies only
              .order('start_date', { ascending: false })
              .limit(1)
              .maybeSingle();

            if (residency?.properties) {
              callerProperty = residency.properties;
              callerCommunity = residency.properties.communities || null;
              // Attach residency_type so the bridge can pass it through to
              // Claire's prompt. Without this, she defaults to asking
              // "are you the homeowner or renting?" — but the system
              // already knows. Encode-Ed miss caught by Ed 2026-06-08
              // during his own test call ("I was needing to get a key fob").
              callerProperty.residency_type = residency.residency_type || null;
            }
          }
        }
      } catch (e) {
        console.warn('[voice/incoming] caller-ID lookup failed:', e.message);
      }
    }

    // ========================================================================
    // PRE-CALL CONTEXT WARMUP (Ed 2026-06-08)
    // ------------------------------------------------------------------------
    // When we identified the caller via caller-ID, fire parallel queries to
    // pull what Ed would already know if HE were picking up the phone:
    //   - Current AR balance (any recent payment? any arrears?)
    //   - Any open violations on the property
    //   - Any open ACC submissions
    //   - Recent calls in the last 30 days (continuation? repeat issue?)
    //
    // Result: Claire's first response can already be specific. Encode-Ed
    // pattern at its purest — the system shows up informed instead of
    // asking the caller to re-explain context from prior interactions.
    //
    // Timeboxed to 800ms total via Promise.race so a slow query never
    // delays the opener. Worst case: warmup is empty, opener falls back
    // to the generic flow.
    // ========================================================================
    let callerWarmup = null;
    if (callerContact && callerProperty) {
      try {
        const warmupPromise = (async () => {
          const propId = callerProperty.id;
          // 3 parallel queries. ACC/ARC was considered but the schema is in
          // flux (arc_historical_decisions vs acc_decisions, different
          // property linkage patterns). Skipping for v1 of warmup — add in
          // follow-up once the right ARC source-of-truth is settled.
          const [arRes, violationsRes, recentCallsRes] = await Promise.allSettled([
            supabase
              .from('owner_ar_snapshots')
              .select('balance_total, snapshot_date, enforcement_stage, at_legal, in_collections, payment_plan_active')
              .eq('property_id', propId)
              .order('snapshot_date', { ascending: false })
              .limit(1)
              .maybeSingle(),
            supabase
              .from('violations')
              .select('id, primary_category_id, current_stage, opened_at')
              .eq('property_id', propId)
              .is('closed_at', null)
              .order('opened_at', { ascending: false })
              .limit(3),
            supabase
              .from('homeowner_calls')
              .select('call_sid, started_at, brief, status')
              .eq('caller_homeowner_id', callerContact.id)
              .neq('call_sid', callSid)
              .order('started_at', { ascending: false })
              .limit(3),
          ]);
          const ar = arRes.status === 'fulfilled' ? arRes.value?.data : null;
          const violations = violationsRes.status === 'fulfilled' ? (violationsRes.value?.data || []) : [];
          const acc = []; // intentionally empty — see TODO above
          const recentCallsRaw = recentCallsRes.status === 'fulfilled' ? (recentCallsRes.value?.data || []) : [];
          // Flatten the brief JSONB into a 'summary' field the prompt builder
          // can read directly. Use brief.concern as the primary summary;
          // fall back to answer_or_status if no concern.
          const recentCalls = recentCallsRaw.map(c => ({
            started_at: c.started_at,
            status: c.status,
            summary: c.brief?.concern || c.brief?.answer_or_status || null,
          }));
          return { ar, violations, acc, recentCalls };
        })();
        // Race against an 800ms timeout so we never delay the opener
        const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 800));
        callerWarmup = await Promise.race([warmupPromise, timeout]);
        if (callerWarmup) {
          const summaryParts = [];
          if (callerWarmup.violations?.length) summaryParts.push(`${callerWarmup.violations.length} open violation${callerWarmup.violations.length > 1 ? 's' : ''}`);
          if (callerWarmup.acc?.length) summaryParts.push(`${callerWarmup.acc.length} open ACC submission${callerWarmup.acc.length > 1 ? 's' : ''}`);
          if (callerWarmup.recentCalls?.length) summaryParts.push(`${callerWarmup.recentCalls.length} prior call${callerWarmup.recentCalls.length > 1 ? 's' : ''} in last 30 days`);
          console.log(`[voice/incoming] warmup for ${callerContact.preferred_name || callerContact.full_name}: ${summaryParts.join(', ') || 'no flags'}`);
        } else {
          console.log(`[voice/incoming] warmup timed out (>800ms) — falling back to generic opener`);
        }
      } catch (e) {
        console.warn('[voice/incoming] warmup fetch failed (non-fatal):', e.message);
      }
    }

    // Build a short hint string for the opener IF there's exactly one
    // likely call reason. Multiple flags → don't probe (would feel like a
    // database dump). Zero flags → fall back to generic opener. One clear
    // flag → soft probe so Claire shows up informed.
    let warmupOpenerHint = null;
    if (callerWarmup) {
      const accCount = callerWarmup.acc?.length || 0;
      const violationCount = callerWarmup.violations?.length || 0;
      const recentCallCount = callerWarmup.recentCalls?.length || 0;
      // Single-flag probes only. Order: ACC > violation > recent call.
      if (accCount === 1 && violationCount === 0) {
        const project = callerWarmup.acc[0]?.project_summary;
        warmupOpenerHint = project
          ? `I see we have your ARC submission for the ${project.slice(0, 40)} in review — calling about that?`
          : `I see we have an open ARC submission for you — calling about that?`;
      } else if (violationCount === 1 && accCount === 0) {
        warmupOpenerHint = `I see we have an open compliance item on the property — calling about that?`;
      } else if (recentCallCount > 0 && accCount === 0 && violationCount === 0) {
        warmupOpenerHint = `Good to hear from you again — what can I help with today?`;
      }
    }
    // Serialize warmup context for the bridge (caps total parameter size
    // for TwiML — keep it tight). JSON-encoded then base64 to avoid XML-
    // escape headaches in the TwiML <Parameter value>.
    let warmupSerialized = '';
    if (callerWarmup) {
      try {
        const compact = {
          ar: callerWarmup.ar ? {
            balance_total: callerWarmup.ar.balance_total,
            snapshot_date: callerWarmup.ar.snapshot_date,
            enforcement_stage: callerWarmup.ar.enforcement_stage,
            at_legal: !!callerWarmup.ar.at_legal,
            in_collections: !!callerWarmup.ar.in_collections,
            payment_plan_active: !!callerWarmup.ar.payment_plan_active,
          } : null,
          v_count: callerWarmup.violations?.length || 0,
          acc: (callerWarmup.acc || []).slice(0, 2).map(a => ({
            status: a.status,
            project_summary: (a.project_summary || '').slice(0, 80),
            submitted_at: a.submitted_at,
          })),
          recent: (callerWarmup.recentCalls || []).slice(0, 3).map(c => ({
            started_at: c.started_at,
            summary: (c.summary || '').slice(0, 120),
          })),
        };
        warmupSerialized = Buffer.from(JSON.stringify(compact), 'utf8').toString('base64');
      } catch (e) {
        warmupSerialized = '';
      }
    }

    // Derive the community Claire uses for context. Priority order:
    //   1. voice_phone_routes (Model B — explicit per-community routing)
    //   2. caller's home community via caller-ID lookup
    //   3. null (generic Bedrock greeting + Claire asks which community)
    const effectiveCommunityId = route?.community_id || callerCommunity?.id || null;
    const effectiveCommunityName = route?.community_display_name || callerCommunity?.name || null;

    // Derive first name for the opener — preferred_name if set, else first
    // word of full_name. (Bedrock's contacts schema uses full_name not
    // separate first_name/last_name.)
    let callerFirstName = null;
    if (callerContact) {
      const candidate = callerContact.preferred_name || callerContact.full_name || '';
      callerFirstName = candidate.trim().split(/\s+/)[0] || null;
    }

    // Pre-create the homeowner_calls row so the bridge can update it as
    // the call progresses. ALWAYS write — even when community couldn't
    // be resolved (effectiveCommunityId is null). Migration 182 made
    // community_id nullable so unrouted calls still show up in the
    // operator's Calls dashboard. Otherwise the call would be invisible:
    // Claire answered it but no one would know it happened until a
    // homeowner complained.
    try {
      await supabase.from('homeowner_calls').upsert({
        community_id: effectiveCommunityId,   // may be null = unrouted
        voice_route_id: route?.id || null,
        call_sid: callSid,
        caller_phone: fromPhone,
        caller_homeowner_id: callerContact?.id || null,
        status: 'ringing',
      }, { onConflict: 'call_sid' });
      if (!effectiveCommunityId) {
        console.warn(`[voice/incoming] call ${callSid} logged WITHOUT community — to ${toPhone} from ${fromPhone}. Check voice_phone_routes mapping for ${toPhone}.`);
      }
    } catch (e) {
      console.warn('[voice/incoming] call log create failed:', e.message);
    }

    // Construct the WebSocket URL. If VOICE_WEBSOCKET_URL is set in env
    // (preferred — explicit Render URL), use that; otherwise derive from
    // the request host (works for local dev).
    const wsUrl = process.env.VOICE_WEBSOCKET_URL
      || `wss://${req.get('host')}/api/voice/stream`;

    // TwiML response — open the Media Stream + pass call context as
    // custom parameters. Twilio will deliver these in the WS "start" event.
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="call_sid" value="${escapeXml(callSid)}"/>
      <Parameter name="from_phone" value="${escapeXml(fromPhone || '')}"/>
      <Parameter name="to_phone" value="${escapeXml(toPhone || '')}"/>
      <Parameter name="community_id" value="${escapeXml(effectiveCommunityId || '')}"/>
      <Parameter name="community_name" value="${escapeXml(effectiveCommunityName || '')}"/>
      <Parameter name="caller_contact_id" value="${escapeXml(callerContact?.id || '')}"/>
      <Parameter name="caller_name" value="${escapeXml(callerContact?.full_name || '')}"/>
      <Parameter name="caller_first_name" value="${escapeXml(callerFirstName || '')}"/>
      <Parameter name="caller_property_id" value="${escapeXml(callerProperty?.id || '')}"/>
      <Parameter name="caller_property_address" value="${escapeXml(callerProperty?.street_address || '')}"/>
      <Parameter name="caller_residency_type" value="${escapeXml(callerProperty?.residency_type || '')}"/>
      <Parameter name="warmup_opener_hint" value="${escapeXml(warmupOpenerHint || '')}"/>
      <Parameter name="warmup_b64" value="${escapeXml(warmupSerialized || '')}"/>
    </Stream>
  </Connect>
</Response>`;
    res.set('Content-Type', 'text/xml').send(twiml);
  } catch (err) {
    console.error('[voice/incoming] failed:', err.stack || err.message);
    // Fall back to a graceful TwiML that doesn't open a stream — caller
    // hears a polite message rather than dead air.
    res.set('Content-Type', 'text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Sorry, our system is having trouble right now. Please call back in a few minutes or email info at bedrock t x dot com.</Say>
</Response>`);
  }
});

// ----------------------------------------------------------------------------
// POST /api/voice/status — Twilio call status webhook
// ----------------------------------------------------------------------------
router.post('/status', async (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const status = req.body.CallStatus; // 'ringing' | 'in-progress' | 'completed' | 'busy' | 'failed' | 'no-answer'
    const duration = req.body.CallDuration ? Number(req.body.CallDuration) : null;

    const dbStatus = mapTwilioStatus(status);
    const patch = { status: dbStatus };
    if (duration !== null) patch.duration_seconds = duration;
    if (status === 'completed') patch.ended_at = new Date().toISOString();
    if (status === 'in-progress' && !patch.answered_at) patch.answered_at = new Date().toISOString();

    try {
      await supabase
        .from('homeowner_calls')
        .update(patch)
        .eq('call_sid', callSid);
    } catch (e) {
      console.warn('[voice/status] update failed:', e.message);
    }
    res.status(204).end();
  } catch (err) {
    console.error('[voice/status] failed:', err.stack || err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

function mapTwilioStatus(twilioStatus) {
  switch (twilioStatus) {
    case 'ringing': return 'ringing';
    case 'in-progress': return 'in_progress';
    case 'completed': return 'completed';
    case 'busy':
    case 'no-answer':
    case 'failed':
    case 'canceled':
      return 'dropped';
    default: return 'ringing';
  }
}

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ----------------------------------------------------------------------------
// WebSocket connection handler — called by server.js on /api/voice/stream
// upgrade requests. Receives the WS connection and spawns a CallBridge.
// ----------------------------------------------------------------------------
function handleWebSocketConnection(ws, req) {
  console.log(`[voice/stream] WS connection from ${req.socket.remoteAddress}`);

  // Twilio sends the "start" event with the custom parameters we set in
  // TwiML. We construct a partial CallBridge and let it finish setup once
  // we have the params.
  let bridge = null;

  ws.on('message', async (raw) => {
    // First message we expect is "connected" then "start" with params.
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch (_) { return; }

    if (msg.event === 'start' && !bridge) {
      const params = msg.start?.customParameters || {};

      // Pre-call warmup unpacks back into a structured object the bridge
      // forwards into Claire's system prompt. Encode-Ed: opener feels
      // informed because we already pulled AR + violations + ACC + recent
      // calls during the Twilio webhook (Ed 2026-06-08).
      let warmup = null;
      if (params.warmup_b64) {
        try {
          warmup = JSON.parse(Buffer.from(String(params.warmup_b64), 'base64').toString('utf8'));
        } catch (e) {
          console.warn('[voice/stream] warmup decode failed:', e.message);
        }
      }

      const callContext = {
        call_sid: params.call_sid || msg.start.callSid,
        from_phone: params.from_phone,
        caller_phone: params.from_phone,  // alias used by SMS-link tool
        to_phone: params.to_phone,
        // Caller-ID-matched homeowner info (null if anonymous / unknown caller)
        caller: params.caller_contact_id
          ? {
              contact_id: params.caller_contact_id,
              id: params.caller_contact_id,    // alias used by tools
              full_name: params.caller_name || null,
              first_name: params.caller_first_name || null,
              property_id: params.caller_property_id || null,
              property_address: params.caller_property_address || null,
              // owner / renter / vacant / unknown — from property_residencies.
              // Lets Claire skip the "are you the homeowner?" question when
              // the system already knows. Encode-Ed correction 2026-06-08.
              residency_type: params.caller_residency_type || null,
            }
          : null,
        community: {
          id: params.community_id || null,
          name: params.community_name || null,
          // profile_block + doc_context are loaded asynchronously inside
          // the bridge if we have a community_id. v1 builds without them
          // and relies on the system prompt + community name only; deeper
          // integration is the next iteration.
          profile_block: null,
          doc_context: null,
        },
        warmup,                                              // structured prefetch
        warmup_opener_hint: params.warmup_opener_hint || '', // soft probe for buildOpener
      };
      bridge = new CallBridge({ twilioWs: ws, callContext, supabase });
    }
    if (bridge) bridge.handleTwilioMessage(raw.toString());
  });

  ws.on('close', () => {
    if (bridge) bridge.endCall('ws_closed');
  });

  ws.on('error', (err) => {
    console.warn('[voice/stream] WS error:', err.message);
    if (bridge) bridge.endCall('ws_error');
  });
}

// ============================================================================
// POST /api/voice/vapi-assistant-request — Vapi assistant-request webhook
// ----------------------------------------------------------------------------
// Vapi calls this BEFORE connecting an inbound call. Payload includes the
// caller's phone number; we look up their contact + property + community
// via the shared caller_lookup helper, then return an assistant config with:
//   - assistantId: which assistant to use (the existing Friendly FAQ Agent)
//   - assistantOverrides.firstMessage: DYNAMIC opener built from caller-ID
//   - assistantOverrides.metadata: caller_contact_id, community_id,
//     community_name (flows through to every LLM webhook call so Claire
//     knows who's on the line and which community to scope to)
//
// Why this matters:
//   - The Vapi "First Message" field is static (hardcoded "Am I speaking
//     with Ed from Waterview"). Useless for any non-Ed caller.
//   - Without dynamic metadata, our LLM webhook can't know which
//     community context to load — was hardcoded to Waterview for testing.
//   - This endpoint solves BOTH at once via Vapi's assistant-request
//     pattern: pre-call lookup → per-call config.
//
// Vapi config: in the assistant's settings, set "Server URL" to
//   https://my.bedrocktxai.com/api/voice/vapi-assistant-request
// Then Vapi will POST here on every inbound call before connecting.
// ============================================================================
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID || '6054ad5b-28c1-4d61-b2fa-92068c06a4d7';
// Isabella's Vapi assistant ID. Unset by default — when unset, all callers
// route to Claire (graceful degradation). Set this env var AFTER:
//   1. Creating Isabella as a separate Vapi assistant in the dashboard
//   2. Configuring her Server URL to /api/voice/vapi-llm-webhook-es/chat/completions
//   3. Picking her ElevenLabs Spanish voice ID via ISABELLA_VOICE_ID env var
// See docs/voice-isabella-setup.md for the full walkthrough.
const VAPI_ISABELLA_ASSISTANT_ID = process.env.VAPI_ISABELLA_ASSISTANT_ID || '';

router.post('/vapi-assistant-request', express.json({ limit: '64kb' }), async (req, res) => {
  const requestId = `vapi-ar-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const expectedSecret = process.env.VAPI_WEBHOOK_SECRET || '';
  if (expectedSecret) {
    const auth = String(req.headers.authorization || '');
    if (auth !== `Bearer ${expectedSecret}`) {
      console.warn(`[vapi-ar ${requestId}] auth failed`);
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  const body = req.body || {};
  const msg = body.message || body;
  const eventType = msg?.type || body?.type || 'unknown';
  console.log(`[vapi-ar ${requestId}] event=${eventType}`);

  // Defensive log redaction. Vapi's payload includes credentials we should
  // NEVER write to logs in plaintext (twilioAuthToken, twilioAccountSid,
  // any *Token / *Secret / *Key field). Build a safe-to-log clone of the
  // body that masks these before any console.log call below.
  function safeForLogs(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(safeForLogs);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/token|secret|key|password|credential/i.test(k) && typeof v === 'string') {
        out[k] = v.slice(0, 4) + '***REDACTED***';
      } else if (v && typeof v === 'object') {
        out[k] = safeForLogs(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  // Vapi's Server URL receives MULTIPLE event types — assistant-request,
  // end-of-call-report, conversation-update, function-call, status-update,
  // transcript, hang, speech-update, model-output, tool-calls, etc.
  //
  // We only do the dynamic-opener / metadata logic on 'assistant-request'.
  // For every other event type, return 200 OK with empty body — Vapi
  // doesn't require a structured response for most events.
  if (eventType !== 'assistant-request') {
    // End-of-call-report: persist the call into homeowner_calls so it
    // shows in trustEd's Calls dashboard, flows into the operational
    // queue, and feeds the encode-Ed audit pattern. This was previously
    // a no-op which meant Vapi calls were invisible to trustEd.
    if (eventType === 'end-of-call-report') {
      console.log(`[vapi-ar ${requestId}] end-of-call report received`, JSON.stringify(safeForLogs(msg)).slice(0, 500));
      const endingCallId = msg?.call?.id || msg?.callId || null;
      try {
        await _persistVapiEndOfCall(msg, requestId);
      } catch (e) {
        console.error(`[vapi-ar ${requestId}] persist end-of-call failed:`, e.message);
      }
      // Clear the per-call cache to release memory
      if (endingCallId) cacheClear(endingCallId);
    }
    return res.json({});
  }

  // assistant-request specifically. Log redacted payload for diagnostic.
  console.log(`[vapi-ar ${requestId}] assistant-request payload:`, JSON.stringify(safeForLogs(body)).slice(0, 2000));

  // Vapi's assistant-request shape (per their docs / observed in practice):
  //   { message: { type: 'assistant-request', call: { customer: { number: '+1...' },
  //                                                    phoneNumber: { number: '+1...' } } } }
  // Extract the caller's phone — defensively check both top-level and nested
  // 'message' wrapper since Vapi has historically used both shapes.
  const callerNumber = msg?.call?.customer?.number
    || msg?.customer?.number
    || msg?.call?.customer?.phoneNumber
    || null;
  const calledNumber = msg?.call?.phoneNumber?.number
    || msg?.phoneNumber?.number
    || null;

  let caller = null;
  let community = null;
  if (callerNumber) {
    try {
      const lookup = await resolveCallerByPhone(callerNumber);
      caller = lookup.contact;
      community = lookup.community;
      console.log(`[vapi-ar ${requestId}] resolved caller=${caller?.first_name || 'unknown'}, community=${community?.name || 'unknown'}`);
    } catch (e) {
      console.warn(`[vapi-ar ${requestId}] caller lookup failed: ${e.message}`);
    }
  }

  // Fallback: if no caller-ID match but the called number is configured for
  // a specific community via voice_phone_routes, use that.
  if (!community && calledNumber) {
    try {
      const { data: route } = await supabase
        .from('voice_phone_routes')
        .select('community_id, community_display_name, communities:community_id(id, name)')
        .eq('inbound_phone_number', calledNumber)
        .eq('enabled', true)
        .maybeSingle();
      if (route?.communities) {
        community = { id: route.communities.id, name: route.communities.name };
      }
    } catch (_) { /* swallow */ }
  }

  // Persona routing — decide if this caller goes to Claire (English) or
  // Isabella (Spanish) based on contacts.preferred_language. Defaults to
  // Claire when:
  //   - caller is unknown, OR
  //   - preferred_language is null/'en', OR
  //   - VAPI_ISABELLA_ASSISTANT_ID env var is unset (Isabella not configured yet)
  //
  // The persona swap drives both:
  //   1. Which Vapi assistantId we return (Vapi connects the call to that
  //      assistant's voice + Server URL, so the LLM webhook called for each
  //      turn becomes /vapi-llm-webhook-es instead of /vapi-llm-webhook).
  //   2. Which opener builder we use for firstMessage — so the very first
  //      thing the caller hears is in their language.
  //
  // Future personas (Mei Mandarin, Linh Vietnamese, Jin-Soo Korean) add an
  // env-var + opener-builder pair to the same conditional.
  const callerLanguage = caller?.preferred_language || null;
  const useIsabella = callerLanguage === 'es' && !!VAPI_ISABELLA_ASSISTANT_ID;
  const selectedAssistantId = useIsabella ? VAPI_ISABELLA_ASSISTANT_ID : VAPI_ASSISTANT_ID;
  const openerBuilder = useIsabella ? buildIsabellaOpener : buildOpener;
  const firstMessage = openerBuilder(community?.name || null, caller?.first_name || null);
  if (useIsabella) {
    console.log(`[vapi-ar ${requestId}] routing to Isabella (Spanish) — caller.preferred_language=es`);
  }

  // Pre-fetch the community profile here at call start, so subsequent
  // LLM webhook turns don't re-fetch it from Supabase on every turn.
  // This is the per-call cache pattern — saves ~200-500ms per turn after
  // the first. Best-effort: if fetch fails, the LLM webhook will fall
  // back to its own fetch.
  let profileBlock = null;
  if (community?.name) {
    try {
      profileBlock = await buildCommunityContextBlock(community.name);
    } catch (e) {
      console.warn(`[vapi-ar ${requestId}] community profile pre-fetch failed: ${e.message}`);
    }
  }

  // Stash the resolved context by Vapi call_id so the LLM webhook can
  // pull it on every turn without re-resolving. Cache expires after
  // 10 minutes (longer than any normal call).
  const incomingCallId = msg?.call?.id || msg?.callId || null;
  if (incomingCallId) {
    cacheSet(incomingCallId, {
      community: community ? { id: community.id, name: community.name, profileBlock } : null,
      caller: caller || null,
      resolvedAt: Date.now(),
    });
  }

  // Response per Vapi's assistant-request contract:
  //   { assistantId: '<existing assistant>', assistantOverrides: {...} }
  // The metadata field flows through to every LLM webhook call as
  // call.assistantOverrides.metadata — Claire's brain can read it.
  const response = {
    assistantId: selectedAssistantId,
    assistantOverrides: {
      firstMessage,
      metadata: {
        caller_contact_id: caller?.id || null,
        caller_first_name: caller?.first_name || null,
        caller_full_name: caller?.full_name || null,
        caller_preferred_language: callerLanguage,
        community_id: community?.id || null,
        community_name: community?.name || null,
        persona: useIsabella ? 'isabella' : 'claire',
      },
    },
  };

  console.log(`[vapi-ar ${requestId}] responding persona=${useIsabella ? 'isabella' : 'claire'} assistantId=${selectedAssistantId} firstMessage="${firstMessage}" cached_profile=${!!profileBlock} call_id=${incomingCallId || 'none'}`);
  res.json(response);
});

// ============================================================================
// POST /api/voice/vapi-llm-webhook — Vapi Custom LLM endpoint
// ----------------------------------------------------------------------------
// Vapi handles the voice loop (STT, turn-taking, interruption handling, TTS).
// On each user turn, Vapi POSTs an OpenAI-compatible chat completions request
// to this endpoint; we run Bedrock's brain (hybrid retrieval + community
// profile + playbook + caller-ID + the Claire system prompt) and stream the
// response back in OpenAI SSE format.
//
// Per CLAUDE.md diagnostic-first rule: we LOG the full request body on every
// hit so we can learn Vapi's exact metadata format (their public docs are
// vague on the call/customer/assistant field shape). Iterate from real logs.
//
// Phase 2a: community is hardcoded to Waterview Estates for testing. Phase 2b
// will resolve community from Vapi call metadata (incoming phone number) and
// caller from Vapi customer info (caller phone number → contacts table).
//
// Auth: VAPI_WEBHOOK_SECRET env var. Vapi sends `Authorization: Bearer <key>`
// per its docs. We reject any request without a matching bearer token.
//
// Streaming format: OpenAI SSE chat.completion.chunk events, sentence-level
// chunks (each completed sentence becomes a delta). Final chunk has
// finish_reason='stop' + a `data: [DONE]` terminator.
// ============================================================================

// ----------------------------------------------------------------------------
// Shared LLM-webhook handler — used by both Claire (English) and Isabella
// (Spanish) routes. All language differences flow through `personaConfig`:
//
//   personaConfig.personaPack  — optional { buildSystemPromptParts,
//                                bannedPatterns } that overrides Claire defaults.
//                                Undefined = Claire (English) default.
//   personaConfig.logTag       — log prefix ('vapi-llm' / 'vapi-llm-es')
//   personaConfig.modelLabel   — string written into the SSE `model` field
//                                (cosmetic, Vapi logs it). E.g. 'bedrock-claire'.
//   personaConfig.fallbackMessage — language-appropriate failure sentence.
//
// Extracted 2026-05-25 when Isabella (Spanish) landed. Before that, this was
// inlined in the Claire route. Anything inside this function applies to BOTH
// personas — if you find yourself adding persona-specific logic INSIDE the
// handler, push it up into personaConfig instead so all personas stay in sync.
// ----------------------------------------------------------------------------
async function handleVapiLlmTurn(req, res, personaConfig) {
  const cfg = personaConfig || {};
  const personaPack = cfg.personaPack || null;
  const logTag = cfg.logTag || 'vapi-llm';
  const modelLabel = cfg.modelLabel || 'bedrock-claire';
  const fallbackMessage = cfg.fallbackMessage
    || "Sorry, I'm having trouble right now — want me to put you through to someone on the team?";

  const startMs = Date.now();
  const requestId = `${logTag === 'vapi-llm' ? 'vapi' : logTag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // ---- Auth ----
  // Two modes:
  //   1. VAPI_WEBHOOK_SECRET set → enforce Bearer-token match (production)
  //   2. VAPI_WEBHOOK_SECRET unset → DIAGNOSTIC mode: allow through with a
  //      warning log. Used for capturing Vapi's actual request headers /
  //      payload to learn the contract. Re-enable enforcement once we know
  //      what header Vapi sends + how to configure it.
  const expectedSecret = process.env.VAPI_WEBHOOK_SECRET || '';
  if (expectedSecret) {
    const auth = String(req.headers.authorization || '');
    if (auth !== `Bearer ${expectedSecret}`) {
      console.warn(`[${logTag} ${requestId}] auth failed (header: ${auth.slice(0, 30)}…)`);
      return res.status(401).json({ error: 'unauthorized' });
    }
  } else {
    console.warn(`[${logTag} ${requestId}] DIAGNOSTIC MODE — VAPI_WEBHOOK_SECRET unset, allowing request. Set the env var to enforce auth.`);
  }

  // ---- Diagnostic logging (Phase 2a — learn Vapi's actual payload shape) ----
  // Log ALL headers too: Vapi's docs are vague on which header carries the
  // auth secret (Authorization Bearer? X-API-Key? something else?). The
  // headers from the first real call tell us.
  const safeHeaders = { ...req.headers };
  if (safeHeaders.authorization) safeHeaders.authorization = safeHeaders.authorization.slice(0, 20) + '…';
  console.log(`[${logTag} ${requestId}] headers:`, JSON.stringify(safeHeaders, null, 2));

  const body = req.body || {};
  try {
    const payloadPreview = JSON.stringify(body, null, 2);
    console.log(`[${logTag} ${requestId}] payload (${payloadPreview.length} chars):\n${payloadPreview.slice(0, 5000)}${payloadPreview.length > 5000 ? '\n…[truncated]' : ''}`);
  } catch (_) {
    console.log(`[${logTag} ${requestId}] payload not JSON-serializable, keys: ${Object.keys(body).join(', ')}`);
  }

  // ---- Extract messages from the OpenAI-format payload ----
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    console.warn(`[${logTag} ${requestId}] no messages in payload`);
    return res.status(400).json({ error: 'messages_required' });
  }

  // Latest user message is what Claire responds to. History is everything
  // before that (excluding the SYSTEM message; streamTurn builds its own).
  const lastUserIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return i;
    }
    return -1;
  })();
  if (lastUserIdx === -1) {
    console.warn(`[${logTag} ${requestId}] no user message in payload`);
    return res.status(400).json({ error: 'no_user_message' });
  }
  const utterance = String(messages[lastUserIdx].content || '').trim();
  const history = messages
    .slice(0, lastUserIdx)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: String(m.content || '') }));

  // ---- Resolve community + caller (Phase 2b + per-call cache) ----
  // Priority order:
  //   1. Per-call cache (populated by assistant-request webhook at call
  //      start) — includes a pre-fetched profileBlock, saving ~200-500ms
  //      per turn vs re-fetching from Supabase
  //   2. Vapi metadata on the LLM payload (works after assistant-request
  //      but no profile pre-fetch)
  //   3. Hardcoded Waterview fallback (web Talk test path with no real
  //      phone, no assistant-request fired)
  const incomingCallId = body?.call?.id || body?.callId || null;
  const cached = incomingCallId ? cacheGet(incomingCallId) : null;

  const callMetadata = body?.call?.assistantOverrides?.metadata
    || body?.assistantOverrides?.metadata
    || body?.metadata
    || {};

  let community = null;
  let caller = null;
  let profileBlockFromCache = null;

  if (cached?.community?.id) {
    community = { id: cached.community.id, name: cached.community.name };
    profileBlockFromCache = cached.community.profileBlock || null;
    caller = cached.caller || null;
    console.log(`[${logTag} ${requestId}] cache hit for call_id=${incomingCallId}`);
  } else if (callMetadata.community_id) {
    community = {
      id: callMetadata.community_id,
      name: callMetadata.community_name || null,
    };
    if (callMetadata.caller_contact_id) {
      caller = {
        id: callMetadata.caller_contact_id,
        first_name: callMetadata.caller_first_name || null,
        full_name: callMetadata.caller_full_name || null,
      };
    }
    console.log(`[${logTag} ${requestId}] metadata path (no cache)`);
  } else {
    // Fallback for web-test path (no real phone, no assistant-request).
    try {
      const { data: comm } = await supabase
        .from('communities')
        .select('id, name')
        .ilike('name', 'Waterview Estates')
        .maybeSingle();
      if (comm) community = { id: comm.id, name: comm.name };
    } catch (e) {
      console.warn(`[${logTag} ${requestId}] community fallback lookup failed: ${e.message}`);
    }
    console.log(`[${logTag} ${requestId}] fallback to hardcoded Waterview`);
  }

  // If we have a pre-fetched profileBlock from cache, plumb it into the
  // community object so streamTurn uses it instead of re-fetching. streamTurn
  // already accepts community.profile_block as a fast path (see reason.js).
  if (community && profileBlockFromCache) {
    community.profile_block = profileBlockFromCache;
  }

  console.log(`[${logTag} ${requestId}] resolved: community=${community?.name || 'none'}, caller=${caller?.first_name || 'none'}, utterance="${utterance.slice(0, 200)}"`);

  // ---- Extract Vapi-supplied tools (transferCall etc.) and merge with local tools ----
  // Vapi sends `tools` in the request body in OpenAI tool format:
  //   { type: 'function', function: { name, description, parameters: <jsonschema> } }
  // We translate to Anthropic tools format and append to our local tools so
  // Claude can call BOTH our server-side tools (get_ar_for_property — runs in
  // streamTurn) AND Vapi-side tools (transferCall — passes through to Vapi
  // via SSE tool_calls). The split is enforced in streamTurn via
  // passthroughToolNames.
  //
  // Why pass Vapi tools through at all: Squad transfers (Claire ↔ Isabella)
  // happen at the Vapi layer, not ours. Vapi's built-in transferCall function
  // is exposed to the LLM only by being included in the tools array. The
  // function name + arg schema match what Vapi expects when it parses the
  // tool_calls back out of our SSE response.
  const vapiTools = Array.isArray(body.tools) ? body.tools : [];
  const passthroughToolNames = [];
  const translatedVapiTools = [];
  for (const t of vapiTools) {
    if (t?.type !== 'function' || !t.function?.name) continue;
    const fn = t.function;
    translatedVapiTools.push({
      name: fn.name,
      description: fn.description || '',
      input_schema: fn.parameters || { type: 'object', properties: {} },
    });
    passthroughToolNames.push(fn.name);
  }
  if (translatedVapiTools.length > 0) {
    console.log(`[${logTag} ${requestId}] forwarding ${translatedVapiTools.length} Vapi-side tool(s) to Claude: ${passthroughToolNames.join(', ')}`);
  }
  const mergedTools = [...VOICE_TOOLS, ...translatedVapiTools];

  // ---- SSE response headers ----
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering (some hosts)
  res.flushHeaders();

  const createdTs = Math.floor(Date.now() / 1000);
  function sseChunk(delta, finishReason = null) {
    const chunk = {
      id: requestId,
      object: 'chat.completion.chunk',
      created: createdTs,
      model: modelLabel,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  // ---- Stream the response from streamTurn ----
  let aborted = false;
  res.on('close', () => { aborted = true; });

  try {
    // Initial role chunk (OpenAI convention — first delta announces the role)
    sseChunk({ role: 'assistant', content: '' });

    let sentenceCount = 0;
    for await (const sentence of streamTurn({
      utterance,
      history,
      community,
      caller,
      // 2026-05-24 (final) — back to Sonnet 4.5 for production voice.
      //
      // Ed's perceptive A/B feedback after running both: Sonnet 'sounded
      // more personable' (his words). Not imagination — it's a real
      // model-tier difference. Sonnet reads conversational nuance better
      // (tone, register, social cues), uses more relational phrasing,
      // maintains persona consistency better. Haiku is competent but
      // sounds slightly more transactional.
      //
      // For customer-facing voice where personality is part of the
      // product, warmth matters. Sonnet's latency penalty (~1.7s slower
      // per turn) is mitigated by the prompt-caching change (commit
      // 39ee396) AND the per-call profile cache (commit 76d6d59) —
      // turn 2+ approach Haiku speed. Cost premium ~$0.20 per 5-min
      // call vs Haiku — rounding error at current volume; small at
      // back-office scale per the cost-consciousness memo.
      //
      // Don't keep flipping. This is the choice. Applies to Isabella too —
      // Spanish callers deserve the same warmth tier; the language is the
      // variable, not the model class.
      model: 'claude-sonnet-4-5',
      // Tool-use support — Claire/Isabella can call:
      //   • get_ar_for_property (LOCAL): runs server-side, loops back to Claude
      //     with the result. Caller hears the balance disclosure in Claire's
      //     voice.
      //   • transferCall (PASSTHROUGH from Vapi req.body.tools): routed to
      //     Vapi via SSE tool_calls to execute a Squad transfer between
      //     assistants (Claire ↔ Isabella).
      // Tool-name-level split happens in streamTurn via passthroughToolNames.
      tools: mergedTools,
      toolHandlers: VOICE_TOOL_HANDLERS,
      passthroughToolNames,
      // Persona swap — Claire (default English) or Isabella (Spanish). See
      // top-of-file ISABELLA_PERSONA_PACK and lib/voice/reason.js streamTurn.
      personaPack,
    })) {
      if (aborted) break;
      // PASSTHROUGH TOOL — Claude called a Vapi-side tool (today: transferCall).
      // Don't yield as a sentence; emit OpenAI tool_calls SSE so Vapi parses
      // and executes the transfer. After this chunk the turn is over (Vapi
      // takes the wheel) — break the loop and end the response with
      // finish_reason='tool_calls'.
      if (sentence && typeof sentence === 'object' && sentence[PASSTHROUGH_CONTROL_MARKER]) {
        const toolCallId = 'call_' + Math.random().toString(36).slice(2, 12);
        const toolCallChunk = {
          tool_calls: [{
            index: 0,
            id: toolCallId,
            type: 'function',
            function: {
              name: sentence.toolName,
              arguments: JSON.stringify(sentence.toolArgs || {}),
            },
          }],
        };
        if (sentenceCount === 0) toolCallChunk.role = 'assistant';
        sseChunk(toolCallChunk);
        sseChunk({}, 'tool_calls');
        res.write('data: [DONE]\n\n');
        res.end();
        console.log(`[${logTag} ${requestId}] PASSTHROUGH tool fired: ${sentence.toolName} args=${JSON.stringify(sentence.toolArgs)} — Vapi takes over`);
        return;
      }
      // Prepend a space between sentences for natural concatenation. The
      // first sentence has no leading space.
      const content = sentenceCount === 0 ? sentence : ' ' + sentence;
      sseChunk({ content });
      sentenceCount += 1;
    }

    // Final chunk with finish_reason
    sseChunk({}, 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
    console.log(`[${logTag} ${requestId}] completed in ${Date.now() - startMs}ms, ${sentenceCount} sentence(s)`);
  } catch (err) {
    console.error(`[${logTag} ${requestId}] streamTurn failed: ${err.message}`);
    // Try to deliver a graceful fallback over SSE so Vapi has SOMETHING to
    // speak instead of dead silence. If the connection is already torn down
    // this swallow is fine.
    try {
      if (!aborted) {
        sseChunk({ content: fallbackMessage });
        sseChunk({}, 'stop');
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } catch (_) { /* connection closed; nothing to do */ }
  }
}

// ----------------------------------------------------------------------------
// Claire (English) — original Vapi Custom LLM endpoint.
// Vapi sends application/json; the router-level urlencoded parser above
// won't handle it. Apply express.json() specifically on this route.
// Vapi treats the configured URL as a BASE and appends /chat/completions
// (OpenAI-compatible convention). So the mounted path matches what
// Vapi calls: /api/voice/vapi-llm-webhook/chat/completions.
// ----------------------------------------------------------------------------
router.post('/vapi-llm-webhook/chat/completions', express.json({ limit: '256kb' }), (req, res) => {
  return handleVapiLlmTurn(req, res, {
    personaPack: null, // Claire = default
    logTag: 'vapi-llm',
    modelLabel: 'bedrock-claire',
    fallbackMessage:
      "Sorry, I'm having trouble right now — want me to put you through to someone on the team?",
  });
});

// ----------------------------------------------------------------------------
// Isabella (Spanish) — parallel Vapi Custom LLM endpoint.
// ----------------------------------------------------------------------------
// Set up in Vapi as a SEPARATE assistant pointing at:
//   https://my.bedrocktxai.com/api/voice/vapi-llm-webhook-es/chat/completions
//
// The persona's voice + first message live in the Vapi assistant config (or in
// the assistant-request webhook response). This endpoint is just the LLM
// reasoning surface — same pipeline as Claire, but swapped to use Isabella's
// Spanish system prompt + Spanish banned-phrase filter.
//
// Routing options Ed can choose between in the Vapi dashboard:
//   A) Dedicated Spanish phone number → Isabella assistant statically
//      (simplest; ~$2/mo extra Vapi number).
//   B) Single phone number → assistant-request webhook decides per-caller
//      based on contacts.preferred_language. Requires migration 107 +
//      the routing logic added to /vapi-assistant-request below.
//
// Either way, this LLM endpoint is the brain Isabella thinks with.
//
// See docs/voice-isabella-setup.md for the full setup walkthrough.
// ----------------------------------------------------------------------------
router.post('/vapi-llm-webhook-es/chat/completions', express.json({ limit: '256kb' }), (req, res) => {
  return handleVapiLlmTurn(req, res, {
    personaPack: ISABELLA_PERSONA_PACK,
    logTag: 'vapi-llm-es',
    modelLabel: 'bedrock-isabella',
    // Spanish fallback when streamTurn throws. Same intent as Claire's
    // English fallback — offer a take-a-message path so the caller doesn't
    // hear dead air.
    fallbackMessage:
      'Disculpe, estoy teniendo problemas en este momento — ¿quiere que tome un mensaje para que alguien del equipo le devuelva la llamada?',
  });
});

// ============================================================================
// VAPI ↔ trustEd PERSISTENCE + JUDGMENT TOOLS
// ----------------------------------------------------------------------------
// Two pieces that close the loop between Vapi (the voice runtime) and
// trustEd (the brain):
//
//   1. _persistVapiEndOfCall  — fires from /vapi-assistant-request when an
//      end-of-call-report arrives. Maps the Vapi payload to a row in
//      homeowner_calls so the call shows in the Calls dashboard, drives
//      compliance flagging, and feeds follow-up routing.
//
//   2. POST /vapi-tools/caller-context  — Vapi function-call endpoint.
//      Configure this in Vapi's assistant config as a tool. When Claire
//      receives a call, she invokes this BEFORE her first sentence to
//      get a synthesized read on the caller — name, property, recent
//      activity, what they're likely calling about. The opener becomes:
//
//        "Hey John, this is Claire from Bedrock for Waterview —
//         saw you called yesterday about the fob, did you get the
//         application?"
//
//      Instead of the generic:
//        "Hey, this is Claire from Bedrock for Waterview Estates —
//         what can I help with?"
//
//      That's the encode-Ed difference: Ed never opens with "what can I
//      help with?" — he opens already knowing what's likely going on.
//      The synthesis happens HERE, not in the prompt.
// ============================================================================

/**
 * Persist a Vapi end-of-call-report payload into homeowner_calls.
 * Tolerant of payload shape variations (Vapi has shifted field names
 * over time; we check several common paths). Falls back gracefully on
 * missing data — better to log a partial row than skip the call entirely.
 */
async function _persistVapiEndOfCall(msg, requestId) {
  if (!msg) return;
  const call = msg.call || {};
  const callerNumber = call.customer?.number || msg.customer?.number || null;
  const calledNumber = call.phoneNumber?.number || msg.phoneNumber?.number || null;
  const callSid = call.id || call.callId || msg.callId || msg.id || null;
  if (!callSid) {
    console.warn(`[vapi-persist ${requestId}] no call id in payload — skipping`);
    return;
  }

  // Resolve caller + community using the same helper as assistant-request.
  let caller = null;
  let community = null;
  if (callerNumber) {
    try {
      const lookup = await resolveCallerByPhone(callerNumber);
      caller = lookup.contact;
      community = lookup.community;
    } catch (e) {
      console.warn(`[vapi-persist ${requestId}] caller lookup failed: ${e.message}`);
    }
  }
  // Phone-route fallback if caller lookup didn't yield a community.
  if (!community && calledNumber) {
    try {
      const { data: route } = await supabase
        .from('voice_phone_routes')
        .select('community_id, communities:community_id(id, name)')
        .eq('inbound_phone_number', calledNumber)
        .eq('enabled', true)
        .maybeSingle();
      if (route?.communities) {
        community = { id: route.communities.id, name: route.communities.name };
      }
    } catch (_) {}
  }

  // Timing
  const startedAt = msg.startedAt || call.startedAt || call.createdAt || null;
  const endedAt = msg.endedAt || call.endedAt || new Date().toISOString();
  const duration = Number(
    msg.durationSeconds || msg.duration_seconds || call.durationSeconds || 0
  );

  // Transcript / summary — Vapi sends these as separate fields
  const transcript = msg.transcript || msg.fullTranscript || '';
  const summary = msg.summary || msg.callSummary || null;
  const turnCount = Array.isArray(msg.messages)
    ? msg.messages.filter(m => m?.role === 'user' || m?.role === 'human').length
    : (transcript.match(/^(User|Caller):/gim) || []).length;

  // Build the Stage-1 brief shape from whatever Vapi gave us. If a
  // structured summary is present, prefer that; otherwise build a minimal
  // one from the summary text. The downstream follow-up logic in
  // call_log.js gets to enrich this further when we wire it in.
  const brief = msg.analysis?.structuredData || msg.structuredData || (summary ? {
    concern: summary,
    channel: 'voice',
    category: msg.analysis?.category || null,
    next_step: msg.analysis?.nextStep || null,
    owner: 'staff',
    escalate: false,
  } : null);

  const handoffOffered = !!(msg.transferred || msg.handoffOffered);
  const endedReason = msg.endedReason || msg.endReason || null;

  // Build the row — only include fields we actually have values for.
  const row = {
    call_sid: callSid,
    community_id: community?.id || null,
    caller_phone: callerNumber || null,
    caller_homeowner_id: caller?.id || null,
    status: 'completed',
    started_at: startedAt,
    ended_at: endedAt,
    duration_seconds: duration || null,
    full_transcript: transcript || null,
    turn_count: turnCount || 0,
    brief: brief || null,
    brief_extracted_at: brief ? new Date().toISOString() : null,
    handoff_offered: handoffOffered,
    handoff_reason: endedReason && /transfer|handoff/i.test(endedReason) ? endedReason : null,
    raw_provider_metadata: {
      provider: 'vapi',
      vapi_call_id: callSid,
      ended_reason: endedReason,
      recording_url: msg.recordingUrl || msg.stereoRecordingUrl || null,
      cost: msg.cost || null,
      assistant_id: msg.assistant?.id || msg.assistantId || null,
    },
  };

  // Compliance heuristic — if the transcript mentions enforcement-flavored
  // words, flag for review even when the brief didn't. Same defensive
  // posture used in lib/voice/call_log.js.
  if (transcript) {
    const flagRegex = /\b(violation|§\s*209|fine|waiver|hearing|cure|legal|lien|collections?)\b/i;
    if (flagRegex.test(transcript)) {
      row.compliance_flag = true;
      row.compliance_reason = 'transcript_mentioned_enforcement_terms';
    }
  }

  // Upsert on call_sid (UNIQUE per migration 103) so re-fires don't dupe.
  const { error } = await supabase
    .from('homeowner_calls')
    .upsert(row, { onConflict: 'call_sid' });
  if (error) {
    console.error(`[vapi-persist ${requestId}] homeowner_calls upsert failed:`, error.message);
    return;
  }
  console.log(`[vapi-persist ${requestId}] call ${callSid} persisted (community=${community?.name || 'unknown'}, caller=${caller?.preferred_name || caller?.full_name || callerNumber || 'unknown'})`);
}

// ---------------------------------------------------------------------------
// POST /api/voice/vapi-tools/caller-context
// ---------------------------------------------------------------------------
// Vapi function-call endpoint. Configure in Vapi's assistant tools as a
// function named getCallerContext with a single parameter `caller_phone`.
// Vapi invokes this at the start of a conversation (or whenever it needs
// fresh context) and the response is fed back to the LLM as a tool result.
//
// The response is the ENCODE-ED layer: not a dump of facts, but a SYNTHESIS
// of what the caller probably needs, framed the way Ed would frame it on
// his first sentence. The prompt instructs Claire to use the
// `recommended_opener_context` field to inform her opening line.
//
// Auth: shares VAPI_WEBHOOK_SECRET with the assistant-request endpoint.
// ---------------------------------------------------------------------------
router.post('/vapi-tools/caller-context', express.json({ limit: '64kb' }), async (req, res) => {
  const requestId = `vapi-ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const expectedSecret = process.env.VAPI_WEBHOOK_SECRET || '';
    if (expectedSecret) {
      const auth = String(req.headers.authorization || '');
      if (auth !== `Bearer ${expectedSecret}`) {
        return res.status(401).json({ error: 'unauthorized' });
      }
    }

    // Vapi's function call payload puts the arguments at:
    //   message.toolCalls[0].function.arguments  (JSON-stringified)
    // OR for older configs:
    //   message.functionCall.parameters
    // Tolerant extraction.
    const body = req.body || {};
    const msg = body.message || body;
    const toolCall = (msg.toolCalls && msg.toolCalls[0]) || msg.toolCall || null;
    let args = {};
    if (toolCall?.function?.arguments) {
      try { args = JSON.parse(toolCall.function.arguments); } catch (_) { args = toolCall.function.arguments || {}; }
    } else if (toolCall?.function?.parameters) {
      args = toolCall.function.parameters;
    } else if (msg.functionCall?.parameters) {
      args = msg.functionCall.parameters;
    } else if (msg.arguments) {
      args = typeof msg.arguments === 'string' ? safeJsonParse(msg.arguments) : msg.arguments;
    } else if (msg.parameters) {
      args = msg.parameters;
    }

    // Also fall back to the call's caller number if no explicit phone arg
    // was passed (common pattern — Vapi can pass the caller_phone implicitly
    // via the call context).
    const callerPhoneArg = args?.caller_phone || args?.phone || null;
    const callContextPhone = msg.call?.customer?.number || msg.customer?.number || null;
    const callerPhone = callerPhoneArg || callContextPhone;

    if (!callerPhone) {
      return res.json({
        result: {
          found: false,
          recommended_opener_context: 'Hey, this is Claire from Bedrock — what can I help with today?',
          note: 'No caller phone provided; falling back to generic opener.',
        },
      });
    }

    const lookup = await resolveCallerByPhone(callerPhone);
    const caller = lookup.contact;
    const property = lookup.property;
    const community = lookup.community;

    if (!caller) {
      return res.json({
        result: {
          found: false,
          recommended_opener_context: community
            ? `Hey, this is Claire from Bedrock for ${community.name} — what can I help with today?`
            : 'Hey, this is Claire from Bedrock — what can I help with today?',
          note: 'Caller phone not in contacts. Treat as unknown caller; verify identity before sharing account-specific info.',
        },
      });
    }

    // Pull recent activity for synthesis. Bounded queries to keep response time low.
    const homeownerName = caller.preferred_name || caller.first_name || caller.full_name || 'there';
    const firstName = (caller.preferred_name || caller.first_name || (caller.full_name || '').split(' ')[0] || '').trim();

    const recentActivity = await _gatherRecentActivity({
      contact: caller,
      property,
      community,
    });

    // The opener is the synthesis. This is where encode-Ed actually lives —
    // not a script, but a one-liner that already knows what the caller
    // probably wants. Ed never opens with "what can I help with?" — he
    // opens with "saw you called yesterday about X, did you get the Y?"
    let opener;
    if (recentActivity.most_recent_call_summary) {
      opener = `Hey ${firstName}, this is Claire from Bedrock for ${community?.name || 'your community'} — saw you called ${recentActivity.most_recent_call_when || 'recently'} about ${recentActivity.most_recent_call_summary}. Did you get what you needed?`;
    } else if (recentActivity.open_violation_summary) {
      opener = `Hey ${firstName}, this is Claire from Bedrock for ${community?.name || 'your community'} — calling about the ${recentActivity.open_violation_summary} notice we sent over, or something else?`;
    } else if (recentActivity.open_acc_summary) {
      opener = `Hey ${firstName}, this is Claire from Bedrock for ${community?.name || 'your community'} — calling about your ${recentActivity.open_acc_summary} submission, or something else I can help with?`;
    } else {
      opener = `Hey ${firstName}, this is Claire from Bedrock for ${community?.name || 'your community'} — what can I help with today?`;
    }

    return res.json({
      result: {
        found: true,
        caller: {
          first_name: firstName,
          full_name: caller.full_name,
          preferred_name: caller.preferred_name,
          contact_id: caller.id,
        },
        property: property ? {
          street_address: property.street_address,
          community_id: property.community_id,
          property_id: property.id,
        } : null,
        community: community ? { id: community.id, name: community.name } : null,
        recent_activity: recentActivity,
        recommended_opener_context: opener,
        // Guidance for the model: this is the encode-Ed mindset, surfaced
        // as a tool result. Vapi's system prompt should be set up to obey
        // these hints rather than reciting them verbatim.
        conversation_guidance: [
          'Open warmly using the recommended_opener_context — do not read it verbatim, use it as inspiration.',
          'Listen for what is actually behind the question before answering.',
          'Offer paths forward, never just policy.',
          'Take ownership of the next step — never end with we will be in touch.',
          'When account-specific info is requested, verify identity (last 4 of street address or full name) before sharing.',
        ],
      },
    });
  } catch (err) {
    console.error(`[vapi-ctx ${requestId}] failed:`, err.message);
    return res.json({
      result: {
        found: false,
        recommended_opener_context: 'Hey, this is Claire from Bedrock — what can I help with today?',
        note: 'Context lookup failed; falling back to generic opener.',
      },
    });
  }
});

/**
 * Pull recent activity for a caller and synthesize a few one-line
 * summaries Claire can use to anchor her opener. Bounded queries only.
 */
async function _gatherRecentActivity({ contact, property, community }) {
  const out = {
    most_recent_call_summary: null,
    most_recent_call_when: null,
    open_violation_summary: null,
    open_acc_summary: null,
    has_open_ar_balance: false,
    open_items_count: 0,
  };
  if (!contact?.id) return out;

  // Most recent prior call (within last 14 days) — drives the
  // "saw you called yesterday about X" opener
  try {
    const since = new Date(Date.now() - 14 * 86400 * 1000).toISOString();
    const { data: priorCalls } = await supabase
      .from('homeowner_calls')
      .select('id, started_at, brief, full_transcript')
      .eq('caller_homeowner_id', contact.id)
      .gte('started_at', since)
      .order('started_at', { ascending: false })
      .limit(1);
    const last = priorCalls?.[0];
    if (last) {
      const briefConcern = last.brief?.concern || last.brief?.summary || null;
      out.most_recent_call_summary = briefConcern
        ? briefConcern.replace(/\.$/, '').slice(0, 80)
        : 'a question for the team';
      const days = Math.floor((Date.now() - new Date(last.started_at).getTime()) / 86400000);
      out.most_recent_call_when = days === 0 ? 'earlier today'
        : days === 1 ? 'yesterday'
        : days < 7 ? `${days} days ago`
        : 'recently';
    }
  } catch (_) {}

  // Open violation at property
  if (property?.id) {
    try {
      const { data: vios } = await supabase
        .from('violations')
        .select('id, current_stage, opened_at, enforcement_categories(label)')
        .eq('property_id', property.id)
        .is('resolved_at', null)
        .order('opened_at', { ascending: false })
        .limit(1);
      const v = vios?.[0];
      if (v) {
        out.open_violation_summary = v.enforcement_categories?.label
          ? `${v.enforcement_categories.label} ${v.current_stage === 'certified_209' ? 'certified' : 'courtesy'}`
          : 'open violation';
        out.open_items_count += 1;
      }
    } catch (_) {}
  }

  return out;
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch (_) { return {}; }
}

// ============================================================================
// VAPI TOOL — getCommunityFacts
// ----------------------------------------------------------------------------
// Answers the most common type of inbound call: "what are the pool hours,"
// "when's trash pickup," "what's the clubhouse rental fee." Pulls from
// trustEd's structured community knowledge (community_facts table, trash
// schedule JSONB on communities, contacts table for board/staff lookups,
// amenities table for amenity hours and contract terms).
//
// Topic taxonomy — keep it small and aligned with common call topics:
//   'pool'       — pool hours, rules, key/fob requirements
//   'clubhouse'  — clubhouse hours, rental fees, reservation process
//   'amenities'  — generic amenity info (calls below to look up specifics)
//   'trash'      — trash schedule (pickup days, recycling, bulk)
//   'gate'       — gate codes, vendor access, guest pass process
//   'office'     — office hours, contact info, addresses
//   'board'      — board contact info, meeting schedule
//   'rules'      — community rules / general policies
//   'parking'    — parking rules, visitor parking, towing
//   'pets'       — pet policies
//   'general'    — anything not in the above buckets
//
// When called with a topic, the tool pulls structured data for that topic.
// When called with topic='general', it falls back to community_facts with
// a recent / non-expired filter so Claire can answer broad questions.
//
// Response is structured for the LLM: top-level `answer` is a 1-2 sentence
// conversational answer Claire can speak (or paraphrase). `facts_used`
// surfaces the underlying data so Claire can mention specifics. `caveats`
// flags when info is stale or community-specific overrides exist.
//
// Auth: Bearer VAPI_WEBHOOK_SECRET (same as the others).
// ============================================================================
router.post('/vapi-tools/community-facts', express.json({ limit: '64kb' }), async (req, res) => {
  const requestId = `vapi-facts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const expectedSecret = process.env.VAPI_WEBHOOK_SECRET || '';
    if (expectedSecret) {
      const auth = String(req.headers.authorization || '');
      if (auth !== `Bearer ${expectedSecret}`) {
        return res.status(401).json({ error: 'unauthorized' });
      }
    }

    const body = req.body || {};
    const msg = body.message || body;
    const args = _extractToolArgs(msg);
    let communityId = args.community_id || null;
    const topic = String(args.topic || 'general').toLowerCase();
    // Free-text follow-up: if the homeowner asked a more specific question
    // (e.g., "what time does the pool open Saturday"), Vapi can pass it
    // here. We use it for the substrate fallback below.
    const question = String(args.question || '').trim();

    // Resolve community from the call context if not passed explicitly.
    // Vapi exposes the call's customer phone via msg.call.customer.number.
    if (!communityId) {
      const callerPhone = msg.call?.customer?.number || msg.customer?.number || null;
      if (callerPhone) {
        try {
          const lookup = await resolveCallerByPhone(callerPhone);
          communityId = lookup.community?.id || null;
        } catch (_) {}
      }
    }
    if (!communityId) {
      return res.json({
        result: {
          answer: "I want to make sure I give you info for the right community — can you confirm which community you're in?",
          facts_used: [],
          caveats: ['No community resolved from caller-ID. Need explicit community name from caller.'],
        },
      });
    }

    // Pull base community row for trash_schedule JSONB + office contact
    const { data: community } = await supabase
      .from('communities')
      .select('id, name, trash_schedule, portal_module_config')
      .eq('id', communityId)
      .maybeSingle();
    const communityName = community?.name || 'your community';

    // Topic-specific lookups. Each branch returns { answer, facts_used, caveats }
    let result;
    switch (topic) {
      case 'trash':
        result = await _facts_trash(community, communityName);
        break;
      case 'pool':
      case 'clubhouse':
      case 'amenities':
        result = await _facts_amenities(community, communityName, topic, question);
        break;
      case 'office':
      case 'board':
      case 'contact':
        result = await _facts_contacts(communityId, communityName, topic);
        break;
      case 'general':
      default:
        result = await _facts_general(communityId, communityName, question);
        break;
    }

    return res.json({ result });
  } catch (err) {
    console.error(`[vapi-facts ${requestId}] failed:`, err.message);
    return res.json({
      result: {
        answer: "I'm not finding that info right now — want me to take down a message and have someone get back to you?",
        facts_used: [],
        caveats: ['Tool error — caller should be offered a callback.'],
      },
    });
  }
});

// ---- Topic branches ---------------------------------------------------------

async function _facts_trash(community, communityName) {
  const schedule = community?.trash_schedule || null;
  if (!schedule || (Array.isArray(schedule) && schedule.length === 0)) {
    return {
      answer: `I don't have the trash schedule for ${communityName} on file — let me have someone confirm and get back to you.`,
      facts_used: [],
      caveats: ['No trash_schedule configured on communities row.'],
    };
  }
  // trash_schedule is a community-specific JSONB shape — surface the
  // raw structure so the LLM can summarize. The tool returns the data;
  // Claire speaks it conversationally.
  return {
    answer: `Here's ${communityName}'s trash schedule — let me know if you need the recycling or bulk pickup info specifically.`,
    facts_used: [{
      topic: 'trash_schedule',
      source: 'communities.trash_schedule',
      data: schedule,
    }],
    caveats: [],
  };
}

async function _facts_amenities(community, communityName, topic, question) {
  // Detect procedural questions — "how do I get X," "where is the form,"
  // "another way to contact" — these should NEVER surface vendor contacts.
  // Vendor info is for "who maintains the pool" type questions, not "how
  // do I apply for an amenity key."
  const proceduralRe = /\b(how\s+(do|can)\s+I|where\s+(do|is)|another\s+way|form|application|apply|submit|request|sign\s*up|register|get\s+a|get\s+the)\b/i;
  const isProcedural = question && proceduralRe.test(question);
  if (isProcedural) {
    return {
      answer: `That's typically handled through the application process for ${communityName} — I can either send you the form or point you to the community portal. Which works better for you?`,
      facts_used: [],
      caveats: [
        'Question detected as procedural (form/application/process). Do NOT reference amenity vendor contacts. Direct caller to portal or offer to send the form.',
      ],
    };
  }
  // Pull all amenities for the community
  const { data: amenities } = await supabase
    .from('amenities')
    .select('id, name, amenity_type, operating_hours, contract_terms, vendor_name')
    .eq('community_id', community?.id)
    .limit(50);
  const all = amenities || [];
  // Filter to topic if topic is specific
  let filtered = all;
  if (topic === 'pool') {
    filtered = all.filter(a => /pool|swim/i.test(`${a.name} ${a.amenity_type}`));
  } else if (topic === 'clubhouse') {
    filtered = all.filter(a => /clubhouse|club\s*house|community\s*center/i.test(`${a.name} ${a.amenity_type}`));
  }
  if (filtered.length === 0) {
    return {
      answer: `I don't have ${topic} info for ${communityName} on file — let me have someone follow up with you.`,
      facts_used: [],
      caveats: [`No amenities row matching topic=${topic} for this community.`],
    };
  }
  return {
    answer: `Sure — here's what I have for the ${communityName} ${topic}. If you need anything more specific I can connect you with the team.`,
    facts_used: filtered.map(a => ({
      topic: 'amenity',
      source: 'amenities table',
      // Hours-only for procedural-adjacent context. Vendor + contract
      // terms are returned only when the topic is explicitly informational
      // (pool/clubhouse keyed lookups), never when surfacing facts for
      // a procedural question. We already gated above; this is double
      // protection — Claire NEVER receives vendor names for the wrong
      // type of question.
      data: {
        name: a.name,
        type: a.amenity_type,
        hours: a.operating_hours,
      },
    })),
    caveats: [],
  };
}

async function _facts_contacts(communityId, communityName, topic) {
  // community_contacts has per-community directory
  const { data: contacts } = await supabase
    .from('community_contacts')
    .select('id, label, value, category, notes')
    .eq('community_id', communityId)
    .limit(50);
  const all = contacts || [];
  if (all.length === 0) {
    return {
      answer: `I don't have a directory on file for ${communityName} — let me transfer you to someone on the team who can help.`,
      facts_used: [],
      caveats: [`No community_contacts rows for community_id=${communityId}.`],
    };
  }
  // Filter to topic
  let filtered = all;
  if (topic === 'board') {
    filtered = all.filter(c => /board|president|director|treasurer|secretary/i.test(`${c.label} ${c.category}`));
  } else if (topic === 'office') {
    filtered = all.filter(c => /office|management|manager|address/i.test(`${c.label} ${c.category}`));
  }
  if (filtered.length === 0) filtered = all;
  return {
    answer: `Here's the contact info I have for ${communityName}'s ${topic === 'board' ? 'board' : topic === 'office' ? 'office' : 'team'}.`,
    facts_used: filtered.map(c => ({
      topic: 'contact',
      source: 'community_contacts',
      data: { label: c.label, value: c.value, category: c.category, notes: c.notes },
    })),
    caveats: [],
  };
}

async function _facts_general(communityId, communityName, question) {
  // Pull non-expired community_facts. If a question was passed, surface
  // up to 5 most relevant by simple keyword match; otherwise return the
  // top 10 by recency. Substrate-based semantic search would be richer
  // but adds latency — keep this fast for the common case.
  const today = new Date().toISOString().slice(0, 10);
  const { data: facts } = await supabase
    .from('community_facts')
    .select('id, category, key, label, value, expires_at')
    .eq('community_id', communityId)
    .or(`expires_at.is.null,expires_at.gte.${today}`)
    .order('updated_at', { ascending: false, nullsFirst: false })
    .limit(20);
  const all = facts || [];
  if (all.length === 0) {
    return {
      answer: `I don't have specific info on file for that at ${communityName} — let me take a message and have someone get back to you.`,
      facts_used: [],
      caveats: ['No community_facts rows for this community.'],
    };
  }
  let surfaced = all;
  if (question) {
    const q = question.toLowerCase();
    const ranked = all
      .map(f => {
        const text = `${f.label || ''} ${f.value || ''} ${f.category || ''} ${f.key || ''}`.toLowerCase();
        let score = 0;
        for (const word of q.split(/\W+/).filter(w => w.length > 3)) {
          if (text.includes(word)) score += 1;
        }
        return { f, score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);
    if (ranked.length > 0) surfaced = ranked.slice(0, 5).map(x => x.f);
  } else {
    surfaced = all.slice(0, 10);
  }
  return {
    answer: surfaced.length === 1
      ? `Here's what I have on that for ${communityName}.`
      : `Here's the info I have for ${communityName}.`,
    facts_used: surfaced.map(f => ({
      topic: f.category || 'general',
      source: 'community_facts',
      data: { label: f.label, value: f.value, key: f.key },
    })),
    caveats: [],
  };
}

// ============================================================================
// VAPI TOOL — requestHumanCallback
// ----------------------------------------------------------------------------
// The "take ownership of next step" pattern. When Claire can't answer
// something definitively, instead of dead-ending with "we'll be in touch,"
// she creates a concrete callback commitment. This tool:
//
//   1. Captures the request (what they asked, when, why a human is needed)
//   2. Creates a follow-up task in trustEd's operational queue
//   3. Returns confirmation language Claire can speak to the caller
//
// This is the operational equivalent of Ed saying "I'll handle this — I'll
// call you back by [time] with an answer." Most call centers handle this as
// "we'll get back to you" with no actual mechanism. trustEd makes it
// structurally impossible to forget — the row is in the queue.
//
// Auth: Bearer VAPI_WEBHOOK_SECRET.
// ============================================================================
router.post('/vapi-tools/request-callback', express.json({ limit: '64kb' }), async (req, res) => {
  const requestId = `vapi-cb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const expectedSecret = process.env.VAPI_WEBHOOK_SECRET || '';
    if (expectedSecret) {
      const auth = String(req.headers.authorization || '');
      if (auth !== `Bearer ${expectedSecret}`) {
        return res.status(401).json({ error: 'unauthorized' });
      }
    }

    const body = req.body || {};
    const msg = body.message || body;
    const args = _extractToolArgs(msg);
    const callerPhone = args.caller_phone || msg.call?.customer?.number || null;
    const reasonRaw = String(args.reason || args.summary || 'caller wants a callback').trim();
    const reason = reasonRaw.slice(0, 500);
    const urgency = (String(args.urgency || 'standard').toLowerCase());
    const preferredCallbackTime = String(args.preferred_callback_time || '').trim();

    // Resolve caller + community
    let caller = null;
    let community = null;
    if (callerPhone) {
      try {
        const lookup = await resolveCallerByPhone(callerPhone);
        caller = lookup.contact;
        community = lookup.community;
      } catch (_) {}
    }

    // Compute respond-by based on urgency
    const respondHours = urgency === 'urgent' ? 2 : urgency === 'low' ? 72 : 24;
    const respondBy = new Date(Date.now() + respondHours * 3600 * 1000).toISOString();

    // Find or create the homeowner_calls row for this call so the callback
    // ties to the actual call audit trail. Vapi's call id arrives via the
    // tool's call context — we use it as the call_sid.
    const callSid = msg.call?.id || msg.callId || null;
    let row = null;
    if (callSid) {
      const { data: existing } = await supabase
        .from('homeowner_calls')
        .select('id, internal_notes, follow_up_status')
        .eq('call_sid', callSid)
        .maybeSingle();
      row = existing;
    }
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const noteLine = `[${stamp}] Claire committed to callback (urgency=${urgency}): ${reason}${preferredCallbackTime ? ` — caller prefers ${preferredCallbackTime}` : ''}`;
    if (row) {
      const newNotes = row.internal_notes ? `${row.internal_notes}\n${noteLine}` : noteLine;
      await supabase
        .from('homeowner_calls')
        .update({
          follow_up_status: 'open',
          respond_by_at: respondBy,
          internal_notes: newNotes,
        })
        .eq('id', row.id);
    } else if (callSid) {
      // Call row hasn't been created yet (end-of-call hasn't fired). Insert
      // a minimal placeholder so the follow-up doesn't get lost.
      await supabase.from('homeowner_calls').insert({
        call_sid: callSid,
        community_id: community?.id || null,
        caller_phone: callerPhone,
        caller_homeowner_id: caller?.id || null,
        status: 'in_progress',
        started_at: new Date().toISOString(),
        follow_up_status: 'open',
        respond_by_at: respondBy,
        internal_notes: noteLine,
      });
    }

    const friendlyWhen = urgency === 'urgent'
      ? 'within the next couple hours'
      : urgency === 'low'
      ? 'in the next few days'
      : 'by end of business tomorrow';
    return res.json({
      result: {
        callback_scheduled: true,
        respond_by_at: respondBy,
        urgency,
        speak_to_caller: `Okay, I've got that down — someone from the team will get back to you ${friendlyWhen}${preferredCallbackTime ? ` (we'll aim for around ${preferredCallbackTime})` : ''}. Anything else I can help with in the meantime?`,
      },
    });
  } catch (err) {
    console.error(`[vapi-cb ${requestId}] failed:`, err.message);
    return res.json({
      result: {
        callback_scheduled: false,
        speak_to_caller: "Let me try that again — give me one second to get this saved.",
      },
    });
  }
});

// ============================================================================
// VAPI TOOL — getKeyFobInfo
// ----------------------------------------------------------------------------
// The encoded key-fob flow Ed described. Replaces Claire improvising from
// generic amenity data with a structured answer she can deliver in the
// right sequence.
//
// Behavioral contract (the encode-Ed pattern):
//   - Never recite ALL scenarios upfront. Return the path that fits the
//     specific situation given (owner vs tenant, new vs replacement).
//   - When requester_type is unknown, return guidance for Claire to ASK
//     before answering. Default state is question, not data dump.
//   - Always state the fee, the document requirements, and the delivery
//     channel (community website OR offer to email).
//   - Application delivery channels are BEDROCK-LEVEL defaults, not
//     amenity-vendor contacts. Never reference Swim Houston, the pool
//     vendor, or any operational contractor as a way to get the form.
//
// Community-specific overrides (fees, special instructions) live on
// communities.access_fees JSONB when populated. Falls back to sensible
// defaults so Claire never has to say "I don't know" for the basics.
// ============================================================================
router.post('/vapi-tools/key-fob-info', express.json({ limit: '64kb' }), async (req, res) => {
  const requestId = `vapi-fob-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const expectedSecret = process.env.VAPI_WEBHOOK_SECRET || '';
    if (expectedSecret) {
      const auth = String(req.headers.authorization || '');
      if (auth !== `Bearer ${expectedSecret}`) {
        return res.status(401).json({ error: 'unauthorized' });
      }
    }
    const body = req.body || {};
    const msg = body.message || body;
    const args = _extractToolArgs(msg);

    // Resolve community from args or caller context
    let communityId = args.community_id || null;
    if (!communityId) {
      const callerPhone = msg.call?.customer?.number || msg.customer?.number || null;
      if (callerPhone) {
        try {
          const lookup = await resolveCallerByPhone(callerPhone);
          communityId = lookup.community?.id || null;
        } catch (_) {}
      }
    }

    const requesterType = String(args.requester_type || '').toLowerCase(); // 'owner' | 'tenant' | ''
    const requestType = String(args.request_type || '').toLowerCase();     // 'new' | 'replacement' | ''

    // Step gate — if we don't yet know whether they're owner or tenant,
    // we hand Claire a clarifying question rather than a data dump.
    if (!requesterType) {
      return res.json({
        result: {
          next_step: 'clarify_requester_type',
          speak_to_caller: 'Sure, happy to help with a key fob. Quick question first — are you the homeowner, or are you renting the unit?',
        },
      });
    }
    if (!requestType) {
      return res.json({
        result: {
          next_step: 'clarify_request_type',
          requester_type: requesterType,
          speak_to_caller: 'Got it. Is this a first-time fob, or a replacement?',
        },
      });
    }

    // Pull community-specific overrides (fees + instructions) when set
    let community = null;
    let fees = null;
    try {
      const { data } = await supabase
        .from('communities')
        .select('id, name, access_fees')
        .eq('id', communityId)
        .maybeSingle();
      community = data;
      fees = data?.access_fees || null;
    } catch (_) {}
    const communityName = community?.name || 'your community';

    // Fee lookup — community-specific when set, else null (Claire admits
    // she'll need to confirm the exact amount rather than guess).
    const feeKey = `key_fob_${requesterType}_${requestType}`;
    const fee = fees && typeof fees === 'object' ? fees[feeKey] : null;

    // Document requirements — tenants always need lease + ID; owners
    // typically don't need extra documentation for a first fob, but
    // replacements often require the prior fob be returned (subject to
    // per-community policy)
    const requirements = [];
    if (requesterType === 'tenant') {
      requirements.push('a copy of the current lease');
      requirements.push('a photo ID');
    }
    if (requestType === 'replacement') {
      requirements.push('a brief note about what happened to the prior fob (lost, damaged, stolen)');
    }

    // Application delivery — these are BEDROCK-LEVEL defaults, never
    // vendor contacts. Two channels: the homeowner portal (once it's
    // live) and email to forms@bedrocktx.com. Community-specific
    // override URL when set.
    const portalUrl = community?.access_fees?.application_portal_url || 'home.bedrocktx.com';
    const applicationEmail = 'forms@bedrocktx.com';

    // Build the conversational answer Claire should deliver. This is
    // ONE sentence per element, in the right sequence, never the full
    // policy dump.
    const lines = [];
    const feeLine = fee != null
      ? `For ${requesterType} ${requestType === 'replacement' ? 'replacement' : 'first-time'} fobs the fee is $${Number(fee).toFixed(2)}.`
      : `The fee depends on the community's current rate schedule — I can confirm that exact amount and include it with the form.`;
    lines.push(feeLine);
    if (requirements.length > 0) {
      lines.push(`We'll need ${_humanList(requirements)} along with the application.`);
    }
    lines.push(`The application form is up on the community portal at ${portalUrl}, or if it's easier I can email it to you.`);

    return res.json({
      result: {
        next_step: 'deliver_form',
        requester_type: requesterType,
        request_type: requestType,
        fee_dollars: fee,
        fee_known: fee != null,
        requirements_list: requirements,
        delivery_channels: {
          portal_url: portalUrl,
          email_send_available: true,
        },
        speak_to_caller: lines.join(' ') + ' Which would you prefer?',
        guidance_for_claire: [
          'Do NOT reference any vendor (pool maintenance company, landscaper, etc.) as a way to get this form. The form comes from Bedrock or the community portal — those are the ONLY delivery channels.',
          'If the caller picks email, ask for their address, read it back to confirm, then use the requestCallback tool to schedule the send.',
          'If the fee is null (fee_known=false), do not guess. Tell them you will confirm the amount and include it with the form.',
        ],
      },
    });
  } catch (err) {
    console.error(`[vapi-fob ${requestId}] failed:`, err.message);
    return res.json({
      result: {
        next_step: 'fallback_callback',
        speak_to_caller: 'Let me have someone walk you through the fob process — what is the best number to reach you back at?',
      },
    });
  }
});

function _humanList(arr) {
  if (!arr || arr.length === 0) return '';
  if (arr.length === 1) return arr[0];
  if (arr.length === 2) return `${arr[0]} and ${arr[1]}`;
  return `${arr.slice(0, -1).join(', ')}, and ${arr[arr.length - 1]}`;
}

// ============================================================================
// VAPI TOOL — sendPortalLink (stubbed pre-portal-launch)
// ----------------------------------------------------------------------------
// Encode-Ed pattern: when the homeowner needs a form, an application, a
// statement, or a referenced piece of data, Claire's default offer is the
// homeowner portal. The portal magic-link is the primary delivery mechanism
// because it is:
//   - identity-verifying (magic link → on-file phone/email)
//   - self-service for everything (forms, balance, ACC, calendar, ...)
//   - permanent reference (homeowner can find it again later)
//   - friction-eliminating (no manual form delivery, no re-explanation)
//
// CURRENT STATE: the portal is not live yet. This stub tool returns a
// graceful fallback that:
//   1. Acknowledges the portal isn't ready
//   2. Falls back to email delivery (if email on file) or take-a-message
//   3. Returns speak_to_caller text that mentions "the portal" so Claire's
//      conversational flow is already shaped around portal-first
//   4. Logs the request for later reconciliation when the portal launches
//
// WHEN THE PORTAL LAUNCHES: flip the implementation to:
//   1. Generate a magic-link token tied to the caller_phone + contact_id
//   2. Build the URL: communities.homeowner_portal_url || 'home.bedrocktx.com'
//      + token + optional destination_page
//   3. Send via SMS (preferred) or email
//   4. Return speak_to_caller text confirming the send + the URL
//
// Claire's prompt doesn't change. Her words don't change. Only the action
// behind the words changes.
// ============================================================================
router.post('/vapi-tools/send-portal-link', express.json({ limit: '64kb' }), async (req, res) => {
  const requestId = `vapi-portal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const expectedSecret = process.env.VAPI_WEBHOOK_SECRET || '';
    if (expectedSecret) {
      const auth = String(req.headers.authorization || '');
      if (auth !== `Bearer ${expectedSecret}`) {
        return res.status(401).json({ error: 'unauthorized' });
      }
    }
    const body = req.body || {};
    const msg = body.message || body;
    const args = _extractToolArgs(msg);

    const callerPhone = args.caller_phone || msg.call?.customer?.number || msg.customer?.number || null;
    // destination_page: where the link should land — 'balance', 'acc',
    // 'fob_application', 'violations', 'documents', 'calendar', etc.
    const destinationPage = String(args.destination_page || 'home').toLowerCase();
    // delivery_channel: 'sms' (default) or 'email'. Caller-stated preference.
    const deliveryChannel = String(args.delivery_channel || 'sms').toLowerCase();
    // delivery_email: when channel=email and the caller gave an address
    const deliveryEmail = String(args.delivery_email || '').trim();

    // Resolve caller for context + on-file contact info
    let caller = null;
    let community = null;
    if (callerPhone) {
      try {
        const lookup = await resolveCallerByPhone(callerPhone);
        caller = lookup.contact;
        community = lookup.community;
      } catch (_) {}
    }

    // Portal not live yet — stub response with email fallback when possible
    const portalLive = process.env.HOMEOWNER_PORTAL_LIVE === 'true';

    if (!portalLive) {
      // Log the would-have-sent for reconciliation when portal launches
      console.log(`[vapi-portal ${requestId}] STUB: would have sent ${destinationPage} link to ${callerPhone || 'unknown'} via ${deliveryChannel}`);

      // If we have email on file or caller gave one, offer email fallback
      const fallbackEmail = deliveryEmail || caller?.primary_email || caller?.email || null;
      if (fallbackEmail && deliveryChannel === 'email') {
        return res.json({
          result: {
            link_sent: false,
            fallback_action: 'email',
            speak_to_caller: `Sure — I'll have the team email that over to ${fallbackEmail}. You should see it within the next hour. The portal we're rolling out soon will let you grab this stuff directly, but for now email is the fastest. Anything else?`,
            note_for_audit: 'Portal not yet live; falling back to email delivery via team queue.',
          },
        });
      }

      // Otherwise take a message
      return res.json({
        result: {
          link_sent: false,
          fallback_action: 'callback',
          speak_to_caller: `Got it — we're rolling out a homeowner portal in the next few weeks where you'll be able to grab forms and account info directly. Until then, what's the best number for me to have someone from the team get back to you with what you need?`,
          note_for_audit: 'Portal not yet live; falling back to manual callback.',
        },
      });
    }

    // PORTAL LIVE PATH (HOMEOWNER_PORTAL_LIVE=true on Render) — implemented
    // when the portal substrate ships. Marker for future wiring:
    //
    //   const token = await createPortalMagicLink({ contact_id: caller?.id, ... });
    //   const baseUrl = community?.homeowner_portal_url || 'https://home.bedrocktx.com';
    //   const fullUrl = `${baseUrl}/${destinationPage}?t=${token}`;
    //   if (deliveryChannel === 'sms') await sendSms({ to: callerPhone, body: ... });
    //   else await sendEmail({ to: fallbackEmail, ... });
    //
    // For now return a clear "not implemented" signal so the operator sees
    // the wiring is missing on the production side.
    return res.json({
      result: {
        link_sent: false,
        fallback_action: 'not_implemented',
        speak_to_caller: 'One sec — let me have someone get back to you with that.',
        note_for_audit: 'HOMEOWNER_PORTAL_LIVE=true but generator not yet wired. See api/voice.js TODO.',
      },
    });
  } catch (err) {
    console.error(`[vapi-portal ${requestId}] failed:`, err.message);
    return res.json({
      result: {
        link_sent: false,
        fallback_action: 'callback',
        speak_to_caller: "Let me have someone get back to you with that — what's the best number to reach you at?",
      },
    });
  }
});

// ---- shared helper to extract function-call args from Vapi payload --------
function _extractToolArgs(msg) {
  const toolCall = (msg.toolCalls && msg.toolCalls[0]) || msg.toolCall || null;
  let args = {};
  if (toolCall?.function?.arguments) {
    try { args = JSON.parse(toolCall.function.arguments); }
    catch (_) { args = toolCall.function.arguments || {}; }
  } else if (toolCall?.function?.parameters) {
    args = toolCall.function.parameters;
  } else if (msg.functionCall?.parameters) {
    args = msg.functionCall.parameters;
  } else if (msg.arguments) {
    args = typeof msg.arguments === 'string' ? safeJsonParse(msg.arguments) : msg.arguments;
  } else if (msg.parameters) {
    args = msg.parameters;
  }
  return args || {};
}

module.exports = { router, handleWebSocketConnection };
