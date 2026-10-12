// ============================================================================
// lib/banking/monthly_rec.js  (Ed 2026-10-11) — Kat's monthly bank reconciliation
// ----------------------------------------------------------------------------
// One engine for reconciling one bank account for one month against the live
// trustEd GL. Kat's run (lib/accounting/monthly_runs.js, process
// 'bank_reconciliation') prepares with it, Ed approves or holds, and the
// approved result is stored in bank_reconciliations / bank_reconciliation_items
// (migration 169), the same tables the Bank Rec screens read.
//
// Inputs come from trustEd only: the imported bank statements
// (bank_statement_imports / _transactions), the counted GL lines on the
// account's cash GL account (je_status.countsInGl), and the account's 7/31
// opening reconciled position (bank_accounts.opening_position, migration 241 +
// 511): the outstanding checks and deposits in transit at the GL cutover.
//
// reconcileAccountMonth() is PURE (no I/O) so the test suite can pin it.
//   1. statements: the month's statement must exist, chain from the prior one,
//      and tie (beginning + transactions = ending); otherwise the run is blocked.
//   2. opening position: book at cutover = bank + in transit - outstanding.
//   3. matching: opening items first (oldest), then GL lines by date: check
//      number + amount, else the nearest-date exact amount within the window.
//      A void and its reversal that both fall in the period are internal.
//   4. check-number variances (same check, different amount) are carried as a
//      manual adjustment and an open exception: someone determines whether the
//      bank or the books are wrong. Nothing is booked.
//   5. bank lines not in the GL are classified. Only two kinds get a proposed
//      entry, each with its evidence: bank service charges (to the configured
//      fee account) and returned deposits matched to exactly one homeowner's
//      payments of the same total (receivable restored on the homeowner
//      ledger). Everything else is an exception for a person: unrecorded
//      processor receipts, card purchases needing receipts (with a possible-
//      duplicate flag), transfers, interest with no account configured, and
//      anything unexplained. No classification, vendor or explanation is
//      invented.
//   6. outstanding checks older than stale_check_days and deposits in transit
//      older than stale_deposit_days are exceptions.
//   7. adjusted bank = ending + deposits in transit - outstanding checks
//      - bank-side adjustments; adjusted book = GL + bank items not yet in the
//      GL. status: blocked / unbalanced / in_progress (difference 0 but open
//      exceptions) / reconciled (difference 0 and nothing open).
// ============================================================================

const { countsInGl } = require('../accounting/je_status');

