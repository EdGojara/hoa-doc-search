// ============================================================================
// lib/voice/claire_stt_ws.js  (Ed 2026-09-12)
// ----------------------------------------------------------------------------
// Browser <-> Deepgram speech-to-text relay for the /claire web voice.
//
// The web voice used the browser's built-in SpeechRecognition, which misheard a
// lot ("poll" for "pool", "Chris" for "Claire") and frustrated callers. This
// relay streams the browser mic to Deepgram — the SAME engine the phone uses —
// so the web voice hears as well as the phone. It only does STT; the answer
// still comes from the existing /api/claire turn endpoint (one brain).
//
// Protocol (JSON frames over the WS):
//   client -> { type:'audio', audio:<base64 linear16 @16k> }   mic frames
//   client -> { type:'bye' }                                   end
//   server -> { type:'ready' }                                 Deepgram open
//   server -> { type:'partial', text }                         interim words
//   server -> { type:'utterance', text }                       a finished turn
//   server -> { type:'error', message }
//
// Audio in is linear16, 16 kHz, mono (the client resamples to this). Turn
// boundaries come from Deepgram (speech_final / UtteranceEnd), not a client
// timer, so pauses are handled by the same VAD the phone trusts.
// ============================================================================
const { DeepgramSession } = require('./transcribe');

async function handleClaireSttWs(ws, req) {
  const send = (obj) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (_) {} };

  if (!process.env.DEEPGRAM_API_KEY) {
    send({ type: 'error', message: 'Speech recognition is not configured (DEEPGRAM_API_KEY missing).' });
    try { ws.close(); } catch (_) {}
    return;
  }

  let buffer = '';           // accumulates final segments of the current utterance
  const flush = () => {
    const said = buffer.trim();
    buffer = '';
    if (said) send({ type: 'utterance', text: said });
  };

  const stt = new DeepgramSession({
    audio: { encoding: 'linear16', sampleRate: 16000, utteranceEndMs: 1000 },
    onPartial: (text) => send({ type: 'partial', text }),
    onFinal: (text, msg) => {
      buffer = buffer ? `${buffer} ${text}` : text;
      // speech_final = Deepgram decided the utterance ended on this segment.
      if (msg && msg.speech_final) flush();
    },
    onUtteranceEnd: () => flush(),   // silence window elapsed — commit the turn
    onError: (err) => send({ type: 'error', message: err.message || 'Speech error.' }),
  });

  try {
    await stt.open();
    send({ type: 'ready' });
  } catch (e) {
    console.error('[claire-stt] open failed:', e.message);
    send({ type: 'error', message: 'Could not start speech recognition. ' + (e.message || '') });
    try { ws.close(); } catch (_) {}
    return;
  }

  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch (_) { return; }
    if (m && m.type === 'audio' && m.audio) {
      try { stt.send(Buffer.from(m.audio, 'base64')); } catch (_) {}
    } else if (m && m.type === 'bye') {
      try { ws.close(); } catch (_) {}
    }
  });
  ws.on('close', () => { try { stt.close(); } catch (_) {} });
  ws.on('error', () => { try { stt.close(); } catch (_) {} });
}

module.exports = { handleClaireSttWs };
