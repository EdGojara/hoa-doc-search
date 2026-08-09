// Reply-to-vote parsing. Recording a wrong vote from a misread reply is the
// failure that matters, so the deterministic keyword read must be conservative:
// clear yes/no → for/against, anything mixed or vague → unclear (caller then
// falls back to the one-click buttons; it never guesses).
// Run: node tests/test_board_vote_reply.js
try { require('dotenv').config(); } catch (_) {}
const { keywordVote, topOfReply } = require('../lib/board/vote_reply');

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  if (actual === expected) pass++; else { fail++; console.log(`✗ ${label}: expected ${expected}, got ${actual}`); }
}

// Clear FOR
eq(keywordVote('I vote for'), 'for', 'I vote for');
eq(keywordVote('Approved'), 'for', 'Approved');
eq(keywordVote('yes, in favor'), 'for', 'yes in favor');
eq(keywordVote('Aye'), 'for', 'Aye');
eq(keywordVote('I support this'), 'for', 'support');

// Clear AGAINST
eq(keywordVote('I vote against'), 'against', 'vote against');
eq(keywordVote('Opposed'), 'against', 'opposed');
eq(keywordVote('No, I reject this'), 'against', 'reject');
eq(keywordVote('nay'), 'against', 'nay');

// ABSTAIN wins even with other words
eq(keywordVote('I abstain on this one'), 'abstain', 'abstain');

// UNCLEAR — must NOT guess
eq(keywordVote('Can you tell me more before I decide?'), 'unclear', 'question → unclear');
eq(keywordVote('yes but I am against the cost'), 'unclear', 'mixed for+against → unclear');
eq(keywordVote('Thanks, got it'), 'unclear', 'acknowledgment → unclear');
eq(keywordVote(''), 'unclear', 'empty → unclear');

// topOfReply strips quoted history so we only read what they wrote now.
const withQuote = 'I vote for.\n\nOn Mon, Aug 9, 2026 at 9:00 AM Bedrock wrote:\n> A new motion is open...\n> Vote For  Vote Against';
eq(keywordVote(topOfReply(withQuote)), 'for', 'reads only the new text above the quote');
const quotedOnly = 'On Mon wrote:\n> Vote For or Vote Against';
eq(topOfReply(quotedOnly).length >= 0, true, 'topOfReply handles quote-only safely');

console.log(`\nboard vote reply: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
