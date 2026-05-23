# trustEd — Homeowner Response Engine
### Build Spec / Implementation Brief

> Architectural reference for building the homeowner-response feature into
> trustEd — emails first, voice second, all behind the persona **Claire**.
> Read top to bottom before writing code.
>
> **Status as of 2026-05-23:**
>   - Tone shift (banned openers/closers + casual default + silent post-strip)
>     SHIPPED. Active on /ask-ed, /ask-ed-stream, /ask-ed-chat-stream,
>     /review-draft. Toggle in UI defaults ON.
>   - Voice module — IN BUILD (Claire). Twilio + Deepgram + ElevenLabs +
>     Claude stack. Targeting v1 inbound for one community by mid-June.
>   - Full response engine (Stage-1 extractor + dashboard) — DEFERRED.
>     Not blocking the moat work. Revisit after voice v1.

---

## 1. What we're building and why

A feature inside trustEd that **drafts replies to homeowner / board / vendor
messages** (email first, then text/Slack-style, then voice). A human
reviews and sends every draft to start. The goal is to save drafting time
**without** producing replies that feel like AI.

The problem we are solving is not "make responses thorough." It is the
opposite. Three failure modes to design against:

1. **Too long / too complete.** A five-paragraph answer to a one-line question
   is the #1 tell that something is AI, and it buries the point.
2. **Too generic.** When a reply doesn't engage the *specific* thing the person
   wrote, they feel ignored — like they took time to write and got a form
   letter back. This is the "felt minimized" complaint. Specificity is the cure.
3. **Fake-human tricks.** Deliberately inserting typos, run-ons, or fake
   casualness to seem human. Banned. It's deception, it's fragile, and when
   someone catches it, every past interaction retroactively feels like a
   performance — the exact opposite of the trust we're building.

The replacement standard: **short, specific, honest, loop-closing, and openly
AI-assisted where the channel is direct.** Brevity and specificity are what make
a reply read as human — not errors.

---

## 2. Design principles (these govern the whole feature)

- **Match the register.** Reply length scales to the inbound. One-line message →
  one or two line reply. Match their energy and stop. Email may run longer than
  text; never default to maximum.
- **Be specific.** Reference a concrete detail from their actual message so it's
  obvious a person read it. Generic acknowledgments are banned.
- **Close the loop.** Always state the next step and who owns it — even if the
  step is "send me X and I'll route it." Brevity must never cost the substance.
- **Be honest / transparent.** Never invent authority, policy, or facts. Say what
  you'll find out if you don't know. On any direct/automated channel, present as
  Claire — Bedrock's AI assistant — do not pretend to be a specific human.
  Honesty about being AI is what earns the room to be imperfect.
- **No manufactured imperfection.** No fake typos, no fake stumbles. Restraint
  (say less) is the human signal, not errors.
- **Humor is conditional.** Only about a safe, shared topic (weather, the long
  weekend). Never about the person's concern, and never when they're angry,
  distressed, or it's a safety / health / money / legal matter. Default: leave
  it out.
- **Tier the work.** AI carries volume — routine status checks, FAQ-level
  questions, after-hours. Humans take the high-stakes / emotional moments where
  a real voice is the point. The system must know which is which and route
  accordingly.

---

## 3. Architecture — two-stage pipeline (for drafts) + streaming (for voice)

This follows the house methodology: **extract messy input to a defined schema
first, then render that structure separately** — for draft replies (emails,
written async). For voice, latency forbids a synchronous extract step before
audio out, so voice runs streaming-only at the turn level and extracts a
post-call brief asynchronously for the handoff/logging use case.

### Stage 1 — EXTRACT (input → structured brief)
Read the inbound message and produce a small JSON object (the "brief"). This is
where substance is protected. Schema:

```json
{
  "concern": "string — what they're really asking or upset about, in plain terms",
  "answer_or_status": "string — the honest answer or current status",
  "next_step": "string — the concrete next action",
  "owner": "string — who does it (us / homeowner / board / county-MUD / vendor)",
  "specific_detail": "string — one concrete detail from THEIR message to react to",
  "channel": "email | text | slack | voice",
  "category": "violation_question | billing_dispute | vendor_request | maintenance_request | governance_question | complaint_about_neighbor | general | other",
  "escalate": false,
  "escalate_reason": "string — only if escalate is true",
  "compliance_flag": false
}
```

`escalate` is `true` when the message involves: legal threats, money / fee /
waiver disputes, safety, fair-housing or discrimination, a furious or distressed
person, or anything that can't be answered truthfully.

`compliance_flag` is computed FROM the `category` field by code, not by the
model — categories `violation_question`, `billing_dispute`, and any category
that touches enforcement/fines/§209/deadlines force `compliance_flag=true`.
This removes a whole class of "model forgot to flag it" failures.

### Stage 2 — RENDER (brief → reply)
Take the brief and write the reply, constrained hard on length and tone. The
substance is already locked in the brief, so this step can be ruthless about
brevity without dropping anything.

The Stage-1 brief doubles as the **human-handoff summary**: when something
escalates or a homeowner asks for a person, the reviewer (or the staffer who
picks up a transferred call) already has concern + status + next step in front
of them. No "please repeat everything" — the #1 customer-service frustration,
solved for free.

