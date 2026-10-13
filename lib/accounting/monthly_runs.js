// ============================================================================
// lib/accounting/monthly_runs.js  (Ed 2026-10-11)
// ----------------------------------------------------------------------------
// Kat's controlled monthly accounting runs (migration 510). Kat PREPARES; a
// person APPROVES (or HOLDS); only then does the run POST exactly what was
// prepared. Every step is an append-only event. Nothing here runs for a
// community unless community_accounting_automation enables it.
//
//   recognition  the community's approved recognition schedules: every month due
//                through the run month and not yet posted (assessment revenue,
//                CLMA, prepaid insurance, ...). Posting goes through the same RPC
//                as lib/accounting/recognition_engine (post_recognition_period),
//                one previewed (schedule, month) at a time, so a month posts once.
//   interest     lib/ar/monthly_interest: owner-by-owner preview on the homeowner
//                ledger; exceptions are held unless approved by name.
//   bank_reconciliation  lib/banking/monthly_rec: one run per bank account per
//                month (subject_id, migration 511). Kat matches, lists the
//                exceptions and proposes entries with their evidence; approval
//                posts only the proposals ticked by name, then stores the
//                reconciliation (bank_reconciliations). It is complete only when
//                it balances AND nothing is open.
//
// Controls: the accounting period of every posting date must be open; the
// balance account of each schedule must still tie to its unposted months; a run
// that fails records the error (status failed) and is never silent; a posted run
// is final (DB guard).
// ============================================================================

const KAT = 'Kat Reed (AI accounting manager)';
const day = (d) => String(d || '').slice(0, 10);
const firstOf = (d) => `${day(d).slice(0, 7)}-01`;

