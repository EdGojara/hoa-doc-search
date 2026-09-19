# trustEd model routing & execution policy — SPEC (for review, NOT implemented)

Status: **draft for pressure-testing.** No production call path changes until this
is signed off. Grounded in the five-case eval matrix (`evals/cases/*`) + the
evaluator self-check (`evals/evaluator-check.js`). This is a *control
architecture* — how trustEd chooses a model, decides whether to verify, reaches a
business decision, and decides whether it may act — not an intelligence ladder.

## Philosophy: autonomous by default where earned; exception-driven supervision
trustEd is meant to *manage*, not to analyze-and-wait. The target is: Miranda (and
each AI-team persona) receives the work, does it, resolves ambiguity with the
homeowner directly, decides, sends, logs, and closes — and brings Ed only genuine
**exceptions**. "Review-by-default everywhere" would be building conventional AI-
assisted software, which is the wrong product.

But autonomous-by-default is the **architecture target**, not the launch switch.
Activation is earned per task class through an **autonomy state**:

- `shadow` — Miranda reaches the decision and logs what she *would* do; a human
  still sends. Used to accumulate fixtures and measure the false-negative rate.
- `assist` — Miranda sends; Ed is notified for a beat (spot-check window).
- `autonomous` — Miranda acts; Ed hears only exceptions.

A class graduates `shadow → assist → autonomous` when its eval + shadow fixtures
hold clean (no false negatives). This gives the autonomous end-state without
betting a homeowner-facing decision on thin evidence. Core finding that forces
this discipline: **model tier is not a proxy for safety** — the economy model was
fine on three classes and produced a catastrophic ACC error on another.

## Two separate axes (the key correction)
Do not conflate the business outcome with permission to act.

**Business decision:** `APPROVE` | `DENY` | `NEED_INFO` | `ESCALATE`
**Execution authorization:** `EXECUTE` | `REVIEW` | `BLOCK` | `ERROR`

- A verified, unambiguous ACC application may be `APPROVE + EXECUTE` **or**
  `DENY + EXECUTE`. **A denial is not an escalation.**
- `NEED_INFO + EXECUTE` = Miranda emails the homeowner for what's missing, records
  it, and auto-resumes evaluation when they reply (bounded: after ~2 clarification
  rounds with no resolution, `ESCALATE`).
- `REVIEW` = don't send; email Ed a concise exception package.
- `BLOCK` = a safety/policy guard says **this specific action must not fire**
  (e.g. a stale §209 letter, an attempt to auto-post to the GL). **Never a synonym
  for denying an application.**
- `ERROR` = system-health failure (model/verifier/retrieval failure, empty or
  malformed output). Never treated as evidence of incorrect content.

## Principles (invariants)
1. Cheapest **proven-capable** model by default.
2. Verification is triggered by **consequence**, not model price, and is
   **conditional** (task class + severity + reversibility) — blanket verification
   quietly doubles inference cost.
3. Where verification is required it is **cross-provider**; agreement is compared
   on **structured facts/rules/decision**, not prose similarity, and agreement is
   not proof.
4. Disagreement **escalates** — never average two answers, never silently pick one.
5. **Certified §209 and financial (GL) posting always have a human approval
   floor**, even on agreement.
6. **Retrieval completeness is a separate gate** for document-dependent work.
7. Model/verifier **failure or empty output is `ERROR`**, never wrong content.
8. **Evaluator failures are tracked independently** (TP/FP/FN/TN); a false
   negative (unsafe output allowed) is the number to drive to zero.
9. **No model is pinned to a tier by name.** Capability tiers (`economy` /
   `standard` / `advanced` / `frontier`) bind to concrete models in
   `evals/models.json`, swappable after an eval run.
10. An autonomous **DENY** requires an **objective, cited-rule violation**. Any
    subjective standard ("consistent with the neighborhood") → `ESCALATE`. A wrong
    denial to a homeowner is as damaging as a wrong approval.

## Decision pipeline (health BEFORE semantics)
Stop at the first failing gate; emit its reason code.

1. **Model completed?** else `ERROR:HEALTH_MODEL_ERROR` (retry once, else hold).
2. **Required context retrieved?** (doc/governance tasks) else `ERROR:HEALTH_RETRIEVAL_INCOMPLETE` (retry; if unresolved → `ESCALATE`).
3. **Reach the business decision** (APPROVE/DENY/NEED_INFO) with structured output: decision, cited rule(s), per-item disposition, facts established, open issues.
4. **Does this task require verification?** (consequence + class + severity.) If yes, run the cross-provider verifier, which emits the same structured shape.
5. **Do primary & verifier materially agree** (structured decision + cited rule, not wording)? Disagree → `ESCALATE` (`VERIFY_DISAGREEMENT`). Verifier failed → `REVIEW` (`VERIFY_UNAVAILABLE`) — "couldn't verify" ≠ "verified".
6. **Safety/policy guard**: is the concrete action allowed to fire? Stale/contradicted/floored action → `BLOCK` / `HUMAN_FLOOR`.
7. **Autonomy state** for this class permits acting? `autonomous` → act; `assist` → act + notify; `shadow` → log + route to human.
8. **Emit:** business decision + execution authorization + reason code (on any non-EXECUTE).

## ACC — the worked example (autonomous decision-and-execution)
ACC is intended as an **autonomous manage-it workflow**, not review-by-default.

