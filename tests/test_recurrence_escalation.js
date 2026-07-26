// Tests for the §209.006(d) 6-month recurrence decision (movable violations).
try { require('dotenv').config(); } catch (_) {} // module load builds a Supabase client
const assert = require('assert');
const { isRecurrence, RECURRENCE_LOOKBACK_DAYS } = require('../lib/enforcement/find_or_continue_violation');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓', name); };
const NOW = Date.parse('2026-07-25T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 864e5).toISOString();

console.log('recurrence_escalation:');

t('lookback window is the statutory 6 months (~183 days)', () => {
  assert.ok(RECURRENCE_LOOKBACK_DAYS >= 180 && RECURRENCE_LOOKBACK_DAYS <= 184);
});

t('movable violation cured 30 days ago -> recurrence', () => {
  assert.strictEqual(isRecurrence({ escalates: true, priorResolvedAt: daysAgo(30), nowMs: NOW }), true);
});

t('movable violation cured just inside 6 months -> recurrence', () => {
  assert.strictEqual(isRecurrence({ escalates: true, priorResolvedAt: daysAgo(180), nowMs: NOW }), true);
});

t('movable violation cured 200 days ago (>6mo) -> fresh, not recurrence', () => {
  assert.strictEqual(isRecurrence({ escalates: true, priorResolvedAt: daysAgo(200), nowMs: NOW }), false);
});

t('natural-cadence category (not flagged) never escalates, even 1 day ago', () => {
  // grass/trash: escalates=false -> always a fresh courtesy
  assert.strictEqual(isRecurrence({ escalates: false, priorResolvedAt: daysAgo(1), nowMs: NOW }), false);
});

t('no prior cured case -> not a recurrence', () => {
  assert.strictEqual(isRecurrence({ escalates: true, priorResolvedAt: null, nowMs: NOW }), false);
});

t('garbage / future prior date -> safe (not a recurrence)', () => {
  assert.strictEqual(isRecurrence({ escalates: true, priorResolvedAt: 'not-a-date', nowMs: NOW }), false);
  assert.strictEqual(isRecurrence({ escalates: true, priorResolvedAt: daysAgo(-5), nowMs: NOW }), false);
});

console.log(`\nrecurrence_escalation: ${passed} passed`);