async function must(q, what) { const { data, error } = await q; if (error) throw new Error(`${what}: ${error.message}`); return data; }
async function event(supabase, run_id, ev, actor, detail = {}) {
  const { error } = await supabase.from('accounting_run_events').insert({ run_id, event: ev, actor, detail });
  if (error) console.error('[monthly_runs] event write failed', JSON.stringify({ run_id, ev, error: error.message }));
}
async function automation(supabase, community_id, process) {
  return must(supabase.from('community_accounting_automation').select('*').eq('community_id', community_id).eq('process', process).maybeSingle(), 'automation');
}
async function periodOpen(supabase, community_id, date) {
  const p = await must(supabase.from('accounting_periods').select('status').eq('community_id', community_id).lte('period_start', date).gte('period_end', date).maybeSingle(), 'accounting period');
  return p ? ['open', 'reopened'].includes(p.status) : null;   // null = no period row
}
async function liveRun(supabase, community_id, process, period_month, subject_id = null) {
  let q = supabase.from('accounting_runs').select('*').eq('community_id', community_id).eq('process', process).eq('period_month', period_month)
    .in('status', ['prepared', 'approved', 'posted', 'held', 'failed']);
  if (subject_id) q = q.eq('subject_id', subject_id);   // only per-subject processes filter (column from migration 511)
  return must(q.maybeSingle(), 'live run');
}
const lastOfMonth = (pm) => { const d = new Date(`${firstOf(pm)}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); };
const BLOCKING = (e) => e.severity === 'blocking' || ['period_closed', 'balance_mismatch'].includes(e.code);

// ---------------------------------------------------------------- recognition
async function previewRecognition(supabase, { community_id, period_month }) {
  const { postingDateFor } = require('./recognition_engine');
  const through = firstOf(period_month);
  const schedules = await must(supabase.from('recognition_schedules').select('id, description, schedule_type, balance_account_number, balance_account_id, recognition_account_id, period_start, status')
    .eq('community_id', community_id).eq('status', 'active').order('id'), 'schedules');
  const items = []; const exceptions = [];
  for (const s of schedules) {
    const periods = await must(supabase.from('recognition_schedule_periods').select('period_month, scheduled_cents').eq('schedule_id', s.id).order('period_month'), 'periods');
    const posted = await must(supabase.from('recognition_postings').select('period_month, kind, reversed_by_posting_id').eq('schedule_id', s.id), 'postings');
    const done = new Set(posted.filter((p) => p.kind === 'recognition' && !p.reversed_by_posting_id).map((p) => day(p.period_month)));
    const remaining = periods.filter((p) => !done.has(day(p.period_month))).reduce((t, p) => t + Number(p.scheduled_cents), 0);
    // Control: the balance account must still hold exactly the unposted months.
    if (s.balance_account_id) {
      const lines = await must(supabase.from('journal_entry_lines').select('debit_cents, credit_cents, journal_entries!inner(status, void_reversal_je_id)').eq('account_id', s.balance_account_id).limit(5000), 'balance lines');
      const bal = lines.filter((l) => l.journal_entries.status === 'posted' || (l.journal_entries.status === 'voided' && l.journal_entries.void_reversal_je_id)).reduce((t, l) => t + l.debit_cents - l.credit_cents, 0);
      const expected = s.schedule_type === 'prepaid_expense' ? remaining : -remaining;
      if (bal !== expected) exceptions.push({ code: 'balance_mismatch', schedule_id: s.id, text: `${s.balance_account_number} holds ${(bal / 100).toFixed(2)} but the schedule has ${(Math.abs(expected) / 100).toFixed(2)} left to recognize.` });
    }
    for (const p of periods) {
      const m = day(p.period_month);
      if (m > through) break;
      if (done.has(m) || Number(p.scheduled_cents) === 0) continue;
      const posting_date = postingDateFor(s, m);
      const open = await periodOpen(supabase, community_id, posting_date);
      if (open === false) exceptions.push({ code: 'period_closed', schedule_id: s.id, text: `${s.description}: ${m.slice(0, 7)} posts ${posting_date}, a closed period.` });
      items.push({ schedule_id: s.id, schedule: s.description, type: s.schedule_type, month: m, posting_date, amount_cents: Number(p.scheduled_cents), balance_account: s.balance_account_number, catch_up: m < through });
    }
  }
  const totals = { entries: items.length, amount_cents: items.reduce((t, i) => t + i.amount_cents, 0), catch_up_entries: items.filter((i) => i.catch_up).length };
  if (totals.catch_up_entries) exceptions.push({ code: 'catch_up', text: `${totals.catch_up_entries} entr${totals.catch_up_entries === 1 ? 'y is' : 'ies are'} for months before ${through.slice(0, 7)} (catch-up); confirm before approving.` });
  return { items, totals, exceptions };
}

async function postRecognition(supabase, run, actor) {
  const out = [];
  for (const i of run.preview.items || []) {
    const { data, error } = await supabase.rpc('post_recognition_period', { p_schedule_id: i.schedule_id, p_period_month: i.month, p_actor: actor, p_posting_date: i.posting_date });
    if (error) { out.push({ ...i, error: error.message }); throw Object.assign(new Error(`${i.schedule} ${i.month.slice(0, 7)}: ${error.message}`), { partial: out }); }
    out.push({ ...i, posting_id: data, posted: true });
  }
  return { posted: out.length, amount_cents: out.reduce((t, i) => t + i.amount_cents, 0), entries: out };
}

// ---------------------------------------------------------------- framework
async function prepare(supabase, { community_id, process, period_month, run_date = null, subject_id = null, actor = KAT, force = false }) {
  const pm = firstOf(period_month); const rd = day(run_date || pm);
  const auto = await automation(supabase, community_id, process);
  if (!auto || !auto.enabled) { if (!force) return { skipped: `${process} is not enabled for this community` }; }
  if (process === 'bank_reconciliation') {
    if (!subject_id) throw Object.assign(new Error('a bank account is required'), { code: 'invalid_input' });
    const ids = ((auto && auto.settings) || {}).bank_account_ids || [];
    if (!force && !ids.includes(subject_id)) return { skipped: 'this bank account is not enabled for Kat\'s reconciliation' };
  }
  const existing = await liveRun(supabase, community_id, process, pm, subject_id);
  if (existing) return { existing: true, run: existing };
  let preview, totals, exceptions, heldReason = null;
  try {
    if (process === 'bank_reconciliation') {
      const B = require('../banking/monthly_rec');
      const r = await B.runAccountMonth(supabase, { community_id, bank_account_id: subject_id, period_end: lastOfMonth(pm), settings: (auto && auto.settings) || {} });
      preview = { ...r, report: B.reportText(r) };
      totals = { ...r.totals, status: r.status, account: r.account.label };
      exceptions = r.exceptions;
      const missing = r.exceptions.find((e) => e.code === 'statement_missing');
      if (missing) heldReason = missing.text;
    } else if (process === 'recognition') ({ items: preview, totals, exceptions } = await previewRecognition(supabase, { community_id, period_month: pm }));
    else {
      const I = require('../ar/monthly_interest');
      const r = await I.previewInterest(supabase, { community_id, run_date: rd, settings: (auto && auto.settings) || {} });
      const open = await periodOpen(supabase, community_id, rd);
      exceptions = r.items.filter((i) => i.exception).map((i) => ({ code: 'owner_exception', tenure_id: i.tenure_id, address: i.address, interest_cents: i.interest_cents, flags: i.flags.map((f) => f.code), text: i.flags.map((f) => f.text).join(' ') }));
      if (open === false) exceptions.unshift({ code: 'period_closed', text: `The accounting period for ${rd} is closed.` });
      if (r.unmatched.length) exceptions.unshift({ code: 'unmatched_receipts', text: `${r.unmatched.length} receipt(s) could not be matched to an owner; their owners' interest may be overstated.` });
      preview = r.items; totals = { ...r.totals, rule: r.rule };
    }
  } catch (e) {
    const { data: failed } = await supabase.from('accounting_runs').insert({ community_id, process, period_month: pm, run_date: rd, status: 'failed', prepared_by: actor, error: e.message.slice(0, 2000), ...(subject_id ? { subject_id } : {}) }).select('id').single();
    if (failed) await event(supabase, failed.id, 'failed', actor, { stage: 'prepare', error: e.message });
    console.error('[monthly_runs] prepare failed', JSON.stringify({ community_id, process, pm, error: e.message }));
    return { failed: true, error: e.message, run_id: failed && failed.id };
  }
  const row = { community_id, process, period_month: pm, run_date: rd, status: heldReason ? 'held' : 'prepared', held_reason: heldReason,
    preview: process === 'bank_reconciliation' ? preview : { items: preview }, totals, exceptions, prepared_by: actor };
  if (subject_id) row.subject_id = subject_id;
  const { data: run, error } = await supabase.from('accounting_runs').insert(row).select('*').single();
  if (error) throw new Error(`run insert: ${error.message}`);
  await event(supabase, run.id, 'prepared', actor, { totals, exceptions: exceptions.length });
  if (heldReason) await event(supabase, run.id, 'held', actor, { reason: heldReason });
  return { run };
}