const day = (d) => String(d || '').slice(0, 10);
const days = (a, b) => Math.abs(new Date(day(a)) - new Date(day(b))) / 864e5;
const money = (c) => { const v = Math.abs(Number(c || 0)) / 100; const s = v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return Number(c) < 0 ? `(${s})` : s; };
const addDays = (d, n) => { const x = new Date(`${day(d)}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const normChk = (s) => String(s || '').replace(/[^0-9]/g, '').replace(/^0+/, '');
const CHECK_RE = /(?:chk|check)\s*#?\s*(\d{1,6})/i;

const DEFAULTS = { stale_check_days: 90, stale_deposit_days: 10, match_window_days: 45, duplicate_window_days: 3 };

// What a bank line not in the GL looks like. Order matters (a returned item
// "CHARGEBACK FEE" is a fee; "RETURNED DEPOSIT ITEMS" is a returned payment).
function classifyBankLine(t) {
  const d = String(t.description || ''); const amt = Number(t.amount_cents); const type = String(t.transaction_type || '');
  if (amt < 0 && (/\bFEE\b|SERVICE CHARGE|MAINTENANCE CHARGE/i.test(d) || type === 'fee')) return 'bank_fee';
  if (amt < 0 && (/RETURNED (DEPOSIT|ITEM|CHECK)|RETURN ITEM|\bNSF\b|CHARGEBACK/i.test(d) || type === 'nsf')) return 'returned_payment';
  if (amt > 0 && (/INTEREST/i.test(d) || type === 'interest')) return 'interest';
  if (/TRANSFER/i.test(d) || type === 'transfer') return 'transfer';
  if (amt > 0 && /PAYOUT|VANTACA|STRIPE|MERCHANT|SETTLEMENT|DEPOSIT/i.test(d)) return 'unrecorded_receipt';
  if (amt < 0 && /AMAZON|AMZN|POS PURCHASE|DEBIT CARD|PURCHASE TERMINAL|CARD PURCHASE/i.test(d)) return 'card_purchase';
  return 'unexplained';
}

function checkNumberOf(g) { return normChk(g.check_number) || normChk((`${g.memo || ''} ${g.description || ''}`.match(CHECK_RE) || [])[1]); }

// ---------------------------------------------------------------------------
// PURE: reconcile one account for one month.
// input: { account:{id,label,gl_account_number}, period_start, period_end,
//          opening, statements:[{id,statement_period_start,statement_period_end,beginning_balance_cents,ending_balance_cents}],
//          bankTxns:[{id,bank_statement_import_id,posting_date,amount_cents,description,check_number,transaction_type}],
//          glLines:[{id,je_id,reference,posting_date,amount_cents,memo,description,source_module,reverses_je_id}],
//          otherBankTxns:[{account_label,posting_date,amount_cents,description}],
//          homeownerPayments:[{id,property_id,vantaca_account_id,transaction_date,amount_cents,description,address}],
//          settings }
// ---------------------------------------------------------------------------
function reconcileAccountMonth(input) {
  const S = { ...DEFAULTS, ...(input.settings || {}) };
  const { account, period_start, period_end } = input;
  const op = input.opening || null;
  const exceptions = []; const proposals = [];
  const exc = (e) => { exceptions.push({ severity: 'open', ...e }); return e; };
  const label = account.label || account.id;
  const priorEnd = addDays(period_start, -1);

  if (!op || !op.as_of_date) {
    exc({ code: 'opening_position_missing', severity: 'blocking', text: `${label} has no opening reconciled position (bank_accounts.opening_position), so the cutover items cannot be carried.` });
    return finish({ input, S, exceptions, proposals, status: 'blocked' });
  }
  const asOf = day(op.as_of_date);

  // 1. statements -----------------------------------------------------------
  const stmts = (input.statements || []).filter((s) => day(s.statement_period_end) > asOf && day(s.statement_period_end) <= period_end)
    .sort((a, b) => day(a.statement_period_end).localeCompare(day(b.statement_period_end)));
  const stmt = stmts.filter((s) => day(s.statement_period_end) >= period_start).pop() || null;
  if (!stmt) {
    exc({ code: 'statement_missing', severity: 'blocking', text: `No ${label} bank statement ending in ${period_start.slice(0, 7)} has been imported.` });
    return finish({ input, S, exceptions, proposals, status: 'blocked' });
  }
  let prevEnding = op.bank_balance_cents != null ? Number(op.bank_balance_cents) : null;
  for (const s of stmts) {
    const lines = (input.bankTxns || []).filter((t) => t.bank_statement_import_id === s.id);
    const sum = lines.reduce((t, x) => t + Number(x.amount_cents), 0);
    if (prevEnding != null && Number(s.beginning_balance_cents) !== prevEnding) exc({ code: 'statement_gap', severity: 'blocking', statement_id: s.id, text: `The ${day(s.statement_period_end)} statement begins at ${money(s.beginning_balance_cents)} but the prior balance was ${money(prevEnding)}: a statement or transactions are missing.` });
    if (Number(s.beginning_balance_cents) + sum !== Number(s.ending_balance_cents)) exc({ code: 'statement_incomplete', severity: 'blocking', statement_id: s.id, text: `The ${day(s.statement_period_end)} statement does not tie: beginning ${money(s.beginning_balance_cents)} + ${lines.length} transactions ${money(sum)} is not the ending ${money(s.ending_balance_cents)}. The import is incomplete.` });
    prevEnding = Number(s.ending_balance_cents);
  }
  const stmtIds = new Set(stmts.map((s) => s.id));
  const bank = (input.bankTxns || []).filter((t) => stmtIds.has(t.bank_statement_import_id) && day(t.posting_date) <= period_end)
    .map((t) => ({ ...t, posting_date: day(t.posting_date), amount_cents: Number(t.amount_cents), used: null }))
    .sort((a, b) => a.posting_date.localeCompare(b.posting_date) || String(a.id).localeCompare(String(b.id)));

  // 2. GL + opening tie --------------------------------------------------------
  const gl = (input.glLines || []).filter((l) => day(l.posting_date) <= period_end).map((l) => ({ ...l, posting_date: day(l.posting_date), amount_cents: Number(l.amount_cents) }));
  const glBalance = gl.reduce((t, l) => t + l.amount_cents, 0);
  const openingRefs = new Set(op.opening_book_refs || []);
  const bookAtCutover = gl.filter((l) => l.posting_date <= asOf || openingRefs.has(l.reference)).reduce((t, l) => t + l.amount_cents, 0);
  const oc0 = (op.outstanding_checks || []).reduce((t, c) => t + Math.abs(Number(c.amount_cents)), 0);
  const dit0 = (op.deposits_in_transit || []).reduce((t, d) => t + Math.abs(Number(d.amount_cents)), 0);
  if (op.bank_balance_cents != null && bookAtCutover !== Number(op.bank_balance_cents) + dit0 - oc0) {
    exc({ code: 'opening_does_not_tie', severity: 'blocking', text: `Opening position does not tie at ${asOf}: book ${money(bookAtCutover)} vs bank ${money(op.bank_balance_cents)} + in transit ${money(dit0)} - outstanding ${money(oc0)}.` });
  }

  // candidates: operational GL lines after the cutover, minus internal pairs
  const ops = gl.filter((l) => l.posting_date > asOf && !openingRefs.has(l.reference) && l.source_module !== 'opening_entry' && l.amount_cents !== 0);
  const byJe = new Map(ops.map((l) => [l.je_id, l]));
  const internal = new Set();
  for (const l of ops) {
    const o = l.reverses_je_id && byJe.get(l.reverses_je_id);
    if (o && o.amount_cents === -l.amount_cents) { internal.add(l.je_id); internal.add(o.je_id); }
  }
  const cands = ops.filter((l) => !internal.has(l.je_id)).sort((a, b) => a.posting_date.localeCompare(b.posting_date) || String(a.id).localeCompare(String(b.id)))
    .map((l) => ({ ...l, chk: checkNumberOf(l), cleared: null, bank_id: null }));

  // 3. matching ----------------------------------------------------------------
  const take = (t, by) => { t.used = by; return t; };
  const nearest = (pool, date) => pool.sort((a, b) => days(a.posting_date, date) - days(b.posting_date, date) || a.posting_date.localeCompare(b.posting_date))[0];
  const openingItems = [
    ...(op.outstanding_checks || []).map((c) => ({ kind: 'outstanding_check', amount_cents: -Math.abs(Number(c.amount_cents)), date: day(c.issue_date || asOf), chk: normChk(c.check_number), description: `Check ${c.check_number || ''} ${c.payee || ''}`.trim() })),
    ...(op.deposits_in_transit || []).map((d) => ({ kind: 'deposit_in_transit', amount_cents: Math.abs(Number(d.amount_cents)), date: day(d.date || asOf), chk: '', description: d.description || 'Deposit in transit' })),
  ].sort((a, b) => a.date.localeCompare(b.date)).map((o) => ({ ...o, cleared: null, bank_id: null }));
  for (const o of openingItems) {
    let m = o.chk ? bank.find((t) => !t.used && t.amount_cents === o.amount_cents && normChk(t.check_number) === o.chk) : null;
    if (!m) m = nearest(bank.filter((t) => !t.used && t.amount_cents === o.amount_cents && (!o.chk || !normChk(t.check_number)) && t.posting_date > asOf && days(t.posting_date, asOf) <= S.match_window_days), asOf);
    if (m) { take(m, 'opening'); o.cleared = m.posting_date; o.bank_id = m.id; o.bank = m; }
  }
  for (const g of cands) {
    let m = g.chk ? bank.find((t) => !t.used && t.amount_cents === g.amount_cents && normChk(t.check_number) === g.chk) : null;
    if (!m) m = nearest(bank.filter((t) => !t.used && t.amount_cents === g.amount_cents && days(t.posting_date, g.posting_date) <= S.match_window_days && (!g.chk || !normChk(t.check_number) || normChk(t.check_number) === g.chk)), g.posting_date);
    if (m) { take(m, 'gl'); g.cleared = m.posting_date; g.bank_id = m.id; g.bank = m; g.method = g.chk && normChk(m.check_number) === g.chk ? 'check_number_exact' : 'amount_date_proximity'; }
  }

  const items = [];
  // 4. check-number variances --------------------------------------------------
  for (const g of cands.filter((x) => !x.cleared && x.chk)) {
    const t = bank.find((b) => !b.used && normChk(b.check_number) === g.chk && b.amount_cents !== g.amount_cents && Math.sign(b.amount_cents) === Math.sign(g.amount_cents));
    if (!t) continue;
    take(t, 'variance'); g.cleared = t.posting_date; g.bank_id = t.id; g.bank = t; g.method = 'check_number_variance';
    const adj = t.amount_cents - g.amount_cents;
    items.push({ category: 'manual_adjustment', amount_cents: adj, date_ref: t.posting_date, description: `Check ${g.chk}: written ${money(-g.amount_cents)} in the GL (${g.reference}), cleared the bank for ${money(-t.amount_cents)}`, check_number: g.chk, bank_transaction_id: t.id, gl_ref: g.reference, match_method: 'check_number_variance', match_confidence: 'manual', operator_notes: 'Variance: confirm the check image to decide whether the bank or the books are wrong. Nothing is booked until that is known.' });
    exc({ code: 'check_amount_variance', amount_cents: adj, date: t.posting_date, bank_transaction_id: t.id, gl_ref: g.reference, text: `Check ${g.chk} cleared for ${money(-t.amount_cents)} but the GL (${g.reference}) shows ${money(-g.amount_cents)}: a ${money(Math.abs(adj))} difference. Confirm against the check image: a bank encoding error is corrected by the bank; a book error needs a correcting entry.` });
  }

  // matched (cleared this month) -----------------------------------------------
  const inMonth = (d) => d && d >= period_start && d <= period_end;
  for (const o of openingItems.filter((x) => inMonth(x.cleared))) items.push({ category: 'matched', amount_cents: o.amount_cents, date_ref: o.cleared, description: o.bank.description, check_number: o.bank.check_number || null, bank_transaction_id: o.bank_id, match_method: 'opening_position', match_confidence: 'high', operator_notes: `Cleared a ${asOf} opening reconciling item: ${o.description}.` });
  for (const g of cands.filter((x) => inMonth(x.cleared) && x.method !== 'check_number_variance')) items.push({ category: 'matched', amount_cents: g.amount_cents, date_ref: g.cleared, description: g.bank.description, check_number: g.bank.check_number || g.chk || null, bank_transaction_id: g.bank_id, gl_ref: g.reference, match_method: g.method, match_confidence: g.method === 'check_number_exact' ? 'high' : 'medium', operator_notes: `GL ${g.posting_date} ${g.reference}` });

  // 5. outstanding / in transit ------------------------------------------------
  const outstanding = [];
  for (const o of openingItems.filter((x) => !x.cleared)) outstanding.push({ category: o.kind, amount_cents: o.amount_cents, date_ref: o.date, description: o.description, check_number: o.chk || null, gl_ref: `opening ${asOf}`, opening: true });
  for (const g of cands.filter((x) => !x.cleared)) outstanding.push({ category: g.amount_cents < 0 ? 'outstanding_check' : 'deposit_in_transit', amount_cents: g.amount_cents, date_ref: g.posting_date, description: `${g.memo || g.description || ''}`.trim().slice(0, 200), check_number: g.chk || null, gl_ref: g.reference });
  for (const o of outstanding) {
    const age = days(o.date_ref, period_end);
    if (o.category === 'outstanding_check' && age > S.stale_check_days) { o.operator_notes = `STALE: outstanding ${Math.round(age)} days. Verify with the payee before any void or reissue.`; exc({ code: 'stale_check', amount_cents: o.amount_cents, date: o.date_ref, gl_ref: o.gl_ref, text: `${o.description} (${money(o.amount_cents)}, ${o.date_ref}) has been outstanding ${Math.round(age)} days. Verify with the payee before any void or reissue.` }); }
    else if (o.category === 'deposit_in_transit' && age > S.stale_deposit_days) { o.operator_notes = `STALE: in transit ${Math.round(age)} days.`; exc({ code: 'stale_deposit', amount_cents: o.amount_cents, date: o.date_ref, gl_ref: o.gl_ref, text: `${o.description} (${money(o.amount_cents)}, ${o.date_ref}) is recorded but has not reached the bank after ${Math.round(age)} days.` }); }
    else o.operator_notes = 'Not yet cleared';
    const { opening, ...row } = o; items.push(row);
  }

  // 6. bank lines not in the GL ------------------------------------------------
  const others = input.otherBankTxns || [];
  const pays = input.homeownerPayments || [];
  const feeAcct = S.bank_fee_account || null; const intAcct = S.interest_income_account || null;
  const cashAcct = account.gl_account_number;
  for (const t of bank.filter((x) => !x.used && x.posting_date > asOf)) {
    const kind = classifyBankLine(t);
    const ev = { bank_transaction_id: t.id, statement_import_id: t.bank_statement_import_id, bank_date: t.posting_date, bank_description: t.description, amount_cents: t.amount_cents };
    const row = { category: 'bank_only', amount_cents: t.amount_cents, date_ref: t.posting_date, description: t.description, check_number: t.check_number || null, bank_transaction_id: t.id };
    const base = { amount_cents: t.amount_cents, date: t.posting_date, bank_transaction_id: t.id };
    if (kind === 'bank_fee' && feeAcct) {
      const id = `fee:${t.id}`;
      proposals.push({ id, kind: 'journal_entry', posting_date: t.posting_date, amount_cents: -t.amount_cents, source_reference: `bankrec:${t.id}`,
        description: `Bank charge: ${t.description} (${label} ${t.posting_date})`,
        lines: [{ account_number: feeAcct, debit_cents: -t.amount_cents, credit_cents: 0, memo: `${t.description} ${t.posting_date}` }, { account_number: cashAcct, debit_cents: 0, credit_cents: -t.amount_cents, memo: `${label} ${t.description} ${t.posting_date}` }],
        evidence: { ...ev, basis: `Bank statement line classified as a bank service charge; coded to ${feeAcct} per the community's bank reconciliation settings.` } });
      row.operator_notes = `Proposed entry ${id}: Dr ${feeAcct} / Cr ${cashAcct}. Awaiting approval.`;
      exc({ ...base, code: 'unrecorded_fee', proposal_id: id, text: `Bank charge ${money(t.amount_cents)} on ${t.posting_date} (${t.description}) is not in the GL. Proposed: Dr ${feeAcct} / Cr ${cashAcct}.` });
    } else if (kind === 'returned_payment') {
      const amt = -t.amount_cents;
      const groups = new Map();
      for (const p of pays.filter((p) => day(p.transaction_date) <= t.posting_date && days(p.transaction_date, t.posting_date) <= 21)) {
        const k = `${p.vantaca_account_id || p.property_id}|${day(p.transaction_date)}`;
        const g = groups.get(k) || { key: k, payments: [] }; g.payments.push(p); groups.set(k, g);
      }
      const hits = [...groups.values()].filter((g) => g.payments.reduce((s, p) => s - Number(p.amount_cents), 0) === amt);
      if (hits.length === 1) {
        const g = hits[0]; const p0 = g.payments[0]; const id = `returned:${t.id}`;
        proposals.push({ id, kind: 'returned_payment', posting_date: t.posting_date, amount_cents: amt, source_reference: `bankrec:${t.id}`,
          description: `Returned deposit: ${g.payments.map((p) => p.description || 'payment').join(' + ')} (${p0.address || p0.vantaca_account_id}) returned by the bank ${t.posting_date}`,
          lines: [{ account_number: '1300', debit_cents: amt, credit_cents: 0, memo: `Returned payment ${p0.vantaca_account_id || ''} ${day(p0.transaction_date)}`, property_id: p0.property_id }, { account_number: cashAcct, debit_cents: 0, credit_cents: amt, memo: `${label} ${t.description} ${t.posting_date}` }],
          payments: g.payments.map((p) => ({ id: p.id, amount_cents: Number(p.amount_cents), transaction_date: day(p.transaction_date), description: p.description, property_id: p.property_id, vantaca_account_id: p.vantaca_account_id })),
          evidence: { ...ev, basis: `The returned amount equals the ${g.payments.length} payment(s) posted ${day(p0.transaction_date)} to account ${p0.vantaca_account_id || p0.property_id} (${p0.address || ''}), the only payments of that total in the prior 21 days. The homeowner's receivable is restored; no NSF fee is charged unless a fee schedule authorizes it.` } });
        row.operator_notes = `Proposed ${id}: reverse the payment(s) on the homeowner ledger and Dr 1300 / Cr ${cashAcct}. Awaiting approval.`;
        exc({ ...base, code: 'returned_payment', proposal_id: id, text: `Returned deposit ${money(t.amount_cents)} on ${t.posting_date} matches ${g.payments.length} payment(s) from ${p0.address || p0.vantaca_account_id} on ${day(p0.transaction_date)}. Proposed: reverse them and restore the receivable.` });
      } else {
        row.operator_notes = hits.length ? `${hits.length} homeowners have payments of this total; identify the right one from the bank's return notice.` : 'No homeowner payment of this total in the prior 21 days; get the return notice from the bank.';
        exc({ ...base, code: 'returned_payment_unidentified', text: `Returned deposit ${money(t.amount_cents)} on ${t.posting_date}: ${row.operator_notes}` });
      }
    } else if (kind === 'interest' && intAcct) {
      const id = `interest:${t.id}`;
      proposals.push({ id, kind: 'journal_entry', posting_date: t.posting_date, amount_cents: t.amount_cents, source_reference: `bankrec:${t.id}`, description: `Bank interest (${label} ${t.posting_date})`,
        lines: [{ account_number: cashAcct, debit_cents: t.amount_cents, credit_cents: 0, memo: `${label} ${t.description}` }, { account_number: intAcct, debit_cents: 0, credit_cents: t.amount_cents, memo: `Interest ${t.posting_date}` }],
        evidence: { ...ev, basis: `Bank statement interest credit; coded to ${intAcct} per the community's bank reconciliation settings.` } });
      row.operator_notes = `Proposed ${id}. Awaiting approval.`;
      exc({ ...base, code: 'unrecorded_interest', proposal_id: id, text: `Bank interest ${money(t.amount_cents)} on ${t.posting_date} is not in the GL. Proposed: Dr ${cashAcct} / Cr ${intAcct}.` });
    } else {
      const dup = kind === 'card_purchase' ? others.filter((o) => Number(o.amount_cents) === t.amount_cents && days(o.posting_date, t.posting_date) <= S.duplicate_window_days) : [];
      const why = {
        bank_fee: 'Bank charge not in the GL, and no bank fee account is configured.',
        interest: 'Bank interest not in the GL, and no interest income account is configured for this account.',
        transfer: 'Transfer not in the GL: record it against the other account once the purpose is confirmed.',
        unrecorded_receipt: 'Receipt not in the GL: identify the payer from the payout contents or deposit detail before recording.',
        card_purchase: 'Card purchase not in the GL: obtain the receipt or order detail to code it.',
        unexplained: 'Not in the GL and not recognized: investigate.',
      }[kind];
      const dupText = dup.length ? ` POSSIBLE DUPLICATE: the same amount was charged on ${dup.map((o) => `${o.account_label} ${day(o.posting_date)}`).join(', ')}.` : '';
      row.operator_notes = `EXCEPTION QUEUE: ${why}${dupText}`;
      exc({ ...base, code: kind === 'card_purchase' ? 'needs_receipt' : kind === 'bank_fee' || kind === 'interest' ? `uncoded_${kind}` : kind, possible_duplicate: dup.length > 0, text: `${money(t.amount_cents)} on ${t.posting_date} (${t.description}): ${why}${dupText}` });
    }
    items.push(row);
  }

  // cleared since the prior month-end -------------------------------------------
  const clearedSincePrior = [
    ...openingItems.filter((o) => inMonth(o.cleared)).map((o) => ({ date: o.date, cleared: o.cleared, amount_cents: o.amount_cents, description: o.description, ref: `opening ${asOf}` })),
    ...cands.filter((g) => g.posting_date <= priorEnd && inMonth(g.cleared)).map((g) => ({ date: g.posting_date, cleared: g.cleared, amount_cents: g.amount_cents, description: `${g.memo || g.description || ''}`.trim().slice(0, 120), ref: g.reference })),
  ];

  // outstanding at the prior month-end but voided (with its reversal) this month
  const voidedSincePrior = ops.filter((l) => internal.has(l.je_id) && !l.reverses_je_id && l.posting_date <= priorEnd)
    .map((l) => { const r = ops.find((x) => x.reverses_je_id === l.je_id); return { date: l.posting_date, voided: r && r.posting_date, amount_cents: l.amount_cents, description: `${l.memo || l.description || ''}`.trim().slice(0, 120), ref: l.reference, reversal_ref: r && r.reference }; })
    .filter((v) => v.voided && v.voided >= period_start);

  return finish({ input, S, exceptions, proposals, items, stmt, glBalance, clearedSincePrior, voidedSincePrior, matchedCount: cands.filter((g) => g.cleared).length + openingItems.filter((o) => o.cleared).length, internalCount: internal.size });
}

