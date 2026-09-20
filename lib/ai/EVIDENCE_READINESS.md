# ACC Evidence-Readiness Layer

Status (Ed/ChatGPT 2026-09-19):
- **Phase 1 — IMPLEMENTED** (commit dc03f92): frozen/hashed EvidencePackage, four
  artifact states, bounded deterministic retry, readiness gate before reasoning
  (EXTRACTION_FAILED → ERROR, not BLOCK). Solar regression + live proof (retry
  recovered the real transient PDF failure).
- **Phase 2 — IMPLEMENTED** (shadow, offline-proven): narrow factual conflict
  detection; EVIDENCE_CONFLICT gate as a routine autonomous clarification
  (NEED_INFO / REQUEST_CLARIFICATION, not a DECISION_REQUIRED Ed exception);
  homeowner clarification + package versioning + auto-resume; community-scoped
  objective-condition registry (config) + deterministic enforcement. Masonry
  regression covers both answer branches. Live persistence of the clarification
  workflow (a table) is still deferred — see "Needs a migration".

No ACC reasoning prompt, model, verifier policy, autonomy state, or ASSIST change
is part of this work.

## Why (what the diagnostics proved)

Two "must-fix" ACC instabilities both turned out to live in the EVIDENCE layer,
not in Miranda's reasoning:

- **Solar (6019 Water Violet):** the application PDF loaded in 2 of 3 evidence
  gathers and silently failed in 1. On the complete package the primary and the
  verifier were both stable (Terra 10/10 AWC, `missing:none`). The batch's
  "verifier instability" was a degraded-evidence artifact. Root cause: a single
  transient extraction failure with **no retry**, and `input_complete` reading
  `true` off the summary alone (`acc_evidence.js:108`).
- **Masonry (5406 Jay Thrush):** the packet itself contradicts — one approval
  letter says the stone veneer "no longer being replaced" (stays), another says
  "including stone veneer reinstall" (replaced, product ID outstanding). Miranda's
  disposition follows whichever reading she lands on. There is **no conflict
  concept**, so the model silently picks.

So evidence integrity has to become first-class infrastructure, upstream of
reasoning:

**Evidence integrity → factual/rule resolution → deterministic requirements → AI judgment → independent verification → action.**

## The contract

### Artifact state (per expected artifact)
- `PRESENT_READABLE` — obtained and extracted; content non-empty.
- `MISSING` — expected for this app type but no source provided.
- `EXTRACTION_FAILED` — a source exists but could not be read after deterministic retries.
- `NOT_APPLICABLE` — not expected for this application type.

Today's manifest only has `ok:true/false` + `error`, and a no-path artifact is a
silent `continue`. The four-state enum makes MISSING (ask the homeowner) vs
EXTRACTION_FAILED (system problem, retry/human) vs NOT_APPLICABLE (fine) distinct.

### Manifest entry
```
{ artifact, required:boolean, state, source_path, method, attempts, chars|count, error }
```
`required` is per app-type (e.g. an application doc is required; a survey may be
NOT_APPLICABLE for a paint recolor). The readiness gate keys on required artifacts only.

### Evidence conflict
```
{ conflict_id, topic, assertions:[{source, claim}], resolvable_by:'homeowner_clarification'|'precedent'|'governing_docs',
  question, status:'OPEN'|'RESOLVED', resolution:{answer, resolved_at} }
```

### The frozen package (the transaction)
```
EvidencePackage {
  package_id, acc_decision_id, community, assembled_at,
  bundle_text,          // the IMMUTABLE text the primary AND verifier both consume
  manifest:[entry...], conflicts:[conflict...],
  readiness: 'READY' | 'INCOMPLETE' | 'EXTRACTION_FAILED' | 'CONFLICT',
  content_hash          // integrity: proves primary & verifier saw identical bytes
}
```
`Object.freeze` + `content_hash`. Miranda and the verifier receive the SAME package
(the shadow path already passes one `bundle_text` to both — this makes it a
first-class, hashed, manifest-bearing object and refuses to reason until the gate says READY).

### Readiness → routing (BEFORE any reasoning)
| readiness | cause | routed result | notification | reason_code |
|---|---|---|---|---|
| `READY` | all required artifacts PRESENT_READABLE, no open conflict | proceed to reason (primary→verifier→route, unchanged) | — | — |
| `INCOMPLETE` | a required artifact MISSING (never provided) | NEED_INFO — ask homeowner for the doc | DECISION_REQUIRED | `EVIDENCE_INCOMPLETE` (exists) |
| `EXTRACTION_FAILED` | source exists, unreadable after retries | HOLD / BLOCK — retry or human; NOT a homeowner ask | OPERATIONAL_EXCEPTION | `EVIDENCE_EXTRACTION_FAILED` (new) |
| `CONFLICT` | two credible sources assert mutually exclusive facts | NEED_INFO — one clarification question | DECISION_REQUIRED | `EVIDENCE_CONFLICT` (new) |

