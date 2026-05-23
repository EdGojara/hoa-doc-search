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

    // Look up which community this number belongs to. If no route is
    // configured we fall back to a generic greeting.
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

    // Pre-create the homeowner_calls row so the bridge can update it as
    // the call progresses (best-effort — call still proceeds if this fails).
    if (route?.community_id) {
      try {
        await supabase.from('homeowner_calls').upsert({
          community_id: route.community_id,
          voice_route_id: route.id,
          call_sid: callSid,
          caller_phone: fromPhone,
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
      <Parameter name="community_id" value="${escapeXml(route?.community_id || '')}"/>
      <Parameter name="community_name" value="${escapeXml(route?.community_display_name || '')}"/>
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