function finish({ input, S, exceptions, proposals, items = [], stmt = null, glBalance = null, clearedSincePrior = [], voidedSincePrior = [], matchedCount = 0, internalCount = 0, status = null }) {
  const sum = (cat) => items.filter((i) => i.category === cat).reduce((t, i) => t + i.amount_cents, 0);
  const oc = sum('outstanding_check'); const dit = sum('deposit_in_transit'); const bo = sum('bank_only'); const adj = sum('manual_adjustment');
  const bankEnding = stmt ? Number(stmt.ending_balance_cents) : null;
  const adjBank = bankEnding == null ? null : bankEnding + oc + dit - adj;
  const adjBook = glBalance == null ? null : glBalance + bo;
  const difference = adjBank == null || adjBook == null ? null : adjBank - adjBook;
  const open = exceptions.filter((e) => e.severity !== 'info');
  const st = status || (exceptions.some((e) => e.severity === 'blocking') ? 'blocked' : difference !== 0 ? 'unbalanced' : open.length ? 'in_progress' : 'reconciled');
  if (!status && difference !== 0 && difference != null) exceptions.push({ code: 'difference', severity: 'open', amount_cents: difference, text: `The reconciliation is off by ${money(difference)}: adjusted bank ${money(adjBank)} vs adjusted book ${money(adjBook)}.` });
  return {
    account: input.account, period_start: input.period_start, period_end: input.period_end, settings: S,
    statement: stmt ? { id: stmt.id, period_start: day(stmt.statement_period_start), period_end: day(stmt.statement_period_end), beginning_balance_cents: Number(stmt.beginning_balance_cents), ending_balance_cents: bankEnding } : null,
    totals: { bank_ending_cents: bankEnding, gl_ending_cents: glBalance, outstanding_checks_cents: oc, deposits_in_transit_cents: dit, bank_only_cents: bo, manual_adjustments_cents: adj,
      adjusted_bank_cents: adjBank, adjusted_book_cents: adjBook, difference_cents: difference, matched: items.filter((i) => i.category === 'matched').length, matched_since_cutover: matchedCount, internal_pairs: internalCount / 2,
      outstanding_count: items.filter((i) => ['outstanding_check', 'deposit_in_transit'].includes(i.category)).length, open_exceptions: exceptions.filter((e) => e.severity !== 'info').length, proposals: proposals.length,
      proposals_cents: proposals.reduce((t, p) => t + p.amount_cents, 0) },
    status: st, items, exceptions, proposals, cleared_since_prior: clearedSincePrior, voided_since_prior: voidedSincePrior,
  };
}

