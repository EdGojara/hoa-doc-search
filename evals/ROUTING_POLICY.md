# trustEd model routing & execution policy — SPEC (for review, NOT implemented)

Status: **draft for pressure-testing.** No production call path changes until this
is signed off. Grounded only in the five-case eval matrix (`evals/cases/*`) plus
the evaluator self-check (`evals/evaluator-check.js`). This describes how trustEd
should *choose a model, decide whether to verify, and decide whether it may act* —
it is a control architecture, not an intelligence ladder.

## Core finding driving this
Model tier is **not** a reliable proxy for safety. In the five cases the economy
model was safe and sufficient on document analysis, governance interpretation, and
board synthesis, but produced a **catastrophic ACC error** (approved a covenant-
violating shed) and was unstable on reconciliation arithmetic. Independent cross-
provider verification caught real issues even on outputs that passed the rubric
(the esplanades gap; a landscaping non-renewal notice already past due). So: pick
the cheapest proven-capable model, and **verify by consequence, not by price.**

## Principles (invariants)
1. Cheapest **proven-capable** model by default.
2. Verification is triggered by **consequence**, not model price.
3. Where verification is required it is **cross-provider** (different training →
   independent failure modes; agreement is not proof).
4. Disagreement **escalates** (to a stronger model or a human) — never average two
   answers, never silently pick one.
5. **Certified §209 and financial posting always have a human approval floor**,
   even when primary and verifier agree.
6. **Retrieval completeness is a separate gate** for governance / document-
   dependent work (that failure mode is retrieval, not reasoning).
7. A model or verifier **failure / empty output is an error state**, never
   evidence of incorrect content (the gpt-terra "9%" was exhausted-reasoning
   truncation, not a wrong answer).
8. **Evaluator failures are tracked independently** as TP/FP/FN/TN; a false
   negative (unsafe output allowed) is the one to drive to zero.
9. **No model is pinned to a tier by name.** The policy operates on capability
   tiers (`economy` / `standard` / `advanced` / `frontier`); `evals/models.json`
   binds a tier to a concrete model, swappable after an eval run.

## The decision pipeline (health BEFORE semantics)
Evaluate in order; stop at the first failing gate and emit its reason code.

1. **Model completed?** No empty/error output. → fail: `HEALTH_MODEL_ERROR` (retry once, else BLOCK).
2. **Required context retrieved?** (doc/governance-dependent tasks only.) → fail: `HEALTH_RETRIEVAL_INCOMPLETE` (retry retrieval, else REVIEW).
3. **Severity gate on the primary answer** (worst failed rubric/check severity):
   catastrophic|compliance → BLOCK (`GATE_CATASTROPHIC` / `GATE_COMPLIANCE`);
   financial → REVIEW (`GATE_FINANCIAL`).
4. **Does this task require verification?** (consequence + class + severity — see matrix.) If yes, run the cross-provider verifier.
5. **Do primary and verifier materially agree?** No → escalate (`VERIFY_DISAGREEMENT`). Verifier failed/empty → `VERIFY_UNAVAILABLE` → REVIEW (never treat "couldn't verify" as "verified").
6. **Is autonomous execution permitted for this action class?** No → `AUTONOMY_CEILING`; statutory/posting → `HUMAN_FLOOR`.
7. **Verdict:** EXECUTE / REVIEW / BLOCK.

Verification is **conditional**, not "every board-facing output gets a second
model." Trigger it when: task class is financial, action-bearing, or board-facing
AND (severity ≥ financial OR the action is irreversible/outward OR a confidence
signal is low). High-volume, low-consequence work (FAQ, status) is never verified.
Rationale: blanket verification quietly doubles inference cost across most traffic.
(Confidence signal is a known gap — self-reported model confidence is unreliable;
until we have a real one, use task-class + severity + reversibility as the proxy,
and sample-verify a % of "EXECUTE" traffic to measure the false-negative rate.)

## Routing matrix (from the five tested classes + adjacent trustEd surfaces)

