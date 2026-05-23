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

module.exports = { router, handleWebSocketConnection };
