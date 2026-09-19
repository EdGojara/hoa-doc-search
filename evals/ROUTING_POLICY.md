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
Activation is earned through an **autonomy state that is configured per task
SUBCLASS, not per class**. "ACC" never graduates as a block — paint/approved-
palette, standard fence, and roof replacement may each prove extraordinarily
reliable and earn autonomy long before pool/major-structure, while variance and
subjective-aesthetic subclasses may stay exception-oriented indefinitely. Each
subclass carries its own evidence and its own state:

- `shadow` — Miranda reaches the decision and logs what she *would* do; a human
  still executes. Accumulates fixtures and measures the would-be error rate.
- `assist` — Miranda **executes autonomously**, everything is logged to an audit
  dashboard, and a **stratified, risk-weighted sample** (over-sampling higher-risk
  cases) gets a *real* human review. This sample is how the live **false-negative
  rate** is measured — not by CC'ing Ed on every transaction (that just rebuilds
  the management queue we're removing).
- `autonomous` — Miranda executes; only exceptions reach a human.

**Graduation is performance-based, not a volume count** — do not set an arbitrary
"N applications" bar now. Record the metrics that will decide it: zero severe
false executions (FN at severity ≥ compliance), human-override rate below a
threshold set from the data, adequate sample size, stable primary/verifier
agreement, and zero evaluator false negatives. **The dial is reversible**: a
severe false execution auto-demotes the subclass (autonomous → assist → shadow)
and opens an incident — earning trust is not permanent, one bad run pulls it back.

Core finding that forces this discipline: **model tier is not a proxy for
safety** — the economy model was fine on three classes and produced a catastrophic
ACC error on another.

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
An autonomous **DENY** fires only on: objective violation + complete retrieval +
exact cited restriction + primary/verifier agreement + deterministic checks pass
(e.g. "fence 8ft, max 6ft"). A subjective standard ("harmonious with the
neighborhood") never auto-denies — it escalates. Outbound homeowner communication
follows the AI-team signature/tone + honest-AI rules. At launch **every ACC
subclass runs in `shadow`**, each graduating independently on its own evidence.

## Exception notification levels
Once there are thousands of transactions, "email Ed on exception" is itself a
noise source. Three levels, mapped to reason codes:

- **DECISION_REQUIRED** — Trusted genuinely needs human judgment. Email
  immediately, as a **decision-ready** package. Reason codes: `VERIFY_DISAGREEMENT`,
  `SUBJECTIVE_STANDARD`, `CONFLICTING_PROVISIONS`, `VARIANCE_REQUEST`,
  `PRECEDENT_SETTING`.
- **OPERATIONAL_EXCEPTION** — something failed or couldn't complete (retrieval
  incomplete, integration down, verifier unavailable). Self-recover first; email
  only if it can't, and only if intervention is needed. Reason codes:
  `HEALTH_*`, `VERIFY_UNAVAILABLE`, `ERROR`.
- **ANOMALY / WATCH** — Trusted completed the task but saw something unusual (an
  approval that's an outlier vs precedent, a cost variance). Log it; surface in a
  periodic **digest** unless severity warrants immediate notice.

**Decision-ready exception format** (DECISION_REQUIRED) — Miranda does the work
before she emails, so Ed decides, not researches:
> **ACC Exception — 123 Main Street**
> Request: Exterior paint — Sherwin-Williams Naval
> Issue: Restrictions require colors "consistent with the neighborhood"; no approved palette.
> Primary: Approve · Independent verifier: Uncertain
> Checked: Declaration §8.3, ACC guidelines, prior approvals
> Why I stopped: no objective standard establishes compliance
> My recommendation: Approve (three comparable prior approvals)
> Decision needed: [Approve] [Deny] [Request info]

## Feedback loop & precedent (how exceptions stop being exceptions)
Every human resolution is captured as: exception → evidence → Miranda's
recommendation → the human decision → rationale. Each becomes (a) an **eval
fixture** and (b) a **precedent candidate**, so the same question may stop being an
exception once Trusted has an established, validated decision pattern. **Precedent
is scoped to preserve community isolation**: a *subjective-standard* resolution
(a paint color deemed neighborhood-consistent) is **that community's** precedent
only; an *objective-rule* interpretation is portfolio-wide. One community's
aesthetic call must never leak into another's decisions.

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

## Settled (this review round)
- Autonomy dial kept, **per subclass**, **reversible** (auto-demote on a severe
  false execution).
- **Autonomous denials: yes**, once a subclass earns it, on an objective cited
  violation only; subjective standards escalate.
- **ASSIST executes autonomously** with audit logging + stratified sampled human
  review — not CC-on-everything.
- **Graduation is performance-based**, not a volume count.
- Three **notification levels** (DECISION_REQUIRED / OPERATIONAL_EXCEPTION /
  ANOMALY_WATCH); decision-ready exception format; every resolution → fixture +
  scoped precedent.

## Still open (calibrate from data, not now)
1. The **graduation thresholds** — the actual override-rate ceiling, minimum
   sample size, and agreement-rate floor. Record the metrics now; set the numbers
   once real traffic exists.
2. The **verification trigger** thresholds (consequence/severity/reversibility) —
   which combinations pull the second model.
3. What counts as **material disagreement** on the structured decision (a wrong
   rule/decision is clear; a different-but-equivalent rationale is not).
4. The **confidence signal** — build one (sampled cross-check on EXECUTE traffic
   to measure the live false-negative rate) or stay proxy-based on class+severity.
5. **NEED_INFO loop bounds** — max clarification rounds before ESCALATE (~2).
