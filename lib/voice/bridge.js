// ============================================================================
// lib/voice/bridge.js — Twilio Media Streams ↔ Deepgram ↔ Claude ↔ ElevenLabs
// ----------------------------------------------------------------------------
// The orchestrator. One instance per active phone call. Drives the
// turn-by-turn loop end-to-end:
//
//   Twilio MediaStream (μ-law 8kHz inbound) ─► Deepgram streaming STT
//                                                      │
//                                                      ▼
//                                              transcripts arrive
//                                                      │
//                                          on utterance-final ─► Claude.streamTurn()
//                                                                       │
//                                                                       ▼
//                                                              completed sentences
//                                                                       │
//                                                                       ▼
//                                                       ElevenLabs.speakStream() per sentence
//                                                                       │
//                                                                       ▼
//                                                              PCM 16kHz audio chunks
//                                                                       │
//                                                                       ▼
//                                                       resample 16kHz→8kHz, μ-law encode
//                                                                       │
//                                                                       ▼
//                                                       chunked 20ms frames back to Twilio
//
// Twilio Media Streams protocol reference:
//   https://www.twilio.com/docs/voice/twiml/stream
//
// The bridge also detects handoff intent, distress, and compliance-touching
// utterances; any of those trigger a warm transfer (handled in handoff.js
// — TODO module).
// ============================================================================

const { DeepgramSession } = require('./transcribe');
const { streamTurn } = require('./reason');
const { speakStream, speakOnce } = require('./speak');
const { buildOpener, buildHandoffOffer, buildClose, PERSONA } = require('./persona');
const { processCallEnd } = require('./call_log');
const {
  detectHumanHandoffRequest,
  detectDistress,
  detectComplianceMatter,
} = require('./persona_helpers');
const {
  pcm16ToMulaw,
  resamplePcm16,
  chunkMulawForTwilio,
} = require('./audio');

const ELEVENLABS_OUTPUT_HZ = 16000; // we request pcm_16000 from ElevenLabs