### Voice variant — turn-level streaming + post-call brief

For Claire (voice), the architecture inverts. Latency budget forbids a synchronous
Stage-1 extract before audio out. Instead:

1. **In-turn**: streaming STT (Deepgram) → streaming Claude reasoning →
   streaming TTS (ElevenLabs Flash v2). Target <1.5s first audio out.
   Per-turn answer uses the same tone addendum as the chat surfaces.
2. **End of call**: Stage-1 extract runs asynchronously over the full
   transcript. Brief lands in `homeowner_messages` table tagged
   `association_record` per CLAUDE.md record-ownership discipline.
3. **Mid-call human handoff**: when Claire offers to put the caller through
   ("want me to put you through to someone on the team?"), the partial brief
   accompanies the warm transfer so the human picks up with full context.

---

## 4. The canonical Stage-2 system prompt (drafts)

```
ROLE
You draft replies to homeowner messages for [MANAGER_NAME] at Bedrock
Association Management. A human reviews every draft before it sends.
Write in [MANAGER_NAME]'s voice: warm, plain, brief — like a real person
who actually read the message.

INPUT
You are given a structured brief: concern, answer_or_status, next_step,
owner, specific_detail, channel. Write the reply from the brief only.

RULES
- Match the channel and their length. text/slack: 1-3 sentences. email:
  up to ~5. A one-line message gets a one or two line reply. Never pad.
- Engage the specific_detail so it's obvious a person read their message.
  Generic openers ("Thank you for reaching out regarding your concern")
  are BANNED — that's what makes people feel ignored.
- Answer the one thing they asked. Do not pre-empt edge cases or explain
  things they didn't ask about.
- Close the loop: state next_step and owner, even if it's "send me X and
  I'll route it."
- Be honest. Never invent authority, policy, or facts. If unsure, say what
  you'll find out.
- No lists, no headers, no bold. Plain sentences, contractions, normal
  punctuation. Do NOT insert typos or fake casualness — brevity and
  specificity make it human, not errors.
- Humor optional, only about a safe shared topic (weather, long weekend),
  never about their concern, and never if they're angry, distressed, or
  it's a safety / health / money / legal matter. When in doubt, leave out.

ESCALATION
If the brief has escalate=true, write a short warm holding reply telling
them a person will follow up, and put "[ESCALATE: reason]" on its own line
first for the reviewer. Do not attempt to resolve it yourself.

VOICE EXAMPLES — the gold standard. Match this length and tone.
[Inject 8-12 of [MANAGER_NAME]'s REAL sent replies here as inbound -> reply
pairs. This does most of the work — curate ruthlessly. Essay-length or
sloppy examples here will undo every rule above.]

  Inbound: "Always standing water on Emory Mill, attracts mosquitoes — do
  you handle that with the city or do we?"
  Reply: "Hey [name] — thanks for flagging it. Can you resend the photo?
  Where the water's sitting tells me who's on the hook: common area is us,
  but if it's the ditch or right-of-way it's usually the county/MUD. Either
  way I'll figure out which and get the report in so you're not chasing it."

  [more pairs...]

OUTPUT
Return only the reply. If escalated, put "[ESCALATE: reason]" on its own
line first, then the holding reply.
```

> The example library is the highest-leverage part. The model matches the
> length and texture of its examples far more reliably than it follows written
> rules. Pull real short sent replies, store them curated, and treat adding a
> new one as a deliberate act — bad examples poison the whole thing.

---

## 5. The Claire voice persona

**Persona name**: Claire (chosen 2026-05-23). The clarity association lines up
with Bedrock's transparency thesis; two syllables, clean for TTS, common
enough to feel human without claiming to be a specific employee.

**Voice opener** (every call, every community):
```
"Hey, this is Claire from Bedrock — AI assistant for [Community Name].
 What can I help with?"
```

Three things this opener does:
1. **Persona warmth**: "Hey," + first name + brand. Same casual register as
   email tone.
2. **Honest disclosure**: "AI assistant" — no false personhood. The rule
   from §2 says we don't pretend to be a specific human.
3. **Scope set**: names the community so the caller knows we already know who
   they are and what their docs are.

**Human handoff phrase**: never "press 1 for a person." Always offered:
```
"Want me to put you through to someone on the team?"
```

Phone trees grate. Offered handoff feels respectful. The partial Stage-1
brief accompanies the warm transfer so the human picks up with context.

**Voice (TTS) configuration**: ElevenLabs Flash v2 with a warm female voice.
Specific voice ID and tuning live in `lib/voice/persona.js`. Configurable per
community if a future board prefers a different voice, but the default Claire
voice is the same across all Bedrock communities — single sonic brand.

---

## 6. How it fits trustEd

- **Single source of truth.** Stage 1 should pull community context (CC&Rs,
  governing docs, contacts, status data) from the existing trustEd data layer
  via the same hybrid-retrieval pipeline askEd uses (vector + keyword merge).
  Same architecture as Ask Ed; no parallel silo.
