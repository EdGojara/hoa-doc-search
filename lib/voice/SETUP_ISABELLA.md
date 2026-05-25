# Isabella (Spanish voice) — Vapi setup walkthrough

This doc covers the one-time wiring to bring Isabella online alongside Claire.
After this is done, Spanish-speaking callers (whose contacts row has
`preferred_language = 'es'`) are automatically routed to Isabella instead of
Claire.

Everything code-side is already shipped — env vars + Vapi dashboard config
are the only steps remaining.

---

## 1. Run migration 107

Adds `contacts.preferred_language` (the column the assistant-request webhook
reads to decide Claire vs Isabella).

```sql
-- migrations/107_contacts_preferred_language.sql
```

Apply via the usual `node migrations/apply.js` or paste into the Supabase SQL
editor. Column defaults to NULL = unknown = route to Claire (no behavior
change for existing callers).

---

## 2. Pick Isabella's voice (ElevenLabs)

Voice ID is set via env var `ISABELLA_VOICE_ID`. The persona config defaults
to a placeholder string that will fail at TTS time, so this MUST be set
before Isabella takes a real call.

Audition path:
1. Go to https://elevenlabs.io/app/voice-library
2. Filter: Language = Spanish, Gender = Female, Use case = Conversational /
   Customer service
3. Listen to 3–5 candidates. Targets:
   - Warm + steady (the Latin American "Mary" equivalent)
   - Natural Tex-Mex / Latin American accent — NOT Spain Castilian
   - Conversational, not news-anchor / corporate
4. Add the chosen voice to your VoiceLab
5. Copy the voice ID (long alphanumeric string) → set as `ISABELLA_VOICE_ID`
   on Render

Candidate names worth listening to (not yet auditioned — Ed picks):
Lupe, Adriana, Valentina, Mariana, Camila, Sofia (multilingual).

If you want to A/B without redeploying, the env var lets you swap voice IDs
and just restart the service.

---

## 3. Create the Vapi assistant "Isabella"

In the Vapi dashboard → Assistants → New Assistant. Settings:

