// ============================================================================
// lib/accounting/builder_accrual.js  (Ed 2026-10-08, GitHub issue #96)
// ----------------------------------------------------------------------------
// The monthly builder-assessment accrual after a community's conversion
// (Still Creek / Lennar). Each completed month a builder owns a lot, it is billed
// its builder-rate share of that month: round(annual x pct x days / (100 x
// days_in_year)), December carrying the year-end rounding true-up so a full year
// is exactly annual x pct ($247.50 at Still Creek). Coverage always continues
// from the day after the last covered day, so nothing overlaps and nothing is
// skipped; a lot that cannot be continued is BLOCKED and listed, never skipped.
//
//   preview(communityId, through)          builder_accrual_plan: read-only.
//   run({ communityId, through, actor })   1. builder_accrual_stage (mig 501):
//                                             draft batch + ledger rows + pending
//                                             coverage (or the unfinished run)
//                                          2. per month: the GL entry through
//                                             postJournalEntry, Dr 1300 per lot /
//                                             Cr income, keyed to batch + month
//                                          3. builder_accrual_finish: the entry
//                                             must equal the month's coverage;
//                                             marks it posted; commits the batch
// A failure part-way leaves pending coverage (the transfer blocks on it, the
// status shows RED) and the next run finishes the same run: never a second one.
//
// Scheduler job 'builder_assessment_accrual' (lib/scheduler.js) is OFF unless
// SCHEDULER_ENABLED names it; it runs on the 3rd for the month just ended.
// ============================================================================
const { postJournalEntry } = require('./posting');

const lastDayOfPrevMonth = (d) => { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)); return t.toISOString().slice(0, 10); };
const isMonthEnd = (s) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.getUTCDate() === 1; };

function _err(e) { return Object.assign(new Error(e.message || String(e)), { code: e.code, details: e.details }); }

async function preview(supabase, { communityId, through }) {
  if (!communityId) throw new Error('community_id required');
  if (!through || !isMonthEnd(through)) throw new Error('through must be a month end (YYYY-MM-DD)');
  const { data, error } = await supabase.rpc('builder_accrual_plan', { p_community_id: communityId, p_through: through });
  if (error) throw _err(error);
  return data;
}

async function _accounts(supabase, communityId, incomeNo) {
  const want = ['1300', incomeNo || '4000'];
  const { data, error } = await supabase.from('chart_of_accounts').select('id, account_number').eq('community_id', communityId).in('account_number', want);
  if (error) throw _err(error);
  const by = Object.fromEntries((data || []).map((a) => [a.account_number, a.id]));
  const missing = want.filter((n) => !by[n]);
  if (missing.length) throw new Error(`accounts ${missing.join('/')} missing for this community`);
  return by;
}

// The month's GL lines: one AR debit per lot (so the receivable names the lot), one income credit.
function monthLines(acct, incomeNo, month) {
  const lines = month.lines.map((l) => ({ account_id: acct['1300'], debit_cents: Number(l.amount_cents), credit_cents: 0, property_id: l.property_id,
    memo: `Builder assessment ${l.from} to ${l.through}${Number(l.rounding_true_up_cents) ? ` (incl. year-end rounding true-up ${l.rounding_true_up_cents} cents)` : ''}` }));
  lines.push({ account_id: acct[incomeNo], debit_cents: 0, credit_cents: Number(month.amount_cents), memo: `Builder assessments earned through ${month.month_end}` });
  return lines;
}

