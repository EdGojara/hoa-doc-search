// Positive Pay submission tracking (Ed 2026-10-22, migration 542). Offline: pure rules plus
// the prepare -> upload -> outcome lifecycle against an in-memory table store that enforces
// the one-live-row-per-check index. Locks: only enrolled, started NewFirst accounts of
// operational communities; voided checks never exported; preparing/downloading never marks
// anything uploaded or accepted; a check is never in two live files; a rejected row frees it.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://offline.invalid';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'offline';
const fs = require('fs');
const path = require('path');
const P = require('../lib/accounting/positive_pay_submissions');
const { PP_HEADER } = require('../lib/accounting/positive_pay');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };
const throwsCode = async (fn, code) => { try { await fn(); return false; } catch (e) { return e.code === code; } };

const ACTIVE = { id: 'c-wv', name: 'Waterview Estates', management_status: 'active' };
const ARCHIVED = { id: 'c-eg', name: 'Eaglewood', management_status: 'archived' };
const acct = (o) => ({ id: 'a1', community_id: ACTIVE.id, bank_id: P.NEWFIRST_BANK_ID, account_nickname: 'Waterview Operating', account_last4: '5961', is_active: true, positive_pay_enabled: true, community: ACTIVE, account_number_full: '765961', ...o });
const chk = (o) => ({ id: 'k1', community_id: ACTIVE.id, bank_account_id: 'a1', check_number: '1050', issue_date: '2026-10-21', payee_name: 'Lake Pro, Inc.', amount_cents: 32470, status: 'issued', created_at: '2026-10-21T20:00:00Z', ...o });

console.log('who is in the file');
{
  const e = (a, c) => P.accountEligibility(a, c || a.community);
  check('enrolled, operational, full number ends in last four: eligible', e(acct()).eligible);
  check('not enrolled: excluded', !e(acct({ positive_pay_enabled: false })).eligible);
  check('former client (archived Eaglewood): excluded, named', !e(acct({ community: ARCHIVED })).eligible && /former client/.test(e(acct({ community: ARCHIVED })).reason));
  check('full account number missing: a problem, not silently skipped', /not on file/.test(e(acct({ account_number_full: '' })).problem || ''));
  check('full number that does not end in the last four: a problem', /does not end in 5961/.test(e(acct({ account_number_full: '762449' })).problem || ''));

  const plan = P.planExport({
    accounts: [acct(), acct({ id: 'a2', account_nickname: 'Eaglewood Operating', account_last4: '7385', community: ARCHIVED, community_id: ARCHIVED.id, account_number_full: '777385' })],
    checks: [
      chk(),
      chk({ id: 'k2', check_number: '1051', status: 'voided', voided_at: '2026-10-21T21:00:00Z' }),
      chk({ id: 'k3', check_number: '1052', status: 'stop_payment', stop_payment_at: '2026-10-21T21:00:00Z' }),
      chk({ id: 'k4', check_number: '1053', status: 'cleared', cleared_date: '2026-10-22' }),
      chk({ id: 'k5', check_number: '1040', issue_date: '2026-10-09' }),
      chk({ id: 'k6', check_number: '1054', bank_account_id: 'a2', community_id: ARCHIVED.id }),
      chk({ id: 'k7', check_number: '1049' }),
      chk({ id: 'k8', check_number: '1055', status: 'outstanding' }),
    ],
    items: [{ id: 'i1', submission_id: 's-old', check_register_id: 'k7', status: 'accepted' }],
    submissions: [{ id: 's-old', status: 'accepted' }],
    exportFrom: '2026-10-20',
  });
  const ids = plan.toExport.map((c) => c.id);
  check('exports the new issued and outstanding checks only', JSON.stringify(ids) === '["k1","k8"]', JSON.stringify(ids));
  check('voided, stop-paid and cleared checks are never exported (status allow-list, not .neq(void))', !ids.includes('k2') && !ids.includes('k3') && !ids.includes('k4'));
  check('a check issued before the cutoff is never exported (e.g. one NewFirst already paid as an exception)', plan.backlog.map((c) => c.id).join() === 'k5' && /before the Positive Pay cutoff/.test(plan.backlog[0].backlog_reason));
  check('a former client\'s checks are excluded and the account is listed as excluded', !ids.includes('k6') && plan.excludedAccounts.some((a) => a.bank_account_id === 'a2'));
  check('a check already accepted in an earlier file is not sent again', !ids.includes('k7') && plan.alreadyLive.some((c) => c.id === 'k7'));
  const ns = P.planExport({ accounts: [acct()], checks: [chk()] });
  check('no cutoff set: nothing exports', !ns.toExport.length && ns.backlog.length === 1 && /no Positive Pay cutoff/.test(ns.backlog[0].backlog_reason));
  const stale = P.planExport({ accounts: [acct()], checks: [chk()], items: [{ id: 'i9', submission_id: 's-x', check_register_id: 'k1', status: 'included' }], submissions: [{ id: 's-x', status: 'cancelled' }], exportFrom: '2026-10-20' });
  check('a row left included on a cancelled file does not hide the check', stale.toExport.length === 1);
}

