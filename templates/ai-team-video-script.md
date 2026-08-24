# AI-Team Demo Video — Script & Storyboard (DRAFT for lock)

> Ed 2026-08-24. Lock this BEFORE rendering. HeyGen renders cost money; the
> discipline is script → storyboard → one test render → batch. Do not render by
> trial and error.
>
> **Evergreen rule:** nothing in the narration may name an audience (bank, board,
> a specific partner), a date, or a count that changes ("seven communities").
> Those live in the cheap text screens of the in-platform demo, never in the
> expensive video. This keeps every segment reusable for the bank, boards, and
> partners with no re-render.
>
> **Format:** modular SOLO segments, one persona each, stitched by the in-platform
> slide-screens between them. NOT multi-avatar-in-one-frame (hardest to produce,
> most brittle, forces full re-renders). Each segment stands alone and is reusable
> on its own.
>
> **Voice = HeyGen, NOT ElevenLabs.** The video is rendered end to end by HeyGen:
> it produces the avatar AND speaks the script with a HeyGen voice (`voice_id`).
> ElevenLabs is the separate LIVE phone-voice stack (Vapi + ElevenLabs Mary) and
> is not in the video path. Each persona's HeyGen avatar_id + voice_id are already
> configured (CLAIRE/KAT/PAIGE/AMANDA _AVATAR_ID + _VOICE_ID in env), so the cast
> is built — the remaining work is rendering their segments, not creating characters.
>
> **Target runtime:** ~3–4 minutes total. Per-segment ~30–45s. Cast kept to the
> minimum the script needs.
>
> **Honest-AI rule (CLAUDE.md):** every persona is named as Bedrock's AI team
> member, never presented as a specific human. Keep it warm, specific, brief.

---

## Cast (minimum viable — build only these characters)

| Persona | Role in the video | Why they're in it |
|---|---|---|
| **Claire** | Host. Opens and closes. | Already live (EN + ES), the established face. |
| **Kat** | The money. Accounting/financials segment. | Shows judgment where it's most consequential. |
| **Paige** | The board. Board-ops segment. | Shows the board actually being served. |
| **Amanda** | The community. Enforcement/ARC/day-to-day. | Shows the operator role, the thing we automate. |

> Tessa is owner-only — excluded. Add Emma (AP) or Annie (ACC) later only if a
> future cut earns them; each new character is a fixed avatar+voice setup cost.

---

## Segment 1 — Claire, the open  (~30s)

> Storyboard: plays on the in-platform screen titled **"This is what we built."**
> (screen id `bedrock_ai_video`).

"Hi, I'm Claire, part of the Bedrock team. We're not a chatbot bolted onto old
HOA software. We're the operating system that actually runs a community. I answer
homeowners around the clock, and behind me is a team that handles the money, the
board, and everything that happens on your streets. Let me introduce them, and
then show you what that looks like."

---

## Segment 2 — Kat, the money  (~40s)

"I'm Kat. I handle the accounting the way a seasoned controller would, not just
faster. When an invoice comes in, I read it, I know which account it belongs to,
and I know when the amount doesn't match the vendor's history and needs a second
look. The books reconcile themselves, so the exceptions are the only thing a
person touches. A board gets financials they can actually trust, and they get
them without waiting on anyone."

---

## Segment 3 — Paige, the board  (~40s)

"I'm Paige. I work for the board. Most boards get a quarterly binder and a
generic template. I give them analysis of their own community: what's really
happening with the budget, which decisions are coming, and the context that
usually walks out the door when a manager leaves. When the board meets, the
packet is ready, it's specific to them, and every recommendation comes with the
reasoning behind it."

---

## Segment 4 — Amanda, the community  (~40s)

"I'm Amanda. I handle the day-to-day that used to need a full-time manager on
site. Architectural requests, deed-restriction enforcement, the vendor
coordination. Every letter a homeowner gets is grounded in that community's own
governing documents, not a form. And it's consistent: the same rule, applied the
same way, every time, which is exactly what holds up when someone questions it."

---

## Segment 5 — Claire, the close  (~25s)

> Storyboard: plays on the closing screen, or just before the roadmap.

"That's the team. One system, tuned to each community's bylaws, its board, its
history, and getting sharper every month it's in use. It's not a product we push
hoping it fits. It's a system we configure. That's what community, simplified,
actually means."

---

## Production checklist (the money-saver)

- [ ] Script locked (this file), read aloud once for timing (~3–4 min total).
- [ ] Characters: Claire, Kat, Paige, Amanda — HeyGen avatar_id + voice_id already
      set in env for all four. Nothing to build; confirm each renders as expected.
- [ ] **ONE test render: Segment 1 (Claire) only.** Check avatar, voice, pacing,
      caption burn-in, aspect ratio (16:9 to match the in-platform player).
- [ ] Approve the test, THEN batch-render Segments 2–5 with the same settings.
- [ ] Each rendered segment lands in `claire_explainers` with its own `topic`
      (e.g. `team_open`, `team_kat`, `team_paige`, `team_amanda`, `team_close`),
      stored in the public `explainers` bucket (permanent URL, mig 369).
- [ ] Wire the topics into `lib/presentations/story.js` video screens.
- [ ] Optional Spanish cut later: Claire + Isabella, same locked script translated.

## Cost note

~3–4 min of render across 5 short segments, well inside the HeyGen cap. Modular
segments mean a re-render is one 30–40s segment, never the whole video.
