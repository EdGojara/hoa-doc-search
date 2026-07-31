// tests/test_line_history_tokens.js — the tokenizer behind Emma's line-item
// learning (gl_classifier matchByLineHistory). Two lines are "the same kind" by
// their DISTINCTIVE words, not the billing boilerplate — so "Monthly Water
// Management Fee" matches a prior "Water Management" but not "Monthly Service
// Charge". Pure function; the fire/one-off-guard behavior is verified against
// live data. Run: node tests/test_line_history_tokens.js
const assert = require('assert');
try { require('dotenv').config(); } catch (_) { /* env may be set already */ }
// gl_classifier builds a Supabase client on load; lineToks itself needs no DB.
if (!process.env.SUPABASE_URL) process.env.SUPABASE_URL = 'http://localhost:54321';
if (!process.env.SUPABASE_KEY) process.env.SUPABASE_KEY = 'test-key';
const { lineToks } = require('../lib/accounting/gl_classifier');

const sim = (a, b) => { const A = lineToks(a), B = lineToks(b); if (!A.size || !B.size) return 0; let i = 0; for (const w of A) if (B.has(w)) i++; return i / Math.max(A.size, B.size); };
let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  -', name); } catch (e) { console.error('  FAIL -', name, '\n      ', e.message); process.exitCode = 1; } };

console.log('line-history tokenizer:');

t('drops billing boilerplate, keeps distinctive words', () => {
  const toks = lineToks('Monthly Water Management Fee - August 2026');
  assert.ok(toks.has('water') && toks.has('management'));
  assert.ok(!toks.has('monthly') && !toks.has('fee'));   // boilerplate dropped
});

t('same kind of line = high similarity', () => {
  assert.ok(sim('Monthly Water Management Fee - August 2026', 'Water Management - Sept') >= 0.6);
});

t('different kinds from same vendor = low similarity (usual vs different)', () => {
  assert.ok(sim('Monthly Water Management Fee', 'Irrigation Repair - broken valve') < 0.6);
});

t('boilerplate-only lines share nothing distinctive', () => {
  assert.ok(sim('Monthly Service Charge', 'Current Charges Due') < 0.6);
});

t('empty / junk description -> empty token set', () => {
  assert.strictEqual(lineToks('').size, 0);
  assert.strictEqual(lineToks('- / 2026').size, 0);
});

console.log(`\n${pass} passed`);
