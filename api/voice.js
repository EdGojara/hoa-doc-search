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
const { streamTurn } = require('../lib/voice/reason');
const { VOICE_TOOLS, VOICE_TOOL_HANDLERS } = require('../lib/voice/tools');
const { buildOpener } = require('../lib/voice/persona');
const { resolveCallerByPhone } = require('../lib/voice/caller_lookup');
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
            }
          }
        }
      } catch (e) {
        console.warn('[voice/incoming] caller-ID lookup failed:', e.message);
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
    // the call progresses (best-effort — call still proceeds if this fails).
    if (effectiveCommunityId) {
      try {
        await supabase.from('homeowner_calls').upsert({
          community_id: effectiveCommunityId,
          voice_route_id: route?.id || null,
          call_sid: callSid,
          caller_phone: fromPhone,
          caller_homeowner_id: callerContact?.id || null,
          status: 'ringing',
        }, { onConflict: 'call_sid' });
      } catch (e) {
        console.warn('[voice/incoming] call log create failed:', e.message);
      }
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
      const callContext = {
        call_sid: params.call_sid || msg.start.callSid,
        from_phone: params.from_phone,
        to_phone: params.to_phone,
        // Caller-ID-matched homeowner info (null if anonymous / unknown caller)
        caller: params.caller_contact_id
          ? {
              contact_id: params.caller_contact_id,
              full_name: params.caller_name || null,
              first_name: params.caller_first_name || null,
              property_id: params.caller_property_id || null,
              property_address: params.caller_property_address || null,
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
  console.log(`[vapi-ar ${requestId}] payload:`, JSON.stringify(body).slice(0, 2000));

  // Vapi's assistant-request shape (per their docs / observed in practice):
  //   { message: { type: 'assistant-request', call: { customer: { number: '+1...' },
  //                                                    phoneNumber: { number: '+1...' } } } }
  // Extract the caller's phone — defensively check both top-level and nested
  // 'message' wrapper since Vapi has historically used both shapes.
  const msg = body.message || body;
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

  // Build the dynamic opener via the same buildOpener used by the old
  // Twilio bridge — Single source of truth for opener phrasing across
  // both code paths.
  const firstMessage = buildOpener(community?.name || null, caller?.first_name || null);

  // Response per Vapi's assistant-request contract:
  //   { assistantId: '<existing assistant>', assistantOverrides: {...} }
  // The metadata field flows through to every LLM webhook call as
  // call.assistantOverrides.metadata — Claire's brain can read it.
  const response = {
    assistantId: VAPI_ASSISTANT_ID,
    assistantOverrides: {
      firstMessage,
      metadata: {
        caller_contact_id: caller?.id || null,
        caller_first_name: caller?.first_name || null,
        caller_full_name: caller?.full_name || null,
        community_id: community?.id || null,
        community_name: community?.name || null,
      },
    },
  };

  console.log(`[vapi-ar ${requestId}] responding with firstMessage="${firstMessage}"`);
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

// Vapi sends application/json; the router-level urlencoded parser above
// won't handle it. Apply express.json() specifically on this route.
// Vapi treats the configured URL as a BASE and appends /chat/completions
// (OpenAI-compatible convention). So the actual mounted path matches what
// Vapi calls: /api/voice/vapi-llm-webhook/chat/completions.
router.post('/vapi-llm-webhook/chat/completions', express.json({ limit: '256kb' }), async (req, res) => {
  const startMs = Date.now();
  const requestId = `vapi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
      console.warn(`[vapi-llm ${requestId}] auth failed (header: ${auth.slice(0, 30)}…)`);
      return res.status(401).json({ error: 'unauthorized' });
    }
  } else {
    console.warn(`[vapi-llm ${requestId}] DIAGNOSTIC MODE — VAPI_WEBHOOK_SECRET unset, allowing request. Set the env var to enforce auth.`);
  }

  // ---- Diagnostic logging (Phase 2a — learn Vapi's actual payload shape) ----
  // Log ALL headers too: Vapi's docs are vague on which header carries the
  // auth secret (Authorization Bearer? X-API-Key? something else?). The
  // headers from the first real call tell us.
  const safeHeaders = { ...req.headers };
  if (safeHeaders.authorization) safeHeaders.authorization = safeHeaders.authorization.slice(0, 20) + '…';
  console.log(`[vapi-llm ${requestId}] headers:`, JSON.stringify(safeHeaders, null, 2));

  const body = req.body || {};
  try {
    const payloadPreview = JSON.stringify(body, null, 2);
    console.log(`[vapi-llm ${requestId}] payload (${payloadPreview.length} chars):\n${payloadPreview.slice(0, 5000)}${payloadPreview.length > 5000 ? '\n…[truncated]' : ''}`);
  } catch (_) {
    console.log(`[vapi-llm ${requestId}] payload not JSON-serializable, keys: ${Object.keys(body).join(', ')}`);
  }

  // ---- Extract messages from the OpenAI-format payload ----
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    console.warn(`[vapi-llm ${requestId}] no messages in payload`);
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
    console.warn(`[vapi-llm ${requestId}] no user message in payload`);
    return res.status(400).json({ error: 'no_user_message' });
  }
  const utterance = String(messages[lastUserIdx].content || '').trim();
  const history = messages
    .slice(0, lastUserIdx)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: String(m.content || '') }));

  // ---- Resolve community + caller from Vapi metadata (Phase 2b) ----
  // The assistant-request webhook (above) does the caller-ID lookup at
  // call start and stashes the result in assistantOverrides.metadata.
  // Every per-turn LLM webhook call carries that metadata. So we just
  // pluck it from the payload rather than re-doing the lookup per turn.
  //
  // Fallback: if metadata is missing (e.g., web Talk test with no
  // customer.number, or assistant-request wasn't configured yet),
  // hardcode Waterview for backward compat with the testing flow.
  const callMetadata = body?.call?.assistantOverrides?.metadata
    || body?.assistantOverrides?.metadata
    || body?.metadata
    || {};
  let community = null;
  let caller = null;
  if (callMetadata.community_id) {
    community = {
      id: callMetadata.community_id,
      name: callMetadata.community_name || null,
    };
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
      console.warn(`[vapi-llm ${requestId}] community fallback lookup failed: ${e.message}`);
    }
  }
  if (callMetadata.caller_contact_id) {
    caller = {
      id: callMetadata.caller_contact_id,
      first_name: callMetadata.caller_first_name || null,
      full_name: callMetadata.caller_full_name || null,
    };
  }

  console.log(`[vapi-llm ${requestId}] resolved: community=${community?.name || 'none'}, caller=${caller?.first_name || 'none'}, utterance="${utterance.slice(0, 200)}"`);

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
      model: 'bedrock-claire',
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
      // 2026-05-24 (later) — switched BACK to Haiku 4.5 to test whether
      // the additional prompt tightening (FINAL HARD RULES section + HARD
      // RULE #6 explicitly banning document-citation voice + the synthesis
      // principle examples) now makes Haiku reliable enough on the over-
      // citing pattern. Cost win: Haiku LLM is ~3× cheaper + ~3× faster
      // than Sonnet, can nearly offset the Vapi platform fee.
      //
      // If over-citing regression returns, swap back to Sonnet here and
      // accept the cost premium for reliable synthesis compliance.
      model: 'claude-haiku-4-5-20251001',
      // Tool-use support — Claire can call get_ar_for_property when a
      // caller asks for account balance. Verifies identity via address
      // confirmation before disclosing. See lib/voice/tools.js.
      tools: VOICE_TOOLS,
      toolHandlers: VOICE_TOOL_HANDLERS,
    })) {
      if (aborted) break;
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
    console.log(`[vapi-llm ${requestId}] completed in ${Date.now() - startMs}ms, ${sentenceCount} sentence(s)`);
  } catch (err) {
    console.error(`[vapi-llm ${requestId}] streamTurn failed: ${err.message}`);
    // Try to deliver a graceful fallback over SSE so Vapi has SOMETHING to
    // speak instead of dead silence. If the connection is already torn down
    // this swallow is fine.
    try {
      if (!aborted) {
        sseChunk({ content: "Sorry, I'm having trouble right now — want me to put you through to someone on the team?" });
        sseChunk({}, 'stop');
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } catch (_) { /* connection closed; nothing to do */ }
  }
});

module.exports = { router, handleWebSocketConnection };
