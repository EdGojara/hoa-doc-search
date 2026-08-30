#!/usr/bin/env node
// ============================================================================
// scripts/train_growth.js  (Ed 2026-08-30)
// ----------------------------------------------------------------------------
// Train Maggie (Growth) in isolation, the same way train_persona.js trains the
// community team. Feed her a prospect message to respond to, or a task to
// compose, and read exactly what she would draft — DARK, nothing is sent or
// published. Use it to tune her voice and confirm she stays on the rails
// (approved claims only, no over-promise, pre-sale) before she is ever wired up.
//
// Usage:
//   node scripts/train_growth.js respond "<subject>" "<body>" [prospectName]
//   node scripts/train_growth.js compose "<task>" ["<what we know about them>"]
//
// Examples:
//   node scripts/train_growth.js respond "Interested in a demo" "We're a 300-home HOA in Katy unhappy with our manager. What do you do differently?" "Board President"
//   node scripts/train_growth.js compose "Warm intro email to the board of a 250-home community in Sugar Land that just posted about manager frustrations" "Self-managed, volunteer board, frustrated with slow responses"
// ============================================================================

require('dotenv').config();
const { OPS_CONFIGS } = require('../lib/team/bedrock_ops_configs');
const { draftGrowthReply } = require('../lib/team/growth_reply');

(async () => {
  const [mode, a, b, contact] = process.argv.slice(2);
  if (!mode || !a || (mode !== 'respond' && mode !== 'compose')) {
    console.log('Usage:');
    console.log('  node scripts/train_growth.js respond "<subject>" "<body>" [prospectName]');
    console.log('  node scripts/train_growth.js compose "<task>" ["<what we know>"]');
    process.exit(1);
  }
  const d = mode === 'respond'
    ? await draftGrowthReply(OPS_CONFIGS.maggie, { inbound: { subject: a, body: b || '', sender_name: contact || 'Prospect' }, contactName: contact })
    : await draftGrowthReply(OPS_CONFIGS.maggie, { task: a, communityHint: b || null });

  const line = '─'.repeat(72);
  console.log('\n' + line);
  console.log('  PERSONA:   maggie (Growth) — internal Bedrock-ops, DARK');
  console.log(`  MODE:      ${mode}`);
  console.log(`  VERDICT:   ${d.disposition} / ${d.confidence}  —  ${d.disposition_reason}`);
  console.log(`  HINT:      ${d.review_hint}`);
  console.log(line);
  console.log(`  SUBJECT:   ${d.subject}\n`);
  console.log(d.body);
  console.log('\n' + line);
  console.log('  (nothing was sent or published — training only)\n');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
