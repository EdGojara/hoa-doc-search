// ============================================================================
// lib/ar/vantaca_receipts.js  (Ed 2026-10-31) — post-cutover Vantaca homeowner receipts
// ----------------------------------------------------------------------------
// Until Stripe is live, homeowners still pay through Vantaca (Vantaca Pay online
// payments and remote-deposited checks). This brings those receipts into the trustEd
// homeowner ledger and GL, the same way Canyon Gate's 8/1-9/30 receipts were posted
// by hand on 2026-10-11 (Ed-approved pattern), as one repeatable, idempotent import:
//
//   read     lib/onboarding/adapters/vantaca (Payout Contents + Deposit Register),
//            every row tied back to the report's own printed totals
//   normalize  one item per receipt with a stable Vantaca identity (vantaca_ref);
//            an online payment that is on BOTH reports is one receipt, not two
//   plan     (pure) match each item to its community account (ownership_tenures /
//            properties by Vantaca account), drop what is already in trustEd, hold
//            what is ambiguous, and propose the ledger rows + one GL entry per bank
//            settlement (payout / deposit date)
//   post     (not run by the dry run) the existing pattern: a DRAFT
//            transaction_upload_batches row no reader sees, the homeowner rows, the GL
//            entries through postJournalEntry (source_module payment_intake, which
//            refuses any date before the GL cutover), then commit the batch.
//
// Controls:
//   * Idempotent: an item already in trustEd (same vantaca_ref, or the same report
//     tuple from the 10/11 Canyon Gate import whose refs carry a report ordinal) is
//     reported "already imported" and never proposed again. Migration 551 adds the
//     unique indexes that make a second insert impossible in the database too.
//   * A receipt is never guessed onto an account: an unknown Vantaca account, a
//     same-amount payment already on the account from another path (check scan,
//     closing payoff, Stripe, manual) or an unlinked GL credit to AR is HELD as an
//     exception. Held items never stop the rest of the batch.
//   * Every source amount is accounted for: parsed total = proposed + already
//     imported + before cutover + outside the window + held + not a homeowner receipt.
//
// Record ownership: the homeowner rows and GL entries are association_record; the
// dry-run report is a workpaper.
// ============================================================================
const crypto = require('crypto');
const { fetchAll, fetchAllQuery } = require('../db/fetch_all');

const SOURCE = 'vantaca_receipt';
const LEGACY_SOURCES = ['vantaca_pay_payout_contents', 'vantaca_deposit_register'];
const DUP_WINDOW_DAYS = 7;