// approve: approver is a person (owner-gated at the API). For interest, include
// lists the tenure_ids of exception owners approved by name; every other
// exception owner is held (not charged) and recorded as such. For a bank
// reconciliation, include lists the proposal ids approved by name; the rest stay
// exceptions.
//
// Approval channel (Ed 2026-10-13): a run posts only on an AUTHENTICATED in-app owner
// approval. approval = { channel: 'in_app', user_id, email } is built by the API from
// the signed-in session (requireOwner), never from a chat instruction or a script. A
// chat authorization is not an approval: the run stays prepared for the owner to
// approve in Kat's queue. A plain approver string is refused.
function assertInAppApproval(approval) {
  const ok = approval && typeof approval === 'object' && approval.channel === 'in_app' && approval.user_id && approval.email;
  if (!ok) throw Object.assign(new Error("approval_required: a run posts only on the owner's authenticated approval in Kat's queue (Command Center). A chat authorization or a server-side call cannot approve it; leave the run prepared."), { code: 'approval_required' });
  return `${approval.email} (authenticated in-app approval)`;
}

async function approveAndPost(supabase, { run_id, approval, include = [] }) {
  const approver = assertInAppApproval(approval);
  const run = await must(supabase.from('accounting_runs').select('*').eq('id', run_id).single(), 'run');
  if (run.status !== 'prepared') throw Object.assign(new Error(`run is ${run.status}, not prepared`), { code: 'invalid_state' });
  const blocking = (run.exceptions || []).filter(BLOCKING);
  if (blocking.length) throw Object.assign(new Error(`cannot post: ${blocking.map((b) => b.text).join(' ')}`), { code: 'blocked' });
  await must(supabase.from('accounting_runs').update({ status: 'approved', approved_by: approver, approved_at: new Date().toISOString() }).eq('id', run_id).select('id'), 'approve');
  await event(supabase, run_id, 'approved', approver, { include, channel: 'in_app', user_id: approval.user_id });
  const actor = `${KAT}; approved by ${approver}`;
  await event(supabase, run_id, 'posting', KAT, {});
  try {
    let result;
    if (run.process === 'recognition') result = await postRecognition(supabase, run, actor);
    else if (run.process === 'bank_reconciliation') result = await postBankRec(supabase, run, { include, approver, actor });
    else {
      const auto = await automation(supabase, run.community_id, 'interest');
      const inc = new Set(include);
      const items = (run.preview.items || []).filter((i) => !i.skip && i.interest_cents > 0 && (!i.exception || inc.has(i.tenure_id)));
      const held = (run.preview.items || []).filter((i) => i.exception && !inc.has(i.tenure_id) && i.interest_cents > 0).map((i) => ({ tenure_id: i.tenure_id, address: i.address, interest_cents: i.interest_cents }));
      const I = require('../ar/monthly_interest');
      result = { ...(await I.postInterest(supabase, { community_id: run.community_id, run_date: run.run_date, items, settings: (auto && auto.settings) || {}, actor })), held_exceptions: held };
    }
    await must(supabase.from('accounting_runs').update({ status: 'posted', posted_by: actor, posted_at: new Date().toISOString(), result }).eq('id', run_id).select('id'), 'mark posted');
    await event(supabase, run_id, 'posted', KAT, result);
    return { status: 'posted', result };
  } catch (e) {
    await supabase.from('accounting_runs').update({ status: 'failed', error: e.message.slice(0, 2000), result: e.partial ? { partial: e.partial } : null }).eq('id', run_id);
    await event(supabase, run_id, 'failed', KAT, { stage: 'post', error: e.message, partial: e.partial || null });
    console.error('[monthly_runs] post failed', JSON.stringify({ run_id, error: e.message }));
    throw e;
  }
}