// The report Kat sends with every run (plain text, Ed-voice: no em dashes).
function reportText(r) {
  const t = r.totals; const L = [];
  L.push(`${r.account.label}: bank reconciliation for ${r.period_end}`);
  if (r.statement) L.push(`Statement ${r.statement.period_start} to ${r.statement.period_end}: beginning ${money(r.statement.beginning_balance_cents)}, ending ${money(r.statement.ending_balance_cents)}.`);
  if (t.bank_ending_cents != null) {
    L.push(`Bank ending balance ${money(t.bank_ending_cents)}; outstanding checks ${money(t.outstanding_checks_cents)}; deposits in transit ${money(t.deposits_in_transit_cents)}; bank-side adjustments ${money(-t.manual_adjustments_cents)}; adjusted bank ${money(t.adjusted_bank_cents)}.`);
    L.push(`GL balance ${money(t.gl_ending_cents)}; bank items not yet in the GL ${money(t.bank_only_cents)}; adjusted book ${money(t.adjusted_book_cents)}.`);
    L.push(`Difference ${money(t.difference_cents)}. Matched this month ${t.matched}; outstanding ${t.outstanding_count}; cleared since the prior month-end ${r.cleared_since_prior.length}${r.voided_since_prior.length ? `; voided since the prior month-end ${r.voided_since_prior.map((v) => `${v.ref} ${money(v.amount_cents)} (reversed by ${v.reversal_ref})`).join(', ')}` : ''}.`);
  }
  if (r.proposals.length) L.push(`Proposed entries needing approval: ${r.proposals.map((p) => `${p.description} ${money(p.amount_cents)}`).join('; ')}.`);
  if (r.exceptions.length) L.push(`Exceptions: ${r.exceptions.map((e) => e.text).join(' | ')}`);
  L.push(`Status: ${{ reconciled: 'reconciled, nothing open', in_progress: 'balances to $0.00 with open exceptions (not complete)', unbalanced: 'does not balance', blocked: 'blocked' }[r.status] || r.status}.`);
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Loader: everything reconcileAccountMonth needs, from trustEd tables.
// ---------------------------------------------------------------------------
async function loadAccountMonth(supabase, { community_id, bank_account_id, period_end, settings = {} }) {
  const { fetchAllQuery } = require('../db/fetch_all');
  const must = async (q, what) => { const { data, error } = await q; if (error) throw new Error(`${what}: ${error.message}`); return data; };
  const pe = day(period_end); const ps = `${pe.slice(0, 7)}-01`;
  const ba = await must(supabase.from('bank_accounts').select('id, community_id, account_nickname, account_last4, gl_account_number, opening_position').eq('id', bank_account_id).single(), 'bank account');
  if (ba.community_id !== community_id) throw Object.assign(new Error('bank account is not in this community'), { code: 'invalid_input' });
  const coa = await must(supabase.from('chart_of_accounts').select('id').eq('community_id', community_id).eq('account_number', ba.gl_account_number).maybeSingle(), 'cash account');
  if (!coa) throw Object.assign(new Error(`GL account ${ba.gl_account_number} not found for this community`), { code: 'invalid_input' });
  const raw = await fetchAllQuery(() => supabase.from('journal_entry_lines')
    .select('id, debit_cents, credit_cents, memo, journal_entries!inner(id, reference, posting_date, description, status, void_reversal_je_id, reverses_je_id, source_module, community_id)')
    .eq('account_id', coa.id).eq('journal_entries.community_id', community_id).lte('journal_entries.posting_date', pe));
  const glLines = raw.filter((l) => countsInGl(l.journal_entries)).map((l) => ({ id: l.id, je_id: l.journal_entries.id, reference: l.journal_entries.reference, posting_date: l.journal_entries.posting_date,
    amount_cents: Number(l.debit_cents) - Number(l.credit_cents), memo: l.memo, description: l.journal_entries.description, source_module: l.journal_entries.source_module, reverses_je_id: l.journal_entries.reverses_je_id }));
  const statements = await must(supabase.from('bank_statement_imports').select('id, statement_period_start, statement_period_end, beginning_balance_cents, ending_balance_cents')
    .eq('bank_account_id', ba.id).lte('statement_period_end', pe).order('statement_period_end'), 'statements');
  const asOf = ba.opening_position && ba.opening_position.as_of_date;
  const ids = statements.filter((s) => !asOf || day(s.statement_period_end) > asOf).map((s) => s.id);
  const bankTxns = ids.length ? await fetchAllQuery(() => supabase.from('bank_statement_transactions').select('id, bank_statement_import_id, posting_date, amount_cents, description, check_number, transaction_type').in('bank_statement_import_id', ids)) : [];

  // other accounts' bank lines around the month (duplicate-charge check)
  const otherAccts = await must(supabase.from('bank_accounts').select('id, account_nickname, account_last4').eq('community_id', community_id).neq('id', ba.id), 'other accounts');
  let otherBankTxns = [];
  if (otherAccts.length) {
    const oImps = await must(supabase.from('bank_statement_imports').select('id, bank_account_id').in('bank_account_id', otherAccts.map((a) => a.id)).gte('statement_period_end', ps), 'other statements');
    if (oImps.length) {
      const lab = Object.fromEntries(otherAccts.map((a) => [a.id, `${a.account_nickname || 'account'}${a.account_last4 ? ' ' + a.account_last4 : ''}`]));
      const imp = Object.fromEntries(oImps.map((i) => [i.id, i.bank_account_id]));
      const rows = await fetchAllQuery(() => supabase.from('bank_statement_transactions').select('id, bank_statement_import_id, posting_date, amount_cents, description').in('bank_statement_import_id', oImps.map((i) => i.id)).gte('posting_date', addDays(ps, -7)).lte('posting_date', addDays(pe, 7)));
      otherBankTxns = rows.map((r) => ({ ...r, account_label: lab[imp[r.bank_statement_import_id]] }));
    }
  }
  // homeowner payments, only when a returned item needs matching
  let homeownerPayments = [];
  const returned = bankTxns.filter((t) => day(t.posting_date) >= ps && day(t.posting_date) <= pe && classifyBankLine(t) === 'returned_payment');
  if (returned.length) {
    const lo = addDays(returned.map((t) => day(t.posting_date)).sort()[0], -21);
    const pay = await fetchAllQuery(() => supabase.from('homeowner_transactions').select('id, property_id, vantaca_account_id, transaction_date, amount_cents, description, properties(street_address)')
      .eq('community_id', community_id).eq('txn_type', 'payment').gte('transaction_date', lo).lte('transaction_date', pe));
    const rev = await fetchAllQuery(() => supabase.from('homeowner_transactions').select('id, reverses_txn_id').eq('community_id', community_id).not('reverses_txn_id', 'is', null).gte('transaction_date', lo));
    const reversed = new Set(rev.map((r) => r.reverses_txn_id));
    homeownerPayments = pay.filter((p) => !reversed.has(p.id)).map((p) => ({ ...p, address: p.properties && p.properties.street_address }));
  }
  return {
    account: { id: ba.id, label: `${ba.account_nickname || 'Bank account'}${ba.account_last4 ? ' ' + ba.account_last4 : ''}`, gl_account_number: ba.gl_account_number, cash_account_id: coa.id },
    period_start: ps, period_end: pe, opening: ba.opening_position, statements, bankTxns, glLines, otherBankTxns, homeownerPayments, settings,
  };
}

async function runAccountMonth(supabase, args) {
  return reconcileAccountMonth(await loadAccountMonth(supabase, args));
}

// ---------------------------------------------------------------------------
// Posting approved proposals. Each is idempotent on its source_reference
// (bankrec:<bank transaction id>): an entry already in the GL is reported, not
// posted twice. A returned payment reverses the homeowner's payment(s) on the
// ledger (draft batch -> rows -> GL entry -> commit; the batch is reverted if
// the GL entry fails) exactly like the 8/26 returned checks (JE-2026-00512).
// ---------------------------------------------------------------------------
async function postProposals(supabase, { community_id, proposals, actor, approver }) {
  const P = require('../accounting/posting');
  const must = async (q, what) => { const { data, error } = await q; if (error) throw new Error(`${what}: ${error.message}`); return data; };
  const out = [];
  if (!proposals.length) return out;
  const nums = [...new Set(proposals.flatMap((p) => p.lines.map((l) => l.account_number)))];
  const coa = await must(supabase.from('chart_of_accounts').select('id, account_number, fund_id').eq('community_id', community_id).in('account_number', nums), 'accounts');
  const A = Object.fromEntries(coa.map((a) => [a.account_number, a]));
  for (const n of nums) if (!A[n]) throw Object.assign(new Error(`GL account ${n} does not exist for this community`), { code: 'blocked' });
  const lines = (p) => p.lines.map((l) => ({ account_id: A[l.account_number].id, fund_id: A[l.account_number].fund_id, debit_cents: l.debit_cents, credit_cents: l.credit_cents, memo: l.memo, ...(l.property_id ? { property_id: l.property_id } : {}) }));
  const notes = (p) => `${p.evidence.basis} Bank line ${p.evidence.bank_date} "${p.evidence.bank_description}" (statement import ${p.evidence.statement_import_id}). Prepared by ${actor}; approved by ${approver}.`;
  for (const p of proposals) {
    const prior = await must(supabase.from('journal_entries').select('id, reference').eq('community_id', community_id).eq('source_reference', p.source_reference).limit(1), 'idempotency');
    if (prior.length) { out.push({ id: p.id, already_posted: prior[0].reference }); continue; }
    if (p.kind === 'journal_entry') {
      const je = await P.postJournalEntry({ community_id, posting_date: p.posting_date, source_module: 'bank_reconciliation', source_reference: p.source_reference, description: p.description, notes: notes(p), lines: lines(p) });
      out.push({ id: p.id, reference: je.entry.reference, journal_entry_id: je.entry.id, amount_cents: p.amount_cents });
    } else if (p.kind === 'returned_payment') {
      const ids = p.payments.map((x) => x.id);
      const pays = await must(supabase.from('homeowner_transactions').select('*').in('id', ids).eq('community_id', community_id).eq('txn_type', 'payment'), 'payments');
      if (pays.length !== ids.length) throw Object.assign(new Error(`${p.id}: the payments to reverse are no longer on the ledger`), { code: 'blocked' });
      const already = await must(supabase.from('homeowner_transactions').select('id').in('reverses_txn_id', ids), 'existing reversals');
      if (already.length) throw Object.assign(new Error(`${p.id}: a payment is already reversed on the homeowner ledger`), { code: 'blocked' });
      const comm = await must(supabase.from('communities').select('management_company_id').eq('id', community_id).single(), 'community');
      const b = await must(supabase.from('transaction_upload_batches').insert({ management_company_id: comm.management_company_id, community_id, period_label: `Returned deposit ${p.posting_date} (bank reconciliation)`, as_of_date: p.posting_date,
        source_format: 'manual', row_count: pays.length, account_count: 1, total_charges_cents: p.amount_cents, total_payments_cents: 0, status: 'draft', min_transaction_date: p.posting_date, max_transaction_date: p.posting_date,
        notes: notes(p).slice(0, 2000) }).select('id').single(), 'batch');
      const revert = async (why) => { await supabase.from('transaction_upload_batches').update({ status: 'reverted', reverted_at: new Date().toISOString(), reverted_reason: String(why).slice(0, 500) }).eq('id', b.id); };
      const { error: ie } = await supabase.from('homeowner_transactions').insert(pays.map((x, n) => ({ source_batch_id: b.id, source_row_index: n + 1, community_id, vantaca_account_id: x.vantaca_account_id, trusted_account_number: x.trusted_account_number,
        property_id: x.property_id, contact_id: x.contact_id, tenure_id: x.tenure_id, transaction_date: p.posting_date, txn_type: 'charge', charge_category: 'payment_reversal', amount_cents: -x.amount_cents, reverses_txn_id: x.id,
        description: `Returned payment: ${x.description || 'payment'} (${x.transaction_date}, returned by the bank ${p.posting_date})` })));
      if (ie) { await revert(ie.message); throw new Error(`${p.id}: ledger rows: ${ie.message}`); }
      let je;
      try { je = await P.postJournalEntry({ community_id, posting_date: p.posting_date, source_module: 'bank_reconciliation', source_reference: p.source_reference, description: p.description, notes: notes(p), lines: lines(p) }); }
      catch (e) { await revert(e.message); throw e; }
      await must(supabase.from('transaction_upload_batches').update({ status: 'committed' }).eq('id', b.id).select('id'), 'commit batch');
      out.push({ id: p.id, reference: je.entry.reference, journal_entry_id: je.entry.id, ledger_batch_id: b.id, amount_cents: p.amount_cents });
    } else throw new Error(`unknown proposal kind ${p.kind}`);
  }
  return out;
}

// Store the reconciliation where the Bank Rec screens read it. One record per
// account + month: an existing record (not voided) is updated and its items
// replaced, so the stored reconciliation is always Kat's latest approved one.
async function storeReconciliation(supabase, { community_id, r, run_id, actor }) {
  const must = async (q, what) => { const { data, error } = await q; if (error) throw new Error(`${what}: ${error.message}`); return data; };
  const comm = await must(supabase.from('communities').select('management_company_id').eq('id', community_id).single(), 'community');
  const t = r.totals;
  const status = r.status === 'reconciled' ? 'reconciled' : r.status === 'unbalanced' ? 'unbalanced' : 'in_progress';
  const open = r.exceptions.filter((e) => e.severity !== 'info');
  const header = { management_company_id: comm.management_company_id, community_id, bank_account_id: r.account.id, period_start: r.period_start, period_end: r.period_end,
    bank_statement_import_id: r.statement && r.statement.id, bank_ending_balance_cents: t.bank_ending_cents, gl_ending_balance_cents: t.gl_ending_cents,
    outstanding_checks_total_cents: t.outstanding_checks_cents, deposits_in_transit_total_cents: t.deposits_in_transit_cents, bank_only_adjustments_cents: t.bank_only_cents, gl_only_adjustments_cents: 0,
    manual_adjustments_cents: -t.manual_adjustments_cents, reconciled_balance_cents: t.adjusted_bank_cents, difference_cents: t.difference_cents, status, prepared_at: new Date().toISOString(),
    notes: `${reportText(r)}\nOpen exceptions: ${open.length}. Kat's run ${run_id}; ${actor}.`.slice(0, 8000) };
  const existing = await must(supabase.from('bank_reconciliations').select('id, status').eq('bank_account_id', r.account.id).eq('period_end', r.period_end).neq('status', 'voided'), 'existing reconciliation');
  let id;
  if (existing.length) {
    id = existing[0].id;
    await must(supabase.from('bank_reconciliations').update(header).eq('id', id).select('id'), 'update reconciliation');
    await must(supabase.from('bank_reconciliation_items').delete().eq('reconciliation_id', id).select('id'), 'clear items');
  } else id = (await must(supabase.from('bank_reconciliations').insert(header).select('id').single(), 'insert reconciliation')).id;
  const rows = r.items.map((i) => ({ reconciliation_id: id, category: i.category, amount_cents: i.amount_cents, date_ref: i.date_ref || null, description: (i.description || '').slice(0, 1000), check_number: i.check_number || null,
    bank_transaction_id: i.bank_transaction_id || null, gl_ref: i.gl_ref || null, match_method: i.match_method || null, match_confidence: i.match_confidence || null, operator_notes: i.operator_notes || null }));
  for (let k = 0; k < rows.length; k += 500) await must(supabase.from('bank_reconciliation_items').insert(rows.slice(k, k + 500)).select('id'), 'insert items');
  return { reconciliation_id: id, status, replaced: existing.length > 0, items: rows.length };
}

module.exports = { reconcileAccountMonth, loadAccountMonth, runAccountMonth, classifyBankLine, reportText, postProposals, storeReconciliation };
