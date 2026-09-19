// evals/cases/clma-bid-analysis/case.js
// ---------------------------------------------------------------------------
// FIRST eval case: CLMA landscape + irrigation bid analysis.
//
// Grounded in CLMA's real situation (2009 Maintenance Agreement): Cinco LMA
// maintains the landscaping AND the irrigation/water systems on the Cinco Ranch
// monument property, at its sole cost; Cinco Residential holds the monuments +
// lighting. So irrigation is a CORE CLMA duty — a landscape bid that excludes it
// has a real scope gap, not a nicety.
//
// The three bids carry deliberate, realistic gotchas that separate a careful
// analysis from a naive one:
//   Bid A (GreenScape)  — LOWEST headline ($5,800/mo, yr-1 $69,600) BUT a 6%
//                         annual escalator AND explicitly EXCLUDES irrigation
//                         repairs/controller. Cheapest on paper, worst on scope.
//   Bid B (Lone Star)   — $6,450/mo, flat 3 yr, yr-1 $77,400, includes
//                         irrigation, GL $1M. Fully compliant, highest yr-1.
//   Bid C (Cypress)     — $5,950/mo, yr-1 $71,400, includes irrigation, BUT GL
//                         only $500,000 — below the required $1,000,000.
//
// A weak read anchors on Bid A's price. A good read (or a cross-check) surfaces
// A's irrigation exclusion + escalator and C's insufficient insurance, leaving B
// as the only fully-compliant bid — WITHOUT being asked to "recommend," because
// trustEd's rule is the operator dictates the recommendation, the system lays out
// the decision-relevant facts (lib/vendors/board_memo.js).
// ---------------------------------------------------------------------------

const REQUIRED_GL = 1_000_000; // per-occurrence general liability CLMA requires

const SYSTEM = [
  'You are the vendor-analysis function of an HOA/association management platform.',
  'You lay out the decision-relevant facts for a board. You do NOT pick a winner — the operator dictates the recommendation. Never write "we recommend", "the winner is", or choose one bid as the answer.',
  'Every figure you state must be tied to a specific bid. Show the math for annualized cost. Flag any scope gap, any insurance shortfall, and anything missing. If a bid excludes something the association is obligated to maintain, say so plainly.',
].join(' ');

const PROMPT = `Community: Cinco Landscape Maintenance Association (CLMA), Cinco Ranch (Fort Bend + Harris counties, TX).

What CLMA is obligated to maintain (per its 2009 Maintenance Agreement): the LANDSCAPING and the IRRIGATION and water systems on the Cinco Ranch monument property, at its sole cost. (Cinco Residential separately maintains the monuments and lighting — not CLMA's cost.) So irrigation maintenance and repair is a core CLMA responsibility, not optional.

Association requirements for this contract:
- Required scope: mowing and landscape maintenance of monument beds and esplanades, seasonal color, shrub and tree care, AND irrigation system maintenance and repair (including controllers).
- Required insurance: Commercial General Liability of at least $1,000,000 per occurrence.
- Annual landscape+irrigation budget: $85,000.

Three bids were received. Compare them for the board.

BID A — GreenScape Services
- Price: $5,800 per month, base year.
- Escalator: 6% increase each year (3-year term).
- Insurance: General Liability $1,000,000 per occurrence.
- Scope included: mowing, bed maintenance, seasonal color (2 rotations), shrub trimming.
- Explicitly excluded: "Irrigation system repairs, controller programming, and backflow testing are NOT included and will be billed separately or are the Association's responsibility."

BID B — Lone Star Grounds
- Price: $6,450 per month, flat for the full 3-year term (no escalator).
- Insurance: General Liability $1,000,000 per occurrence.
- Scope included: mowing, bed maintenance, seasonal color (3 rotations), shrub and tree care, and irrigation system maintenance and repairs (including controllers).

BID C — Cypress Landscaping
- Price: $5,950 per month, base year.
- Escalator: 3% increase each year (3-year term).
- Insurance: General Liability $500,000 per occurrence.
- Scope included: mowing, bed maintenance, seasonal color (2 rotations), and irrigation system maintenance.

Produce the board-facing comparison: the annualized (year-1) cost of each bid with the math, insurance compliance for each, scope coverage against the required scope (call out any gap), the multi-year cost effect of any escalator, and anything missing. Do not recommend a single winner.`;

// Ground truth:
//   A yr-1 = 5800*12 = 69,600 ; B = 6450*12 = 77,400 ; C = 5950*12 = 71,400
const RUBRIC = [
  { id: 'a_annual', type: 'number', value: 69600, tolerance: 50, weight: 1, sev: 'financial', desc: 'States Bid A year-1 annual = $69,600' },
  { id: 'b_annual', type: 'number', value: 77400, tolerance: 50, weight: 1, sev: 'financial', desc: 'States Bid B year-1 annual = $77,400' },
  { id: 'c_annual', type: 'number', value: 71400, tolerance: 50, weight: 1, sev: 'financial', desc: 'States Bid C year-1 annual = $71,400' },
  { id: 'a_irrigation_gap', type: 'regex', pattern: '(irrigation)[\\s\\S]{0,80}(exclud|not included|separate|responsibilit)|(exclud|not included)[\\s\\S]{0,40}(irrigation)', weight: 2, sev: 'operational', desc: 'Flags that Bid A EXCLUDES irrigation (a core CLMA duty) — the key scope gap' },
  { id: 'a_escalator', type: 'regex', pattern: '(6\\s?%|escalat|annual increase|year 2|multi-?year)', weight: 1, sev: 'informational', desc: 'Notes Bid A\'s 6% escalator / multi-year cost effect' },
  { id: 'c_insurance', type: 'regex', pattern: '(500,?000|\\$500k)[\\s\\S]{0,120}(below|short|insufficient|does not meet|under|fails|not meet|1,?000,?000)|insur[\\s\\S]{0,120}(insufficient|below|does not meet|fails|short)', weight: 2, sev: 'compliance', desc: 'Flags Bid C insurance $500k is BELOW the required $1M' },
  { id: 'b_compliant', type: 'regex', pattern: '(Lone Star|Bid B)[\\s\\S]{0,160}(irrigation|fully|compliant|includes|meets)', weight: 1, sev: 'informational', desc: 'Notes Bid B includes irrigation / meets requirements' },
  { id: 'no_winner', type: 'absent', pattern: '\\b(we recommend|i recommend|the winner is|our recommendation is|recommend awarding|should be awarded to|best choice is)\\b', weight: 1, sev: 'compliance', desc: 'Did NOT fabricate a single winner/recommendation (operator dictates)' },
  // Added after a cross-check caught it: required scope names esplanades, and no
  // bid addresses them — a strong analysis flags that silence. (The harness
  // improving its own ground truth.)
  { id: 'esplanade_gap', type: 'regex', pattern: 'esplanade', weight: 1, sev: 'operational', desc: 'Raises esplanades (required scope) — none of the bids cover them' },
];

module.exports = {
  id: 'clma-bid-analysis',
  title: 'CLMA landscape + irrigation bid comparison',
  system: SYSTEM,
  prompt: PROMPT,
  maxTokens: 3200,
  rubric: RUBRIC,
  meta: { required_gl: REQUIRED_GL, truth: { a_annual: 69600, b_annual: 77400, c_annual: 71400 } },
};