async function hold(supabase, { run_id, actor, reason }) {
  if (!String(reason || '').trim()) throw Object.assign(new Error('a reason is required to hold a run'), { code: 'invalid_input' });
  const run = await must(supabase.from('accounting_runs').update({ status: 'held', held_reason: reason }).eq('id', run_id).eq('status', 'prepared').select('id'), 'hold');
  if (!run.length) throw Object.assign(new Error('only a prepared run can be held'), { code: 'invalid_state' });
  await event(supabase, run_id, 'held', actor, { reason });
  return { status: 'held' };
}

// Bank reconciliation: post the approved proposals exactly as prepared, re-run
// the engine on the live books (so the posted entries now match their bank
// lines), and store the reconciliation. The stored record is 'reconciled' only
// when it balances and nothing is open; otherwise it stays in progress.
async function postBankRec(supabase, run, { include, approver, actor }) {
  const B = require('../banking/monthly_rec');
  const proposals = run.preview.proposals || [];
  const unknown = include.filter((id) => !proposals.some((p) => p.id === id));
  if (unknown.length) throw Object.assign(new Error(`not proposals of this run: ${unknown.join(', ')}`), { code: 'invalid_input' });
  const inc = new Set(include);
  const posted = await B.postProposals(supabase, { community_id: run.community_id, proposals: proposals.filter((p) => inc.has(p.id)), actor: KAT, approver });
  const auto = await automation(supabase, run.community_id, 'bank_reconciliation');
  const r = await B.runAccountMonth(supabase, { community_id: run.community_id, bank_account_id: run.subject_id, period_end: lastOfMonth(run.period_month), settings: (auto && auto.settings) || {} });
  if (r.status === 'blocked') throw Object.assign(new Error(`cannot store: ${r.exceptions.filter((e) => e.severity === 'blocking').map((e) => e.text).join(' ')}`), { code: 'blocked' });
  const stored = await B.storeReconciliation(supabase, { community_id: run.community_id, r, run_id: run.id, actor });
  const p0 = run.totals || {};
  return { posted_entries: posted, not_approved: proposals.filter((p) => !inc.has(p.id)).map((p) => p.id), reconciliation: stored, status: r.status, totals: r.totals,
    open_exceptions: r.exceptions.filter((e) => e.severity !== 'info'), report: B.reportText(r),
    changed_since_prepared: ['bank_ending_cents', 'gl_ending_cents', 'difference_cents'].filter((k) => p0[k] !== r.totals[k]) };
}

