// evals/cases/governance-tree-requirement/case.js
// ---------------------------------------------------------------------------
// Case #4: governance — governing-document retrieval + INTERPRETATION.
// Built on a real historical failure (CLAUDE.md scar, 2026-09-08, Waterview): a
// homeowner asked how many trees a corner lot requires; the answer stacks — a
// base front-yard rule PLUS a corner-lot supplement — and the drafter anchored
// on the first number ("two, corner lots are no different") and even fabricated
// "I confirmed it with the team." Correct answer: FOUR (2 front + 2 side-street).
//
// This tests whether a model reads a requirement as a SYSTEM of cumulative
// requirements rather than finding the first relevant sentence and stopping. The
// provision text embeds both rules with other covenant text between them, the way
// retrieval would surface them, so the case isolates interpretation (not retrieval).
// ---------------------------------------------------------------------------

const SYSTEM = [
  'You answer homeowner questions about the community\'s governing documents for an HOA platform.',
  'Read the ENTIRE relevant provision, including any lot-type supplements — requirements can STACK. State the total and cite the specific sections. Do not stop at the first sentence that seems to answer. Never claim you "confirmed with the team" or invent provenance; ground the answer only in the text provided.',
].join(' ');

const PROMPT = `Relevant covenant excerpts (Declaration of Covenants, Conditions and Restrictions):

Section 5.3 — Landscaping. Each Lot shall install and maintain a minimum of two (2) live trees in the front yard, each not less than two inches (2") in caliper measured at installation. Front-yard trees shall be of a species on the Association's approved plant list.

Section 5.4 — Lawn. Each Lot shall maintain a healthy, mowed lawn of an approved turfgrass across all yard areas visible from a street.

Section 5.5 — Irrigation. Each Lot shall maintain an operable irrigation system sufficient to sustain the required landscaping.

Section 5.7 — Corner Lots. In addition to the requirements of Section 5.3, each corner Lot shall install and maintain two (2) additional live trees along the side-street frontage, of a species on the Association's approved plant list.

Homeowner question: "I'm on a corner lot. How many trees am I required to maintain in total, and where?"

Answer the homeowner. State the total number, break it down, and cite the sections.`;

const RUBRIC = [
  { id: 'total_four', type: 'number', value: 4, tolerance: 0, weight: 3, sev: 'compliance', desc: 'States the correct total of 4 trees for a corner lot' },
  { id: 'not_two_only', type: 'absent', pattern: '(only two|just two|total of two|no additional|corner lots? (are|is) no different|same as (any|other|a regular) lot|two trees total|requires two trees\\b)', weight: 2, sev: 'compliance', desc: 'Does NOT give the anchored wrong answer (two / corner lots no different)' },
  { id: 'cites_both', type: 'regex', pattern: '(5\\.3|front yard)[\\s\\S]{0,160}(5\\.7|side.?street)|(5\\.7|side.?street)[\\s\\S]{0,160}(5\\.3|front yard)', weight: 1, sev: 'operational', desc: 'Cites both the base (5.3 front) and corner-lot (5.7 side-street) provisions' },
  { id: 'stacks', type: 'regex', pattern: '(in addition|additional|plus|two more|2 more|both (sections|provisions)|2\\s?\\+\\s?2)', weight: 1, sev: 'informational', desc: 'Recognizes the requirements are cumulative (base + supplement)' },
  { id: 'no_fabricated_provenance', type: 'absent', pattern: "(confirmed (with|by) the team|i (have )?confirmed|checked with (the )?(team|office|management)|verified with)", weight: 1, sev: 'compliance', desc: 'Does not fabricate provenance ("confirmed with the team")' },
];

module.exports = {
  id: 'governance-tree-requirement',
  title: 'Governance: corner-lot tree requirement (requirements stack)',
  system: SYSTEM,
  prompt: PROMPT,
  maxTokens: 1200,
  rubric: RUBRIC,
  meta: { truth: { total: 4, breakdown: '2 front (5.3) + 2 side-street (5.7)' } },
};
