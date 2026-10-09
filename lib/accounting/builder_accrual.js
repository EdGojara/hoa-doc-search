// ============================================================================
// lib/accounting/builder_accrual.js  (Ed 2026-10-08, GitHub issue #96)
// ----------------------------------------------------------------------------
// The periodic builder-assessment accrual after a configured community's
// conversion. GENERIC: the builder rate, the annual assessment, the assessment
// year, the cadence and the AR / income accounts all come from the community's
// builder assessment program (migration 500) through the SQL plan; nothing here
// names a community, a builder, an amount or an account.
//
// Each COMPLETED billing period (the program's cadence within the assessment
// year) a builder owns a lot, it is billed round(annual x pct x days / (100 x
// days_in_year)); the period that ends the assessment year carries the rounding
// true-up so a full year is exactly annual x pct. Coverage always continues from
// the day after the last covered day, so nothing overlaps and nothing is
// skipped; a lot that cannot be continued is BLOCKED and listed, never skipped.
//
//   preview(communityId, through)          builder_accrual_plan: read-only.
//   activate(communityId, actor)           the explicit post-conversion step
//                                          (refused until the conversion posts)
//   run({ communityId, through, actor })   1. builder_accrual_stage (mig 501):
//                                             draft batch + ledger rows + pending
//                                             coverage (or the unfinished run);
//                                             refused until the accrual is activated
//                                          2. per period end: the GL entry through
//                                             postJournalEntry, Dr AR per lot /
//                                             Cr income, keyed to batch + period end
//                                          3. builder_accrual_finish: the entry
//                                             must equal the period's coverage;
//                                             marks it posted; commits the batch
// A failure part-way leaves pending coverage (the transfer blocks on it, the
// status shows RED) and the next run finishes the same run: never a second one.
//
// Scheduler job 'builder_assessment_accrual' (lib/scheduler.js) is OFF unless
// SCHEDULER_ENABLED names it; it runs on the 3rd through the month just ended,
// and only for programs whose accrual has been activated.
// ============================================================================
const { postJournalEntry } = require('./posting');

const lastDayOfPrevMonth = (d) => { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)); return t.toISOString().slice(0, 10); };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

function _err(e) { return Object.assign(new Error(e.message || String(e)), { code: e.code, details: e.details }); }

async function preview(supabase, { communityId, through }) {
  if (!communityId) throw new Error('community_id required');
  if (!isDate(through)) throw new Error('through must be a date (YYYY-MM-DD)');
  const { data, error } = await supabase.rpc('builder_accrual_plan', { p_community_id: communityId, p_through: through });
  if (error) throw _err(error);
  return data;
}

async function activate(supabase, { communityId, actor }) {
  if (!communityId || !actor) throw new Error('community_id and actor required');
  const { data, error } = await supabase.rpc('activate_builder_accrual', { p_community_id: communityId, p_actor: actor });
  if (error) throw _err(error);
  return data;
}

async function _accounts(supabase, communityId, arNo, incomeNo) {
  if (!arNo || !incomeNo) throw new Error('the builder assessment program names no AR / income account');
  const want = [arNo, incomeNo];
  const { data, error } = await supabase.from('chart_of_accounts').select('id, account_number').eq('community_id', communityId).in('account_number', want);
  if (error) throw _err(error);
  const by = Object.fromEntries((data || []).map((a) => [a.account_number, a.id]));
  const missing = want.filter((n) => !by[n]);
  if (missing.length) throw new Error(`accounts ${missing.join('/')} missing for this community`);
  return by;
}

// One billing period's GL lines: one AR debit per lot (so the receivable names the lot), one income credit.
function periodLines(acct, arNo, incomeNo, period) {
  const lines = period.lines.map((l) => ({ account_id: acct[arNo], debit_cents: Number(l.amount_cents), credit_cents: 0, property_id: l.property_id,
    memo: `Builder assessment ${l.from} to ${l.through}${Number(l.rounding_true_up_cents) ? ` (incl. year-end rounding true-up ${l.rounding_true_up_cents} cents)` : ''}` }));
  lines.push({ account_id: acct[incomeNo], debit_cents: 0, credit_cents: Number(period.amount_cents), memo: `Builder assessments earned through ${period.period_end}` });
  return lines;
}

async function _jeOf(supabase, communityId, batchId, periodEnd) {
  const { data, error } = await supabase.from('journal_entries').select('id, reference, status')
    .eq('community_id', communityId).eq('source_module', 'assessment_billing').eq('source_reference', `${batchId}:${periodEnd}`).maybeSingle();
  if (error) throw _err(error);
  return data || null;
}

