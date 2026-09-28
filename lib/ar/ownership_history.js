// ============================================================================
// lib/ar/ownership_history.js  (Issue #1, 2026-09-28)
// ----------------------------------------------------------------------------
// Property ownership history + per-tenure (per-owner) balances. READ-ONLY: it
// never writes, allocates, adjusts or re-stamps anything. A row that cannot be
// tied to an ownership period from recorded links is shown as Unassigned /
// needs review, never assigned by date.
//
// CANONICAL SOURCE POLICY (one population feeds every tenure balance AND the
// property total, so the two can never disagree or double-count):
//
//   1. homeowner_transactions, COMMITTED upload batches only
//      The owner subledger for every community (the same population as
//      v_homeowner_current_balance / v_current_owner_ledger). Rows in reverted,
//      superseded or pending batches are not live and are ignored (counted).
//
//   2. ar_charges / ar_payments posted natively in trustEd (source_module /
//      source other than 'vantaca_migration'), not voided
//      ADDITIVE: these are real receivables posted with their own GL entry
//      (e.g. certified-letter fees) that are not in homeowner_transactions.
//      A native row is held OUT of every total and listed for review when a
//      live homeowner_transactions row on the same lot has the same signed
//      amount within 3 days (possible mirrored posting).
//
//   3. ar_charges / ar_payments with source 'vantaca_migration'
//      MIRRORS of the imported Vantaca history (open items at conversion). The
//      same economic events are already in homeowner_transactions, so they are
//      never added. Counted and shown for transparency only.
//
//   4. homeowner_ledger_entries
//      A statement display copy (Quail Ridge history + mirrored native
//      postings). Never read here and never counted.
//
// CLOSEOUT CLASSIFICATION (ended tenures). A row dated after the ownership end
// date is "authorized closeout" ONLY when recorded links prove it:
//   the row is a closing payoff (raw_row_jsonb.source = 'closing_payoff'), it is
//   on the tenure the approved ownership proposal names as the SELLER tenure,
//   and that proposal belongs to a CLOSED home sale for the same lot.
// Date proximity alone never qualifies. Every other post-end row is
// "unexpected post-end activity" and puts the tenure in review.
//
// UNKNOWN: an ended tenure with no live ledger rows has no ledger data for that
// ownership period (pre-ledger history). It is Unknown, never $0 / closed.
// ============================================================================

const { fetchAll, fetchAllQuery } = require('../db/fetch_all');

const DUP_WINDOW_DAYS = 3;
const MIRROR_SOURCE = 'vantaca_migration';
const DEAD_CHARGE = new Set(['voided']);
const DEAD_PAYMENT = new Set(['voided', 'returned_nsf']);

const day = (d) => (d ? String(d).slice(0, 10) : null);
const dayDiff = (a, b) => Math.abs(Date.parse(day(a)) - Date.parse(day(b))) / 86400000;
const sum = (rows) => rows.reduce((s, r) => s + r.amount_cents, 0);

const STATUS = {
  current: { code: 'current', icon: '', label: 'Current owner' },
  closed_clean: { code: 'closed_clean', icon: '✓', label: 'Closed cleanly' },
  debit_remains: { code: 'debit_remains', icon: '⚠', label: 'Prior-owner balance remains' },
  credit_remains: { code: 'credit_remains', icon: '⚠', label: 'Prior-owner credit remains' },
  post_end_review: { code: 'post_end_review', icon: '⚠', label: 'Activity after ownership ended: review' },
  unknown: { code: 'unknown', icon: '⚠', label: 'Unknown: no ledger data for this ownership period' },
  legacy_unlinked: { code: 'legacy_unlinked', icon: '⚠', label: 'Legacy account: property/owner not linked' },
};

