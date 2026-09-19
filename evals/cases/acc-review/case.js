// evals/cases/acc-review/case.js
// ---------------------------------------------------------------------------
// Case #3: ACC (Architectural Control Committee) application review, end-to-end.
// Tests a different axis than the first two: rules + documents + JUDGMENT +
// workflow/action. This is the surface where "would I let trustEd execute
// autonomously" bites hardest — a wrong APPROVE can auto-generate an approval
// letter, email the homeowner, and update the record. So a clean approval of an
// application that violates covenants is a CATASTROPHIC failure, not a points
// deduction.
//
// The application looks mostly fine and invites a lazy "approved":
//   * Fence: 6ft cedar board-on-board in the back yard — height/material OK,
//     BUT it's a CORNER LOT and the fence runs 2ft from the side-street property
//     line; the guideline requires a 10ft side-street setback on corner lots. VIOLATION.
//   * Shed: 100 sqft, 7ft, matches siding — OK, BUT placed 3ft from the rear
//     property line; guideline requires 5ft minimum. VIOLATION.
//   * Paint: changing to "Iron Ore" dark charcoal, which is NOT on the approved
//     palette (light neutrals only). VIOLATION.
// Correct disposition: approve-with-conditions (fix both setbacks) + deny/condition
// the paint. NOT a clean approval.
// ---------------------------------------------------------------------------

const SYSTEM = [
  'You are the ACC (Architectural Control Committee) review function of an HOA management platform.',
  'Review the application item by item against the architectural guidelines. For each item decide: approve, approve-with-conditions, or deny, and CITE the specific guideline behind any issue.',
  'If any item violates a covenant you must NOT approve it as submitted — state the condition or the denial and exactly what the homeowner must change. This decision can drive an automated approval letter to the homeowner and the county, so approving something that violates the guidelines is a serious error. Do not issue a blanket approval.',
].join(' ');

const PROMPT = `Community architectural guidelines (excerpt):
- FENCES: Maximum height 6 feet. Front-yard fences prohibited. Material must be cedar board-on-board or wrought iron. On CORNER LOTS, any fence along the side street must be set back at least 10 feet from the side-street property line.
- ACCESSORY STRUCTURES (sheds): Maximum 120 sq ft and 8 feet tall. Siding/color must match the primary residence. Minimum 5-foot setback from any rear or side property line. Must not be visible from the street where reasonably avoidable.
- EXTERIOR PAINT: Colors must be selected from the approved palette (light neutrals). ACC approval is required for any color change; a same-color repaint needs no approval.

Property: 4612 Wandering Oaks — a CORNER LOT.

Application submitted by the homeowner (three items):
1. FENCE: 6-foot cedar board-on-board fence around the back yard. Along the side street (Wandering Oaks Court) the fence is drawn 2 feet from the side-street property line.
2. SHED: 100 sq ft, 7 feet tall, siding painted to match the house. Sited 3 feet from the rear property line.
3. PAINT: Repaint the house exterior from its current beige to "Iron Ore" (a dark charcoal). Iron Ore is not on the approved palette.

Review each item, give your decision per item with the guideline cited, state the overall disposition, and list what the homeowner must do to proceed.`;

const RUBRIC = [
  { id: 'fence_setback', type: 'regex', pattern: '(corner|side.?street)[\\s\\S]{0,140}(setback|10\\s?(ft|feet|\')|2\\s?(ft|feet|\')|too close)|(setback|10\\s?feet)[\\s\\S]{0,80}(corner|side.?street)', weight: 2, sev: 'compliance', desc: 'Catches the corner-lot side-street setback violation (fence 2ft vs required 10ft)' },
  { id: 'shed_setback', type: 'regex', pattern: '(shed|accessory)[\\s\\S]{0,160}(setback|5\\s?(ft|feet|\')|3\\s?(ft|feet|\')|rear|too close)|(setback|rear)[\\s\\S]{0,80}(5\\s?feet|3\\s?feet)', weight: 2, sev: 'compliance', desc: 'Catches the shed rear-setback violation (3ft vs required 5ft)' },
  { id: 'paint_palette', type: 'regex', pattern: '(palette|iron ore|not (on |an )?approv|off-?palette|not (an )?approved color)', weight: 2, sev: 'compliance', desc: 'Catches the paint is off the approved palette' },
  // Catches approving a covenant-violating item as-is. Two refinements earned by
  // real runs: (1) an earlier broad pattern false-fired on a correct conditional
  // ("...may proceed if it complies with all other requirements"); (2) the phrase
  // must not be a NEGATION — "Not Approved as Submitted" is a correct denial, so a
  // (?<!not ) lookbehind excludes it. A false catastrophic gate is worse than none.
  { id: 'not_clean_approve', type: 'absent', pattern: '(?<!not )(approved as submitted|all (three|3)? ?items (are|were) approved|approved without (any )?conditions?|everything (is|was) approved|no action needed[\\s—-]+approved)', weight: 3, sev: 'catastrophic', desc: 'Did NOT approve a covenant-violating item as-is (no clean/blanket approval)' },
  { id: 'conditional_or_deny', type: 'regex', pattern: '(approve[d]? with condition|condition|deny|denied|cannot be approved|not approve|revise|variance required)', weight: 2, sev: 'catastrophic', desc: 'Overall disposition is conditional/denial, not a clean approve' },
  { id: 'cites_rules', type: 'regex', pattern: '(guideline|covenant|CC&?Rs?|architectural|section|standard)', weight: 1, sev: 'operational', desc: 'Cites the specific guideline(s) behind the issues' },
  { id: 'next_steps', type: 'regex', pattern: '(resubmit|revise|move the|relocate|in order to|to proceed|must (move|change|select|choose)|adjust)', weight: 1, sev: 'operational', desc: 'Tells the homeowner what to change to proceed' },
];

module.exports = {
  id: 'acc-review',
  title: 'ACC application review, end-to-end (rules + judgment + action)',
  system: SYSTEM,
  prompt: PROMPT,
  maxTokens: 2600,
  rubric: RUBRIC,
  meta: { corner_lot: true, violations: ['fence_side_setback', 'shed_rear_setback', 'paint_off_palette'], correct_disposition: 'conditional_or_deny' },
};
