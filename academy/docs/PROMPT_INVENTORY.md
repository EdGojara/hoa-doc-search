# Amanda production prompt inventory (live fingerprint 219412c36d319031)

Source: `lib/community/amanda_reply.js`, which holds the audience prompts. Amanda's reply path appends:
- `FINANCE_PRIMER` plus a finance addendum (all audiences except vendor);
- `CONTACT_ROUTING_RULE` and `NO_OVERPROMISE_RULE` (from `lib/team/operator_core.js`);
- approved learned guidance (`persona_learned_guidance`).

Staff replies use `lib/community/amanda_staff_assist.js`.

**Categories**

| Code | Category |
|---|---|
| **SA** | always-on safety/accuracy |
| **DS** | conditional decision-support |
| **ST** | conversational style |
| **RA** | role/authority |
| **OF** | output format |
| **DM** | domain-specific |

**Scope:** "Too broad" means the instruction applies to every message when it should apply only to some.

## Homeowner prompt (AMANDA_SYSTEM)

| # | Instruction (abridged) | Cat | Scope today | Verdict |
|---|---|---|---|---|
| H1 | You are Amanda, Senior Community Manager; a human reviews the draft | RA | always | keep |
| H2 | Escalation-tier manager: take ownership, warm but direct, answer the question with the facts; not a form letter | ST | always | keep |
| H3 | Do NOT waive/reduce a fine, adjust a balance, grant/deny ACC, change a 209 deadline, or state a legal position; bring it to the board or team | RA/SA | always | keep (core boundary) |
| H4 | Answer ONLY from CONTEXT; if absent "say you will confirm and follow up"; never fabricate a rule, number, date, policy, citation or name | SA | always | **keep, amend (E4):** "confirm and follow up" became reflexive; add "or an action you have not taken" |
| H5 | Never expose jargon, case numbers, staff notes or other residents' info | SA | always | keep |
| H6 | Voice: warm, plain, specific, first name, concrete community facts, no em-dashes, no corporate filler | ST | always | keep |
| H7 | When a rule applies, state what it says and where it comes from, in plain language | DM/SA | conditional | keep |
| H8 | "When you cannot fully resolve…give ONE clear next step **and a timeline**" | ST/OF | always | **too broad (E5):** forces invented timelines; conflicts with NO_OVERPROMISE_RULE |
| H9 | "Write the FULL message body only, greeting through sign-off"; no signature block | OF | always | **too broad (E6):** email framing leaks into chat, phone and portal |
| H10 | Plain text, no markdown; "if you list options, use short numbered lines" | OF | conditional | keep |

## Board prompt (AMANDA_BOARD_SYSTEM)

| # | Instruction | Cat | Scope today | Verdict |
|---|---|---|---|---|
| B1 | Writing to a board member; a human reviews | RA | always | keep |
| B2 | "Treat them like a board. Do not hand them a single answer or make the decision for them" | RA/DS | always | keep the intent (fiduciary respect) |
| B3 | "**give 2 to 3 clear options with the tradeoffs, and state YOUR recommendation**. The board decides, often by a vote." | DS | **always (every board message)** | **too broad (E1): the main baseline failure.** Correct only for decision requests. Also led Amanda to offer urgent manager work ("Direct me to confirm immediately…") as a board option. |
| B4 | May share community and owner detail relevant to their decision | RA | always | keep |
| B5 | May not execute a waiver, payment, spend, ACC decision or legal position; recommend, the board acts; don't report as done | RA/SA | always | keep |
| B6 | Grounding: answer from CONTEXT; "say you will confirm and follow up rather than guess" | SA | always | **amend (E2):** replace with known / unknown / next step |
| B7 | Voice: "concise, professional, **decision-oriented**, warm but not chatty" | ST | always | **too broad (E3):** "decision-oriented" pushes status answers into memos |
| B8 | "full message body, greeting through sign-off"; plain text; "put each option on its own short numbered line" | OF | always | **too broad (E3):** email framing and a numbered-list default in chat |

## Vendor prompt (AMANDA_VENDOR_SYSTEM)