class CallBridge {
  constructor({ twilioWs, callContext, supabase, logger = console }) {
    this.twilioWs = twilioWs;
    this.callContext = callContext;  // { call_sid, community, caller_phone, ... }
    this.supabase = supabase;
    this.logger = logger;

    this.streamSid = null;
    this.history = [];               // [{ role, content }]
    this.stt = null;
    this.openerSent = false;
    this.assistantSpeaking = false;  // true while ElevenLabs audio is mid-flight
    this.utteranceInProgress = false;
    this.closed = false;
    this.pendingHandoff = null;      // { reason, queuedAt }

    // Continuation buffer — for handling natural-pause splits where Deepgram
    // sends a single thought as two utterances. When the new utterance
    // arrives mid-turn, we accumulate it here instead of dropping. After
    // the current turn finishes, the buffered text starts a fresh turn
    // immediately. See: bug 03:41:06 in the Render logs 2026-05-23 where
    // "parking RVs or boats on the driveway?" was dropped because it came
    // in 2s after "Can you tell me what the rules are about".
    this.pendingUtterance = '';
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  async start() {
    this.logger.log(`[bridge ${this.callContext.call_sid}] starting; community=${this.callContext.community?.name || 'unknown'}`);

    // Spin up the Deepgram session
    try {
      this.stt = new DeepgramSession({
        onPartial: () => { /* could implement barge-in here later */ },
        onFinal: (text) => this.onUtteranceFinal(text),
        onError: (err) => this.logger.warn(`[bridge ${this.callContext.call_sid}] stt error: ${err.message}`),
      });
      await this.stt.open();
    } catch (err) {
      this.logger.error(`[bridge ${this.callContext.call_sid}] STT setup failed:`, err.message);
      // Without STT we can't have a conversation — close the call
      this.endCall('stt_unavailable');
      return;
    }

    // Speak the opener — personalized if we matched the caller by phone
    await this.speakAndPlay(buildOpener(
      this.callContext.community?.name,
      this.callContext.caller?.first_name
    ));
    this.openerSent = true;
  }

  // -------------------------------------------------------------------------
  // Twilio Media Streams protocol — incoming events
  // -------------------------------------------------------------------------
  handleTwilioMessage(rawJson) {
    let msg;
    try { msg = JSON.parse(rawJson); }
    catch (_) { return; }

    switch (msg.event) {
      case 'connected':
        this.logger.log(`[bridge ${this.callContext.call_sid}] twilio connected`);
        break;
      case 'start':
        this.streamSid = msg.start?.streamSid;
        this.logger.log(`[bridge ${this.callContext.call_sid}] stream started: ${this.streamSid}`);
        this.start().catch((e) => this.logger.error('[bridge] start failed:', e.message));
        break;
      case 'media': {
        // Inbound audio from caller — base64-encoded μ-law 8kHz
        const audio = Buffer.from(msg.media.payload, 'base64');
        // Forward to Deepgram if we're not currently speaking (avoid
        // transcribing Claire's own audio). When we implement barge-in we'll
        // remove this gate and rely on energy detection instead.
        if (this.stt && !this.assistantSpeaking) {
          this.stt.send(audio);
        }
        break;
      }
      case 'mark':
        // Twilio confirms we've received a media chunk we sent earlier.
        // Useful for synchronizing turn boundaries; not needed in v1.
        break;
      case 'stop':
        this.logger.log(`[bridge ${this.callContext.call_sid}] stream stopped`);
        this.endCall('stream_stopped');
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Utterance handling — what Claire does when the caller finishes speaking
  // -------------------------------------------------------------------------
  async onUtteranceFinal(text) {
    if (this.closed) return;
    if (this.utteranceInProgress) {
      // BUFFER instead of drop — Deepgram often splits a single thought
      // into multiple utterances when the speaker pauses. We accumulate
      // the continuation here, and start a fresh turn with the combined
      // text the moment the current turn finishes (see finally block).
      this.pendingUtterance = this.pendingUtterance
        ? `${this.pendingUtterance} ${text}`.trim()
        : text;
      this.logger.log(`[bridge ${this.callContext.call_sid}] buffered followup: "${text}" (pending="${this.pendingUtterance}")`);
      return;
    }
    this.utteranceInProgress = true;

    // Combine with anything pending from a previous mid-turn arrival
    const combinedText = this.pendingUtterance
      ? `${this.pendingUtterance} ${text}`.trim()
      : text;
    this.pendingUtterance = '';

    this.logger.log(`[bridge ${this.callContext.call_sid}] caller: "${combinedText}"`);
    text = combinedText;  // use the combined text for downstream logic

    try {
      // Add caller turn to history
      this.history.push({ role: 'user', content: text });

      // Detect handoff intent BEFORE generating a response
      const compliance = detectComplianceMatter(text);
      const distress = detectDistress(text);
      const explicit = detectHumanHandoffRequest(text);

      if (explicit || distress || compliance) {
        const reason = distress ? 'distressed'
                     : compliance ? 'compliance'
                     : 'caller_requested';
        await this.speakAndPlay(buildHandoffOffer(reason));
        this.pendingHandoff = { reason, queuedAt: Date.now() };
        // For v1, the actual warm-transfer to a human is a TODO (handoff.js).
        // The bridge just plays the offer; caller hangup or human transfer
        // happens externally.
        this.utteranceInProgress = false;
        return;
      }

      // Otherwise: regular Q&A turn — stream Claude → speak sentence-by-sentence
      let assistantFull = '';
      for await (const sentence of streamTurn({
        utterance: text,
        history: this.history.slice(0, -1), // exclude the user message we just added
        community: this.callContext.community,
        caller: this.callContext.caller, // homeowner context if matched by phone
      })) {
        if (this.closed) break;
        assistantFull += sentence + ' ';
        await this.speakAndPlay(sentence);
      }
      this.history.push({ role: 'assistant', content: assistantFull.trim() });
    } catch (err) {
      this.logger.error(`[bridge ${this.callContext.call_sid}] turn failed:`, err.stack || err.message);
      await this.speakAndPlay("Sorry, I'm having trouble right now — want me to put you through to someone?")
        .catch(() => {});
    } finally {
      this.utteranceInProgress = false;

      // If utterances arrived while this turn was running, immediately
      // start a new turn with the buffered text — don't make the caller
      // re-say it. This is what stops "I asked a follow-up question and
      // she ignored it" from happening.
      if (this.pendingUtterance && !this.closed) {
        const queued = this.pendingUtterance;
        this.pendingUtterance = '';
        this.logger.log(`[bridge ${this.callContext.call_sid}] processing queued utterance: "${queued}"`);
        // setImmediate so we yield to the event loop before recursing
        setImmediate(() => this.onUtteranceFinal(queued).catch(() => {}));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Outbound — generate TTS, convert audio, stream back to Twilio
  // -------------------------------------------------------------------------
  async speakAndPlay(text) {
    if (this.closed || !text) return;
    this.logger.log(`[bridge ${this.callContext.call_sid}] claire: "${text}"`);
    this.assistantSpeaking = true;
    try {
      // Streaming TTS — incoming chunks are PCM-16 LE @ 16kHz
      await speakStream(text, (pcmChunk) => {
        if (this.closed) return;
        // Resample 16kHz → 8kHz, μ-law encode
        const pcm8k = resamplePcm16(pcmChunk, ELEVENLABS_OUTPUT_HZ, 8000);
        const mulaw = pcm16ToMulaw(pcm8k);
        // Chunk into 20ms frames (160 bytes at 8kHz) and send to Twilio
        for (const frame of chunkMulawForTwilio(mulaw)) {
          if (this.twilioWs?.readyState !== 1 /* OPEN */) return;
          this.twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid: this.streamSid,
            media: { payload: frame.toString('base64') },
          }));
        }
      });
      // Mark message so Twilio confirms playback completed
      if (this.twilioWs?.readyState === 1 && this.streamSid) {
        this.twilioWs.send(JSON.stringify({
          event: 'mark',
          streamSid: this.streamSid,
          mark: { name: `claire-${Date.now()}` },
        }));
      }
    } catch (err) {
      this.logger.warn(`[bridge ${this.callContext.call_sid}] speak failed: ${err.message}`);
    } finally {
      this.assistantSpeaking = false;
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------
  endCall(reason) {
    if (this.closed) return;
    this.closed = true;
    this.logger.log(`[bridge ${this.callContext.call_sid}] ending call: ${reason}`);
    try { this.stt?.close(); } catch (_) {}
    try { this.twilioWs?.close(); } catch (_) {}

    // Fire-and-forget post-call processing — Stage-1 brief extraction +
    // take-a-message detection + Resend email if Claire took a message
    // for Ed or a named staffer. Runs after the caller's hung up so it
    // can't affect their experience.
    processCallEnd({
      callContext: this.callContext,
      history: this.history,
      endReason: reason,
      logger: this.logger,
    }).catch((err) => {
      this.logger.warn(`[bridge ${this.callContext.call_sid}] post-call processing failed: ${err.message}`);
    });
  }
}

module.exports = { CallBridge };
