# Spec — ACC approval → DRV violation suppression

**Problem.** A homeowner whose modification (fence, patio, shed, paint color)
was **approved** through ACC can still be **cited** by a DRV drive, because the
violation-creation path never checks ACC decisions. Citing approved work is
embarrassing and erodes board/homeowner trust.

**Where it wires.** `lib/enforcement/find_or_continue_violation.js` — the single
chokepoint every violation-creation path calls first. The check goes here (or a
helper it calls), after the category is known, before a `new` violation is
returned.

**The moat is the judgment, not the plumbing.** A naive competitor does one of
two wrong things: never suppress (cite approved work) or over-suppress (an
approved fence is never cited again, even when it's falling down). The correct
behavior is the nuanced middle, and it's encoded Texas-HOA judgment.

---

## The core distinction: APPROVAL covers EXISTENCE/DESIGN, not MAINTENANCE/CONDITION

An approved fence means "you may HAVE this fence, as designed." It does **not**
mean "this fence is exempt from upkeep forever." So:

- Approved fence → **suppress** "unapproved structure / did you build this"
  violations for the fence.
- Approved fence → **still cite** "fence is in disrepair / leaning / needs
  stain" violations. Different category class (condition), not covered by the
  approval.

This split is the whole game. It's why category matching must be class-aware:
suppress **existence/design** categories, never suppress **condition/maintenance**
categories.

---

## Decisions — LOCKED (Ed, 2026-08-06)

1. **Fail-safe = FLAG, never silently suppress or silently cite.** When an
   approved ACC decision matches the property + category group, **still create
   the observation but FLAG it** (`needs_acc_verification` + `acc_approved_ref`)
   so the DRV Review queue shows "⚠ Approved ACC decision on file for [category]
   — verify this isn't the approved work before sending a letter." Human dismisses
   if it's the approved fence; confirms if it's a genuine separate issue. This is
   the encode-Ed-with-human-gate pattern, NOT silent auto-suppression. (Silently
   suppressing risks letting a real violation slide, which is as bad as citing
   approved work.)

2. **Category classing = YES.** Each enforcement category gets a
   `category_class`: `existence_design` | `maintenance_condition` | `other`.
   Approvals only ever flag the `existence_design` categories; a
   `maintenance_condition` violation (fence in disrepair) is never suppressed by
   an approval. Ed to tag / review the category list once.

3. **Approved-with-conditions = FLAG (revisit later).** A conditioned approval
   (finish in 12 months, stain in 60 days) that may have lapsed is still flagged
   for human, never auto-cleared. Deeper condition-lapse logic is a later pass —
   for v1, conditions just mean "definitely flag, don't suppress."

**Match granularity** (implied by the above): map at the **category-group**
level via an `acc_project_type → enforcement_category_group` map, class-aware.
**Duration**: existence-flagging is permanent (no expiry). **Deviation** (approved
6ft cedar vs actual 8ft vinyl) is out of scope for v1 — the flag lets the human
adjudicate; automated dimension/material detection is the telephoto/vision-detail
problem, later.

---

## Data / matching approach

- Source of approvals: `acc_decisions` (status='decided', decision_type starts
  'approved') + `community_applications` (final_status approved). Both key on
  homeowner_address → resolve to `property_id` (existing `resolveProperty`).
- At `findOrContinueViolation`, after category is known: look up approved ACC
  decisions at this `property_id` whose project maps to the same
  `enforcement_category_group` (via the new project-type → category-group map).
- If found AND the flagged category is an existence/design class: attach
  `acc_approved_ref` (the acc_decision id + project summary + decided_at) to the
  observation/violation and set a `needs_acc_verification` flag the Review queue
  renders.
- If the flagged category is a maintenance/condition class: do nothing (approval
  doesn't cover it).

## Schema (draft)
- `violations.acc_approved_ref uuid` (nullable, FK acc_decisions) + `violations.needs_acc_verification bool default false`, OR carry on the observation row. Migration + service_role GRANT (new-column, inherits).
- `enforcement_categories.category_class text` — 'existence_design' | 'maintenance_condition' | 'other' (drives the suppress-vs-not decision). This is the encode-Ed data: which categories are "did you build it" vs "is it maintained."
- A small `acc_project_type_to_category_group` map (seed table or JSON).

## Fixture / test
- Property with approved fence + a fence-existence observation → flagged, not silently created-clean.
- Same property + a fence-DISREPAIR observation → NOT flagged (approval doesn't cover condition).
- Property with NO approval + fence observation → normal violation, no flag.
- Approved-with-conditions → flagged for human.

## Explicitly OUT of scope for v1
- Reading approved dimensions/materials from the photo to detect deviation
  (that's the telephoto/vision-detail problem). v1 flags at category level and
  lets the human adjudicate.