| Task class (tested case) | Default tier | Verify (cross-provider)? | Autonomy ceiling | Escalate when | Human floor | Max verdict |
|---|---|---|---|---|---|---|
| Informational Q&A — FAQ, balance, status (not separately tested; lowest consequence) | economy | No | Answer the resident directly | Retrieval incomplete; low confidence | — | EXECUTE |
| Governance / doc interpretation (`governance-tree-requirement`) | economy | No (interpretation is not the risk) | Answer with citations | **Retrieval incomplete** (the real gate); ambiguity across docs | — | EXECUTE if retrieval complete, else REVIEW |
| Vendor bid / document analysis (`clma-bid-analysis`) | economy | Yes when board-facing (recommendation) | Produce the analysis/draft; **operator dictates the recommendation** | Verifier finds a scope/insurance gap; disagreement | — | REVIEW (draft to operator) — never auto-award |
| Financial / accounting (`bank-reconciliation`) | economy + **required** cross-provider verify | Yes, always | Produce the reconciliation for sign-off | Any numeric disagreement; catastrophic gate | **Posting to the GL** | REVIEW — never auto-post |
| Rules + judgment + **action** — ACC decisions (`acc-review`) | economy insufficient alone → **verify required** | Yes, always | A **straightforward low-risk approval** may auto-complete only when primary+verifier agree and no violation is present | Any denial, variance, conflicting docs, or violation; disagreement | Board-sensitive / precedent-setting decisions | EXECUTE only for verified clean approvals; else REVIEW/BLOCK |
| Large-context synthesis — board packet (`board-packet-completeness`) | economy | Yes (completeness + date logic) | Assemble the packet/report | Verifier finds an omission or a date/deadline error | — | REVIEW (board consumes; human sends) |
| Certified §209 / enforcement statutory | (drafting: standard) | Yes | Draft only | Always | **Always — human sends** | REVIEW at most; never autonomous |

Notes the matrix encodes:
- ACC is the case that proves the architecture: the economy model made a
  catastrophic approve-error, so this class is *never economy-alone*; it needs
  verification, and only a **verified, violation-free, low-risk approval** may
  auto-complete. Everything else is REVIEW/BLOCK.
- Financial output is never auto-posted regardless of agreement (principle 5).
- Governance's gate is **retrieval completeness**, not model tier (principle 6).

## Reason codes (every non-EXECUTE outcome carries one)
`HEALTH_MODEL_ERROR`, `HEALTH_RETRIEVAL_INCOMPLETE`, `GATE_CATASTROPHIC`,
`GATE_COMPLIANCE`, `GATE_FINANCIAL`, `VERIFY_DISAGREEMENT`, `VERIFY_UNAVAILABLE`,
`AUTONOMY_CEILING`, `HUMAN_FLOOR`, `LOW_CONFIDENCE` (reserved, pending a real
confidence signal). Every REVIEW/BLOCK is logged with its code so the queue is
triageable and the router's decisions are auditable.

## Evaluator quality (the gate that guards the gates)
`evals/evaluator-check.js` scores the gate itself against labeled safe/unsafe
outputs and reports TP/FP/FN/TN. FN (an unsafe output allowed) is the dangerous
class; FP (a correct output blocked) erodes trust. This should move into CI so a
rubric change that introduces a false negative fails the build. Two false-BLOCK
bugs found during case #3 are already locked in as fixtures.

## Evidence basis & honest limits
Five model cases and six evaluator fixtures are enough to **design** this
architecture; they are **nowhere near** enough to claim reliability. Do not read
any "100%" as proof. This is the **start of a regression system**: every real
production failure, near miss, false block, board correction, accounting
correction, and human override becomes a new fixture. The moat is the accumulating
answer to "when can AI do HOA work, when must another AI check it, and when must a
person decide" — proprietary operational knowledge, not model access.

## Open questions for pressure-testing (before any code)
1. The **EXECUTE / REVIEW / BLOCK boundaries** per class — especially: which ACC
   approvals, if any, may truly auto-complete, vs. all ACC going to REVIEW at launch.
2. Should launch be **REVIEW-by-default everywhere** (human-in-loop) and earn
   EXECUTE per class as fixtures accumulate? (Safer start; the gate becomes a
   confidence meter first, an executor later.)
3. The **verification trigger** — exact consequence/severity/reversibility thresholds.
4. What counts as **"material disagreement"** between primary and verifier.
5. The **confidence signal** — build one (e.g. sampled cross-check on EXECUTE
   traffic) or stay proxy-based.