// ---------------------------------------------------------------------------
// Normalisation: every source becomes { key, source, date, amount_cents (+ =
// owed to the HOA), ... } so one ledger/running balance covers all of them.
// ---------------------------------------------------------------------------
function normalizeHt(r, batch) {
  return {
    key: 'ht:' + r.id, source: 'homeowner_transactions', id: r.id,
    date: day(r.transaction_date), description: r.description || '', type: r.txn_type || null,
    category: r.charge_category || null, amount_cents: Number(r.amount_cents) || 0,
    tenure_id: r.tenure_id || null, property_id: r.property_id || null, created_at: r.created_at || null,
    batch_label: batch ? batch.period_label || null : null,
    opening: r.txn_type === 'balance_brought_forward' || /^conversion:/.test((batch && batch.uploaded_by) || ''),
    closing_payoff: r.raw_source === 'closing_payoff'
      ? { home_sale_id: r.raw_home_sale_id || null, proposal_id: r.raw_proposal_id || null, check_number: r.raw_check_number || null }
      : null,
    reverses_txn_id: r.reverses_txn_id || null,
  };
}
function normalizeCharge(c) {
  return {
    key: 'arc:' + c.id, source: 'ar_charges', id: c.id, date: day(c.charge_date), description: c.description || 'Charge',
    type: 'charge', category: c.source_module || null, amount_cents: Number(c.original_amount_cents) || 0,
    tenure_id: c.tenure_id || null, property_id: c.property_id || null, created_at: c.created_at || null,
    source_module: c.source_module, journal_entry_id: c.posting_journal_entry_id || null, opening: false, closing_payoff: null,
  };
}
function normalizePayment(p) {
  return {
    key: 'arp:' + p.id, source: 'ar_payments', id: p.id, date: day(p.payment_date), description: `Payment (${p.source || 'unknown'})`,
    type: 'payment', category: 'payment', amount_cents: -(Number(p.amount_cents) || 0),
    tenure_id: p.tenure_id || null, property_id: p.property_id || null, created_at: p.created_at || null,
    source_module: p.source, journal_entry_id: p.posting_journal_entry_id || null, opening: false, closing_payoff: null,
  };
}

// Deterministic ledger order: date, opening balances first, then entry time, key.
function ledgerOrder(a, b) {
  return String(a.date || '').localeCompare(String(b.date || ''))
    || (Number(b.opening) - Number(a.opening))
    || String(a.created_at || '').localeCompare(String(b.created_at || ''))
    || a.key.localeCompare(b.key);
}

// Apply the source policy to raw inputs. Returns the ONE live population plus
// what was excluded and why.
function canonicalPopulation({ htRows = [], batches = [], arCharges = [], arPayments = [] }) {
  const batchById = new Map(batches.map((b) => [b.id, b]));
  const live = [], excluded = { non_live_rows: 0, mirror_rows: [], voided_rows: 0, possible_duplicates: [] };
  const htLive = [];
  for (const r of htRows) {
    const b = batchById.get(r.source_batch_id);
    if (!b || b.status !== 'committed') { excluded.non_live_rows++; continue; }
    htLive.push(normalizeHt(r, b));
  }
  live.push(...htLive);
  const natives = [];
  for (const c of arCharges) {
    if (DEAD_CHARGE.has(c.status)) { excluded.voided_rows++; continue; }
    const n = normalizeCharge(c);
    if (c.source_module === MIRROR_SOURCE) excluded.mirror_rows.push(n); else natives.push(n);
  }
  for (const p of arPayments) {
    if (DEAD_PAYMENT.has(p.status)) { excluded.voided_rows++; continue; }
    const n = normalizePayment(p);
    if (p.source === MIRROR_SOURCE) excluded.mirror_rows.push(n); else natives.push(n);
  }
  // Possible mirrored posting: same lot, same signed amount, within the window,
  // each ledger row matched at most once.
  const used = new Set();
  for (const n of natives) {
    const hit = htLive.find((h) => !used.has(h.key) && h.property_id && h.property_id === n.property_id
      && h.amount_cents === n.amount_cents && dayDiff(h.date, n.date) <= DUP_WINDOW_DAYS);
    if (hit) { used.add(hit.key); excluded.possible_duplicates.push({ ...n, matches: hit.key, reason: `Same amount on the homeowner ledger ${hit.date}: possible duplicate posting, held out of every total` }); continue; }
    live.push(n);
  }
  return { live, excluded };
}

// ---------------------------------------------------------------------------
// One tenure: ledger with running balance, and for ended tenures the split into
// balance at ownership end / authorized closeout / unexpected post-end.
// ---------------------------------------------------------------------------
function isAuthorizedCloseout(row, tenure, proposals, sales) {
  const cp = row.closing_payoff;
  if (!cp || !tenure.end_date || row.date < tenure.end_date) return false;
  const prop = proposals.find((p) => p.id === cp.proposal_id);
  if (!prop || prop.status !== 'approved' || prop.seller_tenure_id !== tenure.id) return false;
  const sale = sales.find((s) => s.id === cp.home_sale_id);
  return !!(sale && sale.status === 'closed' && sale.property_id === tenure.property_id && sale.ownership_proposal_id === prop.id);
}

