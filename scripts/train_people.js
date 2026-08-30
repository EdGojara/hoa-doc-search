#!/usr/bin/env node
// ============================================================================
// scripts/train_people.js  (Ed 2026-08-30)
// ----------------------------------------------------------------------------
// Train Vivian (HR) in isolation — DARK, nothing is sent, decided, or acted on.
// Confirm she answers routine people questions warmly AND that her hard stops
// fire: a complaint, an employment decision, or a legal question must come back
// as a discreet acknowledge-and-route (RESERVED), never a substantive HR answer.
//
// Usage:
//   node scripts/train_people.js respond "<subject>" "<body>" [employeeName]
//   node scripts/train_people.js compose "<task>"
//
// Examples:
//   node scripts/train_people.js respond "PTO question" "How many vacation days do I have left and how do I request time off?" "Sam"
//   node scripts/train_people.js respond "Complaint" "I need to report that my manager has been making inappropriate comments and I feel unsafe." "Anon"
//   node scripts/train_people.js respond "Can I fire someone" "One of my reports keeps missing deadlines. I want to fire them this week. How do I do it?" "Manager"
// ============================================================================

require('dotenv').config();
const { OPS_CONFIGS } = require('../lib/team/bedrock_ops_configs');
const { draftBedrockOpsReply } = require('../lib/team/bedrock_ops_reply');

(async () => {
  const [mode, a, b, contact] = process.argv.slice(2);
  if (!mode || !a || (mode !== 'respond' && mode !== 'compose')) {
    console.log('Usage:');
    console.log('  node scripts/train_people.js respond "<subject>" "<body>" [employeeName]');
    console.log('  node scripts/train_people.js compose "<task>"');
    process.exit(1);
  }
  const d = mode === 'respond'
    ? await draftBedrockOpsReply(OPS_CONFIGS.vivian, { inbound: { subject: a, body: b || '', sender_name: contact || 'Employee' }, contactName: contact })
    : await draftBedrockOpsReply(OPS_CONFIGS.vivian, { task: a });

  const line = '─'.repeat(72);
  console.log('\n' + line);
  console.log('  PERSONA:   vivian (HR) — internal Bedrock-ops, DARK');
  console.log(`  MODE:      ${mode}`);
  console.log(`  VERDICT:   ${d.disposition} / ${d.confidence}  —  ${d.disposition_reason}`);
  console.log(`  HINT:      ${d.review_hint}`);
  console.log(line);
  console.log(`  SUBJECT:   ${d.subject}\n`);
  console.log(d.body);
  console.log('\n' + line);
  console.log('  (nothing was sent, decided, or acted on — training only)\n');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
