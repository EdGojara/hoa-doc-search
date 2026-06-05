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
const { isSentenceComplete } = require('./sentence_completeness');
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

// Semantic endpointing — feature-flagged at deploy time. When ON, after
// Deepgram says "speech ended" we ask Haiku "is this sentence complete?"
// before responding; if incomplete, hold text and wait N ms for more
// speech before proceeding. Default OFF until tested in a controlled call.
//
// Backchannel: when we enter a grace period (semantic endpointing held for
// continuation), optionally play a quick "mm-hmm, take your time" so the
// caller hears we're still listening rather than dead air. Bundled with
// semantic endpointing because they only make sense together — without
// the semantic hold there's no defined "we're waiting" window to fill.
// Case-insensitive boolean env parser — accepts true/TRUE/True/yes/1.
// Defends against the "I typed True with a capital T and wondered why
// the flag didn't flip" silent-failure pattern.
function envBool(name) {
  const v = String(process.env[name] || '').trim().toLowerCase();
  return v === 'true' || v === 'yes' || v === '1' || v === 'on';
}

// Fast-pacing bundle — one env switch that pairs three changes that fix each
// other's regressions: lower Deepgram threshold (persona.js does this part) +
// force semantic endpointing on + force backchannel on + tighter grace window.
// The whole point: 1500ms Deepgram silence was paying for safety against
// interrupts; with the Haiku sentence-completeness check active, we don't
// need that safety margin built into the silence threshold. Net: ~600ms
// faster per substantive turn, same answers.
const FAST_PACING = envBool('CLAIRE_FAST_PACING');
const SEMANTIC_ENDPOINTING_ENABLED = FAST_PACING || envBool('CLAIRE_SEMANTIC_ENDPOINTING');
const SEMANTIC_ENDPOINTING_WAIT_MS = Number(
  process.env.CLAIRE_SEMANTIC_WAIT_MS || (FAST_PACING ? 1200 : 1500)
);
const BACKCHANNEL_DURING_HOLD = FAST_PACING || envBool('CLAIRE_BACKCHANNEL');
const BACKCHANNEL_PHRASES = [
  'Mm-hmm.',
  'Take your time.',
  'Go ahead.',
];
function pickBackchannel() {
  return BACKCHANNEL_PHRASES[Math.floor(Math.random() * BACKCHANNEL_PHRASES.length)];
}

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

    // Semantic endpointing — feature-flagged. Ask Haiku whether this
    // sentence is semantically complete. If incomplete, set up a brief
    // grace window for more speech before we commit to responding.
    // This catches the "caller paused to think" case where Deepgram
    // declared speech-end after 800ms of silence but the caller wasn't
    // actually finished. Cost: ~150-250ms extra latency on every turn.
    //
    // Guard against infinite hold: `_alreadyHeldOnce` is set when we
    // entered a grace period; on the re-entry triggered by the timeout,
    // we proceed without re-checking even if Haiku still says incomplete.
    if (SEMANTIC_ENDPOINTING_ENABLED && !this._alreadyHeldOnce) {
      const verdict = await isSentenceComplete(text);
      this.logger.log(`[bridge ${this.callContext.call_sid}] endpointing: complete=${verdict.complete} confidence=${verdict.confidence} (${verdict.reasoning})`);
      if (!verdict.complete && verdict.confidence !== 'low') {
        this.pendingUtterance = text;
        this.utteranceInProgress = false;
        this._alreadyHeldOnce = true;
        this.logger.log(`[bridge ${this.callContext.call_sid}] holding for continuation (${SEMANTIC_ENDPOINTING_WAIT_MS}ms)`);

        // Backchannel: signal we're still listening with a quick
        // acknowledgment instead of dead air. Skip if a backchannel was
        // very recently played (rate-limit to avoid spamming).
        if (BACKCHANNEL_DURING_HOLD && Date.now() - (this._lastBackchannelAt || 0) > 5000) {
          this._lastBackchannelAt = Date.now();
          const phrase = pickBackchannel();
          this.logger.log(`[bridge ${this.callContext.call_sid}] backchannel: "${phrase}"`);
          this.speakAndPlay(phrase).catch(() => {});
        }

        setTimeout(() => {
          if (this.closed || this.utteranceInProgress) return;
          if (!this.pendingUtterance) return; // already consumed by a continuation
          const held = this.pendingUtterance;
          this.pendingUtterance = '';
          this.logger.log(`[bridge ${this.callContext.call_sid}] grace expired, proceeding with: "${held}"`);
          this.onUtteranceFinal(held).catch(() => {});
        }, SEMANTIC_ENDPOINTING_WAIT_MS);
        return;
      }
    }
    // Reached the response stage — clear the hold guard so the next
    // utterance gets a fresh chance at semantic endpointing.
    this._alreadyHeldOnce = false;

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