function balanceLabel(cents) {
  if (cents === 0) return '$0.00';
  const s = '$' + (Math.abs(cents) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return cents > 0 ? `${s} due` : `(${s}) credit`;
}

function buildTenure(tenure, rows, { owners = [], proposals = [], sales = [] } = {}) {
  const ledger = rows.slice().sort(ledgerOrder);
  let run = 0;
  const end = tenure.end_date ? day(tenure.end_date) : null;
  const start = tenure.start_date ? day(tenure.start_date) : null;
  const out = ledger.map((r) => {
    run += r.amount_cents;
    const flags = [];
    let klass = 'in_period';
    if (end && r.date > end) klass = 'post_end';
    if (isAuthorizedCloseout(r, tenure, proposals, sales)) klass = 'closeout';
    else if (r.closing_payoff && end && r.date > end) flags.push('closing payoff whose sale / seller-tenure link could not be verified');
    if (klass === 'post_end') flags.push('posted after ownership ended');
    if (r.opening) flags.push('opening / conversion balance');
    if (start && r.date < start && tenure.origin === 'transfer' && !r.opening) flags.push('dated before this ownership began');
    if (r.property_id && tenure.property_id && r.property_id !== tenure.property_id) flags.push('row is tagged to a different lot');
    return { ...r, class: klass, flags, running_balance_cents: run };
  });
  const names = owners.filter((o) => o.tenure_id === tenure.id)
    .sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || String(a.name).localeCompare(String(b.name)))
    .map((o) => o.name).filter(Boolean);
  const base = {
    tenure_id: tenure.id, kind: tenure.kind, origin: tenure.origin || null, property_id: tenure.property_id || null,
    community_id: tenure.community_id || null, vantaca_account_id: tenure.vantaca_account_id || null,
    start_date: start, end_date: end, is_current: tenure.kind === 'owner' && !end, owners: [...new Set(names)],
    ledger: out, has_ledger_data: out.length > 0, balance_cents: run,
    last_transaction_date: out.length ? out[out.length - 1].date : null,
    first_transaction_date: out.length ? out[0].date : null,
    has_opening_balance: out.some((r) => r.opening),
    review_flags: out.filter((r) => r.flags.some((f) => f !== 'opening / conversion balance')).map((r) => ({ key: r.key, date: r.date, amount_cents: r.amount_cents, flags: r.flags.filter((f) => f !== 'opening / conversion balance') })),
  };
  if (tenure.kind === 'legacy') {
    return { ...base, status: base.balance_cents === 0 ? { ...STATUS.closed_clean, label: 'Legacy account at $0.00 (property/owner not linked)' } : STATUS.legacy_unlinked, balance_label: balanceLabel(run) };
  }
  if (!end) return { ...base, status: STATUS.current, balance_label: balanceLabel(run) };
  if (!out.length) return { ...base, status: STATUS.unknown, balance_label: 'Unknown', balance_at_end_cents: null, final_balance_cents: null };
  const beforeCloseout = out.filter((r) => r.class === 'in_period');
  const closeout = out.filter((r) => r.class === 'closeout');
  const postEnd = out.filter((r) => r.class === 'post_end');
  const atEnd = sum(beforeCloseout);
  const final = run;
  let status;
  if (postEnd.length) status = STATUS.post_end_review;
  else if (final === 0) status = STATUS.closed_clean;
  else status = final > 0 ? STATUS.debit_remains : STATUS.credit_remains;
  return {
    ...base, status, balance_label: balanceLabel(final),
    balance_at_end_cents: atEnd,
    closeout: closeout.map((r) => ({ key: r.key, date: r.date, amount_cents: r.amount_cents, description: r.description, check_number: r.closing_payoff && r.closing_payoff.check_number, note: r.date > end ? 'Closing payoff posted after ownership end as part of closing' : 'Closing payoff' })),
    closeout_cents: sum(closeout),
    unexpected_post_end: postEnd.map((r) => ({ key: r.key, date: r.date, amount_cents: r.amount_cents, description: r.description, type: r.type })),
    unexpected_post_end_cents: sum(postEnd),
    final_balance_cents: final,
  };
}