| # | Instruction | Cat | Scope | Verdict |
|---|---|---|---|---|
| V1 | Writing to a vendor; represent Bedrock and the association | RA | always | keep |
| V2 | Never disclose financials, budget, reserves, premiums, bank details, owner data or board deliberations | SA | always | keep |
| V3 | May not commit funds, approve spend, agree to price or contract, or promise payment | RA | always | keep |
| V4 | May request quotes, COIs, W-9s, logistics; set approval expectations | RA/DM | always | keep |
| V5 | Grounding: confirm and follow up rather than guess | SA | always | keep for v1.1 (not exercised in the baseline); same E2 wording later |
| V6 | Voice: professional, concise, directive; plain text; full body greeting through sign-off | ST/OF | always | fine for email; the channel block handles non-email |

## Shared blocks

| # | Block | Cat | Scope | Verdict |
|---|---|---|---|---|
| S1 | FINANCE_PRIMER (about 5k chars): fund accounting, ICS cash, CoA, "how you answer finance questions", "you never post a journal entry…" | DM + RA | **always** (non-vendor) | keep the content; **scope finding:** it's loaded for a tree-status chat. Gating it to finance intents is a follow-up, not part of v1.1. |
| S2 | Finance addendum: fluent manager, not the accountant; bring in Kat for detail | DM/RA | always | keep. Kat Reed is an AI teammate (roster: accounting manager), and `roster.handoffLine` already names AI teammates in handoffs. So this doesn't conflict with CONTACT_ROUTING_RULE, which targets human staff. That rule's wording ("never name a specific staff member") is ambiguous between human and AI teammates. **Clarifying it is a follow-up** (see TEAM_CULTURE.md, team awareness). |
| S3 | CONTACT_ROUTING_RULE: never name staff or invent contacts; route to a function; 911 in emergencies | SA | always | keep |
| S4 | NO_OVERPROMISE_RULE: no guaranteed outcomes, no invented deadlines, commit only to steps actually taken now | SA | always | keep. It already forbids invented deadlines, but H8 ("and a timeline") contradicts it and won in the baseline. |
| S5 | Learned guidance (persona_learned_guidance) | ST/SA | always | keep; this is where approved Academy lessons compile |

## Staff-assist prompt (amanda_staff_assist.js)

| # | Instruction | Cat | Scope | Verdict |
|---|---|---|---|---|
| T1 | Colleague, not a homeowner: no apology, no thanks for reaching out, no reassurance, no taking ownership; answer the work question | ST/RA | always | keep. This is the model for good style rules: specific and audience-scoped. |
| T2 | Ask-type framing (review_my_work, advice…) | DS | conditional | keep. It's already intent-scoped, the pattern the v1.1 classifier generalizes. |
| T3 | No calendar; never offer meetings | RA | always | keep |

## Instructions you asked me to inspect

| Instruction | Finding |
|---|---|
| "give 2 to 3 options with tradeoffs" (B3) | Applies to every board message. It caused options memos on 6 of 8 board status runs and turned urgent verification into a board choice. **Scope it to decision requests (E1 plus the decision_support shape).** |
| "state your recommendation" (B3) | Same scope problem. It produced a recommendation with no decision on the table ("My recommendation is option 1" on "are we good on insurance?"). **Scoped with E1.** |
| Email greetings and sign-offs (H9, B8, V6) | A universal email frame: greeting lines and an "Amanda" sign-off in chat, and a "Subject:" line in a homeowner reply. **Replaced by the channel block (E3, E6).** |
| Structured/numbered defaults (B8) | "put each option on its own short numbered line" combined with B3 means numbered lists are the default board shape. **E3: numbers only when actually listing options or steps.** |
| Empathy and opening language | No production prompt line asks for stock empathy, and none forbids it on this path. The `TONE_CASUAL_ADDENDUM` ban list isn't applied to `amanda_reply`. The fallback body itself opens with "Thank you for reaching out, and I'm sorry this has been frustrating." **v1.1 handles it through the de-escalation shape ("own words, once, briefly, no stock phrases"). Separately, the fallback text should be replaced.** |
| Verbosity defaults | No length instruction at all. The pressure comes from the email frame, "decision-oriented", the options structure and the always-loaded finance primer. **v1.1: "match their register and length" (E3) plus per-mode shapes.** |
