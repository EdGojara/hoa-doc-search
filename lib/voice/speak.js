// ============================================================================
// lib/voice/speak.js — ElevenLabs streaming TTS client
// ----------------------------------------------------------------------------
// Wraps ElevenLabs' Flash v2.5 streaming TTS endpoint. Returns PCM 16-bit
// audio chunks that the bridge then resamples to 8kHz, μ-law-encodes, and
// frames for Twilio Media Streams.
//
// Two usage patterns:
//   1. speakOnce(text)         → returns a Buffer of PCM-16 audio (one-shot)
//   2. speakStream(text, onChunk) → fires onChunk(pcmBuffer) repeatedly as
//      audio arrives. Lower TTFB; preferred for live calls.
//
// Reference: https://elevenlabs.io/docs/api-reference/text-to-speech/stream
// ============================================================================

const https = require('https');
const { PERSONA } = require('./persona');

const ELEVENLABS_BASE = 'api.elevenlabs.io';

/** Generate full PCM-16 audio for a single text utterance (non-streaming).
 *  Returns a Promise<Buffer>. Use for short phrases (under ~3 seconds)
 *  where latency doesn't matter; for live calls prefer speakStream. */
async function speakOnce(text, opts = {}) {
  return new Promise((resolve, reject) => {
    const apiKey = opts.apiKey || process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      const err = new Error('ELEVENLABS_API_KEY not set in environment');
      err.code = 'ELEVENLABS_NOT_CONFIGURED';
      return reject(err);
    }
    const voiceId = opts.voiceId || PERSONA.tts.voice_id;
    const body = JSON.stringify({
      text,
      model_id: PERSONA.tts.model,
      voice_settings: {
        stability: PERSONA.tts.stability,
        similarity_boost: PERSONA.tts.similarity_boost,
        style: PERSONA.tts.style,
        use_speaker_boost: PERSONA.tts.use_speaker_boost,
      },
    });
    const req = https.request({
      hostname: ELEVENLABS_BASE,
      path: `/v1/text-to-speech/${voiceId}?output_format=ulaw_8000`,
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'audio/pcm',
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', (c) => { errBody += c.toString(); });
        res.on('end', () => reject(new Error(`ElevenLabs HTTP ${res.statusCode}: ${errBody.slice(0,200)}`)));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Streaming variant. Fires onChunk(pcmBuffer) as audio arrives. Returns
 *  a Promise that resolves when the full utterance has been streamed.
 *
 *  PCM format: signed 16-bit LE @ 16000 Hz mono. */
function speakStream(text, onChunk, opts = {}) {
  return new Promise((resolve, reject) => {
    const apiKey = opts.apiKey || process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      const err = new Error('ELEVENLABS_API_KEY not set in environment');
      err.code = 'ELEVENLABS_NOT_CONFIGURED';
      return reject(err);
    }
    const voiceId = opts.voiceId || PERSONA.tts.voice_id;
    const body = JSON.stringify({
      text,
      model_id: PERSONA.tts.model,
      voice_settings: {
        stability: PERSONA.tts.stability,
        similarity_boost: PERSONA.tts.similarity_boost,
        style: PERSONA.tts.style,
        use_speaker_boost: PERSONA.tts.use_speaker_boost,
      },
    });
    const req = https.request({
      hostname: ELEVENLABS_BASE,
      path: `/v1/text-to-speech/${voiceId}/stream?output_format=ulaw_8000`,
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'audio/pcm',
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', (c) => { errBody += c.toString(); });
        res.on('end', () => reject(new Error(`ElevenLabs HTTP ${res.statusCode}: ${errBody.slice(0,200)}`)));
        return;
      }
      res.on('data', (c) => {
        try { onChunk(c); }
        catch (e) { console.warn('[elevenlabs] onChunk threw:', e.message); }
      });
      res.on('end', resolve);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { speakOnce, speakStream };