| Situation | Business decision | Execution | What Miranda does |
|---|---|---|---|
| Complete, compliant, verified | APPROVE | EXECUTE | Send approval, generate letter, update ACC record, log rationale, close |
| Complete, objective rule violation, verified | DENY | EXECUTE | Send denial citing the rule + what to change, log, close |
| Missing/clarifiable info | NEED_INFO | EXECUTE | Email homeowner for the specific item, record it, auto-resume on reply (≤2 rounds) |
| Genuine ambiguity / subjective standard / conflicting provisions / variance request / precedent-setting / model disagreement / unresolved retrieval | ESCALATE | REVIEW | Email Ed the exception package; homeowner hears nothing until resolved |
| Proposed action itself unsafe to fire (e.g. stale/contradicted) | — | BLOCK | Don't send; notify Ed with the safety/policy reason |
| System failure (empty/malformed/verifier down) | — | ERROR | Don't send; log, notify if intervention needed |

**Exception package** (what a `REVIEW`/`ESCALATE` email to Ed contains): property/
application, requested modification, relevant governing provisions, facts
established, the unresolved issue, primary conclusion, verifier conclusion, reason
code, Miranda's recommended disposition (when she has one), and the specific
decision needed from Ed. After Ed resolves it, Miranda **continues automatically**
— communicates the decision, generates the letter, updates the record, preserves
the rationale in the audit log, and closes/continues.

Cross-provider verification is kept for autonomous ACC approvals **and** denials.
Outbound homeowner communication follows the AI-team signature/tone + honest-AI
rules. At launch ACC runs in `shadow`, graduating per evidence.

## Routing matrix (five tested classes + adjacent surfaces)

| Task class (tested case) | Default tier | Verify (cross-provider)? | Autonomous outcomes | Escalate / human floor |
|---|---|---|---|---|
| Informational Q&A — FAQ/balance/status | economy | No | Answer the resident | Retrieval incomplete → ESCALATE |
| Governance / doc interpretation (`governance-tree-requirement`) | economy | No (gate = **retrieval completeness**) | Answer w/ citations | Retrieval incomplete or cross-doc conflict → ESCALATE |
| Vendor bid analysis (`clma-bid-analysis`) | economy | Yes, board-facing | Produce analysis/draft | Operator dictates the *award*; no auto-award |
| Financial / accounting (`bank-reconciliation`) | economy + **required verify** | Yes, always | Produce reconciliation for sign-off | **GL posting = human floor** |
| ACC decisions (`acc-review`) | economy + **required verify** | Yes, always | APPROVE+EXECUTE, DENY+EXECUTE, NEED_INFO+EXECUTE (per autonomy state) | Ambiguity/subjective/variance/conflict/disagreement → ESCALATE |
| Board packet (`board-packet-completeness`) | economy | Yes (completeness + dates) | Assemble packet | Board consumes; omission/date error → ESCALATE |
| Certified §209 / enforcement statutory | standard (draft) | Yes | Draft only | **Always human-sends** |

## Reason codes (every non-EXECUTE carries one)
`HEALTH_MODEL_ERROR`, `HEALTH_RETRIEVAL_INCOMPLETE`, `GATE_CATASTROPHIC`,
`GATE_COMPLIANCE`, `GATE_FINANCIAL`, `VERIFY_DISAGREEMENT`, `VERIFY_UNAVAILABLE`,
`SUBJECTIVE_STANDARD`, `CONFLICTING_PROVISIONS`, `VARIANCE_REQUEST`,
`PRECEDENT_SETTING`, `AUTONOMY_STATE` (class not yet autonomous), `HUMAN_FLOOR`,
`ACTION_UNSAFE` (BLOCK), `LOW_CONFIDENCE` (reserved). Every REVIEW/BLOCK/ESCALATE
is logged with its code so the exception queue is triageable and auditable.

## Evaluator quality (the gate that guards the gates)
`evals/evaluator-check.js` scores the gate itself against labeled safe/unsafe
outputs (TP/FP/FN/TN). FN (unsafe allowed) is the dangerous class; FP (correct
blocked) erodes trust. Move it into CI so a rubric change that introduces a false
negative fails the build. Every real production failure, near miss, false block,
board correction, accounting correction, and human override becomes a new fixture.

## Honest limits
Five model cases + six evaluator fixtures are enough to **design** this, nowhere
near enough to claim reliability. Do not read any "100%" as proof — it is the
*start* of a regression system. The moat is the accumulating answer to "when can
AI do HOA work, when must another AI check it, and when must a person decide" —
proprietary operational knowledge, not model access.

## Open questions for pressure-testing (before any code)
1. The `shadow → assist → autonomous` **graduation bar** per class — how many
   clean fixtures / how long in shadow before a class earns autonomy?
2. **Autonomous denials** — comfortable with DENY+EXECUTE on an objective rule
   violation at launch (in shadow first), or hold all denials for a human longer
   than approvals?
3. The **verification trigger** thresholds (consequence/severity/reversibility).
4. What counts as **material disagreement** on the structured decision.
5. The **confidence signal** — build one (sample-verify a % of EXECUTE traffic to
   measure the false-negative rate) or stay proxy-based.
6. **NEED_INFO loop bounds** — max clarification rounds before ESCALATE.
