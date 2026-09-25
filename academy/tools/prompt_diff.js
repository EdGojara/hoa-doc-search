#!/usr/bin/env node
// academy/tools/prompt_diff.js - render the minimal prompt diff (now v1.2) from
// the single source of truth (academy/lib/candidate_prompt.js EDITS + blocks).
//   node academy/tools/prompt_diff.js > academy/docs/PROMPT_V1_2_DIFF.md
// (PROMPT_V1_1_DIFF.md is kept as the record of what was reviewed for v1.1.)
require('dotenv').config({ quiet: true, path: require('path').join(__dirname, '..', '..', '.env') });
const { EDITS, FACTUAL_INTEGRITY, UNCERTAINTY, channelFormat } = require('../lib/candidate_prompt');
const { directoryBlock } = require('../team/directory');
const { capabilityBlock, COMMITMENT_RULE } = require('../team/capabilities');
const { SHAPES } = require('../lib/intent');
const { loadLivePrompts } = require('../lib/live_prompt');

const L = [];
L.push('# Amanda v1.2: proposed minimal prompt diff (NOT applied to production)', '');
L.push('v1.2 = v1.1 plus: edit E7 (routing rule), a rewritten escalation_risk shape, FACTUAL INTEGRITY without the phone-call example and with stricter legal wording, and three team layers (directory, capabilities, commitments). Changes since v1.1 are marked **(v1.2)**.', '');
L.push(`Generated from \`academy/lib/candidate_prompt.js\` against the live prompt (fingerprint \`${loadLivePrompts().fingerprint}\`). Every "current" line below is asserted verbatim against production by \`tests/test_academy_v1_1.js\`.`, '');
L.push(`**Scope:** ${EDITS.length} replaced sentences in the audience prompts, plus 3 always-on blocks, 3 team layers, and 2 per-message blocks. Nothing is removed from NO_OVERPROMISE_RULE, the finance primer, or any HARD RULE; one sentence of CONTACT_ROUTING_RULE is replaced (E7).`, '');
L.push('## Replaced instructions', '');
for (const e of EDITS) {
  L.push(`### ${e.id} (${e.target === 'routing_rule' ? 'CONTACT_ROUTING_RULE' : e.target + ' prompt'})${e.id.startsWith('E7') ? ' (v1.2)' : ''}`, '');
  L.push('**Current (production):**', '', '> ' + e.from, '');
  L.push(`**Problem observed in baseline:** ${e.problem}`, '');
  L.push('**Proposed replacement:**', '', '> ' + e.to, '');
  L.push(`**Cases affected:** ${e.cases.join(', ')}`, '');
}
L.push('## Added always-on blocks (appended after NO_OVERPROMISE_RULE)', '');
L.push('### FACTUAL INTEGRITY', '', '```text', FACTUAL_INTEGRITY, '```', '', '**Why:** baseline fabricated actions ("I checked with TreeWise this morning", "I pushed them again this morning"), statutory authority ("the board has the statutory authority to set assessments without a member vote"), generic norms ("commonly 10% or 20% per year"), and a deadline ("by end of week"). Cases: AA-REL-003, AA-REL-009, AA-TEC-007, AA-REG-002, AA-REG-003, AA-REG-005.', '');
L.push('### CERTAINTY LANGUAGE', '', '```text', UNCERTAINTY, '```', '', '**Why:** "The association\'s real property is uninsured or we have lost track of the coverage" (AA-TEC-004) and a lapse treated as fact (AA-REL-006). Cases: AA-REL-006, AA-TEC-004, AA-REG-004.', '');
L.push('### ACTIONS ON RECORD (user content, before "Draft Amanda\'s reply")', '', 'Lists actions actually taken (production source: interactions, sent outbound_email_drafts, objective_events, vendor_project_events, tool calls this turn). "Anything not listed has NOT happened." This is what the action guard verifies claims against.', '');
L.push('## Team layers (v1.2), appended after CERTAINTY LANGUAGE', '');
L.push('### YOUR TEAM + ESCALATION PATHS (academy/team/directory.js; live humans and ownership are filled at run time)', '', '```text', directoryBlock('amanda', {}), '```', '');
L.push('### WHAT YOU CAN ACTUALLY DO (academy/team/capabilities.js)', '', '```text', capabilityBlock('amanda'), '```', '');
L.push('### COMMITMENTS', '', '```text', COMMITMENT_RULE, '```', '');
L.push('**Why (v1.2):** v1.1 invented escalation targets ("our risk team", "our VP of operations and our E&O carrier", "leadership"), promised to bind coverage without authority, promised phone calls and a site visit ("I will go to the pool today to check the latch myself"), and made untracked same-day promises. Cases: AA-REL-006, AA-REL-009, AA-REL-010, AA-REG-004, AA-TEC-004.', '');
L.push('## Added per-message blocks', '');
L.push('### FORMAT FOR THIS CHANNEL (replaces the universal "greeting through sign-off")', '');
for (const ch of ['email', 'chat', 'phone']) L.push(`- **${ch}:** ${channelFormat(ch).replace(/^FORMAT FOR THIS CHANNEL \([^)]*\): /, '')}`);
L.push('', '### WHAT THIS MESSAGE IS + HOW TO SHAPE THE REPLY (from the intent classifier)', '');
for (const [m, s] of Object.entries(SHAPES)) L.push(`- **${m}:** ${s}`);
L.push('', 'Decision format (options, tradeoffs, recommendation) appears ONLY under decision_support.', '');
L.push('## Not changed (deliberately)', '');
L.push('- HARD RULES (no fine waivers, ACC decisions, 209 determinations, legal positions): unchanged.');
L.push('- Board disclosure rules, vendor non-disclosure rules, NO_OVERPROMISE_RULE, and the rest of CONTACT_ROUTING_RULE (no direct staff contact details, no invented phone numbers, 911 in emergencies): unchanged.');
L.push('- FINANCE_PRIMER: unchanged in this diff. Inventory finding: it is ~5k chars loaded on every non-vendor message (even a tree status chat); gating it to finance intents is a follow-up candidate, not part of v1.2.');
L.push('- The warm voice ("warm, plain, specific", "take ownership"): kept. Friendliness is allowed, not mandated.');
process.stdout.write(L.join('\n') + '\n');
