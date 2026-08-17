// =============================================================================
// tests/test_claire_scope.js — who Claire will talk about
// =============================================================================
//
// The bug this locks down, found by Ed on 2026-08-16:
//
// He used staff "view as" on a Waterview board member to check that community
// isolation held on the Claire surface. Claire offered her a picker containing
// all eight communities. The isolation itself was fine — that board member's
// real scope resolves to exactly one community — but resolveVisitor() checked
// STAFF identity before it checked the mimic cookie, so the server saw Ed, not
// her, and returned scope 'all'.
//
// The dropdown was the symptom. The actual defect is worse: a "view as" that
// does not constrain the view is used precisely when someone is trying to
// verify a boundary, and it answers with false confidence. A test that lies is
// more dangerous than no test.
//
// So: mimic always wins, and a mimicked visitor can never resolve to 'all'.
//
// Run: node tests/test_claire_scope.js   (wired into npm test)
// =============================================================================

try { require('dotenv').config(); } catch (_) { /* live lookups need SUPABASE_* */ }
const assert = require('assert');
const { canAccessCommunity, resolveVisitCommunity } = require('../lib/claire/scope');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failures += 1; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); }
}

console.log('\nClaire — community scope\n');

const ALL = ['c1', 'c2', 'c3'];
const staff = { role: 'staff', communityIds: 'all' };
const board = { role: 'board', communityIds: ['c1'] };
const boardTwo = { role: 'board', communityIds: ['c1', 'c2'] };
const owner = { role: 'homeowner', communityIds: ['c2'] };

// ---------------------------------------------------------------------------
console.log('A community you hold no seat in is refused');

check('board member cannot access another community', () => {
  assert.strictEqual(canAccessCommunity(board, 'c2'), false);
  assert.strictEqual(canAccessCommunity(board, 'c3'), false);
  assert.strictEqual(canAccessCommunity(board, 'c1'), true);
});

check('homeowner cannot access another community', () => {
  assert.strictEqual(canAccessCommunity(owner, 'c1'), false);
  assert.strictEqual(canAccessCommunity(owner, 'c2'), true);
});

check('staff may access any community', () => {
  for (const c of ALL) assert.strictEqual(canAccessCommunity(staff, c), true);
});

check('a null visitor is refused everything', () => {
  for (const c of ALL) assert.strictEqual(canAccessCommunity(null, c), false);
});

// ---------------------------------------------------------------------------
console.log('\nA request cannot widen its own scope');

check('board member naming another community gets null, never a fallback', () => {
  // null must be treated as 403 by callers. The dangerous bug would be
  // returning their OWN community here, quietly succeeding on a request that
  // asked for someone else's.
  assert.strictEqual(resolveVisitCommunity(board, 'c2'), null);
  assert.strictEqual(resolveVisitCommunity(board, 'c1'), 'c1');
});

check('homeowner asking for another community gets null', () => {
  assert.strictEqual(resolveVisitCommunity(owner, 'c1'), null);
  assert.strictEqual(resolveVisitCommunity(owner, 'c2'), 'c2');
});

check('a homeowner with no community named still only gets their own', () => {
  assert.strictEqual(resolveVisitCommunity(owner, null), 'c2');
});

check('single-seat board member does not have to name their community', () => {
  assert.strictEqual(resolveVisitCommunity(board, null), 'c1');
});

check('multi-seat board member must name one rather than defaulting', () => {
  // Defaulting to the first seat would silently answer about the wrong
  // community when they meant the other.
  assert.strictEqual(resolveVisitCommunity(boardTwo, null), null);
  assert.strictEqual(resolveVisitCommunity(boardTwo, 'c2'), 'c2');
  assert.strictEqual(resolveVisitCommunity(boardTwo, 'c3'), null);
});

check('staff with many seats must name one too', () => {
  assert.strictEqual(resolveVisitCommunity(staff, null), null);
  assert.strictEqual(resolveVisitCommunity(staff, 'c3'), 'c3');
});

// ---------------------------------------------------------------------------
console.log('\nMimic can only ever narrow');

check('a mimicked visitor never carries scope "all"', () => {
  // The exact shape _mimickedVisitor returns: a role of board or homeowner and
  // an ARRAY of ids. If this ever becomes 'all', staff view-as has stopped
  // constraining the view and the boundary check silently passes for everyone.
  for (const v of [
    { role: 'board', communityIds: ['c1'], actingAs: { mimic: true } },
    { role: 'homeowner', communityIds: ['c2'], actingAs: { mimic: true } },
  ]) {
    assert.notStrictEqual(v.communityIds, 'all', 'mimicked visitor widened to all');
    assert(Array.isArray(v.communityIds), 'mimicked scope must be an explicit list');
    assert.notStrictEqual(v.role, 'staff', 'mimic resolved as staff');
    assert.strictEqual(canAccessCommunity(v, 'c3'), false);
  }
});

check('mimic is checked before staff identity in resolveVisitor', () => {
  // Guards the ordering itself. Ed's session is staff; the mimic branch must
  // return before the staff branch is reached, or view-as lies again.
  const src = require('fs').readFileSync(require.resolve('../lib/claire/scope.js'), 'utf8');
  const mimicAt = src.indexOf('_mimickedVisitor(req)');
  const staffAt = src.indexOf('resolveBoardViewer(req)');
  assert(mimicAt > -1, 'mimic branch is gone');
  assert(staffAt > -1, 'staff branch is gone');
  assert(mimicAt < staffAt, 'staff identity is resolved BEFORE mimic — view-as will report the wrong scope');
});

console.log(failures ? `\n${failures} FAILED\n` : '\nAll scope checks passed.\n');
process.exit(failures ? 1 : 0);