// ---------------------------------------------------------------------------
// One property: every tenure + unassigned rows + reconciliation.
// ---------------------------------------------------------------------------
function buildPropertyHistory({ property, tenures = [], owners = [], proposals = [], sales = [], population, currentOwnerView = null }) {
  const pid = property.id;
  const mine = tenures.filter((t) => t.property_id === pid);
  const mineIds = new Set(mine.map((t) => t.id));
  const { live, excluded } = population;
  const byTenure = new Map(mine.map((t) => [t.id, []]));
  const unassigned = [], foreign = [];
  for (const r of live) {
    if (r.tenure_id && mineIds.has(r.tenure_id)) byTenure.get(r.tenure_id).push(r);
    else if (r.property_id === pid && !r.tenure_id) unassigned.push({ ...r, reason: 'No ownership period recorded on this row' });
    else if (r.property_id === pid) foreign.push({ ...r, reason: 'Row on this lot is stamped to another account (legacy or another lot)' });
  }
  const built = mine.map((t) => buildTenure(t, byTenure.get(t.id), { owners, proposals, sales }))
    .sort((a, b) => Number(b.is_current) - Number(a.is_current) || String(b.start_date || '').localeCompare(String(a.start_date || '')));
  const current = built.filter((t) => t.is_current);
  const prior = built.filter((t) => !t.is_current);
  const sumTenures = built.reduce((s, t) => s + t.balance_cents, 0);
  const unassignedCents = sum(unassigned);
  const mineDup = excluded.possible_duplicates.filter((d) => d.property_id === pid);
  const reasons = [];
  if (unassigned.length) reasons.push(`${unassigned.length} live row(s) on this lot have no ownership period`);
  if (foreign.length) reasons.push(`${foreign.length} row(s) on this lot are stamped to another account`);
  if (mineDup.length) reasons.push(`${mineDup.length} possible duplicate posting(s) held out of the totals`);
  if (current.length > 1) reasons.push('more than one current owner period');
  const reviewTenures = built.filter((t) => t.review_flags.length);
  if (reviewTenures.length) reasons.push(`${reviewTenures.length} ownership period(s) have rows flagged for review`);
  const cur = current[0] || null;
  let currentCheck = null;
  if (cur && currentOwnerView) {
    const nativeOnCurrent = cur.ledger.filter((r) => r.source !== 'homeowner_transactions').reduce((s, r) => s + r.amount_cents, 0);
    const viewCents = Number(currentOwnerView.balance_cents) || 0;
    currentCheck = {
      history_cents: cur.balance_cents, current_owner_view_cents: viewCents,
      native_trusted_postings_cents: nativeOnCurrent,
      ties: cur.balance_cents - nativeOnCurrent === viewCents,
      note: nativeOnCurrent ? 'The current-balance screens read the homeowner ledger only; trustEd-native charges/payments on this owner are included here and not there.' : null,
    };
    if (!currentCheck.ties) reasons.push('current-owner balance does not match the current-balance view');
  }
  return {
    property: { id: pid, community_id: property.community_id, address: [property.street_address, property.unit ? '#' + property.unit : ''].filter(Boolean).join(' ') },
    current_owner: cur, prior_owners: prior,
    unassigned: unassigned.sort(ledgerOrder), unassigned_cents: unassignedCents,
    stamped_elsewhere: foreign.sort(ledgerOrder),
    possible_duplicates: mineDup,
    excluded: {
      non_live_rows: excluded.non_live_rows, voided_rows: excluded.voided_rows,
      mirror_rows: excluded.mirror_rows.filter((m) => m.property_id === pid).length,
    },
    reconciliation: {
      scope: 'Owner subledger only: committed homeowner ledger + trustEd-native AR postings (source policy in lib/ar/ownership_history.js). This is not a GL proof.',
      property_total_cents: sumTenures + unassignedCents,
      sum_of_tenures_cents: sumTenures, unassigned_cents: unassignedCents,
      current_balance_check: currentCheck,
      clean: reasons.length === 0, reasons,
    },
  };
}