Five concepts kept strictly separate (req 7): evidence-incompleteness ·
evidence-extraction-failure · evidence-conflict · administrative-incompleteness
(`administrative_status`, already shipped) · substantive-noncompliance (severity / GATE_CATASTROPHIC).

## Pipeline change

Today: `gatherEvidence` → `evaluateApplication` (primary → verifier → route).

Proposed:
1. `assembleEvidencePackage(accRow, deps)` → frozen `EvidencePackage`.
   - **Deterministic retry** on transient download/extract failures (req 3): N attempts with backoff; `attempts` recorded. A required doc that fails all retries becomes `EXTRACTION_FAILED` — never silently dropped from the bundle (req 4).
   - **Readiness computed from required-artifact states**, not from a summary fallback (kills the `input_complete`-off-the-summary silent pass).
2. `detectConflicts(package, deps)` (req 5) — a NARROW, factual pass separate from the ACC decision: "do any two sources assert mutually exclusive facts about scope / materials / dimensions? list them." Structured `conflicts[]`. This is a factual question (stable), aligned with GPT's "assertion-checking, not redo-the-whole-decision" direction, and seeds the eventual verifier redesign.
3. **Readiness gate in `route()` BEFORE reasoning** — per the table above. Only `READY` reaches the model.
4. Primary and verifier both consume `package.bundle_text`; assert `content_hash` equality (req 1).
5. **Clarification loop** (req 6) — on `CONFLICT` (or resolvable `INCOMPLETE`): Miranda emits the minimal specific question (structured), the system asks the homeowner ONE question (in shadow: recorded, not sent; live: existing homeowner-comms path with honest-AI + AI-team signature), the answer becomes a new `PRESENT_READABLE` artifact (`source:'homeowner_clarification'`), the conflict flips `RESOLVED`, the package is re-assembled + re-frozen (new hash, versioned), and evaluation resumes automatically. Asking the right question is part of doing the job.
6. **Deterministic condition enforcement** (req 8) — post-reasoning, pre-route: `enforceObjectiveConditions(struct, community)`. The model decides a rule is APPLICABLE; CODE guarantees its objective curing condition is attached. Keyed on an objective-condition registry (config file first, no migration): e.g. `stone_veneer_in_scope → "existing stone must be matched; no substitution without prior ACC approval" (Waterview Design Guidelines §3.9.1)`. The model never has to "remember" an objective condition again. **Boundary: AI determines applicability + exercises judgment; deterministic logic enforces the consequences of established objective facts/rules.**

## Regression fixtures (offline, injected extraction results — no live calls)
- `solar-pdf-extraction-fails` → readiness `EXTRACTION_FAILED`, retries attempted + recorded, does NOT proceed to reason, reason_code `EVIDENCE_EXTRACTION_FAILED`.
- `solar-pdf-retry-succeeds` → fails attempt 1, succeeds attempt 2 → `READY`.
- `masonry-stone-veneer-conflict` → two sources contradict → readiness `CONFLICT`, exactly one clarification question generated; with an injected homeowner answer → `RESOLVED` → resumes to a stable decision.
- `objective-condition-enforced` → model omits the stone "match-existing" condition → `enforceObjectiveConditions` adds it → deterministic, present every run.

## Needs a migration (flag, not build)
- Clarification requests + resolution + evidence-package versioning persistence (for the resume loop and the audit trail). Objective-condition registry proposed as a **config file** first (no migration).
- `record_ownership`: evidence package + extractions = `workpaper`; a homeowner clarification exchange = `mixed` (sent question is theirs).

## Scope boundaries (unchanged by this work)
ACC reasoning prompts · model selection · verifier policy/thresholds · autonomy
state · ASSIST. The evidence layer is upstream; the condition-enforcer is
deterministic post-processing; the conflict pass is a new narrow step, not an
edit to the ACC decision prompt.

## Open questions for approval
1. Retry policy: attempts + backoff for transient extraction failures (propose 3 attempts, 2s/4s backoff)?
2. Where does the objective-condition registry live — config file (`lib/ai/objective_conditions.config.json`) vs a table? (Propose config first.)
3. Clarification send: shadow records only; when this reaches a live/ASSIST path, it uses the existing homeowner-comms rail (honest-AI opener, AI-team signature). Confirm that's the intended channel.
4. Conflict detection as a narrow model pass vs deterministic rules — propose the narrow factual model pass (stable, and it seeds the verifier-as-assertion-checker redesign). Agree?