async function run(supabase, { communityId, through, actor, post = postJournalEntry }) {
  if (!actor) throw new Error('actor required');
  if (!through || !isMonthEnd(through)) throw new Error('through must be a month end (YYYY-MM-DD)');
  const { data: staged, error } = await supabase.rpc('builder_accrual_stage', { p_community_id: communityId, p_through: through, p_actor: actor });
  if (error) throw _err(error);
  if (!staged || staged.status === 'nothing_to_accrue') return { status: 'nothing_to_accrue', plan: staged && staged.plan };
  const acct = await _accounts(supabase, communityId, staged.income_account_number);
  let view = staged; const posted = [];
  for (const month of staged.months) {
    if (!Number(month.pending)) continue;
    const sourceRef = `${staged.batch_id}:${month.month_end.slice(0, 7)}`;
    const { data: je0, error: e0 } = await supabase.from('journal_entries').select('id, reference, status')
      .eq('community_id', communityId).eq('source_module', 'assessment_billing').eq('source_reference', sourceRef).maybeSingle();
    if (e0) throw _err(e0);
    let entry = je0;
    if (!entry) {
      const r = await post({
        community_id: communityId, posting_date: month.month_end, source_module: 'assessment_billing', source_reference: sourceRef,
        description: `Builder assessments ${month.month_end.slice(0, 7)} (${month.periods} lot-period${Number(month.periods) === 1 ? '' : 's'})`,
        notes: `Builder assessment accrual run ${staged.run_id}; subledger batch ${staged.batch_id}; issue #96`,
        lines: monthLines(acct, staged.income_account_number, month),
      });
      entry = r.entry;
    }
    const { data: v, error: fe } = await supabase.rpc('builder_accrual_finish', { p_run: staged.run_id, p_month_end: month.month_end, p_je: entry.id });
    if (fe) throw Object.assign(new Error(`GL ${entry.reference} posted, but the month could not be marked covered: ${fe.message}. Run again to finish.`), { code: 'finish_pending' });
    view = v; posted.push({ month_end: month.month_end, amount_cents: Number(month.amount_cents), journal_entry_id: entry.id, journal_reference: entry.reference });
  }
  if (!posted.length) {
    // Every month already posted on an earlier attempt; close the run.
    const last = staged.months[staged.months.length - 1];
    if (last) { const { data: v, error: fe } = await supabase.rpc('builder_accrual_finish', { p_run: staged.run_id, p_month_end: last.month_end, p_je: (await _jeOf(supabase, communityId, staged, last)).id }); if (fe) throw _err(fe); view = v; }
  }
  return { status: view.status === 'posted' ? (staged.resumed ? 'completed_retry' : 'posted') : 'partial', run_id: staged.run_id, batch_id: staged.batch_id, through: staged.through, posted, blocked: staged.blocked || [], view };
}

async function _jeOf(supabase, communityId, staged, month) {
  const { data, error } = await supabase.from('journal_entries').select('id').eq('community_id', communityId).eq('source_module', 'assessment_billing')
    .eq('source_reference', `${staged.batch_id}:${month.month_end.slice(0, 7)}`).maybeSingle();
  if (error) throw _err(error);
  if (!data) throw new Error(`no journal entry for ${month.month_end}`);
  return data;
}

async function status(supabase, { communityId, asOf }) {
  const { data, error } = await supabase.rpc('builder_coverage_status', { p_community_id: communityId, p_as_of: asOf });
  if (error) throw _err(error);
  return data;
}

// Scheduler: on the 3rd (Central), accrue the month just ended for every configured community.
async function runMonthlyIfDue({ supabase, today = new Date(), logger = console } = {}) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = Object.fromEntries(fmt.formatToParts(today).map((x) => [x.type, x.value]));
  if (Number(p.day) !== 3) return { skipped: 'not the 3rd' };
  const through = lastDayOfPrevMonth(new Date(Date.UTC(Number(p.year), Number(p.month) - 1, 1)));
  const { data: rules, error } = await supabase.from('transfer_proration_builders').select('community_id').eq('active', true).order('community_id');
  if (error) throw _err(error);
  const out = [];
  for (const cid of [...new Set((rules || []).map((r) => r.community_id))]) {
    try { const r = await run(supabase, { communityId: cid, through, actor: 'scheduler:builder_assessment_accrual' }); out.push({ community_id: cid, status: r.status, posted: (r.posted || []).length, blocked: (r.blocked || []).length }); if ((r.blocked || []).length) logger.warn(`[builder_accrual] ${cid}: ${r.blocked.length} builder lot(s) BLOCKED through ${through}`); }
    catch (e) { logger.error(`[builder_accrual] ${cid} failed: ${e.message}`); out.push({ community_id: cid, status: 'failed', error: e.message }); }
  }
  return { through, communities: out };
}

module.exports = { preview, run, status, runMonthlyIfDue, monthLines, isMonthEnd, lastDayOfPrevMonth };