// ---------------------------------------------------------------------------
// Loaders (read-only)
// ---------------------------------------------------------------------------
const HT_COLS = 'id, source_batch_id, community_id, property_id, tenure_id, transaction_date, description, txn_type, charge_category, amount_cents, created_at, reverses_txn_id, raw_source:raw_row_jsonb->>source, raw_home_sale_id:raw_row_jsonb->>home_sale_id, raw_proposal_id:raw_row_jsonb->>ownership_proposal_id, raw_check_number:raw_row_jsonb->>check_number';
const ARC_COLS = 'id, community_id, property_id, tenure_id, charge_date, description, original_amount_cents, status, source_module, posting_journal_entry_id, created_at';
const ARP_COLS = 'id, community_id, property_id, tenure_id, payment_date, amount_cents, source, status, posting_journal_entry_id, created_at';

async function inChunks(ids, fn, size = 150) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(...await fn(ids.slice(i, i + size))); // eslint-disable-line no-await-in-loop
  return out;
}

async function loadSupport(supabase, tenures) {
  const tIds = tenures.map((t) => t.id);
  const owners = (await inChunks(tIds, (ids) => fetchAll(supabase, 'property_ownerships', { select: 'id, tenure_id, is_primary, contacts(full_name)', filters: { tenure_id: ids } })))
    .map((o) => ({ tenure_id: o.tenure_id, is_primary: !!o.is_primary, name: o.contacts && o.contacts.full_name }));
  const proposals = await inChunks(tIds, (ids) => fetchAll(supabase, 'ownership_change_proposals', { select: 'id, status, seller_tenure_id, buyer_tenure_id, home_sale_id', filters: { seller_tenure_id: ids } }));
  const saleIds = [...new Set(proposals.map((p) => p.home_sale_id).filter(Boolean))];
  const sales = await inChunks(saleIds, (ids) => fetchAll(supabase, 'home_sales', { select: 'id, property_id, status, closing_date, ownership_proposal_id, seller_final_balance_cents', filters: { id: ids } }));
  return { owners, proposals, sales };
}

async function batchesFor(supabase, htRows) {
  const ids = [...new Set(htRows.map((r) => r.source_batch_id).filter(Boolean))];
  return inChunks(ids, (c) => fetchAll(supabase, 'transaction_upload_batches', { select: 'id, status, uploaded_by, period_label', filters: { id: c } }));
}

async function propertyOwnershipHistory(supabase, propertyId) {
  const { data: property, error } = await supabase.from('properties').select('id, community_id, street_address, unit').eq('id', propertyId).maybeSingle();
  if (error) throw error;
  if (!property) return null;
  const tenures = await fetchAll(supabase, 'ownership_tenures', { select: 'id, community_id, property_id, kind, start_date, end_date, vantaca_account_id, origin', filters: { property_id: propertyId } });
  const tIds = tenures.map((t) => t.id);
  const htByProp = await fetchAllQuery(() => supabase.from('homeowner_transactions').select(HT_COLS).eq('property_id', propertyId));
  const htByTenure = tIds.length ? await fetchAllQuery(() => supabase.from('homeowner_transactions').select(HT_COLS).in('tenure_id', tIds).or(`property_id.is.null,property_id.neq.${propertyId}`)) : [];
  const htRows = [...htByProp, ...htByTenure];
  const [batches, arCharges, arPayments, support] = await Promise.all([
    batchesFor(supabase, htRows),
    fetchAll(supabase, 'ar_charges', { select: ARC_COLS, filters: { property_id: propertyId } }),
    fetchAll(supabase, 'ar_payments', { select: ARP_COLS, filters: { property_id: propertyId } }),
    loadSupport(supabase, tenures),
  ]);
  const { data: view, error: vErr } = await supabase.from('v_current_owner_balance').select('balance_cents, tenure_id').eq('property_id', propertyId);
  if (vErr) throw vErr;
  const population = canonicalPopulation({ htRows, batches, arCharges, arPayments });
  return buildPropertyHistory({ property, tenures, ...support, population, currentOwnerView: (view && view[0]) || { balance_cents: 0 } });
}

