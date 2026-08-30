// ============================================================================
// tests/test_bedrock_ops.js  (Ed 2026-08-30)
// ----------------------------------------------------------------------------
// Maggie (Growth) is the first INTERNAL Bedrock-ops agent. The invariants that
// keep her safe and correctly placed: she is ISOLATED from the community team
// (never on a community-facing surface), she carries the policy RAILS in her
// prompt (dark / human-released, approved-claims-only, no over-promise, AI
// disclosure, pre-sale), and her primer states both what she may and may NOT
// claim. Deterministic: config + registry + primer text, no model, no DB.
// ============================================================================
const assert = require('assert');
const communityRoster = require('../lib/team/roster');
const ops = require('../lib/team/bedrock_ops');
const { OPS_CONFIGS } = require('../lib/team/bedrock_ops_configs');
const { GROWTH_PRIMER } = require('../lib/team/knowledge/growth_primer');

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } }

console.log('\nBedrock-ops: Maggie (Growth)\n');

// --- isolation: Maggie is NOT on the community team --------------------------
console.log('Isolation from the community-facing team:');
ok(communityRoster.get('maggie') === null, 'Maggie is NOT in the community roster (never on a community surface)');
ok(!communityRoster.people().some((m) => m.persona === 'maggie'), 'community people() excludes Maggie');
ok(ops.get('maggie') && ops.get('maggie').name === 'Maggie Sullivan', 'Maggie IS in the internal Bedrock-ops registry');
const m = ops.get('maggie');
ok(m.community_facing === false && m.internal === true && m.owner_gated === true, 'flagged internal, owner-gated, not community-facing');

// --- config well-formed + rails present -------------------------------------
console.log('\nConfig + policy rails:');
ok(OPS_CONFIGS.maggie && typeof OPS_CONFIGS.maggie.systemPromptFor === 'function', 'Maggie has a config with a system prompt');
const sys = OPS_CONFIGS.maggie.systemPromptFor();
ok(/never send|reserved|releases?/i.test(sys), 'prompt: dark / human-released rail');
ok(/approved positioning|approved|only what/i.test(sys), 'prompt: approved-claims-only rail');
ok(/over-?promise/i.test(sys), 'prompt: no-over-promise rail');
ok(/\bAI\b/.test(sys) && /disclos/i.test(sys), 'prompt: AI-disclosure rail');
ok(/pre-sale/i.test(sys), 'prompt: stay pre-sale (does not touch signed communities)');
const fb = OPS_CONFIGS.maggie.fallback('Dana');
ok(typeof fb === 'string' && /Dana/.test(fb), 'fallback greets the prospect');

// --- primer: what she may AND may not claim ---------------------------------
console.log('\nGrowth primer — claims discipline:');
ok(/APPROVED/i.test(GROWTH_PRIMER) && /AI-native/i.test(GROWTH_PRIMER), 'primer states the approved positioning');
ok(/audit|tax|fraud/i.test(GROWTH_PRIMER) && /MUST NOT|not claim|hard line/i.test(GROWTH_PRIMER), 'primer states the OFF-LIMITS claims (no audit/tax/fraud)');
ok(/guarantee/i.test(GROWTH_PRIMER), 'primer forbids guarantees of results/savings');
ok(/DARK|human-released|reserved/i.test(GROWTH_PRIMER) && /disclos/i.test(GROWTH_PRIMER), 'primer restates the dark + disclosure rails');
ok(/board-seat flywheel|demonstrate|artifacts leave/i.test(GROWTH_PRIMER), 'primer carries the growth playbook (Ed\'s winning plays)');

console.log(`\n${fail ? 'FAILED' : 'All'} Bedrock-ops cases ${fail ? '' : 'passed'} (${pass} passed, ${fail} failed).`);
process.exit(fail ? 1 : 0);