| Field | Value |
|---|---|
| Name | Isabella |
| First Message Mode | `assistant-speaks-first-with-model-generated-message` (so our assistant-request webhook supplies the dynamic opener) — OR `assistant-speaks-first` with a static Spanish greeting as a fallback |
| Provider (LLM) | **Custom LLM** |
| Custom LLM URL | `https://my.bedrocktxai.com/api/voice/vapi-llm-webhook-es` (Vapi appends `/chat/completions`) |
| Voice provider | ElevenLabs |
| Voice ID | The one you picked in step 2 (or leave blank if Vapi reads `ISABELLA_VOICE_ID` from env — confirm what Vapi supports) |
| TTS model | `eleven_flash_v2_5` (default) |
| Transcriber | Deepgram |
| Transcriber model | `nova-2-general` (NOT `nova-2-phonecall` — that variant is English-only) |
| Transcriber language | `es` |
| Endpointing | 1500ms (matches Claire's setting) |
| Server URL (for non-LLM events) | `https://my.bedrocktxai.com/api/voice/vapi-assistant-request` (same as Claire — shared for end-of-call-report processing) |

Once saved, Vapi will assign Isabella a unique assistant ID. Copy it.

---

## 4. Set Isabella's env var on Render

```
VAPI_ISABELLA_ASSISTANT_ID = <Isabella's assistant ID from step 3>
ISABELLA_VOICE_ID = <ElevenLabs voice ID from step 2>
```

Optional:
```
ISABELLA_TTS_MODEL = eleven_flash_v2_5     # default; only set if changing
```

After saving env vars, **click Manual Deploy on Render** so the new values
load.

When `VAPI_ISABELLA_ASSISTANT_ID` is unset, the assistant-request webhook
ignores Spanish routing entirely and sends every caller to Claire — safe
graceful-degradation default.

---

## 5. Phone routing — two paths

### Path A: Dedicated Spanish phone number (simplest)

Buy a second Vapi phone number ($2/mo). In its config, assign Isabella's
assistant directly. Print this number on Spanish-language flyers, mention it
in voicemail greetings, etc.

Pro: No reliance on knowing `preferred_language` ahead of time. Spanish
callers know to call the Spanish number.

Con: $2/mo extra; two numbers to publicize per community.

### Path B: Single number, language-preference routing (cleaner UX)

One phone number; assistant-request webhook decides per-caller based on
`contacts.preferred_language`. Requires populating the column for known
Spanish-speaking contacts before they call.

How to populate:
- Bulk: ask each community board for a list of households that prefer
  Spanish, set their contacts row to `preferred_language='es'` in Supabase
- Per-caller: after a Spanish-speaking caller's first call, mark their
  contact row so subsequent calls route to Isabella automatically
- Eventually: surface this as a toggle in the Contact admin UI (small UI
  task — not blocking)

Recommended: start with Path B and Waterview Estates as the pilot. Mark a
few known Spanish-speaking Waterview contacts, ask them to test-call the
existing number, verify Isabella picks up.

---

## 6. Smoke test

After deploy:

1. SSH into Supabase, set a test contact's `preferred_language` to `'es'`:
   ```sql
   UPDATE contacts SET preferred_language = 'es' WHERE primary_phone ILIKE '%832...%';
   ```
2. Call the Vapi number from that test contact's phone
3. Confirm Isabella picks up — greeting should be in Spanish:
   `Hola [name] — habla Isabella de Bedrock. ¿Qué le trae por [community] hoy?`
4. Ask a routine question in Spanish, e.g. *"¿Puedo estacionar mi RV este fin
   de semana?"* — expect a conversational Spanish response, no English
   leak, no document-citation register.
5. Ask for an account balance in Spanish — expect address-verification flow
   in Spanish, then the disclosure pattern with snapshot date translated to
   Spanish.
6. Hang up — confirm the Calls Dashboard shows the call with persona metadata
   (`persona: 'isabella'` in the assistant-request webhook log line).

If step 3 fails (Claire picks up instead of Isabella):
- Check Render logs for `[vapi-ar ...] routing to Isabella` line
- Verify `VAPI_ISABELLA_ASSISTANT_ID` env var is set + matches the Vapi
  dashboard ID exactly
- Verify the contact row's `preferred_language` is `'es'` (not `'ES'` /
  `'es-MX'` / etc. — the CHECK constraint allows only the canonical codes)

---

## 7. What's NOT in this build (deferred)

- **Mid-call language switch** (Claire detects caller is speaking Spanish →
  hands off to Isabella). Requires Vapi Squad config + transferCall tool
  registered in Claire's assistant. Reasonable Phase 1B add-on once Path A
  or Path B above is producing real Spanish calls.
- **Admin UI to set `preferred_language`** per contact. Today: Supabase
  direct edit. Small UI task — add to Contact edit screen alongside other
  fields.
- **Pre-translated legal documents** (Tier 3 of the multilingual
  architecture — see `project_multilingual_voice_architecture.md`).
  Separate workstream when first community needs it (Waterview likely first
  candidate).
- **Additional personas** (Mei Mandarin, Linh Vietnamese, Jin-Soo Korean).
  Same pattern as Isabella — voice ID env var + persona file + reason file
  + parallel webhook route. Each ~1-2 hours of dev once the Isabella
  template is locked in.

---

## File map (what this build touched)

```
migrations/107_contacts_preferred_language.sql   NEW
lib/voice/persona_isabella.js                    NEW
lib/voice/reason_isabella.js                     NEW
lib/voice/persona_helpers.js                     CHANGED — accepts banned-patterns override
lib/voice/reason.js                              CHANGED — streamTurn accepts personaPack
lib/voice/caller_lookup.js                       CHANGED — surfaces preferred_language
api/voice.js                                     CHANGED — factored shared handler, added /vapi-llm-webhook-es, persona routing in assistant-request
server.js                                        CHANGED — staff-gate exemption for /vapi-llm-webhook-es
lib/voice/SETUP_ISABELLA.md                      NEW (this file)
```