async function run(supabase, { communityId, through, actor, post = postJournalEntry }) {
  if (!actor) throw new Error('actor required');
  if (!isDate(through)) throw new Error('through must be a date (YYYY-MM-DD)');
  const { data: staged, error } = await supabase.rpc('builder_accrual_stage', { p_community_id: communityId, p_through: through, p_actor: actor });
  if (error) throw _err(error);
  if (!staged || staged.status === 'nothing_to_accrue') return { status: 'nothing_to_accrue', plan: staged && staged.plan };
  const arNo = staged.ar_account_number; const incomeNo = staged.income_account_number;
  const acct = await _accounts(supabase, communityId, arNo, incomeNo);
  let view = staged; const posted = [];
  for (const period of staged.periods || []) {
    if (!Number(period.pending)) continue;
    let entry = await _jeOf(supabase, communityId, staged.batch_id, period.period_end);
    if (!entry) {
      const r = await post({
        community_id: communityId, posting_date: period.period_end, source_module: 'assessment_billing', source_reference: `${staged.batch_id}:${period.period_end}`,
        description: `Builder assessments through ${period.period_end} (${period.lots} lot${Number(period.lots) === 1 ? '' : 's'})`,
        notes: `Builder assessment accrual run ${staged.run_id}; subledger batch ${staged.batch_id}; issue #96`,
        lines: periodLines(acct, arNo, incomeNo, period),
      });
      entry = r.entry;
    }
    const { data: v, error: fe } = await supabase.rpc('builder_accrual_finish', { p_run: staged.run_id, p_period_end: period.period_end, p_je: entry.id });
    if (fe) throw Object.assign(new Error(`GL ${entry.reference} posted, but the period could not be marked covered: ${fe.message}. Run again to finish.`), { code: 'finish_pending' });
    view = v; posted.push({ period_end: period.period_end, amount_cents: Number(period.amount_cents), journal_entry_id: entry.id, journal_reference: entry.reference });
  }
  if (view.status !== 'posted' && !posted.length && (staged.periods || []).length) {
    // Every period was posted on an earlier attempt; close the run.
    const last = staged.periods[staged.periods.length - 1];
    const je = await _jeOf(supabase, communityId, staged.batch_id, last.period_end);
    if (!je) throw new Error(`no journal entry for ${last.period_end}`);
    const { data: v, error: fe } = await supabase.rpc('builder_accrual_finish', { p_run: staged.run_id, p_period_end: last.period_end, p_je: je.id });
    if (fe) throw _err(fe); view = v;
  }
  return { status: view.status === 'posted' ? (staged.resumed ? 'completed_retry' : 'posted') : 'partial', run_id: staged.run_id, batch_id: staged.batch_id, through: staged.through, posted, blocked: staged.blocked || [], view };
}

async function status(supabase, { communityId, asOf }) {
  const { data, error } = await supabase.rpc('builder_coverage_status', { p_community_id: communityId, p_as_of: asOf });
  if (error) throw _err(error);
  return data;
}

// Scheduler: on the 3rd (Central), accrue through the month just ended for every
// active program whose accrual has been ACTIVATED (after its conversion posted).
async function runMonthlyIfDue({ supabase, today = new Date(), logger = console } = {}) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = Object.fromEntries(fmt.formatToParts(today).map((x) => [x.type, x.value]));
  if (Number(p.day) !== 3) return { skipped: 'not the 3rd' };
  const through = lastDayOfPrevMonth(new Date(Date.UTC(Number(p.year), Number(p.month) - 1, 1)));
  const { data: programs, error } = await supabase.from('builder_assessment_programs').select('community_id, accrual_activated_at').eq('active', true).order('community_id');
  if (error) throw _err(error);
  const out = []; const notActivated = [];
  for (const prog of programs || []) {
    if (!prog.accrual_activated_at) { notActivated.push(prog.community_id); continue; }
    try { const r = await run(supabase, { communityId: prog.community_id, through, actor: 'scheduler:builder_assessment_accrual' }); out.push({ community_id: prog.community_id, status: r.status, posted: (r.posted || []).length, blocked: (r.blocked || []).length }); if ((r.blocked || []).length) logger.warn(`[builder_accrual] ${prog.community_id}: ${r.blocked.length} builder lot(s) BLOCKED through ${through}`); }
    catch (e) { logger.error(`[builder_accrual] ${prog.community_id} failed: ${e.message}`); out.push({ community_id: prog.community_id, status: 'failed', error: e.message }); }
  }
  return { through, communities: out, not_activated: notActivated };
}

module.exports = { preview, activate, run, status, runMonthlyIfDue, periodLines, isDate, lastDayOfPrevMonth };
