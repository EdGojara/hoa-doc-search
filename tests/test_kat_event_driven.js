#!/usr/bin/env node
// Kat date- and event-driven (Ed 2026-11-04): "scheduled execution for monthly accounting dates and
// event-driven execution for imports, approvals, and transaction changes."
//   scheduler   a daily or slot job that already succeeded skips in memory (no cron_runs read);
//               a days:[...] job never fires on other days of the month
//   Kat         kat_monthly_accounting runs only on accounting dates (default the 1st and 10th);
//               a statement upload prepares that account's month; an approved bank reconciliation
//               refreshes the interest run it unblocks (refresh prepares, never posts)
//   Positive    the watch fires at cutoff slots (default 9 and 11 Central), on a notice's arrival,
//   Pay         and on a statement upload, not on every tick
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:1';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'x';
const fs = require('fs');
const path = require('path');
const { Scheduler, jobGate } = require('../lib/scheduler');
const R = require('../lib/accounting/monthly_runs');
const W = require('../lib/banking/positive_pay_watch');
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };
const settle = () => new Promise((r) => setImmediate(r));

// Minimal in-memory PostgREST stand-in.
function fakeDb(seed = {}) {
  const T = { cron_runs: [], accounting_runs: [], accounting_run_events: [], community_accounting_automation: [], bank_reconciliations: [], ...seed };
  let n = 0; const reads = {};
  const from = (table) => {
    const st = { filters: [], op: 'select', row: null, patch: null, single: false };
    const match = (r) => st.filters.every(([k, op, v]) => (op === 'eq' ? r[k] === v : op === 'in' ? v.includes(r[k]) : op === 'gte' ? String(r[k]) >= String(v) : true));
    const exec = () => {
      const rows = (T[table] = T[table] || []);
      if (st.op === 'insert') { const r = { id: `id${++n}`, ...st.row }; rows.push(r); return { data: st.single ? r : [r], error: null }; }
      if (st.op === 'update') { const hit = rows.filter(match); hit.forEach((r) => Object.assign(r, st.patch)); return { data: hit, error: null }; }
      reads[table] = (reads[table] || 0) + 1;
      const hit = rows.filter(match); return { data: st.single ? hit[0] || null : hit, error: null };
    };
    const q = {
      select() { return q; }, order() { return q; }, limit() { return q; },
      eq(k, v) { st.filters.push([k, 'eq', v]); return q; }, in(k, v) { st.filters.push([k, 'in', v]); return q; }, gte(k, v) { st.filters.push([k, 'gte', v]); return q; },
      insert(row) { st.op = 'insert'; st.row = row; return q; }, update(p) { st.op = 'update'; st.patch = p; return q; },
      single() { st.single = true; return q; }, maybeSingle() { st.single = true; return q; },
      then(res, rej) { return Promise.resolve(exec()).then(res, rej); },
    };
    return q;
  };
  return { from, T, reads };
}
const quiet = { log() {}, warn() {}, error() {} };

