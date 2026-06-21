// ============================================================================
// lib/banking/clearing_worksheet.js — traditional clearing-register worksheet
// ----------------------------------------------------------------------------
// Builds the two-column (GL | Bank) reconciliation worksheet. Every GL cash
// line and bank line is shown; the system PRE-POPULATES matches and the
// operator confirms (Accept) or disputes (Reopen) — so the matching only has to
// be reasonable, not perfect. Matched groups stay visible but cleared; uncleared
// GL lines are the open items (deposits in transit / outstanding checks) that
// carry forward. Bank lines not in the GL are the only real exceptions.
//
// Reconciles GL <-> Bank only (the deposit/check registers are not involved):
//   bank ending + open deposits in transit − open outstanding checks = GL balance
//
//   buildWorksheet({ periodEnd, glItems, bankItems, overrides,
//                    bankEndingCents, glBalanceCents }) -> worksheet
//
// glItems/bankItems: { id, date, amount_cents (signed: deposit +, payment −),
//   description, check_number }. overrides: keyed 'gl:<id>' / 'bank:<id>' ->
//   { status:'cleared'|'open', match_group }.
// ============================================================================

const MATCH_DATE_WINDOW_DAYS = 14;   // a GL item clears the bank within ~2 weeks
const GROUP_DATE_WINDOW_DAYS = 21;   // batched payout/check lag
const TOLERANCE_CENTS = 2;
const MAX_GROUP = 12;                // cap constituents per batch
const MAX_SUBSET_NODES = 200000;     // exploration cap — give up gracefully past this

function days(a, b) {
  const da = new Date(a + 'T12:00:00Z').getTime();
  const db = new Date(b + 'T12:00:00Z').getTime();
  return (db - da) / 86400000;
}
function normCheck(s) { const d = String(s || '').replace(/\D/g, ''); return d || null; }

// Smallest subset of pool (by abs amount) summing to target within tolerance.
// Sorted descending with suffix-sum pruning and a hard node cap so a large pool
// can't hang the worksheet (the operator confirms matches, so "good enough"
// pre-population beats an exhaustive search).
function subsetSum(pool, target) {
  const cand = pool.slice().sort((a, b) => Math.abs(b.amount_cents) - Math.abs(a.amount_cents));
  const n = cand.length;
  const amt = cand.map((c) => Math.abs(c.amount_cents));
  const suffix = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + amt[i];
  let nodes = 0, found = null;
  function search(start, remaining, sum, picked) {
    if (found || ++nodes > MAX_SUBSET_NODES) return;
    if (remaining === 0) { if (Math.abs(sum - target) <= TOLERANCE_CENTS) found = picked.slice(); return; }
    for (let i = start; i + remaining <= n && !found; i++) {
      const next = sum + amt[i];
      if (next - target > TOLERANCE_CENTS) continue;                 // overshoot; smaller items later
      if (next + (suffix[i + 1] - suffix[i + remaining]) + TOLERANCE_CENTS < target) break; // can't reach
      search(i + 1, remaining - 1, next, picked.concat(cand[i]));
    }
  }
  for (let k = 2; k <= Math.min(MAX_GROUP, n) && !found; k++) { nodes = 0; search(0, k, 0, []); }
  return found;
}

