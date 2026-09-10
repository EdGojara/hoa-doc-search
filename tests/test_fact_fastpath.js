// tests/test_fact_fastpath.js — Claire fast-lane detector (Ed 2026-09-10)
// Locks the gate: operational-fact questions take the fast lane (skip doc
// retrieval); anything governing-doc / compliance / "can I build X" MUST NOT.
const assert = require('assert');
const { isCommonFactQuestion } = require('../lib/voice/fact_fastpath');

// Questions that SHOULD take the fast lane (structured profile facts).
const FAST = [
  'what day is trash pickup',
  'when is trash day',
  'what day does recycling get picked up',
  'when does the pool close',
  'what are the pool hours',
  'what time does the clubhouse open',
  'what are the office hours',
  'how do I contact management',
  'who do I call about my account',
  "what's the management phone number",
  'how much are my assessments',
  'when are my dues due',
  'how do I pay my assessment',
  'when is the annual meeting',
  'when is the next board meeting',
];

// Questions that MUST stay in full retrieval (governing-doc / compliance).
// The tree-count and "can I build X" cases are the hard-won correctness ones.
const FULL = [
  'can I build a pergola in my backyard',
  'how many trees does my corner lot need',
  'am I allowed to paint my front door red',
  'what are the rules about parking my RV',
  'can I install a fence',
  'is my dog breed allowed here',
  'how do I dispute a violation',
  "what's the fine for tall grass",
  'can I rent out my house',
  'do I need approval for a storage shed',
  'what does the declaration say about roof color',
  'can I remove a tree in my front yard',
  'may I put up a satellite dish',
];

let pass = 0; const fails = [];
for (const q of FAST) {
  try { assert.strictEqual(isCommonFactQuestion(q), true, q); pass++; }
  catch (e) { fails.push(`FAST expected true : "${q}"`); }
}
for (const q of FULL) {
  try { assert.strictEqual(isCommonFactQuestion(q), false, q); pass++; }
  catch (e) { fails.push(`FULL expected false: "${q}"`); }
}
// Edge: empty / ack-length / overlong all stay in the safe (non-fast) default.
for (const q of ['', 'ok', 'yes', 'a'.repeat(250)]) {
  try { assert.strictEqual(isCommonFactQuestion(q), false, q); pass++; }
  catch (e) { fails.push(`EDGE expected false: "${String(q).slice(0, 30)}"`); }
}

if (fails.length) {
  console.error(`fact_fastpath: ${fails.length} FAILURES (${pass} passed):`);
  fails.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log(`fact_fastpath: all ${pass} cases passed`);