console.log('the file');
{
  const f = P.buildFile([{ ...chk(), account_number_full: '765961' }, { ...chk({ id: 'k2', check_number: '1051', payee_name: "O'Brien & Sons, Inc.", amount_cents: 100000 }), account_number_full: '765961' }]);
  check('NewFirst combined layout: bank header, M/D/YYYY, payee without punctuation, full account number',
    f.csv === `${PP_HEADER}\r\n10/21/2026,1050,Lake Pro Inc,324.70,765961\r\n10/21/2026,1051,O Brien Sons Inc,1000.00,765961\r\n`, JSON.stringify(f.csv));
  check('SHA-256 of the exact bytes, count and total', /^[0-9a-f]{64}$/.test(f.sha256) && f.count === 2 && f.total_cents === 132470);
  let threw = false; try { P.buildFile([{ ...chk(), account_number_full: '' }]); } catch (e) { threw = e.code === 'invalid_state'; }
  check('a row with no account number refuses the whole file', threw);
}

console.log('recording the bank\'s outcome');
{
  const items = [{ id: 'r1', check_register_id: 'k1', check_number: '1050' }, { id: 'r2', check_register_id: 'k8', check_number: '1055' }];
  const a = P.planOutcome(items, 'accepted');
  check('accepted: every row accepted', a.accept.length === 2 && !a.reject.length);
  const r = P.planOutcome(items, 'rejected', [], 'file format not recognised');
  check('rejected: every row rejected with the reason', r.reject.length === 2 && r.reject[0].reason === 'file format not recognised');
  let t = false; try { P.planOutcome(items, 'rejected'); } catch (e) { t = e.code === 'invalid_input'; }
  check('rejected without a reason is refused', t);
  const p = P.planOutcome(items, 'partially_accepted', P.rejectionsByNumber(items, ['#1055'], 'duplicate check number at bank'));
  check('partial: the named check rejected, the rest accepted', p.accept.join() === 'r1' && p.reject.map((x) => x.id).join() === 'r2');
  t = false; try { P.rejectionsByNumber(items, ['9999']); } catch (e) { t = /not in this file/.test(e.message); }
  check('a rejected number that is not in the file is refused', t);
  t = false; try { P.planOutcome(items, 'partially_accepted', P.rejectionsByNumber(items, ['1050', '1055'], 'x')); } catch (e) { t = /record the outcome as rejected/.test(e.message); }
  check('a "partial" that rejects every row must be recorded as rejected', t);
}

console.log('exceptions');
{
  const now = new Date('2026-10-23T15:00:00Z');
  const plan = P.planExport({ accounts: [acct()], checks: [chk(), chk({ id: 'k5', check_number: '1040', issue_date: '2026-10-09' })], exportFrom: '2026-10-20' });
  const subs = [
    { id: 's1', status: 'prepared', prepared_at: '2026-10-23T09:00:00Z', check_count: 3 },
    { id: 's2', status: 'uploaded', uploaded_at: '2026-10-22T22:00:00Z', check_count: 2 },
    { id: 's3', status: 'partially_accepted' },
  ];
  const checks = [chk(), chk({ id: 'k9', check_number: '1060', status: 'voided', voided_at: '2026-10-23T12:00:00Z' }), chk({ id: 'k10', check_number: '1061' })];
  const items = [
    { submission_id: 's2', check_register_id: 'k9', status: 'included' },
    { submission_id: 's3', check_register_id: 'k10', status: 'rejected', rejection_reason: 'payee mismatch' },
  ];
  const ex = P.exceptions({ plan, checks, submissions: subs, items, now });
  const kinds = ex.map((x) => x.kind);
  check('an issued check not in any file is reported', kinds.includes('not_submitted'));
  check('checks before the cutoff are not an exception (history is resolved once, by hand)', !kinds.includes('backlog'));
  check('no cutoff set is reported', P.exceptions({ plan: P.planExport({ accounts: [acct()], checks: [] }), now }).some((x) => x.kind === 'no_cutoff'));
  check('a prepared file not uploaded, and an uploaded file with no bank confirmation, are reported', kinds.includes('awaiting_upload') && kinds.includes('awaiting_confirmation'));
  check('a rejected check not yet resubmitted is reported', ex.some((x) => x.kind === 'rejected' && /payee mismatch/.test(x.text)));
  check('a check voided after it was sent says to cancel it at the bank', ex.some((x) => x.kind === 'voided_after_submission' && /remove it in NewFirst Positive Pay/.test(x.text)));
}