function buildWorksheet({ periodEnd, glItems = [], bankItems = [], overrides = {}, bankEndingCents = 0, glBalanceCents = 0 }) {
  const gl = glItems.map((g) => ({ ...g, _key: 'gl:' + g.id, _matched: false, _group: null }));
  const bank = bankItems.map((b) => ({ ...b, _key: 'bank:' + b.id, _matched: false, _group: null }));
  let groupSeq = 0;
  const groupConf = {};                 // match_group -> 'high' | 'medium' | 'low'
  const newGroup = (conf) => { const g = 'm' + (++groupSeq); groupConf[g] = conf; return g; };

  // --- PRE-POPULATE -------------------------------------------------------
  // Pass 1: exact check-number match (bank check ↔ GL line[s] with that check#). HIGH.
  for (const bt of bank) {
    if (bt._matched) continue;
    const cn = normCheck(bt.check_number);
    if (!cn) continue;
    const hits = gl.filter((g) => !g._matched && normCheck(g.check_number) === cn);
    if (hits.length) { const grp = newGroup('high'); bt._matched = true; bt._group = grp; hits.forEach((g) => { g._matched = true; g._group = grp; }); }
  }
  // Pass 2: 1:1 same signed amount within the window (unambiguous only). HIGH.
  for (const bt of bank) {
    if (bt._matched) continue;
    const cands = gl.filter((g) => !g._matched && Math.abs(g.amount_cents - bt.amount_cents) <= TOLERANCE_CENTS && Math.abs(days(g.date, bt.date)) <= MATCH_DATE_WINDOW_DAYS);
    if (cands.length === 1) { const grp = newGroup('high'); bt._matched = true; bt._group = grp; cands[0]._matched = true; cands[0]._group = grp; }
  }
  // Pass 3: one bank line ↔ several GL lines summing to it (payout / check / lockbox batch). MEDIUM.
  for (const bt of bank) {
    if (bt._matched) continue;
    const sameSign = bt.amount_cents >= 0;
    const pool = gl.filter((g) => !g._matched && (g.amount_cents >= 0) === sameSign
      && days(g.date, bt.date) >= -GROUP_DATE_WINDOW_DAYS && days(g.date, bt.date) <= GROUP_DATE_WINDOW_DAYS);
    if (pool.length < 2) continue;
    const subset = subsetSum(pool, Math.abs(bt.amount_cents));
    if (subset && subset.length) { const grp = newGroup('medium'); bt._matched = true; bt._group = grp; subset.forEach((g) => { g._matched = true; g._group = grp; }); }
  }
  // Pass 4: ambiguous 1:1 — same amount repeats (e.g. many $260 dues / payouts). Take
  // the closest-date GL line of equal amount. LOW — the operator confirms via Accept.
  for (const bt of bank) {
    if (bt._matched) continue;
    const cands = gl.filter((g) => !g._matched && Math.abs(g.amount_cents - bt.amount_cents) <= TOLERANCE_CENTS
      && days(g.date, bt.date) >= -GROUP_DATE_WINDOW_DAYS && days(g.date, bt.date) <= GROUP_DATE_WINDOW_DAYS);
    if (!cands.length) continue;
    cands.sort((a, b) => Math.abs(days(a.date, bt.date)) - Math.abs(days(b.date, bt.date)));
    const grp = newGroup('low'); bt._matched = true; bt._group = grp; cands[0]._matched = true; cands[0]._group = grp;
  }

  // --- APPLY OPERATOR OVERRIDES ------------------------------------------
  // Reopen forces an item open (drops it from its group). Accept/cleared is the
  // default for matched items; a manual match_group override pins a grouping.
  const statusOf = (item) => {
    const o = overrides[item._key];
    if (o && o.status === 'open') return 'open';
    if (o && o.status === 'cleared') return 'cleared';
    return item._matched ? 'cleared' : 'open';
  };

  // --- ASSEMBLE ROWS ------------------------------------------------------
  const groups = {};
  for (const it of [...bank, ...gl]) {
    if (!it._group) continue;
    (groups[it._group] = groups[it._group] || { match_group: it._group, bank: [], gl: [] });
    const slim = { id: it.id, date: it.date, amount_cents: it.amount_cents, description: it.description || '', check_number: it.check_number || null, status: statusOf(it) };
    (it._key.startsWith('bank:') ? groups[it._group].bank : groups[it._group].gl).push(slim);
  }
  const matchedRows = Object.values(groups).map((grp) => {
    const allCleared = [...grp.bank, ...grp.gl].every((x) => x.status === 'cleared');
    const confidence = groupConf[grp.match_group] || 'medium';
    // "confirmed" = a sure match (exact check# / unambiguous) or one the operator
    // explicitly Accepted. Anything else is a pre-populated guess to review.
    const accepted = [...grp.bank.map((x) => 'bank:' + x.id), ...grp.gl.map((x) => 'gl:' + x.id)]
      .some((k) => overrides[k] && overrides[k].status === 'cleared');
    return { ...grp, status: allCleared ? 'cleared' : 'open', confidence, confirmed: confidence === 'high' || accepted };
  });

  const openGl = gl.filter((g) => !g._group && statusOf(g) === 'open').map((g) => ({
    id: g.id, date: g.date, amount_cents: g.amount_cents, description: g.description || '', check_number: g.check_number || null,
    kind: g.amount_cents >= 0 ? 'deposit_in_transit' : 'outstanding_check',
  }));
  const openBank = bank.filter((b) => !b._group && statusOf(b) === 'open').map((b) => ({
    id: b.id, date: b.date, amount_cents: b.amount_cents, description: b.description || '', check_number: b.check_number || null,
    kind: 'unrecorded',  // on the bank, not in the GL — the only true exception
  }));

  // --- TIE-OUT ------------------------------------------------------------
  const ditCents = openGl.filter((g) => g.kind === 'deposit_in_transit').reduce((a, g) => a + g.amount_cents, 0);
  const ocCents = openGl.filter((g) => g.kind === 'outstanding_check').reduce((a, g) => a + g.amount_cents, 0); // negative
  const reconciledBalance = bankEndingCents + ditCents + ocCents;
  const difference = reconciledBalance - glBalanceCents;

  return {
    period_end: periodEnd,
    bank_ending_cents: bankEndingCents,
    gl_balance_cents: glBalanceCents,
    matched: matchedRows,
    open_deposits_in_transit: openGl.filter((g) => g.kind === 'deposit_in_transit'),
    open_outstanding_checks: openGl.filter((g) => g.kind === 'outstanding_check'),
    open_bank_unrecorded: openBank,
    deposits_in_transit_cents: ditCents,
    outstanding_checks_cents: ocCents,
    reconciled_balance_cents: reconciledBalance,
    difference_cents: difference,
    reconciled: Math.abs(difference) <= 100,
  };
}

module.exports = { buildWorksheet };
