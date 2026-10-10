// ============================================================================
// lib/accounting/transfer_activity.js  (Ed 2026-10-10)
// ----------------------------------------------------------------------------
// What the BOOKS show for a configured interfund transfer over a period. Read-only.
// The budget line and the account configuration never prove a transfer happened:
// only posted entries on the transfer account do, and only for the months trustEd
// holds in detail.
//
//   confirmed               posted entries move money in the configured direction
//   offsetting              posted entries record BOTH sides on the transfer account
//                           (the Vantaca convention: Dr and Cr on 4010 net to zero).
//                           Net zero is NOT "no transfer": the gross amount is shown.
//   not_found               trustEd holds every month of the period in detail and no
//                           entry touches the transfer account
//   requires_reconciliation part of the period is not in trustEd detail (activity carried
//                           from the prior system as one balance, or history starts
//                           later), or the entries run against the configured direction.
//                           No amount is shown (never an unsupported $0).
// ============================================================================

const STATUS_LABEL = {
  confirmed: 'Recorded',
  offsetting: 'Recorded through offsetting entries',
  not_found: 'No transfer found in the accounting records',
  requires_reconciliation: 'Needs reconciliation',
};
const int = (n) => Math.round(Number(n) || 0);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayLabel = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };

/**
 * Pure. lines: posted (counted, non-opening) entries on ONE transfer account in [from, to]:
 *   [{ debit_cents, credit_cents, posting_date }]
 * account_type 'revenue'|'expense'; recorded_leg 'outgoing'|'incoming' (from the budget line);
 * detail_from: first date trustEd holds this community's activity in detail (null = whole period).
 */
function classifyTransferActivity({ lines = [], account_type, recorded_leg, from, to, detail_from = null }) {
  const dr = lines.reduce((t, l) => t + int(l.debit_cents), 0);
  const cr = lines.reduce((t, l) => t + int(l.credit_cents), 0);
  // A transfer recorded on the outgoing side debits the account (a negative revenue line or an
  // expense); on the incoming side it credits it.
  const directional = account_type === 'expense' || recorded_leg === 'outgoing' ? dr - cr : cr - dr;
  const gap = !!(detail_from && String(detail_from) > String(from));
  const base = { debits_cents: dr, credits_cents: cr, line_count: lines.length, from, to, detail_from: gap ? detail_from : null };
  const coverage = gap ? `Activity before ${dayLabel(detail_from)} was carried from the prior accounting system as balances, so transfers in that part of the period are not visible in trustEd.` : null;
  if (gap) {
    const seen = lines.length ? ` trustEd shows ${dr === cr ? `offsetting entries of ${fmt(dr)}` : `${fmt(Math.abs(directional))} recorded`} from ${dayLabel(detail_from)}.` : ` No transfer entry is recorded from ${dayLabel(detail_from)} through ${dayLabel(to)}.`;
    return { ...base, status: 'requires_reconciliation', amount_cents: null, note: `${coverage}${seen} Reconcile against the bank and fund records.` };
  }
  if (!lines.length) return { ...base, status: 'not_found', amount_cents: 0, note: `No entry on this account from ${dayLabel(from)} through ${dayLabel(to)}.` };
  if (dr === cr) return { ...base, status: 'offsetting', amount_cents: dr, note: `Both sides were recorded on this account (debits and credits of ${fmt(dr)} each), so its balance nets to zero. Confirm the cash moved between the funds.` };
  if (directional > 0) return { ...base, status: 'confirmed', amount_cents: directional, note: `${fmt(directional)} recorded from ${dayLabel(from)} through ${dayLabel(to)}.` };
  return { ...base, status: 'requires_reconciliation', amount_cents: null, note: `Entries on this account run against the configured direction (debits ${fmt(dr)}, credits ${fmt(cr)}). Reconcile before relying on the transfer amount.` };
}
const fmt = (c) => `$${(Math.abs(int(c)) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

/**
 * Read-only: classify every configured transfer account for [from, to].
 * transfers: [{ account_id, account_type, recorded_leg }]; windows: statement_periods.loadWindows output.
 */
async function loadTransferActivity(supabase, { community_id, transfers = [], from, to, windows = [] }) {
  if (!transfers.length) return {};
  const { COUNTED_JE_STATUSES } = require('./je_status');
  const ids = transfers.map((t) => t.account_id);
  const { data, error } = await supabase.from('journal_entry_lines')
    .select('account_id, debit_cents, credit_cents, journal_entries!inner(community_id, posting_date, status, source_module)')
    .in('account_id', ids).eq('journal_entries.community_id', community_id)
    .gte('journal_entries.posting_date', from).lte('journal_entries.posting_date', to)
    .in('journal_entries.status', COUNTED_JE_STATUSES).order('id').limit(5000);   // paginate-ok: bounded to a few transfer accounts in one fiscal year
  if (error) throw Object.assign(new Error(`transfer activity: ${error.message}`), { code: error.code });
  // trustEd holds detail from the day after the latest carryforward window, or from the first posted entry.
  const through = (windows || []).map((w) => w.through).filter(Boolean).sort().pop() || null;
  const afterThrough = through ? new Date(Date.UTC(+through.slice(0, 4), +through.slice(5, 7) - 1, +through.slice(8, 10) + 1)).toISOString().slice(0, 10) : null;
  const detailFrom = afterThrough || (windows && windows.history_start) || null;
  const out = {};
  for (const t of transfers) {
    const lines = (data || []).filter((l) => l.account_id === t.account_id && l.journal_entries.source_module !== 'opening_entry')
      .map((l) => ({ debit_cents: l.debit_cents, credit_cents: l.credit_cents, posting_date: l.journal_entries.posting_date }));
    out[t.account_id] = classifyTransferActivity({ lines, account_type: t.account_type, recorded_leg: t.recorded_leg, from, to, detail_from: detailFrom });
    out[t.account_id].status_label = STATUS_LABEL[out[t.account_id].status];
  }
  return out;
}

module.exports = { classifyTransferActivity, loadTransferActivity, STATUS_LABEL };
