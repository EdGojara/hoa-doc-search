// Tests for board motion result math — quorum + pass/fail thresholds.
// A wrongly-computed "passed" puts an unauthorized decision in the minutes,
// so this logic must be right. Run: node tests/test_board_motions.js
try { require('dotenv').config(); } catch (_) { /* env optional; client is only built at import */ }
const { evaluateMotion } = require('../api/board_motions');

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; } else { fail++; console.log(`✗ ${label}\n    expected ${e}\n    got      ${a}`); }
}
const votes = (f, a, ab) => [
  ...Array(f).fill({ vote: 'for' }),
  ...Array(a).fill({ vote: 'against' }),
  ...Array(ab).fill({ vote: 'abstain' }),
];

// 5-seat board, quorum = 3.
const M = (threshold = 'simple_majority', seats = 5) => ({ seats_at_open: seats, threshold });

// Simple majority
eq(evaluateMotion(M(), votes(3, 0, 0)).provisional_result, 'passed', '3-0 of 5 → passed');
eq(evaluateMotion(M(), votes(2, 1, 0)).provisional_result, 'passed', '2-1 (quorum 3) → passed');
eq(evaluateMotion(M(), votes(1, 2, 0)).provisional_result, 'failed', '1-2 → failed');
eq(evaluateMotion(M(), votes(1, 1, 0)).provisional_result, 'pending_quorum', '1-1 (only 2 cast) → no quorum');
eq(evaluateMotion(M(), votes(2, 2, 0)).would_pass, false, '2-2 tie → not passing (need > against)');
// Abstentions count for quorum, not for the pass math.
eq(evaluateMotion(M(), votes(2, 0, 1)).quorum_met, true, '2 for + 1 abstain = 3 cast → quorum met');
eq(evaluateMotion(M(), votes(2, 0, 1)).provisional_result, 'passed', '2-0 with an abstain → passed');
eq(evaluateMotion(M(), votes(0, 0, 3)).would_pass, false, 'all abstain → not passing');

// Two-thirds (of for+against): need for >= ceil(2/3 * decisive)
eq(evaluateMotion(M('two_thirds'), votes(2, 1, 0)).would_pass, true, '2/3: 2 of 3 → passes (ceil(2)=2)');
eq(evaluateMotion(M('two_thirds'), votes(3, 2, 0)).would_pass, false, '2/3: 3 of 5 → fails (need ceil(3.33)=4)');
eq(evaluateMotion(M('two_thirds'), votes(4, 1, 0)).would_pass, true, '2/3: 4 of 5 → passes');

// Unanimous: any against fails; needs at least one for.
eq(evaluateMotion(M('unanimous'), votes(4, 0, 0)).would_pass, true, 'unanimous: 4-0 → passes');
eq(evaluateMotion(M('unanimous'), votes(4, 1, 0)).would_pass, false, 'unanimous: one against → fails');
eq(evaluateMotion(M('unanimous'), votes(0, 0, 0)).would_pass, false, 'unanimous: no votes → fails');

// Quorum math on even boards: 4 seats → quorum 3.
eq(evaluateMotion(M('simple_majority', 4), votes(2, 0, 0)).quorum_met, false, '4-seat board, 2 cast → no quorum (need 3)');
eq(evaluateMotion(M('simple_majority', 4), votes(2, 1, 0)).quorum_met, true, '4-seat board, 3 cast → quorum');

// No seat snapshot (defensive): quorum unknown, still tallies.
eq(evaluateMotion({ threshold: 'simple_majority' }, votes(2, 1, 0)).quorum, null, 'no seats → quorum null');

console.log(`\nboard motions: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
