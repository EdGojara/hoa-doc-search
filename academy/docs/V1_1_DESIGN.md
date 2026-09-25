# Amanda Academy v1.1: intent, factual integrity, action verification

Sandbox design. The production prompt is unchanged. Code: `academy/lib/intent.js`, `academy/lib/action_guard.js`, `academy/lib/candidate_prompt.js`.

## 1. Communication-intent classifier

**Why:** the baseline's worst relationship failures came from one prompt shape applied to every message. The classifier decides the *shape* of the reply before Amanda writes. It never decides facts or authority.

| Mode | Example | Shape |
|---|---|---|
| direct_fact | "Did we pay Harned? Y/N" | answer in the first sentence; nothing extra |
| status_update | "Any update on that tree?" | status in one or two sentences (confirmed / unconfirmed / unknown), then next step and owner; no options |
| casual_conversation | "nice, looks like we saved 30k?" | natural and brief; gently correct a wrong premise |
| explanation | "Walk me through why insurance looks low" | plain teaching with the numbers; length to need |
| decision_support | "Should we renew or go out to bid?" | facts, 2 to 3 options, tradeoffs, recommendation, who decides. **The only mode with decision format.** |
| conflict_deescalation | "You people are thieves…" | brief, specific acknowledgment in her own words; facts; calm boundary; one path forward |
| task_request | "Go ahead and sign the contract" | do what's within authority; otherwise say exactly what's needed and the fastest legitimate path |
| escalation_risk | "Are we covered?" (policy expired) | lead with a precise risk status; verifying and escalating is **her job, never a board option**; who is informed; what happens if real |

**How it decides.** Deterministic rules, checked in priority order:
1. conflict
2. task
3. decision
4. status
5. explanation
6. fact question
7. casual
8. fallback

Two adjustments apply after that:
- a staff member asking "should I…?" gets a direct answer, since decision format is for the people who decide;
- long emotional venting counts as de-escalation.

**Risk overlay (kept separate from the mode).** A risk ask is either an explicit hazard in the message, or a status or completion question about a risk-bearing item ("covered", "done", "any update") while the context shows it unresolved (expired, unconfirmed, leaning tree). When it fires, the effective mode becomes `escalation_risk`, and the underlying mode is kept so the tone still fits: "any update on that tree?" stays short.

**Accuracy.** 32 of 32 Academy cases match expected intents (`tests/test_academy_v1_1.js`). The expectations live in the test file, so active case versions stay immutable.

**Limits and next steps.**
- Keyword rules miss unusual phrasing.
- **Production design:** use the deterministic result when confidence is high or medium. When it's low, make one cheap classification call (economy tier, via `lib/ai/model_client`) that returns `{mode, risk, why}`. Log both, and review disagreements weekly.
- The classifier never blocks a reply. A wrong mode only changes the shape.

## 2. Factual-integrity rules (always on; override tone and helpfulness)

Amanda never states as fact, unless the context shows it:
- an action she took;
- an email or call she can't point to;
- a document she wasn't given;
- a board decision that doesn't exist;
- a legal rule without a source (and no "commonly" or "typically" norms presented as applicable);
- a deadline nobody set;
- an insurance or other status the evidence doesn't support.

When evidence is missing she says what's **known**, what's **unknown**, and the **next action**, and never invents a bridge between them. The full text is in `academy/docs/PROMPT_V1_1_DIFF.md`.

## 3. Certainty language

| Level | Meaning | Example |
|---|---|---|
| confirmed | a record shows it | "Liability renewed 9/1; certificates are on file." |
| supported inference | follows from records; basis stated | "The logs suggest they've been skipping Brookside." |
| unconfirmed | expected or claimed, not yet shown | "The prior term ended September 15 and I have not found evidence of renewal. Current coverage is unconfirmed." |
| unknown | nothing answers it | "AquaTech hasn't given a delivery date." |

Never upgrade unconfirmed to a negative fact ("lapsed", "uninsured") or a positive one ("we're covered").

## 4. Action verification: a machine-checkable guard

**Rule.** Any first-person, past-tense action claim ("I checked", "I emailed", "I called", "I followed up", "I pushed them", "I confirmed", "I sent", "I spoke with", "I reached out"…) must match an **action record**. Future intentions ("I'll call them today", "I can check that now") are commitments, not claims. The commitments ledger tracks those.

**What `action_guard.js` checks on every draft:**

| Check | Rule | Supported when |
|---|---|---|
| FABRICATED_ACTION | past-tense first-person action verb (11 types: check, call, email, follow_up, confirm, send, contact, schedule, post, pay, approve) | an action record of the same type exists, or the context records the action as done with a date |
| FABRICATED_DEADLINE | "by Friday", "by end of week", "within 48 hours", "in the next day or two"… | that phrase appears as a commitment in the context |
| UNCONFIRMED_AS_FACT | "coverage lapsed", "uninsured", "we're covered" when the context says unconfirmed or no renewal found | never, while the context shows the status is unconfirmed |
| UNSOURCED_LEGAL_AUTHORITY | "statute/statutory", "state law", "Property Code", "209.xxxx", "legally required" | the phrase appears in a retrieved source |

**Flow in the harness (candidate mode):**
1. draft;
2. guard;
3. if there are violations, **one** revision request listing only the flagged sentences, each with a safe rewrite pattern;
4. guard again;
5. anything still flagged is reported as a critical failure (`action_guard` provenance).

The report keeps the first draft, the violations and the final message.

**Production design (not built):**
- **Action records come from real systems:** `interactions` (logged calls, emails, notes), sent `outbound_email_drafts`, `objective_events`, `vendor_project_events`, `work_items` updates, and any tool calls Amanda makes in the current turn. They're rendered into the prompt as **ACTIONS ON RECORD**, and the guard verifies against the same list.
- **Placement:** after generation and before the draft reaches the review queue or `outbound_email_drafts`.
- **Enforcement:** if a violation survives the one revision, the draft is held with the flagged sentences highlighted for the human reviewer. It is never silently rewritten and never auto-sent.
- **Precision first:** the regexes are narrow on purpose. False positives cost a revision; false negatives are caught by the judges and humans.
- **Future:** once Amanda has tools, "I checked" becomes true only when a tool call happened. The guard then checks the tool log for the turn.

## 5. Relationship style (channel-aware)

The universal email frame ("full message body, greeting through sign-off") is replaced by a channel block:
- **email:** a real email, greeting through sign-off, no "Subject:" line.
- **chat/portal:** like a message to a colleague. No Subject, no Dear, no greeting line, no sign-off.
- **phone/voice:** talk like a person. No lists.

Also:
- register and length follow the person ("a one-line question gets a short answer");
- numbered lines only when actually listing options or steps;
- humor is allowed when they used it and the moment allows;
- **friendliness is allowed, not mandated.**