// In-memory store: enough of the PostgREST builder for the lifecycle, with the
// one-live-row-per-check unique index.
function store(seed) {
  const T = JSON.parse(JSON.stringify(seed)); let n = 0;
  const liveDup = (rows) => { const live = T.positive_pay_submission_items.filter((i) => ['included', 'accepted'].includes(i.status)); for (const r of rows) if (['included', 'accepted'].includes(r.status) && live.some((i) => i.check_register_id === r.check_register_id && i.id !== r.id)) return true; return false; };
  function q(table) {
    let op = 'select', payload = null; const f = []; let lim = null, rng = null, sel = false, one = false;
    const api = {
      select() { sel = true; return api; }, eq(c, v) { f.push((r) => r[c] === v); return api; }, in(c, v) { f.push((r) => v.includes(r[c])); return api; },
      order() { return api; }, limit(x) { lim = x; return api; }, range(a, b) { rng = [a, b]; return api; }, single() { one = true; return api; },
      insert(rows) { op = 'insert'; payload = Array.isArray(rows) ? rows : [rows]; return api; },
      update(p) { op = 'update'; payload = p; return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      const t = T[table] || (T[table] = []);
      if (op === 'insert') {
        const rows = payload.map((r) => ({ id: `${table}-${++n}`, created_at: new Date().toISOString(), prepared_at: new Date().toISOString(), ...r }));
        if (table === 'positive_pay_submission_items' && (liveDup(rows) || new Set(rows.map((r) => r.check_register_id)).size !== rows.length)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_pp_items_one_live_per_check"' } };
        if (table === 'work_items' && rows.some((r) => r.source_ref && t.some((w) => w.source_ref === r.source_ref && ['new', 'in_progress', 'waiting'].includes(w.status)))) return { data: null, error: { code: '23505', message: 'ux_work_items_open_source_ref' } };
        t.push(...rows); return { data: sel ? (one ? rows[0] : rows) : null, error: null };
      }
      let rows = t.filter((r) => f.every((g) => g(r)));
      if (op === 'update') {
        const next = rows.map((r) => ({ ...r, ...payload }));
        if (table === 'positive_pay_submission_items' && liveDup(next)) return { data: null, error: { code: '23505', message: 'duplicate' } };
        // mirror migration 542's CHECK: an outcome names who recorded it and the bank's confirmation
        if (table === 'positive_pay_submissions' && ['accepted', 'partially_accepted', 'rejected'].includes(payload.status) && !(payload.outcome_recorded_at && String(payload.outcome_recorded_by_name || '').trim() && String(payload.outcome_evidence || '').trim())) return { data: null, error: { code: '23514', message: 'check constraint' } };
        rows.forEach((r) => Object.assign(r, payload)); return { data: sel ? rows : null, error: null };
      }
      if (rng) rows = rows.slice(rng[0], rng[1] + 1); if (lim) rows = rows.slice(0, lim);
      return { data: rows.map((r) => ({ ...r })), error: null };
    }
    return api;
  }
  return { from: q, T };
}

(async () => {
  console.log('lifecycle');
  const decrypt = (s) => s;   // the test store holds the number in the clear
  const accountRow = { id: 'a1', community_id: ACTIVE.id, bank_id: P.NEWFIRST_BANK_ID, account_nickname: 'Waterview Operating', account_last4: '5961', account_number_encrypted: '765961', is_active: true, positive_pay_enabled: true, communities: ACTIVE };
  const banks = [{ id: P.NEWFIRST_BANK_ID, positive_pay_settings: { exception_cutoff: '10:00', export_from: '2026-10-20' } }];
  const db = store({ banks, bank_accounts: [accountRow], check_register: [chk(), chk({ id: 'k8', check_number: '1055' })], positive_pay_submission_items: [], positive_pay_submissions: [], email_messages: [] });
  // the module decrypts with lib/crypto_field; route its loads through the clear-text store
  const cf = require('../lib/crypto_field'); const real = cf.decryptField; cf.decryptField = decrypt;
  try {
    const r1 = await P.prepare(db, { preparedBy: P.KAT, now: new Date('2026-10-22T22:00:00Z') });
    const s1 = db.T.positive_pay_submissions[0];
    check('Kat prepares one file of the two new checks', r1.count === 2 && s1.prepared_by === P.KAT && db.T.positive_pay_submission_items.length === 2);
    check('preparing marks nothing uploaded or accepted', s1.status === 'prepared' && !s1.uploaded_at && !s1.outcome_recorded_at && db.T.positive_pay_submission_items.every((i) => i.status === 'included'));
    const f1 = await P.rebuildFile(db, s1.id);
    check('downloading rebuilds the identical file and changes nothing', require('crypto').createHash('sha256').update(f1.csv).digest('hex') === s1.file_sha256 && db.T.positive_pay_submissions[0].status === 'prepared');
    const r2 = await P.prepare(db, {});
    check('preparing again sends nothing twice: no new file while the checks are in a live one', r2.submission === null && db.T.positive_pay_submissions.length === 1);
    check('a result needs NewFirst\'s message as evidence', await throwsCode(() => P.recordOutcome(db, s1.id, { actor: { kat: true }, outcome: 'accepted', evidence: '' }), 'invalid_input'));
    check('no anonymous actor: a person or Kat must record the upload', await throwsCode(() => P.markUploaded(db, s1.id, {}), 'invalid_input'));
    await P.markUploaded(db, s1.id, { actor: { kat: true } });
    check('Kat records the upload; the file is still not accepted', db.T.positive_pay_submissions[0].status === 'uploaded' && db.T.positive_pay_submissions[0].uploaded_by_name === P.KAT);
    check('an uploaded file cannot be cancelled (record the bank\'s outcome instead)', await throwsCode(() => P.cancel(db, s1.id, { actor: { kat: true }, reason: 'x' }), 'invalid_state'));
    check('an outcome needs the bank\'s confirmation as evidence', await throwsCode(() => P.recordOutcome(db, s1.id, { actor: { kat: true }, outcome: 'accepted', evidence: ' ' }), 'invalid_input'));
    await P.recordOutcome(db, s1.id, { actor: { kat: true }, outcome: 'partially_accepted', evidence: 'Ecorp import summary: 1 accepted, 1 rejected', rejectedCheckNumbers: ['1055'], reason: 'payee mismatch' });
    const it = Object.fromEntries(db.T.positive_pay_submission_items.map((i) => [i.check_register_id, i.status]));
    check('partial acceptance: the accepted row is final, the rejected row is freed', it.k1 === 'accepted' && it.k8 === 'rejected' && db.T.positive_pay_submissions[0].status === 'partially_accepted');
    check('the outcome is recorded once', await throwsCode(() => P.recordOutcome(db, s1.id, { actor: { kat: true }, outcome: 'accepted', evidence: 'again' }), 'invalid_state'));
    const r3 = await P.prepare(db, { preparedBy: P.KAT });
    const items3 = db.T.positive_pay_submission_items.filter((i) => i.submission_id === r3.submission.id);
    check('the next file carries only the rejected check, never the accepted one', r3.count === 1 && items3.length === 1 && items3[0].check_register_id === 'k8');
    await P.cancel(db, r3.submission.id, { actor: { userId: 'u1', name: 'Celina Deleon' }, reason: 'prepared by mistake' });
    check('cancelling a prepared file frees its checks and blocks its download', db.T.positive_pay_submission_items.find((i) => i.submission_id === r3.submission.id).status === 'released' && await throwsCode(() => P.rebuildFile(db, r3.submission.id), 'invalid_state'));
    db.T.positive_pay_submission_items.push({ id: 'race', submission_id: 'other', check_register_id: 'k8', status: 'included', bank_account_id: 'a1' });
    db.T.positive_pay_submissions.push({ id: 'other', status: 'prepared', bank_id: P.NEWFIRST_BANK_ID, prepared_at: new Date().toISOString() });
    const r4 = await P.prepare(db, {});
    check('a check already in another live file is never put in a second one', r4.submission === null);
    db.T.check_register.push(chk({ id: 'k20', check_number: '1070' }));
    db.T.positive_pay_submission_items.push({ id: 'race2', submission_id: 'other', check_register_id: 'k20', status: 'included', bank_account_id: 'zz' });   // invisible to the plan: a concurrent writer
    check('a concurrent duplicate is refused by the unique index, and the empty file is closed', await throwsCode(() => P.prepare(db, {}), 'duplicate_submission') && db.T.positive_pay_submissions.slice(-1)[0].status === 'cancelled');
    check('only NewFirst files are built', await throwsCode(() => P.loadState(db, 'first-citizens'), 'invalid_input'));
  } finally { cf.decryptField = real; }

  console.log('event-driven: one run, quiet days, another run');
  {
    const bk = [{ id: P.NEWFIRST_BANK_ID, positive_pay_settings: { export_from: '2026-10-20' } }];
    const d = store({ banks: bk, bank_accounts: [accountRow], check_register: [
      chk({ id: 'old', check_number: '1001', issue_date: '2026-10-01' }),   // before the cutoff: NewFirst already paid it as an exception
      chk({ id: 'm1', check_number: '1100', issue_date: '2026-10-26' }), chk({ id: 'm2', check_number: '1101', issue_date: '2026-10-26' }),
    ], positive_pay_submission_items: [], positive_pay_submissions: [] });
    const cf2 = require('../lib/crypto_field'); const real2 = cf2.decryptField; cf2.decryptField = (x) => x;
    const quiet = (now) => P.exceptions({ plan: P.planExport({ accounts: [{ ...accountRow, community: ACTIVE, account_number_full: '765961' }], checks: d.T.check_register, items: d.T.positive_pay_submission_items, submissions: d.T.positive_pay_submissions, exportFrom: '2026-10-20' }), checks: d.T.check_register, submissions: d.T.positive_pay_submissions, items: d.T.positive_pay_submission_items, now });
    try {
      const mon = await P.prepare(d, { now: new Date('2026-10-26T22:00:00Z') });
      check("Monday: the file has Monday's two checks only, never the pre-cutoff check NewFirst already paid", mon.count === 2 && !d.T.positive_pay_submission_items.some((i) => i.check_register_id === 'old'));
      await P.markUploaded(d, mon.submission.id, { actor: { kat: true } });
      await P.recordOutcome(d, mon.submission.id, { actor: { kat: true }, outcome: 'accepted', evidence: 'Import complete: 2 items' });
      const tue = await P.prepare(d, {}); const wed = await P.prepare(d, {}); const thu = await P.prepare(d, {});
      check('Tuesday to Thursday, no checks issued: no file, and nothing needs attention', !tue.submission && !wed.submission && !thu.submission && d.T.positive_pay_submissions.length === 1 && !quiet(new Date('2026-10-29T22:00:00Z')).length);
      d.T.check_register.push(chk({ id: 'f1', check_number: '1102', issue_date: '2026-10-30' }));
      const fri = await P.prepare(d, {});
      const fr = d.T.positive_pay_submission_items.filter((i) => i.submission_id === fri.submission.id).map((i) => i.check_register_id);
      check("Friday: the next run's file has only the new check; Monday's accepted checks are not resent", fri.count === 1 && fr.join() === 'f1');
      await P.markUploaded(d, fri.submission.id, { actor: { kat: true } });
      await P.recordOutcome(d, fri.submission.id, { actor: { kat: true }, outcome: 'rejected', evidence: 'Import failed: invalid file', reason: 'import failed' });
      d.T.check_register.push(chk({ id: 'n1', check_number: '1103', issue_date: '2026-11-02' }));
      const mon2 = await P.prepare(d, {});
      const m2 = d.T.positive_pay_submission_items.filter((i) => i.submission_id === mon2.submission.id).map((i) => i.check_register_id).sort();
      check('after a failed upload, the next run carries the failed check forward with the new one', m2.join() === 'f1,n1');
      const pending = await P.prepare(d, {});
      check('while that file awaits upload and confirmation, its checks are not put in another file', !pending.submission);
    } finally { cf2.decryptField = real2; }
  }

  console.log("Kat's task: opened by a check run, kept open until resolved, closed by evidence");
  {
    const bk = [{ id: P.NEWFIRST_BANK_ID, positive_pay_settings: { export_from: '2026-10-20' } }];
    const d = store({ banks: bk, bank_accounts: [accountRow], check_register: [], positive_pay_submission_items: [], positive_pay_submissions: [], work_items: [], work_item_events: [] });
    const cf3 = require('../lib/crypto_field'); const real3 = cf3.decryptField; cf3.decryptField = (x) => x;
    const open = () => d.T.work_items.filter((w) => w.source_ref === P.TASK_REF && ['new', 'in_progress', 'waiting'].includes(w.status));
    try {
      let r = await P.syncKatTask(d, { reason: 'check_run', now: new Date('2026-10-23T15:00:00Z') });
      check('a day with no NewFirst checks: no task, nothing runs', r.action === 'none' && !d.T.work_items.length);
      d.T.check_register.push(chk({ id: 't1', check_number: '1200', issue_date: '2026-10-26' }), chk({ id: 't2', check_number: '1201', issue_date: '2026-10-26' }));
      r = await P.syncKatTask(d, { reason: 'check_run', now: new Date('2026-10-26T20:00:00Z') });
      const t = open()[0];
      check('a NewFirst check run opens ONE task for Kat, due 5:00 pm Central that day', r.action === 'opened' && open().length === 1 && t.assigned_to === 'Kat' && /2 checks to send/.test(t.title) && t.sla_due_at === '2026-10-26T22:00:00.000Z' && t.action_url === '/admin/positive-pay', JSON.stringify(t));
      await P.syncKatTask(d, { reason: 'check_run' });
      check('a second event the same day updates the same task, never a second one', open().length === 1);
      const prep = await P.prepare(d, {});
      await P.syncKatTask(d, { reason: 'prepared' });
      check('prepared but not imported: the task stays open and says the file awaits NewFirst', open().length === 1 && /awaiting NewFirst/.test(open()[0].title));
      await P.recordOutcome(d, prep.submission.id, { actor: { kat: true }, outcome: 'accepted', evidence: 'File imported successfully' });
      const sub = d.T.positive_pay_submissions.find((x) => x.id === prep.submission.id);
      check('recording the result straight from prepared stamps the import too (one step for Kat)', sub.status === 'accepted' && sub.uploaded_at && sub.uploaded_by_name === P.KAT && sub.outcome_recorded_by_name === P.KAT);
      r = await P.syncKatTask(d, { reason: 'result_accepted' });
      check('NewFirst accepted everything: the task closes by evidence', r.action === 'closed' && !open().length && d.T.work_item_events.some((e) => e.event === 'closed_by_evidence'));
      r = await P.syncKatTask(d, { reason: 'check_run' });
      check('quiet days after: nothing reopens', r.action === 'none' && !open().length);
      d.T.check_register.find((c) => c.id === 't1').status = 'voided'; d.T.check_register.find((c) => c.id === 't1').voided_at = '2026-10-27T15:00:00Z';
      r = await P.syncKatTask(d, { reason: 'void' });
      check('a check voided after NewFirst accepted it reopens Kat\'s task to remove it at the bank', r.action === 'opened' && /remove it in NewFirst Positive Pay/.test(open()[0].summary));
      d.T.check_register.push(chk({ id: 't3', check_number: '1202', issue_date: '2026-10-28' }));
      const p2 = await P.prepare(d, {});
      await P.recordOutcome(d, p2.submission.id, { actor: { kat: true }, outcome: 'rejected', evidence: 'Error: file could not be imported', reason: 'file could not be imported' });
      await P.syncKatTask(d, { reason: 'result_rejected' });
      check('a file that did not import keeps the task open with the check waiting to send again', open().length === 1 && /1 check to send/.test(open()[0].title));
      const failing = await P.syncKatTask({ from: () => { throw new Error('db down'); } }, { reason: 'check_run' });
      check('a failure syncing the task never breaks the check run (logged, returned)', failing.action === 'error');
    } finally { cf3.decryptField = real3; }
  }

  console.log('static');
  const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'checks.js'), 'utf8');
  check('no check_register query excludes status "void" (the register says voided)', !/\.neq\('status',\s*'void'\)/.test(api));
  check('the per-run and per-community downloads are retired (410)', /'\/run\/:printRunId\/positive-pay', \(req, res\) => res\.status\(410\)/.test(api) && /'\/positive-pay-file', \(req, res\) => res\.status\(410\)/.test(api));
  check('the status route strips full account numbers before they reach the browser', /account_number_full, \.\.\.r/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'accounting', 'positive_pay_submissions.js'), 'utf8')));

  console.log(`\npositive_pay_submissions: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
