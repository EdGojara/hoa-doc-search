# lib/voice — Claire, the Bedrock voice assistant

> Voice module that answers inbound calls into Bedrock-managed communities.
> Persona: **Claire** (see `persona.js` and `templates/responder-engine.spec.md` §5).
> Status as of 2026-05-23: **scaffolding committed; account setup pending; v1
> target mid-June for a single community (probably Lakes of Pine Forest).**

---

## What this module does

Bridges a phone call between a homeowner and Bedrock's AI assistant Claire,
contextualized to the caller's specific community. Claire reasons from the
community's CC&Rs, governing docs, vendor directory, and reserve data — the
same hybrid-retrieval pipeline askEd Chat uses. When a question is outside her
scope or the caller wants a person, Claire warmly offers a handoff and the
partial conversation brief lands in staff's inbox so they pick up with context.

## Architecture (target — not yet built)

```
Caller phone ────► Twilio number ────► Twilio Media Streams (WebSocket)
                                                │
                                                ▼
                            lib/voice/bridge.js (Node WebSocket server on Render)
                                                │
                       ┌────────────────────────┼────────────────────────┐
                       ▼                        ▼                        ▼
              Deepgram Nova-2          Claude (askEd RAG)         ElevenLabs Flash v2
              streaming STT      ─►    streaming reasoning   ─►   streaming TTS
                       │                        │                        │
                       └────────────────────────┼────────────────────────┘
                                                ▼
                                        Audio back to Twilio
```

**Per-turn latency budget**: < 1.5s end-of-utterance → first audio out.

| Stage | Provider | Latency | Cost/min |
|---|---|---|---|
| STT (streaming) | Deepgram Nova-2 phonecall | ~200ms partial, ~500ms final | $0.0043 |
| Reasoning | Claude Sonnet 4.6 (Haiku fallback for short factual lookups) | ~500-800ms first token | ~$0.01-0.02/call |
| TTS (streaming) | ElevenLabs Flash v2 | ~150-200ms first audio chunk | ~$0.10/1k chars (~$0.05/call) |
| Twilio | Programmable Voice + Media Streams | n/a | $0.013/min + $1.15/mo per number |

**Total per 5-minute call**: $0.45-0.60. **Fixed monthly** (1 number, server): ~$25-60.

## Per-call lifecycle

1. **Twilio webhook** hits `/api/voice/incoming` with caller phone + dialed number
2. **Community resolution**: look up dialed number in `voice_phone_routes` (one row per Bedrock community); identify caller via `contacts.phone_number` if a match exists in any community we manage
3. **TwiML response**: Twilio returns `<Connect><Stream>` pointing at our WebSocket bridge with community metadata in custom params
4. **Bridge opens**: spawn Deepgram session, prime Claude with system prompt + community context (hybrid-retrieval), open ElevenLabs streaming session
5. **First audio out**: Claire's opener (`buildOpener(communityName)` from `persona.js`)
6. **Turn loop**: STT partial → on utterance-end, Claude streams response → first complete sentence triggers TTS → audio streams back. Keep going until call ends or handoff.
7. **Handoff detected** (caller asks for a person, or escalation flag fires, or compliance touches): Claire delivers handoff offer, Twilio warm-transfers to the community manager's number (`voice_phone_routes.handoff_phone_number`)
8. **Call end**: full transcript stored in `homeowner_calls` table; Stage-1 brief extracted async; if there's a pending handoff or unanswered question, an item lands in staff's open-items dashboard

## Files in this module

| File | Status | Purpose |
|---|---|---|
| `persona.js` | ✓ committed | Claire's name, voice/STT config, opener/handoff/close phrases, banned patterns |
| `bridge.js` | TODO | WebSocket server bridging Twilio Media Streams ↔ Deepgram ↔ Claude ↔ ElevenLabs |
| `transcribe.js` | TODO | Deepgram streaming client wrapper |
| `reason.js` | TODO | Claude streaming wrapper with hybrid-retrieval context |
| `speak.js` | TODO | ElevenLabs streaming client wrapper |
| `handoff.js` | TODO | Logic to detect handoff intent + Twilio warm-transfer logic |
| `call_log.js` | TODO | Per-call transcript + brief storage to `homeowner_calls` |

## What Ed needs to set up over the weekend (Memorial Day)

This is the only blocking work for Monday-morning resumption.

### 1. Twilio account + number — ~30 min
- Sign up at twilio.com if no existing account (free tier covers initial testing)
- Buy a US local number ($1.15/mo) — pick a 281 or 832 area code (Houston metro, matches Bedrock's existing 832-588-2485)
- Enable Programmable Voice + Media Streams on the number
- Note the **Account SID** and **Auth Token** — these go in Render env vars (see below)

### 2. Deepgram account — ~15 min
- Sign up at deepgram.com (Pay-as-you-go, $200 free credit for new accounts)
- Generate an API key with streaming STT scope
- Note the **API key** — Render env var

### 3. ElevenLabs account — ~15 min
- Sign up at elevenlabs.io (Free tier OK for testing; Starter $5/mo or Creator $22/mo for production volume + commercial use)
- Browse the voice library for a warm, professional female voice (we'll A/B-test 3-5 candidates before locking)
- Note the **API key** — Render env var

### 4. Render env vars
After accounts are created, paste these into Render → trustEd service → Environment:

```
TWILIO_ACCOUNT_SID
```
```
TWILIO_AUTH_TOKEN
```
```
TWILIO_PHONE_NUMBER
```
```
DEEPGRAM_API_KEY
```
```
ELEVENLABS_API_KEY
```
```
VOICE_WEBSOCKET_URL
```
(VOICE_WEBSOCKET_URL = your Render service URL with `/api/voice/stream` appended, e.g. `wss://trusted-x.onrender.com/api/voice/stream`)

That's the whole weekend list. Total time: ~1 hour. The actual bridge code I'll
build Tuesday-Thursday next week so we can demo voice for one community by
mid-June.

## Things deferred (don't build until v1 voice is in production)

- **Outbound voice** (Claire calls homeowners proactively for reminders / surveys) — possible but not in scope
- **Multi-language** — English only for v1. Spanish next, given Texas demographics
- **Voice ID / authentication** — v1 trusts caller-ID + voluntary identification. Doesn't verify identity for sensitive info. Strict mode comes later.
- **Per-community voice variants** — single Claire voice across all communities for v1. Per-community variants only if a board explicitly requests one.

## Why this architecture (vs. alternatives we rejected)

- **Why not Twilio Autopilot / Dialogflow?** Both are pattern-matching, not reasoning. Generic chatbot quality. Same reason Bedrock's existing tools beat Vantaca's email customization.
- **Why not Vapi / Retell / Bland?** Good voice-AI platforms, but they're vertically generic. We want Claire deeply integrated with trustEd's community data (CC&Rs, vendor directory, AR snapshots, ARC files) — that requires owning the bridge layer.
- **Why streaming-only at the turn level?** Latency. A synchronous Stage-1 extract before audio out adds 800ms+; conversations stall. Extract runs asynchronously *after* the call for handoff/logging instead.

See `templates/responder-engine.spec.md` for the full design rationale.
