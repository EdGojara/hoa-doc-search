// ============================================================================
// tests/test_proposal_boundary.js  (2026-09-20)
// ----------------------------------------------------------------------------
// The presentation/proposal domain boundary, as invariants:
//   - the Management Proposal is functional after relocation to lib/proposals,
//   - a proposal is NOT a presentation audience,
//   - pricing/onboarding content cannot appear in a DEMO presentation,
//   - no legacy presentation generator (partner.js / board.js / registry) is
//     callable,
//   - the orphaned static CLMA pptx and the dead scratch file are gone.
// Run: node tests/test_proposal_boundary.js  (wired into npm test)
// ============================================================================
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const story = require('../lib/presentations/story');
const proposals = require('../lib/proposals');

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };
const repo = (...p) => path.join(__dirname, '..', ...p);

// 1. Management Proposal remains functional after relocation, with pricing.
const t = proposals.getTemplate('management_proposal');
ok(!!t, 'management_proposal missing from the proposal registry');
ok(t && t.slug === 'management_proposal', 'proposal slug must be management_proposal (not "board")');
ok(t && /price_per_unit/.test(JSON.stringify(t.variables || [])), 'proposal must keep its pricing variables');
ok(t && typeof t.build === 'function', 'proposal must expose build()');

// 2. The proposal is NOT a presentation audience. ('board' remains a valid
//    DEMO audience — that is the whole point: 'board' the demo vs the proposal.)
ok(!story.AUDIENCES.includes('management_proposal') && !story.AUDIENCES.includes('proposal'), 'the proposal slug must not be a presentation audience');

// 3. Pricing cannot appear in a DEMO presentation (the board demo audience).
const boardDemo = JSON.stringify(story.getStory('board'));
ok(!/price per unit|onboarding fee|\/\s*unit\s*\/\s*month|per door/i.test(boardDemo), 'the board DEMO deck must contain no pricing/onboarding content');

// 4. No legacy presentation generator remains callable.
ok(!fs.existsSync(repo('lib', 'presentations', 'partner.js')), 'legacy lib/presentations/partner.js must be removed');
ok(!fs.existsSync(repo('lib', 'presentations', 'board.js')), 'legacy lib/presentations/board.js must be removed');
ok(!fs.existsSync(repo('lib', 'presentations', 'index.js')), 'legacy presentation registry (lib/presentations/index.js) must be removed');
let registryThrew = false;
try { require('../lib/presentations'); } catch (_) { registryThrew = true; }
ok(registryThrew, 'require("../lib/presentations") must fail — no legacy template registry');

// 5. Orphaned artifacts removed.
ok(!fs.existsSync(repo('public', 'clma', 'CLMA_trustEd_Demo.pptx')), 'orphaned static CLMA pptx must be removed');
ok(!fs.existsSync(repo('scratch_index_js.js')), 'dead scratch_index_js.js must be removed');

if (fails.length) { console.error('✗ proposal boundary: ' + fails.length + ' failure(s)'); fails.forEach((f) => console.error('   - ' + f)); process.exit(1); }
console.log('✓ proposal boundary: proposal relocated + functional, no pricing in demos, no legacy generators, orphans removed');
