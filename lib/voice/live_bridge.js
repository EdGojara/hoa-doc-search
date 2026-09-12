// ============================================================================
// lib/voice/live_bridge.js  (Ed 2026-09-12 — GPT-Live-1 voice PoC)
// ----------------------------------------------------------------------------
// LiveClaireSession — Claire's voice on GPT-Live-1, with reason.js as the brain.
//
// GPT-Live-1 is the full-duplex VOICE SHELL: it listens, speaks, handles
// interruptions and backchannels natively. It owns NO business logic. Every
// substantive turn is delegated back to us (client delegation) and answered by
// reason.js through answerForVoice() — the exact same backend the current phone
// pipeline and the portal use. The voice layer is swappable; the brain is not.
//
// This class is TRANSPORT-AGNOSTIC. It holds the OpenAI Live WebSocket and runs
// the delegation loop; audio flows in via sendAudio() and out via the
// onOutputAudio callback. A Twilio (mu-law) adapter or a browser (pcm) adapter
// wires the actual media, so one provider serves both surfaces.
//
// Protocol verified end-to-end against the live API (see scripts/gpt_live_probe.js):
//   session.start {delegation:{type:'client'}}         -> session becomes active
//   caller audio        -> session.input_audio.append
//   partial transcripts -> session.input_transcript.delta  (we accumulate)
//   model delegates     -> session.delegation.created {delegation:{id}}  (no task text)
//   we answer           -> answerForVoice(accumulated transcript)  [reason.js]
//   we reply            -> session.commentary.append {content, delegation_id}  (she voices it)
//   she speaks          -> session.output_audio.delta  -> onOutputAudio()
// NOTE: response.create / response.item.create are Responses-delegation only and
// are REJECTED under client delegation — do not use them here.
// ============================================================================
const OpenAI = require('openai');
const { LiveWS } = require('openai/resources/live/ws');
const { answerForVoice } = require('./answer_backend');

const MODEL = process.env.GPT_LIVE_MODEL || 'gpt-live-1';
const DEFAULT_VOICE = process.env.CLAIRE_LIVE_VOICE || 'marin';
// session.commentary.append content is capped at 500 tokens; keep the spoken
// answer comfortably under that (~4 chars/token). Voice answers are short by
// nature; this is a defensive trim at a sentence boundary, never mid-word.
const MAX_REPLY_CHARS = 1400;

function trimToBudget(text) {
  const s = String(text || '').trim();
  if (s.length <= MAX_REPLY_CHARS) return s;
  const cut = s.slice(0, MAX_REPLY_CHARS);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return (lastStop > 400 ? cut.slice(0, lastStop + 1) : cut).trim();
}

function buildInstructions(community) {
  const who = community && community.name ? ` for ${community.name}` : '';
  // The SHELL prompt only: identity, pace, and "delegate everything substantive."
  // reason.js carries all the real rules (grounding, guardrails, tone).
  return [
    `You are Claire, Bedrock's AI assistant${who}.`,
    `In your very first sentence, say you are Bedrock's AI assistant. Never claim to be a specific person.`,
    `Keep it warm, brief, and natural. Let people interrupt you and respond to interruptions gracefully.`,
    `You do NOT answer substantive questions yourself. Delegate every question about accounts, balances, rules, violations, architectural requests, payments, meetings, or anything specific to your application, and speak the answer it returns, verbatim in substance.`,
    `Never invent facts. Never grant a waiver or make a compliance, enforcement, or legal decision. Offer to connect a real person whenever someone asks or the matter is sensitive.`,
    `Use commas and periods, never em dashes.`,
  ].join(' ');
}

class LiveClaireSession {
  /**
   * @param {object} opts
   * @param {object} opts.callContext  { community, caller, caller_phone, warmup, call_sid }
   * @param {function} opts.onOutputAudio  (base64Delta) => void — play to the caller
   * @param {function} [opts.onOutputTranscript] (text) => void
   * @param {string} [opts.voice]  stock voice id (default env/marin)
   * @param {object} [opts.audio]  optional audio format override (Twilio mu-law etc.)
   * @param {object} [opts.logger]
   */
  constructor({ callContext = {}, onOutputAudio, onOutputTranscript, voice, audio, logger = console } = {}) {
    this.ctx = callContext;
    this.onOutputAudio = typeof onOutputAudio === 'function' ? onOutputAudio : () => {};
    this.onOutputTranscript = typeof onOutputTranscript === 'function' ? onOutputTranscript : () => {};
    this.voice = voice || DEFAULT_VOICE;
    this.audio = audio || null;
    this.logger = logger;
    this.client = new OpenAI({ apiKey: process.env.GPT_LIVE_API_KEY || process.env.OPENAI_API_KEY });
    this.ws = null;
    this.closed = false;
    this._inputTranscript = '';   // accumulates the caller's current utterance
    this.history = [];            // [{role, content}] for reason.js context
    this._answering = false;
  }

