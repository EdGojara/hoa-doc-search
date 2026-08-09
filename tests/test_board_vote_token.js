// The email ballot token IS the authentication for a no-login vote, so it must
// be unforgeable and expire. Run: node tests/test_board_vote_token.js
process.env.BOARD_VOTE_SECRET = process.env.BOARD_VOTE_SECRET || 'test-secret-abc';
const { signVoteToken, verifyVoteToken } = require('../lib/board/vote_token');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) pass++; else { fail++; console.log('✗ ' + label); } }

const M = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'Director@Example.com';

// Round-trip: identity survives, email normalized to lowercase.
const tok = signVoteToken({ motion_id: M, voter_email: EMAIL });
const v = verifyVoteToken(tok);
ok(v.ok === true, 'valid token verifies');
ok(v.motion_id === M, 'motion_id round-trips');
ok(v.voter_email === 'director@example.com', 'voter_email normalized lowercase');

// Tamper: flip a character in the body → bad signature.
const [body, sig] = tok.split('.');
const tamperedBody = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
ok(verifyVoteToken(`${tamperedBody}.${sig}`).ok === false, 'tampered payload rejected');
ok(verifyVoteToken(`${body}.${sig}xx`).ok === false, 'tampered signature rejected');
ok(verifyVoteToken('garbage').ok === false, 'malformed token rejected');
ok(verifyVoteToken('').ok === false, 'empty token rejected');

// Expiry: a token issued with a negative TTL is already expired.
const expired = signVoteToken({ motion_id: M, voter_email: EMAIL, ttlDays: -1 });
ok(verifyVoteToken(expired).reason === 'expired', 'expired token rejected');

// Wrong secret: a token signed under a different secret must not verify.
delete require.cache[require.resolve('../lib/board/vote_token')];
process.env.BOARD_VOTE_SECRET = 'a-different-secret';
const otherLib = require('../lib/board/vote_token');
ok(otherLib.verifyVoteToken(tok).ok === false, 'token from a different secret rejected');

console.log(`\nboard vote token: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
