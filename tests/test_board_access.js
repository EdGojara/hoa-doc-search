// Tests for lib/portal/board_access.js — the board-portal authorization core.
// The one that matters: a board member of community A must NEVER reach B.
require('dotenv').config();
const assert = require('assert');
const { canSeeCommunity, scopeCommunityIds, boardCommunitiesForEmail } = require('../lib/portal/board_access');

const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'a0000000-0000-4000-8000-00000000000b';
let pass = 0;
const ok = (d, c) => { assert.ok(c, d); pass++; };

(async () => {
  // ---- canSeeCommunity: the isolation gate ----
  const staff = { kind: 'staff', scope: 'all' };
  const boardA = { kind: 'board', scope: new Set([A]) };

  ok('staff sees any community', canSeeCommunity(staff, A) && canSeeCommunity(staff, B));
  ok('board member of A sees A', canSeeCommunity(boardA, A) === true);
  ok('board member of A is DENIED B', canSeeCommunity(boardA, B) === false);
  ok('no viewer sees nothing', canSeeCommunity(null, A) === false);
  ok('viewer with empty community id denied', canSeeCommunity(boardA, '') === false);

  // ---- scopeCommunityIds: /communities enumeration ----
  ok('staff enumerates all', scopeCommunityIds(staff) === 'all');
  ok('board enumerates only their set', JSON.stringify(scopeCommunityIds(boardA)) === JSON.stringify([A]));
  ok('null viewer enumerates nothing', JSON.stringify(scopeCommunityIds(null)) === '[]');

  // ---- boardCommunitiesForEmail: live derivation from board_members ----
  // A real board member resolves to their seat(s); a non-board email → empty set.
  const { createClient } = require('@supabase/supabase-js');
  const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { data: bm } = await s.from('board_members').select('email, community_id').not('email', 'is', null).eq('is_active', true).limit(1);
  if (bm && bm.length) {
    const seats = await boardCommunitiesForEmail(bm[0].email);
    ok(`real board member (${bm[0].email}) resolves to their seat`, seats.has(bm[0].community_id));
    ok('board scope excludes a community they do NOT sit on', !seats.has(B));
  } else {
    console.log('  (no active board_members with email to test live derivation — skipped)');
  }
  const none = await boardCommunitiesForEmail('definitely-not-a-board-member@example.com');
  ok('non-board email gets an empty scope', none.size === 0);
  const blank = await boardCommunitiesForEmail('');
  ok('blank email gets an empty scope', blank.size === 0);

  console.log(`board_access: ${pass} assertions passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