// ---------------------------------------------------------------------------
// Former owners with non-zero balances (one community, or all).
// filters: { side: 'debit'|'credit', ended_from, ended_to, conversion_only,
//            include_unknown, include_legacy (default true), include_clean }
// ---------------------------------------------------------------------------
function exceptionRows(histories, legacyTenures, communityName, filters = {}) {
  const rows = [];
  for (const h of histories) {
    for (const t of h.prior_owners) {
      rows.push({
        community_id: h.property.community_id, community: communityName(h.property.community_id),
        property_id: h.property.id, address: h.property.address, tenure_id: t.tenure_id,
        prior_owner: t.owners.join(' & ') || null, start_date: t.start_date, end_date: t.end_date, origin: t.origin,
        balance_at_end_cents: t.balance_at_end_cents, closeout_cents: t.closeout_cents || 0,
        unexpected_post_end_cents: t.unexpected_post_end_cents || 0, final_balance_cents: t.final_balance_cents,
        last_transaction_date: t.last_transaction_date, closeout: t.closeout || [],
        conversion: t.has_opening_balance || /^backfill/.test(t.origin || ''),
        status: t.status, kind: 'owner',
      });
    }
  }
  for (const t of legacyTenures) {
    rows.push({
      community_id: t.community_id, community: communityName(t.community_id), property_id: null, address: null,
      tenure_id: t.tenure_id, prior_owner: null, vantaca_account_id: t.vantaca_account_id, start_date: t.start_date, end_date: t.end_date,
      origin: t.origin, balance_at_end_cents: null, closeout_cents: 0, unexpected_post_end_cents: 0,
      final_balance_cents: t.balance_cents, last_transaction_date: t.last_transaction_date, closeout: [],
      conversion: true, status: t.status, kind: 'legacy',
    });
  }
  const summary = { closed_clean: 0, debit_remains: 0, credit_remains: 0, post_end_review: 0, unknown: 0, legacy_nonzero: 0, legacy_zero: 0 };
  for (const r of rows) {
    if (r.kind === 'legacy') summary[r.final_balance_cents === 0 ? 'legacy_zero' : 'legacy_nonzero']++;
    else summary[r.status.code] = (summary[r.status.code] || 0) + 1;
  }
  const f = filters;
  const shown = rows.filter((r) => {
    if (r.kind === 'legacy') { if (f.include_legacy === false) return false; if (r.final_balance_cents === 0 && !f.include_clean) return false; }
    else if (r.status.code === 'unknown') { if (!f.include_unknown) return false; }
    else if (r.status.code === 'closed_clean' && !f.include_clean) return false;
    if (f.side === 'debit' && !(r.final_balance_cents > 0)) return false;
    if (f.side === 'credit' && !(r.final_balance_cents < 0)) return false;
    if (f.ended_from && (!r.end_date || r.end_date < f.ended_from)) return false;
    if (f.ended_to && (!r.end_date || r.end_date > f.ended_to)) return false;
    if (f.conversion_only && !r.conversion) return false;
    return true;
  }).sort((a, b) => String(a.community).localeCompare(String(b.community)) || Number(a.kind === 'legacy') - Number(b.kind === 'legacy')
    || String(a.address || a.vantaca_account_id || '').localeCompare(String(b.address || b.vantaca_account_id || '')));
  return { rows: shown, summary, counts_note: 'Unknown periods have no ledger data and are never counted as $0 or cleared.' };
}