(async () => {
  console.log('scheduler');
  {
    const prev = process.env.SCHEDULER_ENABLED; process.env.SCHEDULER_ENABLED = 'daily_job';
    const db = fakeDb(); const sc = new Scheduler({ supabase: db, logger: quiet });
    let runs = 0;
    sc.register({ name: 'daily_job', targetHour: 0, run: async () => { runs++; return { ok: true }; } });
    process.env.SCHEDULER_ENABLED = prev;
    await sc.tick(); await settle(); await settle();
    const readsAfterFirst = db.reads.cron_runs || 0;
    await sc.tick(); await sc.tick(); await settle();
    check('a daily job that succeeded today runs once and later ticks make no cron_runs read', runs === 1 && readsAfterFirst === 1 && (db.reads.cron_runs || 0) === 1, `runs ${runs}, reads ${db.reads.cron_runs}`);
    const sc2 = new Scheduler({ supabase: db, logger: quiet }); sc2.jobs.push({ name: 'daily_job', targetHour: 0, run: async () => { runs++; return {}; } });
    await sc2.tick(); await sc2.tick(); await settle();
    check('after a restart, one cron_runs read finds today\'s success and the job is not re-run', runs === 1 && db.reads.cron_runs === 2);
  }
  {
    const prev = process.env.SCHEDULER_ENABLED; process.env.SCHEDULER_ENABLED = 'flaky';
    const db = fakeDb(); const sc = new Scheduler({ supabase: db, logger: quiet });
    let runs = 0;
    sc.register({ name: 'flaky', targetHour: 0, run: async () => { runs++; if (runs === 1) throw new Error('boom'); return {}; } });
    process.env.SCHEDULER_ENABLED = prev;
    await sc.tick(); await settle(); await settle();
    await sc.tick(); await settle(); await settle();
    check('a failed run is not remembered as done: the next tick retries it', runs === 2 && db.T.cron_runs[0].ok === false);
  }
  const cp = (day, hour, weekday = 'Wed') => ({ year: 2026, month: 11, day, hour, weekday, dateKey: `2026-11-${String(day).padStart(2, '0')}` });
  check('a days:[1,10] job is skipped on the 4th with no database work', jobGate({ targetHour: 6, days: [1, 10] }, cp(4, 12)).skip === true);
  check('a days:[1,10] job is due on the 1st and the 10th after its hour', !jobGate({ targetHour: 6, days: [1, 10] }, cp(1, 7)).skip && !jobGate({ targetHour: 6, days: [1, 10] }, cp(10, 7)).skip && jobGate({ targetHour: 6, days: [1, 10] }, cp(1, 5)).skip);
  check('a poll-mode job is never remembered as done (each interval still runs)', /if \(!pollMode && this\.doneFor\.get\(job\.name\) === lookbackIso\) continue/.test(src('lib/scheduler.js')));

  console.log('Kat on accounting dates');
  check('accounting dates default to the 1st and the 10th', JSON.stringify(R.accountingDays({})) === '[1,10]');
  check('KAT_ACCOUNTING_DAYS overrides; junk falls back to the default', JSON.stringify(R.accountingDays({ KAT_ACCOUNTING_DAYS: '10, 1, 15' })) === '[1,10,15]' && JSON.stringify(R.accountingDays({ KAT_ACCOUNTING_DAYS: 'x,40' })) === '[1,10]');
  const sched = src('lib/scheduler.js');
  check('wired: kat_monthly_accounting fires only on accounting dates', /name: 'kat_monthly_accounting',\s*targetHour: 6,\s*days: require\('\.\/accounting\/monthly_runs'\)\.accountingDays\(\)/.test(sched));

  console.log('statement upload wakes Kat');
  {
    const db = fakeDb({ community_accounting_automation: [{ community_id: 'c1', process: 'bank_reconciliation', enabled: true, settings: { bank_account_ids: ['ba1'] } }] });
    const today = new Date('2026-11-04T18:00:00Z');
    const a = await R.onStatementImported(db, { bank_account_id: 'ba1', statement_period_end: null, today });
    const b = await R.onStatementImported(db, { bank_account_id: 'ba1', statement_period_end: '2026-11-30', today });
    const c = await R.onStatementImported(db, { bank_account_id: 'other', statement_period_end: '2026-10-31', today });
    check('no statement period: nothing prepared', a.status === 'skipped');
    check('a month not yet ended: nothing prepared', b.status === 'skipped' && /not ended/.test(b.reason));
    check('an account Kat does not reconcile: nothing prepared', c.status === 'skipped' && /does not reconcile/.test(c.reason));
    check('nothing was written for any of them', !db.T.accounting_runs.length && !db.T.accounting_run_events.length);
  }
  const rec = src('api/bank_rec.js');
  check('wired: both statement upload routes call Kat and the Positive Pay watch after the import is saved', (rec.match(/await afterStatementImported\(/g) || []).length === 2 && /onStatementImported\(supabase/.test(rec) && /positive_pay_watch'\)\.tick\(\{ supabase \}\)/.test(rec));

  console.log('approved bank reconciliation refreshes the interest run it unblocks');
  {
    const blocked = { id: 'int1', community_id: 'c1', process: 'interest', status: 'prepared', period_month: '2026-11-01', run_date: '2026-11-01', preview: {}, exceptions: [{ code: 'bank_not_reconciled', severity: 'blocking' }] };
    const auto = { community_id: 'c1', process: 'bank_reconciliation', enabled: true, settings: { bank_account_ids: ['ba1', 'ba2'] } };
    const db = fakeDb({ accounting_runs: [blocked], community_accounting_automation: [auto], bank_reconciliations: [{ community_id: 'c1', bank_account_id: 'ba1', period_end: '2026-10-31', status: 'reconciled' }] });
    const r1 = await R.onBankReconciled(db, { community_id: 'c1', period_end: '2026-10-31', logger: quiet });
    check('one of two accounts reconciled: the interest run is left as it is', !r1.refreshed.length && r1.waiting_on_accounts === 1 && blocked.status === 'prepared');
    const r2 = await R.onBankReconciled(db, { community_id: 'c1', period_end: '2026-09-30', logger: quiet });
    check('a different month-end does not touch the November run', !r2.refreshed.length && blocked.status === 'prepared');
    db.T.bank_reconciliations.push({ community_id: 'c1', bank_account_id: 'ba2', period_end: '2026-10-31', status: 'reconciled' });
    const r3 = await R.onBankReconciled(db, { community_id: 'c1', period_end: '2026-10-31', logger: quiet });
    const ev = db.T.accounting_run_events.find((e) => e.run_id === 'int1' && e.event === 'superseded');
    check('all accounts reconciled: Kat refreshes the blocked interest run (supersede, then prepare again)', r3.refreshed.length === 1 && r3.refreshed[0].from === 'int1' && blocked.status === 'superseded' && ev && /approved bank reconciliation for 2026-10-31/.test(ev.actor));
    const clean = fakeDb({ accounting_runs: [{ ...blocked, id: 'int2', status: 'prepared', exceptions: [{ code: 'other', severity: 'warning' }] }], community_accounting_automation: [auto] });
    const r4 = await R.onBankReconciled(clean, { community_id: 'c1', period_end: '2026-10-31', logger: quiet });
    check('an interest run not waiting on the bank is never refreshed', !r4.refreshed.length && clean.T.accounting_runs[0].status === 'prepared');
  }
  const runsSrc = src('lib/accounting/monthly_runs.js');
  check('wired: approving a reconciled bank run calls onBankReconciled after it is marked posted, outside the posting failure path',
    /'posted', KAT, result\);[\s\S]{0,400}run\.process === 'bank_reconciliation' && result\.status === 'reconciled'[\s\S]{0,200}onBankReconciled\(/.test(runsSrc));
  check('the refresh path never approves or posts', !/approveAndPost\(|postInterest\(/.test(runsSrc.slice(runsSrc.indexOf('async function onBankReconciled'), runsSrc.indexOf('async function onBankReconciled') + 2500)));

  console.log('Positive Pay: arrival and cutoff slots');
  check('slots default to 9 and 11 Central (10:00 cutoff: hour-before warning, then cutoff passed)', JSON.stringify(W.watchHours({})) === '[9,11]' && JSON.stringify(W.watchHours({ POSITIVE_PAY_WATCH_HOURS: '8,10' })) === '[8,10]');
  const at = (h, m) => new Date(`2026-10-22T${String(h + 5).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);   // CDT
  const review = { deadline: { at: '2026-10-22T15:00:00.000Z', central: '10:00 Central' }, items: [{ check_number: '1', bank_decision: 'unconfirmed' }], notice: {}, alerts: [] };
  const kinds = (now) => W.dueAlerts(review, now).map((a) => a.kind);
  check('a 9 o\'clock slot (fired 9:00-9:15) sends the "not yet decided" warning', kinds(at(9, 0)).includes('undecided_near_cutoff') && kinds(at(9, 14)).includes('undecided_near_cutoff'));
  check('an 11 o\'clock slot (fired 11:00-11:15) sends "cutoff passed with no recorded decision"', kinds(at(11, 0)).includes('cutoff_passed_unconfirmed') && kinds(at(11, 14)).includes('cutoff_passed_unconfirmed'));
  check('wired: positive_pay_watch is on cutoff slots, not an every-tick interval', /name: 'positive_pay_watch',\s*targetHours: require\('\.\/banking\/positive_pay_watch'\)\.watchHours\(\),\s*businessDaysOnly: true/.test(sched) && !/name: 'positive_pay_watch',\s*minIntervalMin/.test(sched));
  const ing = src('lib/email/graph_ingest.js');
  check('wired: a stored inbound Positive Pay email runs the watch on arrival, best-effort', /\/positive pay\/i\.test\(String\(row\.subject \|\| ''\)\)\)\s*\{\s*try \{ await require\('\.\.\/banking\/positive_pay_watch'\)\.tick\(\{ supabase \}\); \}\s*catch/.test(ing));

  console.log(`\nkat event-driven: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