// supersede a held or failed run so the month can be prepared again.
async function supersede(supabase, { run_id, actor, reason }) {
  const run = await must(supabase.from('accounting_runs').update({ status: 'superseded', held_reason: reason || 'superseded' }).eq('id', run_id).in('status', ['held', 'failed', 'prepared']).select('id'), 'supersede');
  if (!run.length) throw Object.assign(new Error('only a prepared, held or failed run can be superseded'), { code: 'invalid_state' });
  await event(supabase, run_id, 'superseded', actor, { reason });
  return { status: 'superseded' };
}

// Daily scheduler tick: for each enabled community + process, prepare the
// current month's run once (on or after the 1st, Central time). Never posts
// unless auto_post is on (it is off everywhere until Ed authorizes it).
async function dailyTick({ supabase, today = new Date(), logger = console } = {}) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = Object.fromEntries(fmt.formatToParts(today).map((x) => [x.type, x.value]));
  const pm = `${p.year}-${p.month}-01`;
  const autos = await must(supabase.from('community_accounting_automation').select('community_id, process, auto_post, settings').eq('enabled', true), 'automation list');
  const out = [];
  for (const a of autos) {
    // Kat works only for communities Bedrock currently manages (lib/community/lifecycle).
    const life = await require('../community/lifecycle').canDo('financials', a.community_id);
    if (!life.allowed) { out.push({ community_id: a.community_id, process: a.process, status: 'skipped', reason: life.reason }); continue; }
    if (a.process === 'bank_reconciliation') { out.push(...(await bankTick(supabase, a, p, logger))); continue; }
    try {
      const r = await prepare(supabase, { community_id: a.community_id, process: a.process, period_month: pm, run_date: pm });
      out.push({ community_id: a.community_id, process: a.process, status: r.run ? r.run.status : (r.failed ? 'failed' : r.skipped || 'existing') });
      if (r.failed) logger.error(`[kat_monthly_accounting] ${a.community_id} ${a.process} ${pm} prepare FAILED: ${r.error}`);
    } catch (e) { logger.error(`[kat_monthly_accounting] ${a.community_id} ${a.process} ${pm}: ${e.message}`); out.push({ community_id: a.community_id, process: a.process, status: 'failed', error: e.message }); }
  }
  // Attorney invoices held for the legal review are accrued in their own period once the
  // hold window ends, in every community (the review can still reclassify later).
  let legalAccruals = [];
  try { legalAccruals = await require('../ap/intake').accrueHeldLegalInvoices({ today, logger }); }
  catch (e) { logger.error(`[kat_monthly_accounting] held attorney accruals: ${e.message}`); legalAccruals = [{ error: e.message }]; }
  const result = { period_month: pm, runs: out, legal_accruals: legalAccruals };
  // A failure is never a quiet success: after every item has had its turn, throw so the
  // scheduler records the run as failed (cron_runs.ok=false, with the failed items) and
  // retries on its next tick. Preparing is idempotent, so a retry redoes only what failed.
  const failed = out.filter((r) => r.status === 'failed').concat(legalAccruals.filter((r) => r && r.error));
  if (failed.length) throw Object.assign(new Error(`kat_monthly_accounting: ${failed.length} item(s) failed: ${failed.map((f) => `${f.process || 'legal_accrual'} ${f.invoice_id || f.subject_id || f.community_id || ''}: ${f.error || f.status}`).join('; ').slice(0, 800)}`), { summary: result });
  return result;
}

