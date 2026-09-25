#!/usr/bin/env node
// academy/tools/prompt_diff.js - render the v1.1 minimal prompt diff from the
// single source of truth (academy/lib/candidate_prompt.js EDITS + blocks).
//   node academy/tools/prompt_diff.js > academy/docs/PROMPT_V1_1_DIFF.md
require('dotenv').config({ quiet: true, path: require('path').join(__dirname, '..', '..', '.env') });
const { EDITS, FACTUAL_INTEGRITY, UNCERTAINTY, channelFormat } = require('../lib/candidate_prompt');
const { SHAPES } = require('../lib/intent');
const { loadLivePrompts } = require('../lib/live_prompt');

const L = [];
L.push('# Amanda v1.1: proposed minimal prompt diff (NOT applied to production)', '');
L.push(`Generated from \`academy/lib/candidate_prompt.js\` against the live prompt (fingerprint \`${loadLivePrompts().fingerprint}\`). Every "current" line below is asserted verbatim against production by \`tests/test_academy_v1_1.js\`.`, '');
L.push(`**Scope:** ${EDITS.length} replaced sentences in the audience prompts, plus 3 always-on blocks and 2 per-message blocks. Nothing is removed from CONTACT_ROUTING_RULE, NO_OVERPROMISE_RULE, the finance primer, or any HARD RULE.`, '');
L.push('## Replaced instructions', '');
for (const e of EDITS) {
  L.push(`### ${e.id} (${e.target} prompt)`, '');
  L.push('**Current (production):**', '', '> ' + e.from, '');
  L.push(`**Problem observed in baseline:** ${e.problem}`, '');
  L.push('**Proposed replacement:**', '', '> ' + e.to, '');
  L.push(`**Cases affected:** ${e.cases.join(', ')}`, '');
}
L.push('## Added always-on blocks (appended after NO_OVERPROMISE_RULE)', '');
L.push('### FACTUAL INTEGRITY', '', '```text', FACTUAL_INTEGRITY, '```', '', '**Why:** baseline fabricated actions ("I checked with TreeWise this morning", "I pushed them again this morning"), statutory authority ("the board has the statutory authority to set assessments without a member vote"), generic norms ("commonly 10% or 20% per year"), and a deadline ("by end of week"). Cases: AA-REL-003, AA-REL-009, AA-TEC-007, AA-REG-002, AA-REG-003, AA-REG-005.', '');
L.push('### CERTAINTY LANGUAGE', '', '```text', UNCERTAINTY, '```', '', '**Why:** "The association\'s real property is uninsured or we have lost track of the coverage" (AA-TEC-004) and a lapse treated as fact (AA-REL-006). Cases: AA-REL-006, AA-TEC-004, AA-REG-004.', '');
L.push('### ACTIONS ON RECORD (user content, before "Draft Amanda\'s reply")', '', 'Lists actions actually taken (production source: interactions, sent outbound_email_drafts, objective_events, vendor_project_events, tool calls this turn). "Anything not listed has NOT happened." This is what the action guard verifies claims against.', '');
L.push('## Added per-message blocks', '');
L.push('### FORMAT FOR THIS CHANNEL (replaces the universal "greeting through sign-off")', '');
for (const ch of ['email', 'chat', 'phone']) L.push(`- **${ch}:** ${channelFormat(ch).replace(/^FORMAT FOR THIS CHANNEL \([^)]*\): /, '')}`);
L.push('', '### WHAT THIS MESSAGE IS + HOW TO SHAPE THE REPLY (from the intent classifier)', '');
for (const [m, s] of Object.entries(SHAPES)) L.push(`- **${m}:** ${s}`);
L.push('', 'Decision format (options, tradeoffs, recommendation) appears ONLY under decision_support.', '');
L.push('## Not changed (deliberately)', '');
L.push('- HARD RULES (no fine waivers, ACC decisions, 209 determinations, legal positions): unchanged.');
L.push('- Board disclosure rules, vendor non-disclosure rules, CONTACT_ROUTING_RULE, NO_OVERPROMISE_RULE: unchanged.');
L.push('- FINANCE_PRIMER: unchanged in this diff. Inventory finding: it is ~5k chars loaded on every non-vendor message (even a tree status chat); gating it to finance intents is a follow-up candidate, not part of v1.1.');
L.push('- The warm voice ("warm, plain, specific", "take ownership"): kept. Friendliness is allowed, not mandated.');
process.stdout.write(L.join('\n') + '\n');