  _sid() { return this.ctx.call_sid || 'live'; }

  /** Open the session and start the event loop. Resolves once it is active. */
  start() {
    return new Promise((resolve, reject) => {
      try { this.ws = new LiveWS(this.client); }
      catch (e) { return reject(e); }

      try { this.ws.on('error', (e) => this.logger.warn(`[live ${this._sid()}] ws error:`, (e && e.error) || (e && e.message) || e)); } catch (_) {}

      const audioCfg = { output: { voice: this.voice } };
      if (this.audio) Object.assign(audioCfg, this.audio); // e.g. mu-law formats for Twilio
      const cfg = {
        type: 'session.start',
        session: {
          model: MODEL,
          instructions: buildInstructions(this.ctx.community),
          delegation: { type: 'client' },
          audio: audioCfg,
        },
      };
      this.logger.log(`[live ${this._sid()}] starting; community=${this.ctx.community?.name || 'unknown'} voice=${this.voice}`);
      try { this.ws.send(cfg); } catch (e) { return reject(e); }

      let resolved = false;
      this._loop(() => { if (!resolved) { resolved = true; resolve(this); } }).catch((e) => {
        if (!resolved) { resolved = true; reject(e); } else { this.logger.error(`[live ${this._sid()}] loop failed:`, e.message); }
      });
    });
  }

  async _loop(onActive) {
    for await (const raw of this.ws) {
      if (this.closed) break;
      // Server events arrive wrapped: { type:'message', message:{...realEvent} }.
      // Lifecycle events (connecting/open/close) come through top-level.
      const ev = raw && raw.type === 'message' ? raw.message : raw;
      const t = ev && ev.type;
      switch (t) {
        case 'session.started':
          onActive();
          break;
        case 'session.input_transcript.delta':
          this._inputTranscript += (ev.delta || '');
          break;
        case 'session.delegation.created':
          if (ev.delegation && ev.delegation.target === 'client') {
            // fire and forget — do not block the event loop on reason.js
            this._answerDelegation(ev.delegation.id).catch((e) => this.logger.error(`[live ${this._sid()}] answer failed:`, e.message));
          }
          break;
        case 'session.output_transcript.delta':
          if (ev.delta) this.onOutputTranscript(ev.delta);
          break;
        case 'session.output_audio.delta':
          if (ev.delta) this.onOutputAudio(ev.delta);
          break;
        case 'error':
          this.logger.warn(`[live ${this._sid()}] server error:`, JSON.stringify(ev.error || ev).slice(0, 300));
          break;
        case 'close':
        case 'session.closed':
          this.closed = true;
          return;
        default:
          break;
      }
    }
  }

  /** Run reason.js for the delegated turn and voice the grounded answer back. */
  async _answerDelegation(delegationId) {
    const question = this._inputTranscript.trim();
    this._inputTranscript = '';
    if (!question) {
      // Nothing transcribed yet; ask her to prompt rather than answer blind.
      this._reply(delegationId, "Sorry, I did not catch that. Could you say it again?");
      return;
    }
    if (this._answering) { /* serialize; the model rarely double-delegates */ }
    this._answering = true;
    try {
      const { text, empty } = await answerForVoice({
        utterance: question,
        history: this.history.slice(-12),
        community: this.ctx.community || null,
        caller: this.ctx.caller || null,
        caller_phone: this.ctx.caller_phone || null,
        warmup: this.ctx.warmup || null,
      });
      const answer = empty ? "Let me get someone from the team to help with that." : trimToBudget(text);
      this.history.push({ role: 'user', content: question });
      this.history.push({ role: 'assistant', content: answer });
      this._reply(delegationId, answer);
    } finally {
      this._answering = false;
    }
  }

  _reply(delegationId, content) {
    if (this.closed || !this.ws) return;
    try {
      this.ws.send({ type: 'session.commentary.append', content, delegation_id: delegationId });
    } catch (e) {
      this.logger.error(`[live ${this._sid()}] reply send failed:`, e.message);
    }
  }

  /** Feed caller audio (base64, in the session's input format). */
  sendAudio(base64) {
    if (this.closed || !this.ws || !base64) return;
    try { this.ws.send({ type: 'session.input_audio.append', audio: base64 }); }
    catch (e) { this.logger.error(`[live ${this._sid()}] audio send failed:`, e.message); }
  }

  close() {
    this.closed = true;
    try { this.ws && this.ws.close(); } catch (_) {}
  }
}

module.exports = { LiveClaireSession, buildInstructions, MODEL, DEFAULT_VOICE };
