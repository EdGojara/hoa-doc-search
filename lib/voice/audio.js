// ============================================================================
// lib/voice/audio.js — audio format helpers
// ----------------------------------------------------------------------------
// Twilio Media Streams uses 8kHz mono μ-law (PCMU) audio frames, base64-
// encoded in JSON over the WebSocket. ElevenLabs (and most modern TTS) emit
// 16kHz or 22kHz mono PCM or MP3. Deepgram accepts μ-law directly so the
// inbound path needs no conversion, but the OUTBOUND path (TTS audio back to
// the caller) requires:
//
//   1. Get audio from ElevenLabs as PCM 16-bit signed @ 16kHz (or 22kHz)
//   2. Resample → 8kHz
//   3. Encode PCM → μ-law
//   4. Frame into 20ms chunks (160 samples per chunk at 8kHz)
//   5. Base64-encode and send via Twilio media message format
// ============================================================================

// ---- μ-law encoding (G.711) ------------------------------------------------
// Standard ITU-T G.711 μ-law encoder. Maps a 14-bit linear PCM sample
// (sign + magnitude) to an 8-bit μ-law byte.

const MULAW_BIAS = 0x84;
const MULAW_MAX = 32635;

function linearToMulaw(sample) {
  let sign = 0;
  if (sample < 0) { sign = 0x80; sample = -sample; }
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  sample = sample + MULAW_BIAS;
  let exponent = 7;
  for (let exp_lut = 0x4000; (sample & exp_lut) === 0 && exponent > 0; exp_lut >>= 1) {
    exponent--;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

function mulawToLinear(byte) {
  byte = ~byte;
  const sign = byte & 0x80;
  const exponent = (byte >> 4) & 0x07;
  const mantissa = byte & 0x0F;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}

// ---- Buffer conversion -----------------------------------------------------

function pcm16ToMulaw(pcm16Buffer) {
  const sampleCount = Math.floor(pcm16Buffer.length / 2);
  const out = Buffer.alloc(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const sample = pcm16Buffer.readInt16LE(i * 2);
    out[i] = linearToMulaw(sample);
  }
  return out;
}

function mulawToPcm16(mulawBuffer) {
  const out = Buffer.alloc(mulawBuffer.length * 2);
  for (let i = 0; i < mulawBuffer.length; i++) {
    const sample = mulawToLinear(mulawBuffer[i]);
    out.writeInt16LE(sample, i * 2);
  }
  return out;
}

// ---- Resampling to 8kHz ----------------------------------------------------
// Linear-interpolation resampler. Adequate for telephony bandwidth; we can
// swap in a proper FIR filter later if voice quality suffers.

function resamplePcm16(pcm16In, fromHz, toHz) {
  if (fromHz === toHz) return pcm16In;
  const inSamples = Math.floor(pcm16In.length / 2);
  const ratio = fromHz / toHz;
  const outSamples = Math.floor(inSamples / ratio);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const srcIdx = i * ratio;
    const lower = Math.floor(srcIdx);
    const upper = Math.min(lower + 1, inSamples - 1);
    const frac = srcIdx - lower;
    const a = pcm16In.readInt16LE(lower * 2);
    const b = pcm16In.readInt16LE(upper * 2);
    const interpolated = Math.round(a * (1 - frac) + b * frac);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
  }
  return out;
}

// ---- Twilio Media Streams frame helpers ------------------------------------

/** Twilio wants 20ms μ-law chunks (160 bytes at 8kHz). Slice an arbitrary
 *  μ-law buffer into 160-byte chunks for streaming back. */
function chunkMulawForTwilio(mulawBuffer) {
  const chunks = [];
  for (let i = 0; i < mulawBuffer.length; i += 160) {
    chunks.push(mulawBuffer.slice(i, Math.min(i + 160, mulawBuffer.length)));
  }
  return chunks;
}

module.exports = {
  linearToMulaw,
  mulawToLinear,
  pcm16ToMulaw,
  mulawToPcm16,
  resamplePcm16,
  chunkMulawForTwilio,
};