// Bank reconciliation tick: reconcile LAST month once its statement is imported.
// Until it is, nothing is prepared; from statement_due_day (default the 10th) a
// held run says the statement is missing, so Ed sees it (no silent gap). When
// the statement then arrives, Kat supersedes that held run and prepares.
async function bankTick(supabase, a, p, logger) {
  const out = [];
  const prev = new Date(Date.UTC(Number(p.year), Number(p.month) - 2, 1)).toISOString().slice(0, 10);
  const pe = lastOfMonth(prev);
  const S = a.settings || {};
  const note = (ba, status, extra = {}) => out.push({ community_id: a.community_id, process: a.process, subject_id: ba, period_month: prev, status, ...extra });
  for (const ba of S.bank_account_ids || []) {
    try {
      const live = await liveRun(supabase, a.community_id, 'bank_reconciliation', prev, ba);
      const { data: st, error } = await supabase.from('bank_statement_imports').select('id').eq('bank_account_id', ba).gte('statement_period_end', prev).lte('statement_period_end', pe).limit(1);
      if (error) throw new Error(`statement lookup: ${error.message}`);
      const have = st.length > 0;
      if (live) {
        // A run Kat could not complete (statement missing, incomplete or out of
        // sequence) is re-checked daily; once the inputs are fixed she supersedes
        // it and prepares again. Any other live run is left for the person.
        const blocked = ['held', 'prepared'].includes(live.status) && (live.exceptions || []).some((e) => e.severity === 'blocking');
        if (!blocked || !have) { note(ba, live.status); continue; }
        const B = require('../banking/monthly_rec');
        const now = await B.runAccountMonth(supabase, { community_id: a.community_id, bank_account_id: ba, period_end: pe, settings: S });
        if (now.status === 'blocked') { note(ba, live.status, { still_blocked: now.exceptions.filter((e) => e.severity === 'blocking').map((e) => e.code) }); continue; }
        await supersede(supabase, { run_id: live.id, actor: KAT, reason: 'The bank statement inputs are now complete; preparing the reconciliation again.' });
      }
      if (!have && Number(p.day) < Number(S.statement_due_day || 10)) { note(ba, 'waiting_for_statement'); continue; }
      const r = await prepare(supabase, { community_id: a.community_id, process: 'bank_reconciliation', period_month: prev, run_date: `${p.year}-${p.month}-${p.day}`, subject_id: ba });
      note(ba, r.run ? r.run.status : (r.failed ? 'failed' : r.skipped || 'existing'));
      if (r.failed) logger.error(`[kat_monthly_accounting] bank rec ${ba} ${prev} prepare FAILED: ${r.error}`);
    } catch (e) { logger.error(`[kat_monthly_accounting] bank rec ${ba} ${prev}: ${e.message}`); note(ba, 'failed', { error: e.message }); }
  }
  return out;
}

module.exports = { KAT, assertInAppApproval, prepare, approveAndPost, hold, supersede, dailyTick, previewRecognition, lastOfMonth };