const money = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sha8 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dayDiff = (a, b) => Math.abs((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
const provOf = (r) => ({ artifact_sha256: r.provenance.artifact_sha256, ...r.provenance.locator, raw: r.provenance.raw });
const must = async (q, what) => { const { data, error } = await q; if (error) throw Object.assign(new Error(`${what}: ${error.message}`), { code: error.code }); return data; };

// ---------------------------------------------------------------------------
// 1) Normalize parsed reports into receipt items (pure)
// ---------------------------------------------------------------------------
// The identity of a report line, without any report-specific ordinal. Two identical
// lines on one report (same payout, date, account, amount) get #1, #2 in report order.
function tupleOf(it) {
  return it.source === 'vantaca_pay'
    ? `VPAY:${it.settle_date}:${it.trxn_date}:${it.account || 'FEE'}:${it.signed_cents}`
    : `VDEP:${it.settle_date}:${it.account}:${it.check_number}:${it.signed_cents}`;
}

function categorize(r) {
  if (r.type === 'Fee') return 'processor_fee';
  if (r.type === 'Refund') return r.source_account_key && r.method ? 'owner_refund' : 'returned_payment';
  if (r.type === 'Payment') return r.amount_cents > 0 ? 'payment' : 'unreadable';
  return 'unreadable';
}

function normalizeReceipts({ payouts = [], registers = [] }) {
  const items = []; const excluded = [];
  const coverage = [];   // payout-report date ranges: an online deposit-register line inside one must be on it
  for (const rep of payouts) {
    if (rep.period) coverage.push(rep.period);
    for (const r of rep.rows) {
      items.push({
        source: 'vantaca_pay', category: categorize(r), account: r.source_account_key || null,
        trxn_date: r.trxn_date, settle_date: r.payout_date, signed_cents: r.amount_cents, amount_cents: Math.abs(r.amount_cents),
        method: r.method || null, check_number: null, description: r.description, bank_last4: r.bank_last4 || null,
        report: 'vantaca_pay_payouts', provenance: provOf(r),
        corroborated_by: null,
      });
    }
  }
  const onlinePool = items.filter((i) => i.source === 'vantaca_pay' && i.category === 'payment');
  for (const rep of registers) {
    for (const r of rep.rows) {
      const prov = provOf(r);
      if (r.item_kind === 'deposit_other') { excluded.push({ reason: 'not_homeowner_receipt', note: `${r.section || ''}: ${r.description}`.trim(), date: r.date, amount_cents: r.amount_cents, provenance: prov }); continue; }
      if (r.item_kind === 'deposit_check') {
        items.push({
          source: 'deposit_register', category: r.amount_cents > 0 ? 'payment' : 'unreadable', account: r.source_account_key,
          trxn_date: r.deposit_date, settle_date: r.deposit_date, signed_cents: r.amount_cents, amount_cents: Math.abs(r.amount_cents),
          method: 'check', check_number: r.check_number, description: r.description, bank_last4: null, section: r.section,
          report: 'deposit_register', provenance: prov, corroborated_by: null,
        });
        continue;
      }
      // Online payment on the register: the payout report is its settlement record.
      const hit = onlinePool.find((p) => !p.corroborated_by && p.account === r.source_account_key && p.amount_cents === r.amount_cents && p.trxn_date === r.deposit_date);
      if (hit) { hit.corroborated_by = { report: 'deposit_register', ...prov }; continue; }
      // The payout report is dated by PAYOUT date: a payment collected near its end settles in the next report.
      const covered = coverage.some((c) => r.deposit_date >= c.start && addDays(r.deposit_date, 10) <= c.end);
      items.push({
        source: 'deposit_register', category: 'payment', account: r.source_account_key,
        trxn_date: r.deposit_date, settle_date: null, signed_cents: r.amount_cents, amount_cents: Math.abs(r.amount_cents),
        method: 'online', check_number: null, description: r.description, bank_last4: null, section: r.section,
        report: 'deposit_register', provenance: prov, corroborated_by: null,
        hold: covered ? 'online_payment_not_on_payout_report' : 'awaiting_payout_report',
      });
    }
  }
  // Stable identity.
  const seen = {};
  for (const it of items) {
    if (it.source === 'deposit_register' && it.method === 'online') { it.tuple = `VDEPONLINE:${it.trxn_date}:${it.account}:${it.signed_cents}`; }
    else it.tuple = tupleOf(it);
    seen[it.tuple] = (seen[it.tuple] || 0) + 1;
    it.vantaca_ref = `${it.tuple}#${seen[it.tuple]}`;
  }
  return { items, excluded };
}

// ---------------------------------------------------------------------------
// 2) Plan (pure): status per item + proposed ledger rows and GL entries
// ---------------------------------------------------------------------------
// facts = {
//   community: { id, slug, gl_cutover_date },
//   accounts: Map vantaca_account_id -> [{ property_id, tenure_id, current: bool }],
//   existingRefs: [vantaca_ref strings already on committed ledger rows],
//   existingPayments: [{ id, vantaca_account_id, property_id, date, amount_cents (positive), source }],
//   glArCredits: [{ property_id, date, amount_cents, reference, linked: bool }],
//   existingJeRefs: Set of journal_entries.source_reference,
//   gl: { cash_by_last4: {last4: '1000'}, default_cash: '1000', ar: '1300', fee: '1380'|null },
// }
function legacyTuple(ref) {
  // 10/11 Canyon Gate refs: VPAY:<payout>:<trxn>:<acct|FEE>:<cents>:<ordinal> and VDEP:<date>:<acct>:<check>:<cents>
  const s = String(ref || '').replace(/#\d+$/, '');
  if (s.startsWith('VPAY:')) { const p = s.split(':'); return p.length >= 6 ? p.slice(0, 5).join(':') : s; }
  return s;
}

function preCutoverOriginal(items, ret, cutover) {
  return items.some((p) => p.category === 'payment' && p.account === ret.account && p.amount_cents === ret.amount_cents && p.trxn_date < cutover && p.settle_date === ret.settle_date);
}

function planReceipts(normalized, facts, { from, to } = {}) {
  const cutover = facts.community.gl_cutover_date;
  // Multiset of identities already in trustEd (by tuple, so the 10/11 ordinal refs count).
  const have = {};
  for (const r of new Set(facts.existingRefs || [])) { const t = legacyTuple(r); have[t] = (have[t] || 0) + 1; }
  const usedPay = new Set(); const usedGl = new Set();
  const out = [];
  for (const src of normalized.items) {
    const it = { ...src, status: null, reason: null, match: null };
    out.push(it);
    if (it.category === 'unreadable') { it.status = 'held'; it.reason = 'unreadable_line_type'; continue; }
    if (have[it.tuple] > 0) { have[it.tuple]--; it.status = 'already_imported'; continue; }
    if (cutover && it.trxn_date < cutover) { it.status = 'before_cutover'; it.reason = `collected ${it.trxn_date}, before the ${cutover} cutover: in the converted opening balance (deposit in transit)`; continue; }
    if (cutover && it.category === 'returned_payment' && preCutoverOriginal(normalized.items, it, cutover)) {
      it.status = 'before_cutover'; it.reason = `returns a payment collected before the ${cutover} cutover and netted in the same payout: part of the converted deposit in transit`; continue;
    }
    // The window is the BANK date (payout / deposit), the date the GL cash entry carries.
    const windowDate = it.settle_date || it.trxn_date;
    if ((from && windowDate < from) || (to && windowDate > to)) { it.status = 'outside_window'; continue; }
    if (it.hold) { it.status = 'held'; it.reason = it.hold; continue; }
    if (it.category === 'processor_fee') {
      if (!facts.gl.fee) { it.status = 'held'; it.reason = 'fee_account_decision'; continue; }
      it.status = 'proposed'; continue;
    }
    const cands = (facts.accounts.get(it.account) || []);
    if (!it.account || !cands.length) { it.status = 'held'; it.reason = 'account_not_found_in_community'; continue; }
    const props = [...new Set(cands.map((c) => c.property_id).filter(Boolean))];
    if (props.length !== 1) { it.status = 'held'; it.reason = props.length ? 'account_maps_to_several_properties' : 'account_has_no_property'; continue; }
    const tenure = cands.find((c) => c.current) || cands[0];
    it.match = { property_id: props[0], tenure_id: tenure.tenure_id || null, owner: tenure.current ? 'current_owner' : 'former_owner' };
    if (it.category === 'payment') {
      const dup = (facts.existingPayments || []).find((p) => !usedPay.has(p.id) && p.amount_cents === it.amount_cents
        && (p.vantaca_account_id === it.account || p.property_id === it.match.property_id)
        && (dayDiff(p.date, it.trxn_date) <= DUP_WINDOW_DAYS || (it.settle_date && dayDiff(p.date, it.settle_date) <= DUP_WINDOW_DAYS)));
      if (dup) { usedPay.add(dup.id); it.status = 'held'; it.reason = 'possible_duplicate_of_existing_payment'; it.duplicate_of = dup; continue; }
      const gl = (facts.glArCredits || []).find((g) => !g.linked && !usedGl.has(g.line_id) && g.property_id === it.match.property_id && g.amount_cents === it.amount_cents
        && (dayDiff(g.date, it.trxn_date) <= DUP_WINDOW_DAYS || (it.settle_date && dayDiff(g.date, it.settle_date) <= DUP_WINDOW_DAYS)));
      if (gl) { usedGl.add(gl.line_id); it.status = 'held'; it.reason = 'possible_duplicate_of_gl_ar_credit'; it.duplicate_of = gl; continue; }
    }
    it.status = 'proposed';
  }
  return { items: out, ...buildPostings(out, facts), reconciliation: reconcile(normalized, out) };
}

// One GL entry per bank settlement (payout date / deposit date) and source report.
function buildPostings(items, facts) {
  const proposed = items.filter((i) => i.status === 'proposed');
  const groups = {};
  for (const it of proposed) {
    const k = `${it.source}|${it.settle_date}|${it.bank_last4 || it.section || ''}`;
    (groups[k] = groups[k] || []).push(it);
  }
  const entries = []; const ledgerRows = [];
  for (const [k, list] of Object.entries(groups)) {
    const [source, settle, bank] = k.split('|');
    const cashAcct = (bank && facts.gl.cash_by_last4[bank]) || facts.gl.default_cash;
    const lines = []; let net = 0;
    for (const it of list) {
      const memo = `${it.description} (${it.vantaca_ref})`;
      if (it.category === 'payment') { net += it.amount_cents; lines.push({ account: facts.gl.ar, credit_cents: it.amount_cents, debit_cents: 0, property_id: it.match.property_id, memo: `Payment ${it.account} ${it.trxn_date}${it.check_number ? ' check #' + it.check_number : ''}` }); }
      else if (it.category === 'returned_payment' || it.category === 'owner_refund') { net -= it.amount_cents; lines.push({ account: facts.gl.ar, debit_cents: it.amount_cents, credit_cents: 0, property_id: it.match.property_id, memo: `${it.category === 'owner_refund' ? 'Refund to owner' : 'Returned payment'} ${it.account}: ${it.description}` }); }
      else if (it.category === 'processor_fee') { net -= it.amount_cents; lines.push({ account: facts.gl.fee, debit_cents: it.amount_cents, credit_cents: 0, memo: `Vantaca ${it.description} netted from payout ${settle}` }); }
      it.memo = memo;
      if (it.category !== 'processor_fee') ledgerRows.push(ledgerRowFor(it));
    }
    lines.unshift(net >= 0 ? { account: cashAcct, debit_cents: net, credit_cents: 0, memo: `${source === 'vantaca_pay' ? 'Vantaca Pay payout' : 'Remote deposit'} ${settle}` }
      : { account: cashAcct, debit_cents: 0, credit_cents: -net, memo: `${source === 'vantaca_pay' ? 'Vantaca Pay payout' : 'Remote deposit'} ${settle} (net debit)` });
    const keys = list.map((i) => i.vantaca_ref).sort();
    const ref = `VRCPT:${source === 'vantaca_pay' ? 'VPAY' : 'VDEP'}:${settle}:${sha8(keys.join('|'))}`;
    const dr = lines.reduce((s, l) => s + l.debit_cents, 0); const cr = lines.reduce((s, l) => s + l.credit_cents, 0);
    entries.push({
      source_reference: ref, posting_date: settle, source_module: 'payment_intake', cash_account: cashAcct, net_cents: net,
      description: `Homeowner receipts: ${source === 'vantaca_pay' ? 'Vantaca Pay payout' : 'remote deposit'} ${settle} (${list.length} item${list.length === 1 ? '' : 's'}, ${money(net)})`,
      lines, items: keys, balanced: dr === cr, already_posted: facts.existingJeRefs ? facts.existingJeRefs.has(ref) : false,
    });
  }
  entries.sort((a, b) => a.posting_date.localeCompare(b.posting_date) || a.source_reference.localeCompare(b.source_reference));
  return { entries, ledgerRows };
}

function ledgerRowFor(it) {
  const base = {
    property_id: it.match.property_id, tenure_id: it.match.tenure_id, vantaca_account_id: it.account,
    transaction_date: it.trxn_date,
    raw_row_jsonb: {
      source: SOURCE, vantaca_ref: it.vantaca_ref, report: it.report, category: it.category, trxn_date: it.trxn_date,
      settle_date: it.settle_date, check_number: it.check_number, method: it.method, description: it.description,
      owner: it.match.owner, provenance: it.provenance, corroborated_by: it.corroborated_by,
    },
  };
  if (it.category === 'payment') return { ...base, txn_type: 'payment', charge_category: 'payment', amount_cents: -it.amount_cents, reduction_source: 'cash_payment',
    description: it.check_number ? `Chk #${it.check_number} - Payment` : `Payment - Vantaca Pay ${it.method || ''}`.trim() };
  if (it.category === 'returned_payment') return { ...base, txn_type: 'adjustment', charge_category: 'payment_reversal', amount_cents: it.amount_cents, reduction_source: null,
    description: `Returned payment - ${it.description.replace(/^\d+\s+/, '')}` };
  return { ...base, txn_type: 'adjustment', charge_category: 'refund', amount_cents: it.amount_cents, reduction_source: null, description: `Refund to owner - ${it.description.replace(/^\d+\s+/, '')}` };
}

// Every parsed dollar is in exactly one bucket, by category.
function reconcile(normalized, items) {
  const cats = ['payment', 'returned_payment', 'owner_refund', 'processor_fee', 'unreadable'];
  const statuses = ['proposed', 'already_imported', 'before_cutover', 'outside_window', 'held'];
  const table = {};
  for (const c of cats) { table[c] = { source_count: 0, source_cents: 0 }; for (const s of statuses) table[c][s] = { count: 0, cents: 0 }; }
  for (const it of items) {
    const row = table[it.category]; row.source_count++; row.source_cents += it.signed_cents;
    row[it.status].count++; row[it.status].cents += it.signed_cents;
  }
  const ties = cats.every((c) => statuses.reduce((s, st) => s + table[c][st].cents, 0) === table[c].source_cents);
  const corroborated = items.filter((i) => i.corroborated_by).length;
  const excludedCents = normalized.excluded.reduce((s, e) => s + e.amount_cents, 0);
  return { by_category: table, every_item_in_one_bucket: ties, corroborated_online: corroborated, excluded_non_homeowner: { count: normalized.excluded.length, cents: excludedCents } };
}

// ---------------------------------------------------------------------------
// 3) Facts (read-only)
// ---------------------------------------------------------------------------
async function loadFacts(supabase, communityId, { from }) {
  const [community] = await must(supabase.from('communities').select('id, slug, name, gl_cutover_date, management_company_id, financials_active, books_of_record, management_status').eq('id', communityId), 'community');
  if (!community) throw new Error(`community ${communityId} not found`);
  const cutover = community.gl_cutover_date;
  const since = (() => { const d = new Date(`${cutover || from}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - DUP_WINDOW_DAYS); return d.toISOString().slice(0, 10); })();

  const tenures = await fetchAll(supabase, 'ownership_tenures', { select: 'id, property_id, vantaca_account_id, kind, end_date', filters: { community_id: communityId } });
  const props = await fetchAll(supabase, 'properties', { select: 'id, vantaca_account_id', filters: { community_id: communityId } });
  const accounts = new Map();
  const add = (acct, v) => { if (!acct) return; const a = accounts.get(String(acct)) || []; if (!a.some((x) => x.property_id === v.property_id && x.tenure_id === v.tenure_id)) a.push(v); accounts.set(String(acct), a); };
  for (const t of tenures) if (t.kind === 'owner') add(t.vantaca_account_id, { property_id: t.property_id, tenure_id: t.id, current: !t.end_date });
  for (const p of props) if (!(accounts.get(String(p.vantaca_account_id)) || []).length) add(p.vantaca_account_id, { property_id: p.id, tenure_id: null, current: true });

  const batches = await fetchAll(supabase, 'transaction_upload_batches', { select: 'id, status, uploaded_by', filters: { community_id: communityId } });
  const live = new Map(batches.filter((b) => b.status === 'committed').map((b) => [b.id, b]));
  const draft = new Set(batches.filter((b) => b.status === 'draft').map((b) => b.id));
  const ledger = await fetchAllQuery(() => supabase.from('homeowner_transactions')
    .select('id, source_batch_id, vantaca_account_id, property_id, transaction_date, amount_cents, txn_type, charge_category, reduction_source, raw_row_jsonb')
    .eq('community_id', communityId).gte('transaction_date', since));
  const existingRefs = []; const existingPayments = []; const draftRefs = [];
  for (const r of ledger) {
    const raw = r.raw_row_jsonb || {};
    if (draft.has(r.source_batch_id) && raw.vantaca_ref) draftRefs.push(raw.vantaca_ref);
    if (!live.has(r.source_batch_id)) continue;
    if (raw.vantaca_ref && (raw.source === SOURCE || LEGACY_SOURCES.includes(raw.source))) { existingRefs.push(raw.vantaca_ref); continue; }
    const isPayment = Number(r.amount_cents) < 0 && (r.txn_type === 'payment' || r.reduction_source === 'cash_payment' || r.charge_category === 'payment');
    if (isPayment && (!cutover || r.transaction_date >= cutover)) existingPayments.push({ id: r.id, vantaca_account_id: r.vantaca_account_id, property_id: r.property_id, date: r.transaction_date, amount_cents: -Number(r.amount_cents), source: raw.source || live.get(r.source_batch_id).uploaded_by || 'ledger' });
  }
  // Scanned checks recorded in trustEd (lib/payments/check_receipts).
  const checks = await must(supabase.from('homeowner_check_receipts').select('id, property_id, amount_cents, received_date, status')
    .eq('community_id', communityId).in('status', ['recorded', 'deposited', 'reconciled']).gte('received_date', since).limit(2000), 'check receipts');
  for (const c of checks) existingPayments.push({ id: `chk:${c.id}`, vantaca_account_id: null, property_id: c.property_id, date: c.received_date, amount_cents: Number(c.amount_cents), source: 'check_receipt' });

  // GL roles and accounts.
  const coa = await fetchAll(supabase, 'chart_of_accounts', { select: 'id, account_number, fund_id', filters: { community_id: communityId } });
  const byNum = Object.fromEntries(coa.map((a) => [a.account_number, a]));
  const roles = await must(supabase.from('community_account_roles').select('role, account_id').eq('community_id', communityId), 'account roles');
  const roleNum = (role) => { const r = roles.find((x) => x.role === role); const a = r && coa.find((c) => c.id === r.account_id); return a ? a.account_number : null; };
  const banks = await must(supabase.from('bank_accounts').select('account_last4, gl_account_number, is_active').eq('community_id', communityId), 'bank accounts');
  const cash_by_last4 = {}; for (const b of banks) if (b.account_last4 && b.gl_account_number && b.is_active !== false) cash_by_last4[b.account_last4] = b.gl_account_number;
  const gl = { ar: roleNum('homeowner_ar') || (byNum['1300'] && '1300'), default_cash: roleNum('operating_cash') || (byNum['1000'] && '1000'), cash_by_last4, fee: byNum['1380'] ? '1380' : null };

  // AR credits in the GL since cutover (any source) to catch receipts booked without a ledger row.
  const arAcct = gl.ar && byNum[gl.ar];
  const glArCredits = [];
  const existingJeRefs = new Set();
  if (arAcct) {
    const jes = await fetchAllQuery(() => supabase.from('journal_entries').select('id, reference, posting_date, status, source_module, source_reference, notes').eq('community_id', communityId).gte('posting_date', since));
    const posted = new Map(jes.filter((j) => j.status === 'posted').map((j) => [j.id, j]));
    for (const j of jes) if (j.source_reference) existingJeRefs.add(j.source_reference);
    // Receipt identities listed on posted GL entries ("Items: VPAY:...; VDEP:..."): fees live only there.
    for (const j of jes) if (j.status === 'posted' && j.notes) for (const m of String(j.notes).match(/\bV(?:PAY|DEP):[^;\s]+/g) || []) existingRefs.push(m.replace(/[.,]$/, ''));
    const linkedJe = new Set(ledger.map((r) => (r.raw_row_jsonb || {}).journal_entry_id).filter(Boolean));
    const lines = await fetchAllQuery(() => supabase.from('journal_entry_lines').select('id, journal_entry_id, credit_cents, property_id').eq('account_id', arAcct.id).gt('credit_cents', 0));
    for (const l of lines) {
      const j = posted.get(l.journal_entry_id); if (!j || !l.property_id) continue;
      if (j.source_module === 'opening_entry' || j.source_module === 'reversal') continue;
      glArCredits.push({ line_id: l.id, property_id: l.property_id, date: j.posting_date, amount_cents: Number(l.credit_cents), reference: j.reference, source_module: j.source_module,
        linked: linkedJe.has(j.id) || String(j.source_reference || '').startsWith('VRCPT:') });
    }
  }
  return { community, accounts, existingRefs, draftRefs, existingPayments, glArCredits, existingJeRefs, gl, coa: byNum };
}

// ---------------------------------------------------------------------------
// 4) Post an approved plan (never called by the dry run)
// ---------------------------------------------------------------------------
// Same draft-until-GL pattern as lib/accounting/homeowner_payment.js: the batch stays
// DRAFT (invisible) until every GL entry has posted, then commits. A rerun finds the
// committed refs (already_imported) and the existing JE references, so nothing doubles;
// migration 551's unique indexes refuse a duplicate even from a second writer.
// The original report files, exactly as exported (association_record): one
// vantaca_imports row per file, keyed by sha256, bytes in the private 'documents'
// bucket. Idempotent: a file already registered for this community is reused.
async function preserveSources(supabase, community, files) {
  const out = [];
  for (const f of files || []) {
    const existing = await must(supabase.from('vantaca_imports').select('id, source_storage_path').eq('community_id', community.id).eq('source_sha256', f.sha256).neq('status', 'voided').limit(1), 'source registry');
    if (existing.length) { out.push({ ...f, import_id: existing[0].id, storage_path: existing[0].source_storage_path }); continue; }
    const path = `vantaca-receipts/${community.id}/${f.sha256}.pdf`;
    const { error: upErr } = await supabase.storage.from('documents').upload(path, f.buffer, { contentType: 'application/pdf', upsert: false });
    if (upErr && !/exists|duplicate/i.test(upErr.message)) throw new Error(`store ${f.name}: ${upErr.message}`);
    const [row] = await must(supabase.from('vantaca_imports').insert({
      management_company_id: community.management_company_id, community_id: community.id, report_type: f.report_type, as_of_date: f.period_end || null,
      source: 'manual', source_filename: f.name, source_storage_path: path, source_sha256: f.sha256, source_file_size_bytes: f.buffer.length,
      source_file_mime: 'application/pdf', extraction_row_count: f.row_count, status: 'completed',
    }).select('id'), 'register source');
    out.push({ ...f, import_id: row.id, storage_path: path });
  }
  return out;
}

async function postPlan(supabase, plan, facts, { approvedBy, sourceFiles: files, post = null }) {
  if (!approvedBy) throw new Error('approvedBy required: posting needs a named approval');
  post = post || require('../accounting/posting').postJournalEntry;
  const sourceFiles = await preserveSources(supabase, facts.community, files);
  if (!plan.reconciliation.every_item_in_one_bucket) throw new Error('reconciliation does not tie; refusing to post');
  if (plan.entries.some((e) => !e.balanced)) throw new Error('an entry does not balance; refusing to post');
  const c = facts.community;
  const rows = plan.ledgerRows;
  if (!rows.length && !plan.entries.length) return { status: 'nothing_to_post' };
  const dates = rows.map((r) => r.transaction_date).sort();
  const batch = await must(supabase.from('transaction_upload_batches').insert({
    management_company_id: c.management_company_id, community_id: c.id, period_label: `Vantaca receipts ${dates[0] || ''}..${dates[dates.length - 1] || ''}`.slice(0, 60),
    as_of_date: dates[dates.length - 1] || null, source_format: 'pdf', status: 'draft', uploaded_by: SOURCE,
    source_filename: (sourceFiles || []).map((f) => f.name).join(' + ').slice(0, 250) || null,
    source_storage_path: (sourceFiles || []).map((f) => f.storage_path).filter(Boolean).join(' + ') || null,
    row_count: rows.length, account_count: new Set(rows.map((r) => r.vantaca_account_id)).size,
    total_charges_cents: rows.filter((r) => r.amount_cents > 0).reduce((s, r) => s + r.amount_cents, 0),
    total_payments_cents: -rows.filter((r) => r.amount_cents < 0).reduce((s, r) => s + r.amount_cents, 0),
    min_transaction_date: dates[0] || null, max_transaction_date: dates[dates.length - 1] || null,
    notes: `Vantaca homeowner receipts (Payout Contents + Deposit Register). Approved by ${approvedBy}. Sources: ${(sourceFiles || []).map((f) => `${f.name} sha256 ${f.sha256}`).join('; ')}`,
  }).select('id').single(), 'create batch');
  await must(supabase.from('homeowner_transactions').insert(rows.map((r, i) => ({
    source_batch_id: batch.id, source_row_index: i + 1, community_id: c.id, property_id: r.property_id, tenure_id: r.tenure_id,
    vantaca_account_id: r.vantaca_account_id, transaction_date: r.transaction_date, description: r.description, txn_type: r.txn_type,
    charge_category: r.charge_category, amount_cents: r.amount_cents, reduction_source: r.reduction_source, raw_row_jsonb: r.raw_row_jsonb,
  }))), 'insert ledger rows');
  const posted = [];
  for (const e of plan.entries) {
    if (facts.existingJeRefs.has(e.source_reference)) { posted.push({ ref: e.source_reference, status: 'already_posted' }); continue; }
    const lines = e.lines.map((l) => { const a = facts.coa[l.account]; if (!a) throw new Error(`account ${l.account} missing`); return { account_id: a.id, fund_id: a.fund_id || null, debit_cents: l.debit_cents, credit_cents: l.credit_cents, property_id: l.property_id || null, memo: l.memo }; });
    const r = await post({ community_id: c.id, posting_date: e.posting_date, source_module: 'payment_intake', source_reference: e.source_reference, description: e.description,
      notes: `Vantaca receipts batch ${batch.id}. Items: ${e.items.join('; ')}. Approved by ${approvedBy}.`, lines });
    posted.push({ ref: e.source_reference, status: 'posted', journal_entry_id: r.entry.id, reference: r.entry.reference });
  }
  await must(supabase.from('transaction_upload_batches').update({ status: 'committed', committed_at: new Date().toISOString() }).eq('id', batch.id).eq('status', 'draft'), 'commit batch');
  return { status: 'posted', batch_id: batch.id, entries: posted };
}

module.exports = { normalizeReceipts, planReceipts, buildPostings, reconcile, loadFacts, postPlan, legacyTuple, tupleOf, SOURCE, DUP_WINDOW_DAYS };
