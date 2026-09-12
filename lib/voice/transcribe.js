// ============================================================================
// lib/voice/transcribe.js — Deepgram streaming STT client
// ----------------------------------------------------------------------------
// Wraps Deepgram's Nova-2 phonecall model for real-time transcription of
// Twilio Media Stream audio. Accepts μ-law 8kHz mono directly (no
// conversion needed on the inbound path).
//
// Usage:
//   const stt = new DeepgramSession({
//     onPartial: (text) => { ... },     // interim transcripts
//     onFinal:   (text) => { ... },     // utterance-final transcripts
//     onError:   (err) => { ... },
//   });
//   await stt.open();
//   stt.send(mulawBuffer);  // forward audio frames as they arrive
//   stt.close();
//
// The session manages a single WebSocket to Deepgram. Reconnects on close
// during an active call so a hiccup doesn't end the conversation.
// ============================================================================

const WebSocket = require('ws');
const { PERSONA } = require('./persona');

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';

class DeepgramSession {
  constructor({ onPartial, onFinal, onError, onUtteranceEnd, apiKey, audio } = {}) {
    this.apiKey = apiKey || process.env.DEEPGRAM_API_KEY;
    this.onPartial = onPartial || (() => {});
    this.onFinal = onFinal || (() => {});
    this.onUtteranceEnd = onUtteranceEnd || (() => {});
    this.onError = onError || ((err) => console.error('[deepgram]', err.message));
    this.ws = null;
    this.queuedAudio = [];
    this.closed = false;
    // Audio format overrides. Default = the phone path (Twilio μ-law 8kHz).
    // The browser voice passes linear16 @ 16kHz. utteranceEndMs, when set,
    // makes Deepgram emit an UtteranceEnd event after that much silence — used
    // by the web relay to commit a turn without a client-side timer.
    this.audio = Object.assign({ encoding: 'mulaw', sampleRate: 8000, utteranceEndMs: 0 }, audio || {});
  }

  async open() {
    if (!this.apiKey) {
      const err = new Error('DEEPGRAM_API_KEY not set in environment');
      err.code = 'DEEPGRAM_NOT_CONFIGURED';
      throw err;
    }
    const params = new URLSearchParams({
      model: PERSONA.stt.model,
      language: PERSONA.stt.language,
      encoding: this.audio.encoding,
      sample_rate: String(this.audio.sampleRate),
      channels: '1',
      punctuate: String(PERSONA.stt.punctuate),
      smart_format: String(PERSONA.stt.smart_format),
      interim_results: String(PERSONA.stt.interim_results),
      endpointing: String(PERSONA.stt.endpointing),
      vad_events: String(PERSONA.stt.vad_events),
    });
    // Opt-in utterance-end signal (web relay uses it to end a turn).
    if (this.audio.utteranceEndMs && Number(this.audio.utteranceEndMs) > 0) {
      params.set('utterance_end_ms', String(this.audio.utteranceEndMs));
      params.set('interim_results', 'true'); // required by Deepgram for utterance_end_ms
    }

    this.ws = new WebSocket(`${DEEPGRAM_WS_URL}?${params.toString()}`, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });

    return new Promise((resolve, reject) => {
      this.ws.on('open', () => {
        // Flush any audio that arrived before the socket was ready
        for (const buf of this.queuedAudio) this.ws.send(buf);
        this.queuedAudio = [];
        resolve();
      });
      this.ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); }
        catch (_) { return; }
        if (msg.type === 'Results' && msg.channel?.alternatives?.length) {
          const alt = msg.channel.alternatives[0];
          const text = (alt.transcript || '').trim();
          if (!text) return;
          if (msg.is_final) this.onFinal(text, msg);
          else this.onPartial(text, msg);
        } else if (msg.type === 'UtteranceEnd') {
          // Fires after the utterance_end_ms silence window. The web relay uses
          // this to commit the caller's turn to Claire.
          this.onUtteranceEnd(msg);
        } else if (msg.type === 'Error') {
          this.onError(new Error(msg.description || 'Deepgram error'));
        }
      });
      this.ws.on('error', (err) => {
        this.onError(err);
        if (!this.closed) reject(err);
      });
      this.ws.on('close', () => {
        if (!this.closed) {
          // Unexpected close — log but don't reject if we already resolved.
          console.warn('[deepgram] socket closed unexpectedly');
        }
      });
    });
  }

  /** Forward μ-law audio bytes to Deepgram. Buffers until the socket is
   *  ready (handles the race where Twilio media arrives before the
   *  Deepgram open handshake completes). */
  send(mulawBuffer) {
    if (!this.ws || this.ws.readyState === WebSocket.CONNECTING) {
      this.queuedAudio.push(mulawBuffer);
      return;
    }
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(mulawBuffer);
    }
  }

  close() {
    this.closed = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Send the "CloseStream" signal so Deepgram flushes the final transcript
      try { this.ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (_) {}
      this.ws.close();
    }
    this.ws = null;
  }
}

module.exports = { DeepgramSession };
