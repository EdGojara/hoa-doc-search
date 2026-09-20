// ============================================================================
// tests/test_board_tiles.js
// ----------------------------------------------------------------------------
// Board portal tile gating + comfort-banner truthfulness. The board portal is
// vanilla HTML (no module system), so this verifies two things together:
//   (A) the gating/banner LOGIC behaves correctly (behavioral checks on the
//       identical pure logic), and
//   (B) the SHIPPED files (board-portal.html, board_portal.js) actually contain
//       that logic, so the behavioral checks reflect what ships.
//
// Invariants proven:
//   * A board_tiles config hides exactly the configured tiles; a fully-hidden
//     section is suppressed (no dangling label).
//   * No board_tiles config => every tile shows (residential unchanged).
//   * Absence of operational data never renders as positive health.
//   * The board /summary endpoint returns board_tiles from portal_module_config.
// Run: node tests/test_board_tiles.js
// ============================================================================
const fs = require('fs');
const path = require('path');

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); if (!c) fails++; };

// --- (A) The pure logic, identical to board-portal.html ---------------------
const tileOn = (bt, key) => !(bt && bt[key] === 'hidden');
const sect = (label, tiles) => { const vis = tiles.filter(Boolean); return vis.length ? `[${label}]${vis.join('')}` : ''; };
const gate = (bt, key, tile) => (tileOn(bt, key) ? tile : '');
// comfort-banner substrate check, identical to board-portal.html
function bannerShows(counts, projects, ms, budget_headline) {
  const pj = (projects && projects.summary) || {};
  const projCount = (projects && Array.isArray(projects.projects)) ? projects.projects.length
    : ((pj.active || 0) + (pj.planned || 0) + (pj.total || 0));
  return (counts && counts.total_properties > 0) || projCount > 0 || (ms && ms.length > 0) || !!budget_headline;
}

// CLMA config (as migration 438 / live data sets it)
const CLMA_BT = { drv: 'hidden', arc: 'hidden', properties: 'hidden', map: 'hidden' };

// 1-4) Tile gating with CLMA config
ok(!tileOn(CLMA_BT, 'drv'), 'CLMA: DRV/Violations hidden');
ok(!tileOn(CLMA_BT, 'arc'), 'CLMA: ARC hidden');
ok(!tileOn(CLMA_BT, 'properties'), 'CLMA: Properties hidden');
ok(!tileOn(CLMA_BT, 'map'), 'CLMA: Map hidden');
ok(tileOn(CLMA_BT, 'projects') && tileOn(CLMA_BT, 'motions') && tileOn(CLMA_BT, 'meetings') && tileOn(CLMA_BT, 'learning'),
   'CLMA: Projects/Motions/Meetings/Board Learning remain visible');

// Community health = all four hidden -> section suppressed
const ch = sect('Community health', [gate(CLMA_BT, 'map', 'M'), gate(CLMA_BT, 'drv', 'D'), gate(CLMA_BT, 'arc', 'A'), gate(CLMA_BT, 'properties', 'P')]);
ok(ch === '', 'CLMA: the Community health section is suppressed (no dangling label)');
const gov = sect('Governance', [gate(CLMA_BT, 'motions', 'Mo'), gate(CLMA_BT, 'discussion', 'Di'), gate(CLMA_BT, 'projects', 'Pr')]);
ok(gov.includes('[Governance]') && gov.includes('Pr'), 'CLMA: Governance still renders');

// No config => residential renders exactly as before (all tiles show)
const NONE = null;
ok(['drv', 'arc', 'properties', 'map', 'projects', 'motions'].every((k) => tileOn(NONE, k)), 'no config: every tile shows (residential unchanged)');
const chRes = sect('Community health', [gate(NONE, 'map', 'M'), gate(NONE, 'drv', 'D'), gate(NONE, 'arc', 'A'), gate(NONE, 'properties', 'P')]);
ok(chRes.includes('[Community health]') && chRes.includes('D') && chRes.includes('P'), 'no config: Community health renders with all tiles');

// 5) Comfort banner truthfulness
ok(bannerShows({ total_properties: 344 }, null, [], null), 'residential (344 homes): health banner shows');
ok(!bannerShows({ total_properties: 0 }, { summary: {} }, [], null), 'CLMA (no properties/projects/motions/budget): banner SUPPRESSED');
ok(bannerShows({ total_properties: 0 }, null, [], 'FY2026 budget'), 'a landscape org WITH a budget: banner shows (data exists)');

// --- (B) The shipped files contain this logic -------------------------------
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'board-portal.html'), 'utf8');
ok(/bt\s*&&\s*bt\[key\]\s*===\s*'hidden'/.test(html), 'board-portal.html ships the tileOn gate');
ok(/tiles\.filter\(Boolean\)/.test(html), 'board-portal.html ships the empty-section suppression');
ok(/if\s*\(!hasOperational\)\s*return\s*''/.test(html), 'board-portal.html ships the comfort-banner suppression');
ok(/sect\('Community health'/.test(html) && /gate\('drv'/.test(html), 'board-portal.html gates the Community health tiles');
const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'board_portal.js'), 'utf8');
ok(/board_tiles:\s*\(community\.portal_module_config/.test(api), 'board_portal.js /summary returns board_tiles from portal_module_config');
ok(/select\('id, name, legal_name, slug, portal_module_config'\)/.test(api), 'board_portal.js /summary selects portal_module_config');

console.log(fails ? `\n✗ board-tiles: ${fails} failure(s)` : '\n✓ board-tiles: gating + truthful empty states + residential-unchanged, and shipped');
process.exit(fails ? 1 : 0);