async function communityHistories(supabase, communityId) {
  const tenures = await fetchAll(supabase, 'ownership_tenures', { select: 'id, community_id, property_id, kind, start_date, end_date, vantaca_account_id, origin', filters: { community_id: communityId } });
  const htRows = await fetchAll(supabase, 'homeowner_transactions', { select: HT_COLS, filters: { community_id: communityId } });
  const [batches, arCharges, arPayments, support, props] = await Promise.all([
    batchesFor(supabase, htRows),
    fetchAll(supabase, 'ar_charges', { select: ARC_COLS, filters: { community_id: communityId } }),
    fetchAll(supabase, 'ar_payments', { select: ARP_COLS, filters: { community_id: communityId } }),
    loadSupport(supabase, tenures.filter((t) => t.kind === 'owner' && t.end_date || t.kind === 'legacy')),
    fetchAll(supabase, 'properties', { select: 'id, community_id, street_address, unit', filters: { community_id: communityId } }),
  ]);
  const population = canonicalPopulation({ htRows, batches, arCharges, arPayments });
  // Only lots with a prior owner are built (the report is about former owners).
  const withPrior = new Set(tenures.filter((t) => t.kind === 'owner' && t.end_date).map((t) => t.property_id));
  const propById = new Map(props.map((p) => [p.id, p]));
  const histories = [...withPrior].filter((pid) => propById.has(pid)).map((pid) => buildPropertyHistory({ property: propById.get(pid), tenures, ...support, population }));
  const legacyRows = new Map(tenures.filter((t) => t.kind === 'legacy').map((t) => [t.id, []]));
  for (const r of population.live) if (r.tenure_id && legacyRows.has(r.tenure_id)) legacyRows.get(r.tenure_id).push(r);
  const legacy = tenures.filter((t) => t.kind === 'legacy').map((t) => buildTenure(t, legacyRows.get(t.id), support));
  const subledgerTotal = sum(population.live); // every live row in this community, incl. legacy + unassigned
  return { histories, legacy, subledger_total_cents: subledgerTotal, excluded: {
    non_live_rows: population.excluded.non_live_rows, mirror_rows: population.excluded.mirror_rows.length,
    voided_rows: population.excluded.voided_rows, possible_duplicates: population.excluded.possible_duplicates.length } };
}

// Informational only: the GL AR control (1300 receivable + 2400 prepaid) next to
// the owner-subledger population. Not tenure-aware; never "proves" a tenure.
async function glArControl(supabase, communityId, subledgerCents) {
  const { data, error } = await supabase.from('v_trial_balance').select('account_number, total_debits_cents, total_credits_cents').eq('community_id', communityId).in('account_number', ['1300', '2400']);
  if (error) throw error;
  const gl = (data || []).reduce((s, r) => s + (Number(r.total_debits_cents || 0) - Number(r.total_credits_cents || 0)), 0);
  return {
    informational: true, gl_1300_2400_net_cents: gl, subledger_cents: subledgerCents, variance_cents: subledgerCents - gl,
    note: 'Informational control. The GL AR tie-out is not tenure-aware, so this does not prove any individual owner balance.',
  };
}

async function formerOwnerExceptions(supabase, { communityId = null, filters = {} } = {}) {
  const comms = await fetchAll(supabase, 'communities', { select: 'id, name' });
  const name = (id) => (comms.find((c) => c.id === id) || {}).name || null;
  const targets = communityId ? [communityId] : comms.map((c) => c.id);
  const rows = [], summary = {}, controls = [];
  for (const cid of targets) {
    const h = await communityHistories(supabase, cid); // eslint-disable-line no-await-in-loop
    if (!h.histories.length && !h.legacy.length) continue;
    const r = exceptionRows(h.histories, h.legacy, name, filters);
    rows.push(...r.rows);
    for (const [k, v] of Object.entries(r.summary)) summary[k] = (summary[k] || 0) + v;
    controls.push({ community_id: cid, community: name(cid), excluded: h.excluded, gl_control: await glArControl(supabase, cid, h.subledger_total_cents) }); // eslint-disable-line no-await-in-loop
  }
  return { rows, summary, controls, counts_note: 'Unknown periods have no ledger data and are never counted as $0 or cleared.', filters };
}

// Owner/tenure context for the transaction summary: only from a recorded
// tenure_id, never inferred from dates.
async function tenureContext(supabase, tenureId) {
  if (!tenureId) return null;
  const { data: t, error } = await supabase.from('ownership_tenures').select('id, property_id, kind, start_date, end_date').eq('id', tenureId).maybeSingle();
  if (error) throw error;
  if (!t) return null;
  const { data: os, error: oErr } = await supabase.from('property_ownerships').select('is_primary, contacts(full_name)').eq('tenure_id', tenureId);
  if (oErr) throw oErr;
  const names = [...new Set((os || []).sort((a, b) => Number(b.is_primary) - Number(a.is_primary)).map((o) => o.contacts && o.contacts.full_name).filter(Boolean))];
  return { tenure_id: t.id, property_id: t.property_id, kind: t.kind, start_date: day(t.start_date), end_date: day(t.end_date), owners: names };
}

module.exports = {
  canonicalPopulation, buildTenure, buildPropertyHistory, exceptionRows, isAuthorizedCloseout, balanceLabel,
  propertyOwnershipHistory, formerOwnerExceptions, tenureContext, STATUS, DUP_WINDOW_DAYS,
};
