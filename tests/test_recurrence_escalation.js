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

// ---- the prior case must have had a certified §209 notice actually mailed (Ed 2026-10-23) ----
const { detectRecurrence, certifiedNoticeGiven } = require('../lib/enforcement/find_or_continue_violation');
const recentIso = (n) => new Date(Date.now() - n * 864e5).toISOString();
function db({ priors, pieces, piecesError = null }) {
  return { from(table) {
    const q = { _in: null, select() { return q; }, eq() { return q; }, not() { return q; }, gte() { return q; }, order() { return q; }, limit() { return q; },
      in(col, vals) { if (col === 'violation_id') q._in = vals; return q; },
      then(res, rej) {
        let out;
        if (table === 'enforcement_categories') out = { data: [{ recurrence_escalates: true }], error: null };
        else if (table === 'violations') out = { data: priors, error: null };
        else if (table === 'letter_mail_pieces') out = piecesError ? { data: null, error: { message: piecesError } } : { data: pieces.filter((p) => !q._in || q._in.includes(p.violation_id)), error: null };
        else out = { data: [], error: null };
        return Promise.resolve(out).then(res, rej);
      } };
    return q;
  } };
}
(async () => {
  const at = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };
  await at('certifiedNoticeGiven: only a certified §209 letter mailed by certified mail counts', () => {
    assert.strictEqual(certifiedNoticeGiven([{ stage_at_send: 'certified_209', delivery_method: 'certified_mail', status: 'submitted', mailed_at: recentIso(40) }]), true);
    assert.strictEqual(certifiedNoticeGiven([{ stage_at_send: 'certified_209', delivery_method: 'first_class', status: 'submitted', mailed_at: recentIso(40) }]), false, 'a first-class letter is not the statutory notice');
    assert.strictEqual(certifiedNoticeGiven([{ stage_at_send: 'courtesy_1', delivery_method: 'first_class', status: 'delivered', delivered_at: recentIso(40) }]), false);
    assert.strictEqual(certifiedNoticeGiven([{ stage_at_send: 'certified_209', delivery_method: 'certified_mail', status: 'submitted', mailed_at: null }]), false, 'printed but never mailed');
    assert.strictEqual(certifiedNoticeGiven([{ stage_at_send: 'certified_209', delivery_method: 'certified_mail', status: 'cancelled', mailed_at: recentIso(40) }]), false);
    assert.strictEqual(certifiedNoticeGiven([]), false);
  });
  await at('5326 Still Meadow pattern: prior is a Vantaca import closed the same day with no letter -> NOT a recurrence (first notice)', async () => {
    const r = await detectRecurrence({ propertyId: 'p', categoryId: 'c' }, { db: db({ priors: [{ id: 'vantaca', current_stage: 'cured', resolved_at: recentIso(156) }], pieces: [] }) });
    assert.strictEqual(r, null);
  });
  await at('7919 Caribou Valley pattern: prior case recorded certified but only a first-class courtesy letter went out -> NOT a recurrence', async () => {
    const r = await detectRecurrence({ propertyId: 'p', categoryId: 'c' }, { db: db({ priors: [{ id: 'aug', current_stage: 'cured', resolved_at: recentIso(31) }], pieces: [{ violation_id: 'aug', stage_at_send: 'certified_209', delivery_method: 'first_class', status: 'submitted', mailed_at: recentIso(66) }] }) });
    assert.strictEqual(r, null);
  });
  await at('a prior case that WAS given a certified §209 notice by certified mail -> recurrence (certified is legitimate)', async () => {
    const r = await detectRecurrence({ propertyId: 'p', categoryId: 'c' }, { db: db({ priors: [{ id: 'nocert', current_stage: 'cured', resolved_at: recentIso(10) }, { id: 'cert', current_stage: 'cured', resolved_at: recentIso(60) }], pieces: [{ violation_id: 'cert', stage_at_send: 'certified_209', delivery_method: 'certified_mail', status: 'delivered', delivered_at: recentIso(80) }] }) });
    assert.ok(r && r.is_repeat === true && r.prior_violation_id === 'cert', JSON.stringify(r));
  });
  await at('a failed notice lookup never escalates (fail safe)', async () => {
    const r = await detectRecurrence({ propertyId: 'p', categoryId: 'c' }, { db: db({ priors: [{ id: 'x', current_stage: 'cured', resolved_at: recentIso(10) }], pieces: [], piecesError: 'timeout' }) });
    assert.strictEqual(r, null);
  });
  console.log(`\nrecurrence_escalation: ${passed} passed`);
})().catch((e) => { console.error('  ✗', e.message); process.exit(1); });
