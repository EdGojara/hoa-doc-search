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

## Judgment questions for Ed (encode-Ed decisions)

1. **Match granularity.** An approved "fence" ACC decision suppresses which
   enforcement categories? Recommendation: map at the **category-group** level
   (approved fence → fence-existence/design group), NOT individual labels, and
   NEVER the maintenance/condition group. Needs an `acc_project_type →
   enforcement_category_group` map.

2. **Deviation from approved scope.** An approved 6ft cedar fence does not
   approve an 8ft vinyl fence — but a DRV drive can't read height/material from a
   photo reliably. Recommendation: the auto-layer can only match at category
   level, so it **flags**, it does not silently suppress (see fail-safe).

3. **Duration.** Recommendation: existence-suppression is **permanent** (once
   approved, the structure is approved). No expiry.

4. **Approved-with-conditions.** If conditions exist (complete within 12 months,
   stain within 60 days) and aren't met, that's a compliance issue. Recommendation:
   still suppress the "unapproved structure" violation, but **flag** for human —
   never auto-clear a conditioned approval.

5. **Fail-safe — flag, don't silently suppress OR silently cite.** THIS IS THE
   KEY DECISION. Wrongly suppressing a real violation is as bad as wrongly citing
   approved work. Recommendation: when an approved ACC decision matches the
   property + category group, **still create the observation but FLAG it**
   (`acc_approved_ref` on the violation/observation) so the DRV Review queue shows
   "⚠ Approved ACC decision on file for [category] — verify this isn't the
   approved work before sending a letter." Human dismisses if it's the approved
   fence; confirms if it's a genuine separate issue. This is the same
   encode-Ed-with-human-gate pattern the rest of the platform uses. It is NOT
   silent auto-suppression.

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
