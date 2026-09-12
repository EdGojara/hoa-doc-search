// ============================================================================
// lib/voice/claire_live_ws.js  (Ed 2026-09-12 — GPT-Live-1 portal PoC)
// ----------------------------------------------------------------------------
// Browser <-> server audio relay for Claire B (GPT-Live-1) on the portal.
//
// The browser is a dumb audio pipe: it captures mic PCM and sends base64 frames
// over THIS WebSocket, and plays back the base64 audio we send it. The server
// holds the LiveClaireSession (which owns the OpenAI Live socket + the
// client-delegation loop into reason.js), so the brain and all secrets stay
// server-side. One provider serves this and the phone; only the transport here
// differs.
//
// ISOLATION: gated behind GPT_LIVE_ENABLED (default OFF) so it can never be
// reached in production until Ed flips it for a test. Production /claire is
// untouched. Scoped to one community via ?community=<id>.
//
// Wire protocol with the browser (JSON text frames):
//   client -> server : { type:'audio', audio:<base64 pcm16@24k> }
//   client -> server : { type:'bye' }
//   server -> client : { type:'ready' }                     session is live
//   server -> client : { type:'audio', delta:<base64 pcm16@24k> }  play this
//   server -> client : { type:'transcript', delta:<text> }  (what she said)
//   server -> client : { type:'error', message:<string> }
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const { LiveClaireSession } = require('./live_bridge');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const RATE = 24000; // pcm16 both directions; browser AudioContext runs at this rate

function liveEnabled() { return String(process.env.GPT_LIVE_ENABLED || '').toLowerCase() === 'true'; }

async function handleClaireLiveWs(ws, req) {
  // Kill switch: closed unless explicitly enabled for a test.
  if (!liveEnabled()) {
    try { ws.send(JSON.stringify({ type: 'error', message: 'Claire Live is switched off.' })); } catch (_) {}
    try { ws.close(1011, 'gpt_live_disabled'); } catch (_) {}
    return;
  }

  let community = null;
  try {
    const url = new URL(req.url, 'http://localhost');
    const communityId = url.searchParams.get('community');
    if (communityId) {
      const { data, error } = await supabase.from('communities').select('id, name').eq('id', communityId).maybeSingle();
      if (error) console.warn('[claire-live] community lookup failed:', error.message);
      community = data || null;
    }
  } catch (e) { console.warn('[claire-live] bad request url:', e.message); }

  const send = (obj) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (_) {} };

  const session = new LiveClaireSession({
    callContext: { community, call_sid: 'portal-' + Date.now() },
    onOutputAudio: (delta) => send({ type: 'audio', delta }),
    onOutputTranscript: (delta) => send({ type: 'transcript', delta }),
    voice: process.env.CLAIRE_LIVE_VOICE || 'marin',
    audio: {
      input: { format: { type: 'audio/pcm', rate: RATE } },
      output: { voice: process.env.CLAIRE_LIVE_VOICE || 'marin', format: { type: 'audio/pcm', rate: RATE } },
    },
  });

  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch (_) { return; }
    if (m && m.type === 'audio' && m.audio) session.sendAudio(m.audio);
    else if (m && m.type === 'bye') { try { ws.close(); } catch (_) {} }
  });
  ws.on('close', () => session.close());
  ws.on('error', () => session.close());

  try {
    await session.start();
    send({ type: 'ready', community: community ? community.name : null });
    console.log(`[claire-live] session live; community=${community?.name || 'none'}`);
  } catch (e) {
    console.error('[claire-live] start failed:', e.message);
    send({ type: 'error', message: 'Could not start Claire Live.' });
    try { ws.close(); } catch (_) {}
  }
}

module.exports = { handleClaireLiveWs, liveEnabled, RATE };