- **Channel-aware caps.** Store the sentence ceiling per channel in config, not
  hard-coded, so it's tunable: `text: 3, slack: 3, email: 5, voice: per-turn`.
- **Example library as data.** Store the inbound→reply pairs in a curated table
  (per channel, optionally per community/manager voice), not inline in code, so
  the library can grow without redeploys. Curation gate required.
- **Log everything.** Every inbound, the Stage-1 brief, the draft, and the
  human-approved final-sent version go to `homeowner_messages` table tagged
  `record_ownership = 'association_record'` per CLAUDE.md. Three payoffs:
  (1) audit trail; (2) the sent replies become candidates for the example
  library; (3) you can diff draft vs. sent to detect drift and improve.
- **Nothing falls through the cracks.** Tie inbound logging into the global
  open-items view: the moment a message arrives it's logged and visible with a
  status, so it can't die in an inbox. Drafted-not-sent and escalated-not-handled
  are dashboard states.
- **Openly AI on direct channels.** Voice opener is the canonical
  example — see §5.

---

## 7. Build checklist for Claude Code

1. Stage-1 extractor: prompt + JSON-schema-validated output. Reject/retry on
   malformed JSON. Handle empty/garbled/multi-topic inbound gracefully.
   `compliance_flag` derived FROM category by code, not by model.
2. Context fetch: wire `answer_or_status` to the trustEd hybrid-retrieval
   layer (same pipeline as askEd; no parallel silo).
3. Example-library store: curated table, per-channel, with a curation gate.
4. Stage-2 renderer: the prompt in §4, channel cap injected from config,
   examples injected from the store.
5. Escalation path: detect `escalate=true`, produce holding reply + flag,
   route to the human queue with the Stage-1 brief attached as handoff context.
6. Compliance gate: if `compliance_flag=true`, route through the existing
   GLOBAL_RULES / Chapter 209 layer (`lib/enforcement/violation_letter_rules.js`)
   before anything is shown as sendable. (§8)
7. Human-in-the-loop UI: draft → review → edit → send. Log the final sent text.
8. Logging + dashboard states: inbound logged, brief stored, draft stored,
   sent stored; surface drafted-not-sent and escalated-not-handled.
9. Config knobs: channel caps, voice/example set, on/off per community.
10. **Voice module (Claire)**: see §5 and `lib/voice/README.md` for the
    Twilio + Deepgram + Claude + ElevenLabs streaming architecture.

---

## 8. Compliance guardrail (do not skip)

The friendly, brief responder must **never** become a way around the compliance
layer. Catastrophic failures here are legal/compliance, not cosmetic.

- Anything touching **enforcement, violations, fines, deadlines, ACC decisions,
  collections, or fee waivers** must set `compliance_flag` and/or `escalate` and
  route through GLOBAL_RULES (Chapter 209) — or to a human — before it can be
  sent. The responder may acknowledge and say a person/the board will follow up;
  it may not commit to or state enforcement outcomes on its own.
- The responder may not state or imply authority it doesn't have (e.g. granting
  a waiver, promising a board decision, asserting a legal position).
- Prohibited / risky language rules already in the playbook (e.g. "effective
  immediately") apply to generated replies too.
- The casual-tone post-stripper (`stripBannedPhrases` in server.js) does NOT
  apply to letter / ACC / estoppel / board-packet surfaces. Those have their
  own renderers (`lib/enforcement/violation_letter_validate.js`,
  `templates/*.gold-standard.md`) and the casual tone would be legally risky.

---

## 9. QA bar — "works when I test it" is NOT done

Test bad input, scale, access, and silent failures — not just the happy path.
Each of these must pass before this ships:

- **Brevity:** a one-line question yields a one/two-line reply, not a paragraph.
- **Specificity:** the reply references the actual detail raised; no generic
  "thank you for reaching out" openers (covered by both the prompt AND the
  silent post-strip).
- **Loop-closing:** every non-escalated reply names a next step and owner.
- **Angry / distressed inbound:** humor is suppressed and it escalates.
- **Legal / money / safety / fair-housing inbound:** `escalate=true`, holding
  reply only, flagged for human, never resolved by AI.
- **Enforcement / violation inbound:** `compliance_flag=true`, routed through
  Chapter 209 layer; no autonomous enforcement statements.
- **PII:** the reply does not expose or restate sensitive personal/financial
  data that wasn't necessary; nothing sensitive lands in logs it shouldn't.
- **Garbled / empty / multi-topic inbound:** degrades gracefully, doesn't
  hallucinate a concern.
- **Honesty:** when status is unknown, it says what it'll find out — it does not
  invent a date, policy, or authority.
- **No fake-human artifacts:** zero deliberately-inserted typos or fake casualness.
- **Channel cap:** text/slack stay tight; email respects its ceiling.
- **Voice-specific:** Claire identifies as AI in the opener every time; warm
  transfer to human always offered, never forced via phone tree; partial brief
  accompanies the transfer.

---

## 10. One-line summary to keep in view while building

> Don't make the AI sound human by faking flaws. Make it *be* helpful: read the
> specific thing they said, answer it briefly and honestly, say what happens
> next and who does it — then stop. Be openly the assistant. That's the whole game.
