// ============================================================================
// tests/test_lma_board_access.js
// ----------------------------------------------------------------------------
// Locks the Sterling Ridge (Demo LMA) board-authorization invariant used by
// /api/community-map/assets: canSeeCommunity(viewer, communityId). A legitimate
// Sterling Ridge board member (scope derived LIVE from board_members) can read
// Sterling Ridge; a board member of another community cannot (403). Staff
// (scope 'all', incl. staff view-as) can read it. Uses the real board_access
// core + live board_members rows. Run: node tests/test_lma_board_access.js
// ============================================================================
require('dotenv').config();
const { boardCommunitiesForEmail, canSeeCommunity } = require('../lib/portal/board_access');

const LMA = 'e0100000-0000-4000-a000-000000000000';   // Sterling Ridge LMD
const DC  = 'dc100000-0000-4000-a000-000000000000';   // Drama Creek (another demo community)
let fails = 0; const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); if (!c) fails++; };

(async () => {
  // Sterling Ridge board member's live scope
  const srScope = await boardCommunitiesForEmail('board@sterlingridge.demo');
  ok(srScope.has(LMA), '1. Sterling Ridge board seat resolves to the Sterling Ridge community (live board_members)');
  const srViewer = { kind: 'board', scope: srScope };

  // (1) legitimate Sterling Ridge board -> Sterling Ridge assets = 200
  ok(canSeeCommunity(srViewer, LMA) === true, '2. Sterling Ridge board CAN read Sterling Ridge assets (200)');

  // (2) Sterling Ridge board -> unrelated community assets = 403
  ok(canSeeCommunity(srViewer, DC) === false, '3. Sterling Ridge board CANNOT read another community (403)');

  // board member of ANOTHER community -> Sterling Ridge assets = 403
  const dcScope = await boardCommunitiesForEmail('sunny@dramacreekhoa.demo');
  ok(dcScope.has(DC), '4. Drama Creek board seat resolves to Drama Creek');
  ok(canSeeCommunity({ kind: 'board', scope: dcScope }, LMA) === false, '5. A board member of another community CANNOT read Sterling Ridge (403)');

  // staff (scope 'all', incl. staff view-as fallthrough) can read it
  ok(canSeeCommunity({ kind: 'staff', scope: 'all' }, LMA) === true, '6. Staff (scope all) CAN read Sterling Ridge (200)');

  // an email with no board seat -> empty scope -> denied
  const noneScope = await boardCommunitiesForEmail('nobody-no-seat@example.com');
  ok(noneScope.size === 0 && canSeeCommunity({ kind: 'board', scope: noneScope }, LMA) === false, '7. No board seat -> no access (denied)');

  console.log(fails ? `\n✗ lma-board-access: ${fails} failure(s)` : '\n✓ lma-board-access: authorization invariant holds both directions');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
