// tests/test_grounding.js
// ---------------------------------------------------------------------------
// Regression check for the AI-team grounding + verification layer
// (lib/team/grounding.js). The marquee case: an independent number check must
// catch a confident wrong count in a draft (the "18 cameras when it's 27"
// failure on the iTech proposal, Ed 2026-09-17) while passing the correct
// figures and flagging a claim the source never makes.
//
// This exercises a live model, so it is NON-DETERMINISTIC and needs an API key.
// Without ANTHROPIC_API_KEY it SKIPS (exit 0) so it never breaks a keyless CI.
// Run directly: node tests/test_grounding.js
// ---------------------------------------------------------------------------
try { require('dotenv').config(); } catch (_) {}
const { verifyClaims, buildGroundingRecord } = require('../lib/team/grounding');

const SOURCE = `ACME Surveillance Proposal for Test HOA.
Scope of Work:
1. Reuse 5 existing cameras at the Clubhouse.
2. Replace 3 cameras at the Clubhouse.
3. Install 4 new cameras at the Pool.
Summary of Cost: Material & Labor $12,500.00. SALES TAX NOT INCLUDED AT 8.25%.
Payment Terms: 50% upon acceptance, 50% upon completion.`;

// Draft with: a WRONG camera count (9; the source supports 12 total positions),
// a CORRECT total ($12,500.00), and a claim the source never makes (retention).
const DRAFT = `The ACME system is about 9 cameras total across the Clubhouse and Pool. The project total is $12,500.00 plus 8.25% sales tax. It also includes 60 days of guaranteed video retention.`;

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
function pass(msg) { console.log('  ok -', msg); }

(async () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('SKIP test_grounding: no ANTHROPIC_API_KEY');
    return;
  }
  console.log('test_grounding: verifying independent number-check catches a planted miscount...');

  const v = await verifyClaims({ draftBody: DRAFT, sourceText: SOURCE, sourceBlocks: [] });
  if (!v || !Array.isArray(v.claims)) { fail('verifyClaims returned nothing'); return; }

  // 1) The 9-camera claim must be flagged as a mismatch (source supports 12).
  const countMiss = v.claims.some((c) => c.status === 'mismatch' &&
    /camera/i.test((c.claim || '') + ' ' + (c.draft_value || '')));
  countMiss ? pass('flagged the wrong camera count as a mismatch') : fail('did NOT flag the wrong camera count (' + JSON.stringify(v.counts) + ')');

  // 2) The retention claim (never in the source) must be unverifiable, not "match".
  const retention = v.claims.find((c) => /retention|60 day/i.test(c.claim || ''));
  if (!retention) fail('did not surface the retention claim at all');
  else if (retention.status === 'match') fail('wrongly "verified" a retention period the source never states');
  else pass('flagged the unstated retention claim as ' + retention.status);

  // 3) The correct $12,500 total must NOT be a mismatch.
  const total = v.claims.find((c) => /12,?500/.test((c.claim || '') + ' ' + (c.draft_value || '')));
  if (total && total.status === 'mismatch') fail('wrongly flagged the correct $12,500 total as a mismatch');
  else pass('did not false-flag the correct dollar total');

  // 4) Grounding (Layer 1) separates fact / recommendation / gap.
  const g = await buildGroundingRecord({ draftBody: DRAFT, sourceText: SOURCE, sourceBlocks: [] });
  if (!g || !Array.isArray(g.claims)) fail('buildGroundingRecord returned nothing');
  else {
    const hasGap = g.claims.some((c) => c.type === 'gap');
    hasGap ? pass('grounding record flagged at least one gap') : fail('grounding record found no gaps (expected retention/count as gaps)');
  }

  if (process.exitCode) console.error('\ntest_grounding: FAILED');
  else console.log('\ntest_grounding: PASSED');
})().catch((e) => { fail('threw: ' + e.message); });
