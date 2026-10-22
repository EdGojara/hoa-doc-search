// ============================================================================
// lib/accounting/positive_pay_submissions.js  (Ed 2026-10-22, migration 542)
// ----------------------------------------------------------------------------
// The daily Positive Pay file for NewFirst, and the record of what happened to it.
//
// Scar: from go-live (2026-09-10) every check trustEd cut reached NewFirst as an
// exception, because the issued-check file was downloadable per check run but
// nothing recorded whether it was sent. Celina approved the exceptions by email
// every morning; nobody could say which checks the bank had been told about.
//
// The rules this module enforces:
//   * Event-driven, no schedule: on a day trustEd issues NewFirst checks, Kat prepares
//     ONE file, uploads it and records the bank's confirmation. No checks, no file.
//   * The file is cumulative: every outstanding check on an ENABLED account
//     (bank_accounts.positive_pay_enabled) of an OPERATIONAL community, issued on or
//     after the bank's ONE cutoff date (banks.positive_pay_settings.export_from), not
//     already in a live submission, so
//     a check from a failed (rejected) upload is carried into the next file.
//   * Checks issued before the start date (or on an account with no start date yet)
//     are BACKLOG: reported, never exported, until a person reviews them.
//   * Preparing or downloading a file never marks it uploaded or accepted. A person
//     records the upload, then records the bank's outcome with evidence.
//   * A check is in at most one live submission (unique index, migration 542). A
//     rejected row frees the check for the next file; an accepted row never does.
//   * The account number in the file is the FULL decrypted number, and it must end
//     in the account's recorded last four, or the account is held as a problem.
//   * Status selection is an allow-list (issued / outstanding). Never .neq('void'):
//     the register says 'voided', and a deny-list let voided checks into the file.
//
// Banking decisions (pay / return an exception item) are never made here.
// ============================================================================
const crypto = require('crypto');
const { generatePositivePayCsv, sanitizePayee } = require('./positive_pay');
const { isOperational } = require('../community/lifecycle');
const { fetchAllQuery } = require('../db/fetch_all');

const NEWFIRST_BANK_ID = '16e07b6a-8902-4d1a-980e-db78938b98b3';
// Banks whose file layout this module writes (the NewFirst combined CSV).
const SUPPORTED_BANKS = new Set([NEWFIRST_BANK_ID]);
const OUTSTANDING = ['issued', 'outstanding'];
const LIVE_ITEM = ['included', 'accepted'];
const OPEN_SUBMISSION = ['prepared', 'uploaded'];
const OUTCOMES = ['accepted', 'partially_accepted', 'rejected'];
const KAT = 'Kat Reed (AI accounting manager)';

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const digits = (v) => String(v == null ? '' : v).replace(/[^0-9]/g, '');
const day = (d) => (d ? String(d).slice(0, 10) : null);
const central = (t) => `${new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(t))} Central`;
const err = (message, code, extra) => Object.assign(new Error(message), { code }, extra || {});

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/**
 * Can this account's checks go in the file? account carries its community row
 * and the decrypted full number (account_number_full).
 * @returns {{eligible:boolean, problem:string|null, reason:string|null}}
 */
function accountEligibility(account, community, today = null) {
  if (!account || !account.positive_pay_enabled) return { eligible: false, problem: null, reason: 'not enrolled in Positive Pay' };
  if (account.is_active === false) return { eligible: false, problem: null, reason: 'account inactive' };
  if (!isOperational(community, today)) return { eligible: false, problem: null, reason: `former client (${(community && community.management_status) || 'not managed'})` };
  const full = digits(account.account_number_full);
  if (!full) return { eligible: false, problem: 'the full account number is not on file', reason: null };
  if (account.account_last4 && !full.endsWith(String(account.account_last4))) return { eligible: false, problem: `the account number on file does not end in ${account.account_last4}`, reason: null };
  return { eligible: true, problem: null, reason: null };
}

/** A check the bank should still be told about (or warned about). */
function isOutstanding(c) {
  return !!c && OUTSTANDING.includes(c.status) && !c.cleared_date && !c.voided_at && !c.stop_payment_at;
}

/**
 * Sort every check on the bank's accounts into what to do with it.
 * @param state { accounts:[account+community+account_number_full], checks:[register rows], liveItems:[items] }
 * @returns {{ toExport, backlog, alreadyLive, accountProblems, excludedAccounts }}
 */
function planExport({ accounts = [], checks = [], items = [], submissions = [], exportFrom = null }, today = null) {
  // A row only counts as live while its submission is still open or accepted: a row left
  // 'included' on a cancelled or rejected file (an interrupted write) must not hide the check.
  const deadSub = new Set(submissions.filter((s) => s.status === 'cancelled' || s.status === 'rejected').map((s) => s.id));
  const live = new Map(items.filter((i) => LIVE_ITEM.includes(i.status) && !deadSub.has(i.submission_id)).map((i) => [i.check_register_id, i]));
  const acct = new Map(accounts.map((a) => [a.id, { a, e: accountEligibility(a, a.community, today) }]));
  const out = { exportFrom: exportFrom ? day(exportFrom) : null, toExport: [], backlog: [], alreadyLive: [], accountProblems: [], excludedAccounts: [] };
  for (const { a, e } of acct.values()) {
    if (e.problem) out.accountProblems.push({ bank_account_id: a.id, account: a.account_nickname, account_last4: a.account_last4, community_id: a.community_id, community: a.community && a.community.name, problem: e.problem });
    else if (!e.eligible) out.excludedAccounts.push({ bank_account_id: a.id, account: a.account_nickname, account_last4: a.account_last4, community_id: a.community_id, community: a.community && a.community.name, reason: e.reason });
  }
  for (const c of checks) {
    if (!isOutstanding(c)) continue;
    const hit = acct.get(c.bank_account_id);
    if (!hit || !hit.e.eligible) continue;
    if (live.has(c.id)) { out.alreadyLive.push({ ...c, item: live.get(c.id) }); continue; }
    // Before the cutoff (or no cutoff yet): history, resolved once by hand, never by this file.
    if (!exportFrom || day(c.issue_date) < day(exportFrom)) { out.backlog.push({ ...c, backlog_reason: exportFrom ? `issued before the Positive Pay cutoff ${day(exportFrom)}` : 'no Positive Pay cutoff is set yet' }); continue; }
    out.toExport.push({ ...c, account_number_full: digits(hit.a.account_number_full) });
  }
  // Deterministic order: by account, then check number (numeric when it is one).
  const num = (s) => (/^\d+$/.test(String(s)) ? Number(s) : Number.MAX_SAFE_INTEGER);
  out.toExport.sort((x, y) => String(x.bank_account_id).localeCompare(String(y.bank_account_id)) || num(x.check_number) - num(y.check_number) || String(x.check_number).localeCompare(String(y.check_number)));
  return out;
}

/** The file for a set of rows, in row order, plus its SHA-256. Rows need account_number_full. */
function buildFile(rows) {
  const out = generatePositivePayCsv(rows.map((r) => ({ issue_date: r.issue_date, check_number: r.check_number, payee_name: r.payee_name != null ? r.payee_name : r.payee_sent, amount_cents: r.amount_cents, account_number: r.account_number_full })));
  if (out.count !== rows.length) throw err(`the file has ${out.count} rows but ${rows.length} checks were selected`, 'invalid_state');
  if (out.missing_account) throw err(`${out.missing_account} row(s) have no account number`, 'invalid_state');
  return { csv: out.csv, sha256: sha256(out.csv), count: out.count, total_cents: out.total_cents };
}

/**
 * What a recorded outcome does to each row. rejected = [{check_register_id, reason}].
 * @returns {{ accept:[itemId], reject:[{id, reason}] }}
 */
function planOutcome(items, outcome, rejected = [], reason = null) {
  if (!OUTCOMES.includes(outcome)) throw err(`outcome must be one of ${OUTCOMES.join(', ')}`, 'invalid_input');
  const byCheck = new Map(items.map((i) => [i.check_register_id, i]));
  if (outcome === 'accepted') return { accept: items.map((i) => i.id), reject: [] };
  if (outcome === 'rejected') {
    const why = String(reason || '').trim();
    if (!why) throw err('say why the bank rejected the file', 'invalid_input');
    return { accept: [], reject: items.map((i) => ({ id: i.id, reason: why })) };
  }
  const list = Array.isArray(rejected) ? rejected : [];
  if (!list.length) throw err('a partial acceptance must name the rejected checks', 'invalid_input');
  const reject = [];
  for (const r of list) {
    const it = byCheck.get(r && r.check_register_id);
    if (!it) throw err(`check ${r && r.check_register_id} is not in this submission`, 'invalid_input');
    const why = String((r && r.reason) || reason || '').trim();
    if (!why) throw err(`say why check ${it.check_number} was rejected`, 'invalid_input');
    reject.push({ id: it.id, reason: why });
  }
  if (reject.length >= items.length) throw err('every row was rejected: record the outcome as rejected', 'invalid_input');
  const rej = new Set(reject.map((r) => r.id));
  return { accept: items.filter((i) => !rej.has(i.id)).map((i) => i.id), reject };
}

/** Rejected check NUMBERS (as the bank reports them) to this file's rows. Refuses a number that is not in the file or is on two accounts. */
function rejectionsByNumber(items, numbers = [], reason = null) {
  const out = [];
  for (const raw of numbers || []) {
    const n = String(raw).trim().replace(/^#/, '');
    if (!n) continue;
    const hits = items.filter((i) => String(i.check_number) === n);
    if (!hits.length) throw err(`check ${n} is not in this file`, 'invalid_input');
    if (hits.length > 1) throw err(`check ${n} is in this file on ${hits.length} accounts; name the account`, 'invalid_input');
    out.push({ check_register_id: hits[0].check_register_id, reason });
  }
  return out;
}

/**
 * The exception report: everything that needs a person, nothing routine.
 * @param p { plan (from planExport), checks, submissions, items, now }
 */
function exceptions({ plan, checks = [], submissions = [], items = [], now = new Date() }) {
  const byId = new Map(checks.map((c) => [c.id, c]));
  const hours = (t) => (now - new Date(t)) / 3600000;
  const out = [];
  const push = (kind, severity, text, extra) => out.push({ kind, severity, text, ...(extra || {}) });
  const label = (c) => `#${c.check_number} ${c.payee_name || ''} $${(Number(c.amount_cents) / 100).toFixed(2)}`.trim();

  for (const c of plan.toExport) if (hours(`${day(c.created_at) || day(c.issue_date)}T23:59:59-05:00`) > 0) {
    push('not_submitted', 'high', `${label(c)} (issued ${day(c.issue_date)}) is not in any Positive Pay file. The bank will treat it as an exception.`, { check_register_id: c.id, bank_account_id: c.bank_account_id });
  }
  for (const a of plan.accountProblems) push('account_problem', 'high', `${a.community}: ${a.account} (…${a.account_last4}): ${a.problem}. Its checks cannot be exported.`, { bank_account_id: a.bank_account_id });
  if (!plan.exportFrom) push('no_cutoff', 'medium', 'No Positive Pay cutoff date is set, so no file can be prepared. It is set once, after the historical checks are resolved with NewFirst.');
  for (const s of submissions) {
    if (s.status === 'prepared' && hours(s.prepared_at) > 2) push('awaiting_upload', 'high', `The file prepared ${central(s.prepared_at)} (${s.check_count} checks) has not been recorded as uploaded.`, { submission_id: s.id });
    if (s.status === 'uploaded' && hours(s.uploaded_at) > 4) push('awaiting_confirmation', 'high', `The file uploaded ${central(s.uploaded_at)} (${s.check_count} checks) has no recorded bank acceptance.`, { submission_id: s.id });
  }
  const liveByCheck = new Map(items.filter((i) => LIVE_ITEM.includes(i.status)).map((i) => [i.check_register_id, i]));
  const subStatus = new Map(submissions.map((s) => [s.id, s.status]));
  const unsettled = items.filter((i) => i.status === 'included' && ['accepted', 'partially_accepted'].includes(subStatus.get(i.submission_id)));
  if (unsettled.length) push('outcome_incomplete', 'high', `${unsettled.length} row(s) on files with a recorded bank outcome were not updated to accepted or rejected. Re-record the outcome or check the rows.`, { count: unsettled.length });
  for (const i of items.filter((x) => x.status === 'rejected')) {
    if (liveByCheck.has(i.check_register_id)) continue;   // already resubmitted
    const c = byId.get(i.check_register_id);
    if (c && isOutstanding(c)) push('rejected', 'high', `${label(c)} was rejected by the bank (${i.rejection_reason}) and has not been resubmitted.`, { check_register_id: c.id, submission_id: i.submission_id });
  }
  for (const i of liveByCheck.values()) {
    const c = byId.get(i.check_register_id);
    if (c && (c.voided_at || c.stop_payment_at || ['voided', 'stop_payment'].includes(c.status))) {
      push('voided_after_submission', 'high', `${label(c)} was ${c.status === 'stop_payment' || c.stop_payment_at ? 'stop-paid' : 'voided'} after it was sent to the bank (${i.status}). The bank still expects it: remove it in NewFirst Positive Pay (Overview, Item Search, Edit).`, { check_register_id: c.id, submission_id: i.submission_id });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
async function must(q, what) {
  const { data, error } = await q;
  if (error) throw err(`${what}: ${error.message}`, error.code || 'db_error');
  return data;
}

/** Everything the plan and the exception report need for one bank. Read-only. */
async function loadState(supabase, bankId, { decrypt = require('../crypto_field').decryptField } = {}) {
  if (!SUPPORTED_BANKS.has(bankId)) throw err('Positive Pay files are only built for NewFirst National Bank', 'invalid_input');
  const accountsRaw = await must(supabase.from('bank_accounts')
    .select('id, community_id, bank_id, account_nickname, account_last4, account_number_encrypted, is_active, positive_pay_enabled, communities(id, name, management_status, management_end_date)')
    .eq('bank_id', bankId).order('id').limit(500), 'bank accounts');
  const accounts = accountsRaw.map((a) => {
    let full = '';
    try { full = a.account_number_encrypted ? (decrypt(a.account_number_encrypted) || '') : ''; } catch (_) { full = ''; }
    const { account_number_encrypted, communities, ...rest } = a;
    return { ...rest, community: communities || null, account_number_full: full };
  });
  const ids = accounts.map((a) => a.id);
  const checks = ids.length ? await fetchAllQuery(() => supabase.from('check_register')
    .select('id, community_id, bank_account_id, check_number, issue_date, payee_name, amount_cents, status, voided_at, stop_payment_at, cleared_date, print_run_id, created_at')
    .in('bank_account_id', ids), { orderBy: 'id' }) : [];
  const items = ids.length ? await fetchAllQuery(() => supabase.from('positive_pay_submission_items')
    .select('id, submission_id, check_register_id, bank_account_id, check_number, status, rejection_reason, row_number')
    .in('bank_account_id', ids), { orderBy: 'id' }) : [];
  const submissions = await must(supabase.from('positive_pay_submissions')
    .select('id, bank_id, status, file_name, file_sha256, check_count, total_cents, prepared_by, prepared_at, uploaded_at, uploaded_by_name, outcome_recorded_at, outcome_recorded_by_name, bank_reference, outcome_evidence, cancelled_reason, notes')
    .eq('bank_id', bankId).order('prepared_at', { ascending: false }).limit(200), 'submissions');
  // The ONE cutoff: the first issue date this file covers (banks.positive_pay_settings.export_from).
  const [bank] = await must(supabase.from('banks').select('positive_pay_settings').eq('id', bankId).limit(1), 'bank');
  const settings = (bank && bank.positive_pay_settings) || {};
  const exportFrom = settings.export_from || null;
  return { accounts, checks, items, submissions, exportFrom, exportFromSetBy: settings.export_from_set_by || null, exportFromSetAt: settings.export_from_set_at || null };
}

/** The status screen: what would export now, the files and what needs attention. Read-only. */
async function status(supabase, bankId = NEWFIRST_BANK_ID, opts = {}) {
  const st = await loadState(supabase, bankId, opts);
  const plan = planExport(st, opts.today || null);
  const ex = exceptions({ plan, checks: st.checks, submissions: st.submissions, items: st.items, now: opts.now || new Date() });
  const strip = ({ account_number_full, ...r }) => r;   // never send a full account number to the browser
  return {
    bank_id: bankId,
    accounts: st.accounts.map((a) => ({ id: a.id, community: a.community && a.community.name, account: a.account_nickname, account_last4: a.account_last4, enabled: !!a.positive_pay_enabled, eligibility: accountEligibility(a, a.community, opts.today || null) })),
    to_export: plan.toExport.map(strip),
    to_export_total_cents: plan.toExport.reduce((s, c) => s + Number(c.amount_cents || 0), 0),
    export_from: plan.exportFrom,
    export_from_set_by: st.exportFromSetBy,
    export_from_set_at: st.exportFromSetAt,
    can_set_cutoff: !plan.exportFrom && opts.isAdmin === true,
    before_cutoff_count: plan.backlog.length,
    submissions: st.submissions,
    exceptions: ex,
  };
}

/**
 * Prepare the next file: records a 'prepared' submission and its rows. Sends nothing,
 * marks nothing uploaded or accepted. Returns { submission:null } when there is nothing to send.
 */
async function prepare(supabase, { bankId = NEWFIRST_BANK_ID, preparedBy = KAT, userId = null, today = null, now = new Date() } = {}) {
  const st = await loadState(supabase, bankId);
  // Heal an interrupted cancel/reject: free rows still 'included' on a closed file, or the
  // one-live-row index would refuse those checks forever.
  const dead = st.submissions.filter((s) => s.status === 'cancelled' || s.status === 'rejected').map((s) => s.id);
  const stale = st.items.filter((i) => i.status === 'included' && dead.includes(i.submission_id));
  if (stale.length) {
    await must(supabase.from('positive_pay_submission_items').update({ status: 'released' }).in('id', stale.map((i) => i.id)).eq('status', 'included').select('id'), 'release stale rows');
    console.warn(`[positive_pay] released ${stale.length} row(s) left on closed files`);
    for (const i of stale) i.status = 'released';
  }
  const plan = planExport(st, today);
  if (!plan.toExport.length) return { submission: null, reason: plan.exportFrom ? 'no outstanding checks are waiting to be sent' : 'no Positive Pay cutoff is set yet', account_problems: plan.accountProblems };
  const file = buildFile(plan.toExport);
  const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).replace(/-/g, '');
  const [sub] = await must(supabase.from('positive_pay_submissions').insert({
    bank_id: bankId, status: 'prepared', file_name: `BEDROCK_POSITIVEPAY_${stamp}_${file.sha256.slice(0, 8)}.csv`, file_sha256: file.sha256,
    check_count: file.count, total_cents: file.total_cents, prepared_by: preparedBy, prepared_by_user_id: userId,
  }).select('*'), 'record the submission');
  const rows = plan.toExport.map((c, i) => ({
    submission_id: sub.id, check_register_id: c.id, community_id: c.community_id, bank_account_id: c.bank_account_id, check_number: String(c.check_number),
    issue_date: day(c.issue_date), payee_sent: sanitizePayee(c.payee_name), amount_cents: Number(c.amount_cents), row_number: i + 1, status: 'included',
  }));
  const { error: iErr } = await supabase.from('positive_pay_submission_items').insert(rows);
  if (iErr) {
    // The rows went in as one statement, so none were written. Close the empty submission.
    const { error: cErr } = await supabase.from('positive_pay_submissions').update({ status: 'cancelled', cancelled_reason: `rows not recorded: ${iErr.message}` }).eq('id', sub.id).eq('status', 'prepared');
    if (cErr) console.error('[positive_pay] could not close the empty submission', sub.id, cErr.message);
    throw err(iErr.code === '23505' ? 'one of these checks is already in another live Positive Pay file; reload and try again' : `the file's rows could not be recorded: ${iErr.message}`, iErr.code === '23505' ? 'duplicate_submission' : 'db_error');
  }
  return { submission: sub, count: file.count, total_cents: file.total_cents };
}

/** Rebuild a prepared file byte for byte. Downloading changes nothing. */
async function rebuildFile(supabase, submissionId, { decrypt = require('../crypto_field').decryptField } = {}) {
  const [sub] = await must(supabase.from('positive_pay_submissions').select('*').eq('id', submissionId).limit(1), 'submission');
  if (!sub) throw err('submission not found', 'not_found');
  if (sub.status === 'cancelled') throw err('this file was cancelled and must not be uploaded', 'invalid_state');
  const items = await must(supabase.from('positive_pay_submission_items').select('*').eq('submission_id', submissionId).order('row_number').limit(5000), 'submission rows');
  const acctIds = [...new Set(items.map((i) => i.bank_account_id))];
  const accts = await must(supabase.from('bank_accounts').select('id, account_number_encrypted').in('id', acctIds), 'accounts');
  const full = new Map(accts.map((a) => { let n = ''; try { n = a.account_number_encrypted ? (decrypt(a.account_number_encrypted) || '') : ''; } catch (_) { n = ''; } return [a.id, digits(n)]; }));
  const file = buildFile(items.map((i) => ({ ...i, payee_name: i.payee_sent, account_number_full: full.get(i.bank_account_id) || '' })));
  if (file.sha256 !== sub.file_sha256) throw err('the rebuilt file does not match the one prepared (an account number changed since); cancel it and prepare a new one', 'file_mismatch');
  return { submission: sub, csv: file.csv };
}

async function loadSubmission(supabase, id) {
  const [sub] = await must(supabase.from('positive_pay_submissions').select('*').eq('id', id).limit(1), 'submission');
  if (!sub) throw err('submission not found', 'not_found');
  return sub;
}

// Who records a step: a signed-in person (from the verified session) or Kat, when
// server code acts for her (her daily job, or her portal upload once NewFirst
// authorizes it). No HTTP route lets a caller claim to be Kat.
function actorOf(actor) {
  const a = actor || {};
  if (a.kat === true) return { userId: null, name: KAT };
  if (!a.userId) throw err('a signed-in person (or Kat) must record this step', 'invalid_input');
  return { userId: a.userId, name: a.name || 'Staff' };
}

/** Kat (or a person) uploaded the file in the bank portal. Not an acceptance. */
async function markUploaded(supabase, id, { actor, note = null } = {}) {
  const who = actorOf(actor);
  const sub = await loadSubmission(supabase, id);
  if (sub.status !== 'prepared') throw err(`this file is ${sub.status}; only a prepared file can be marked uploaded`, 'invalid_state');
  const rows = await must(supabase.from('positive_pay_submissions').update({ status: 'uploaded', uploaded_at: new Date().toISOString(), uploaded_by_user_id: who.userId, uploaded_by_name: who.name, notes: note || sub.notes })
    .eq('id', id).eq('status', 'prepared').select('*'), 'mark uploaded');
  if (!rows.length) throw err('the file changed while you were recording; reload', 'invalid_state');
  return rows[0];
}

/** Record what the bank did with an uploaded file, with the confirmation that was seen. */
async function recordOutcome(supabase, id, { actor, outcome, evidence, bankReference = null, rejected = [], rejectedCheckNumbers = [], reason = null } = {}) {
  const who = actorOf(actor);
  if (!String(evidence || '').trim()) throw err('describe the bank\'s confirmation (import summary, receipt or email) as evidence', 'invalid_input');
  const sub = await loadSubmission(supabase, id);
  // NewFirst shows the import result the moment the file is imported, so the usual path is
  // prepared -> outcome in one step (the upload is implied and stamped now). 'uploaded' is only
  // for a file whose result is not known yet.
  if (!['prepared', 'uploaded'].includes(sub.status)) throw err(`this file's outcome is already recorded (${sub.status})`, 'invalid_state');
  const nowIso = new Date().toISOString();
  const items = await must(supabase.from('positive_pay_submission_items').select('id, check_register_id, check_number, status').eq('submission_id', id).limit(5000), 'submission rows');
  const open = items.filter((i) => i.status === 'included');
  const plan = planOutcome(open, outcome, [...rejected, ...rejectionsByNumber(open, rejectedCheckNumbers, reason)], reason);
  // Claim the submission first so two people cannot record different outcomes.
  const claimed = await must(supabase.from('positive_pay_submissions').update({
    status: outcome, outcome_recorded_at: nowIso, outcome_recorded_by_user_id: who.userId, outcome_recorded_by_name: who.name,
    outcome_evidence: String(evidence).trim(), bank_reference: bankReference || null,
    ...(sub.status === 'prepared' ? { uploaded_at: nowIso, uploaded_by_user_id: who.userId, uploaded_by_name: who.name } : {}),
  }).eq('id', id).eq('status', sub.status).select('*'), 'record outcome');
  if (!claimed.length) throw err('the file changed while you were recording; reload', 'invalid_state');
  if (plan.accept.length) await must(supabase.from('positive_pay_submission_items').update({ status: 'accepted' }).in('id', plan.accept).eq('status', 'included').select('id'), 'accept rows');
  for (const r of plan.reject) await must(supabase.from('positive_pay_submission_items').update({ status: 'rejected', rejection_reason: r.reason }).eq('id', r.id).eq('status', 'included').select('id'), 'reject row');
  return { submission: claimed[0], accepted: plan.accept.length, rejected: plan.reject.length };
}

/** A prepared file that was never uploaded: close it and free its checks. */
async function cancel(supabase, id, { actor, reason } = {}) {
  actorOf(actor);
  if (!String(reason || '').trim()) throw err('say why the file is being cancelled', 'invalid_input');
  const sub = await loadSubmission(supabase, id);
  if (sub.status !== 'prepared') throw err(sub.status === 'uploaded' ? 'this file was recorded as uploaded: record the bank\'s result (rejected, if it did not take) instead of cancelling' : `this file is ${sub.status} and cannot be cancelled`, 'invalid_state');
  const rows = await must(supabase.from('positive_pay_submissions').update({ status: 'cancelled', cancelled_reason: String(reason).trim() }).eq('id', id).eq('status', 'prepared').select('*'), 'cancel');
  if (!rows.length) throw err('the file changed while you were recording; reload', 'invalid_state');
  await must(supabase.from('positive_pay_submission_items').update({ status: 'released' }).eq('submission_id', id).eq('status', 'included').select('id'), 'release rows');
  return rows[0];
}

/**
 * Admin, once: the first issue date the file covers, set after the historical checks are
 * resolved with NewFirst. Checks issued earlier are never exported by this module, so a
 * check NewFirst already paid through an exception cannot be resubmitted.
 */
async function setCutoff(supabase, fromDate, { setBy, bankId = NEWFIRST_BANK_ID } = {}) {
  const d = String(fromDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(new Date(`${d}T12:00:00Z`))) throw err('from_date must be a date, YYYY-MM-DD', 'invalid_input');
  if (!setBy) throw err('the signed-in owner who sets the cutoff is recorded', 'invalid_input');
  const [bank] = await must(supabase.from('banks').select('id, positive_pay_settings').eq('id', bankId).limit(1), 'bank');
  if (!bank) throw err('bank not found', 'not_found');
  const cur = bank.positive_pay_settings || {};
  if (cur.export_from) throw err(`the cutoff is already set to ${cur.export_from}; it is set once`, 'invalid_state');
  const next = { ...cur, export_from: d, export_from_set_by: setBy, export_from_set_at: new Date().toISOString() };
  const rows = await must(supabase.from('banks').update({ positive_pay_settings: next }).eq('id', bankId).select('id, positive_pay_settings'), 'set cutoff');
  return rows[0];
}


// ---------------------------------------------------------------------------
// Kat's task (Ed 2026-10-22). Event-driven, never scheduled: every event that can
// change what is pending (a check run, a void, preparing, recording a result,
// cancelling) calls syncKatTask. It keeps ONE open work item for Kat while
// anything is pending and closes it by evidence when nothing is, so a file that
// was not uploaded or confirmed stays in front of her until it is. Nothing runs
// on a day with no checks. Later automatic transmission (SFTP or an authorized
// upload) plugs in as another actor on the same steps: prepare, record result.
// ---------------------------------------------------------------------------
const TASK_REF = 'positive-pay:newfirst';
const OPEN_TASK = ['new', 'in_progress', 'waiting'];

/** Pure: what Kat's task should say, or null when nothing is pending. */
function katTask(st, now = new Date()) {
  const waiting = (st.to_export || []).length;
  const open = (st.submissions || []).filter((s) => OPEN_SUBMISSION.includes(s.status));
  const problems = (st.exceptions || []).filter((x) => x.kind !== 'not_submitted' && x.kind !== 'rejected' && x.kind !== 'awaiting_upload' && x.kind !== 'awaiting_confirmation' && x.kind !== 'no_cutoff');
  if (!waiting && !open.length && !problems.length) return null;
  const parts = [];
  if (waiting) parts.push(`${waiting} check${waiting === 1 ? '' : 's'} to send`);
  if (open.length) parts.push(`${open.length} file${open.length === 1 ? '' : 's'} awaiting NewFirst's result`);
  if (problems.length) parts.push(`${problems.length} item${problems.length === 1 ? '' : 's'} to resolve`);
  const next = waiting && !open.length ? 'Prepare the file, import it in NewFirst Positive Pay (Overview, Import a File, Bedrock template), then record the import result.'
    : open.length ? "Import the prepared file in NewFirst Positive Pay if it has not been, then record NewFirst's import result."
      : 'Resolve the items listed under Needs attention.';
  // Due at 5:00 pm Central on the day the work appeared: the file goes in the same day.
  const dayCT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const off = /GMT-5/.test(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'shortOffset' }).format(new Date(`${dayCT}T12:00:00Z`))) ? '-05:00' : '-06:00';
  return {
    title: `Positive Pay (NewFirst): ${parts.join(', ')}`.slice(0, 300),
    summary: [...(waiting ? [`Checks waiting: ${(st.to_export || []).map((c) => '#' + c.check_number).join(', ')}.`] : []), ...(st.exceptions || []).map((x) => x.text)].join(' ').slice(0, 2000),
    next_step: next,
    urgency: problems.some((x) => x.severity === 'high') || open.length ? 'high' : 'normal',
    sla_due_at: new Date(`${dayCT}T17:00:00${off}`).toISOString(),
  };
}

/**
 * Open, update or close Kat's single Positive Pay task to match the current state.
 * Never throws: a check run or a void must not fail because of it (it logs instead).
 */
async function syncKatTask(supabase, { reason = 'update', now = new Date() } = {}) {
  try {
    const st = await status(supabase, NEWFIRST_BANK_ID, { now });
    const want = katTask(st, now);
    const { data: openRows, error: oErr } = await supabase.from('work_items').select('id, title, summary, next_step, urgency').eq('source_ref', TASK_REF).in('status', OPEN_TASK).limit(1);
    if (oErr) throw new Error(`work items: ${oErr.message}`);
    const cur = (openRows || [])[0] || null;
    const ev = async (id, event, detail) => { const { error } = await supabase.from('work_item_events').insert({ work_item_id: id, event, actor: KAT, detail }); if (error) console.warn('[positive_pay] task event not recorded', id, error.message); };
    if (!want) {
      if (!cur) return { action: 'none' };
      const { error } = await supabase.from('work_items').update({ status: 'done', completed_at: now.toISOString() }).eq('id', cur.id).in('status', OPEN_TASK);
      if (error) throw new Error(`close task: ${error.message}`);
      await ev(cur.id, 'closed_by_evidence', { reason, detail: 'every check is in a file NewFirst accepted; nothing pending' });
      return { action: 'closed', id: cur.id };
    }
    if (cur) {
      if (cur.title === want.title && cur.summary === want.summary && cur.next_step === want.next_step && cur.urgency === want.urgency) return { action: 'unchanged', id: cur.id };
      const { error } = await supabase.from('work_items').update({ title: want.title, summary: want.summary, next_step: want.next_step, urgency: want.urgency }).eq('id', cur.id);
      if (error) throw new Error(`update task: ${error.message}`);
      await ev(cur.id, 'agent_touch', { reason, fields: ['title', 'summary', 'next_step', 'urgency'] });
      return { action: 'updated', id: cur.id };
    }
    const { data, error } = await supabase.from('work_items').insert({
      source_type: 'agent', workspace: 'operations', item_type: 'task', module_key: 'positive_pay', horizon: 'now', status: 'new',
      assigned_to: 'Kat', requested_by: 'trustEd (Positive Pay)', created_by: KAT, source_ref: TASK_REF, record_ownership: 'workpaper',
      action_url: '/admin/positive-pay', why: 'NewFirst only pays checks it was told about; a check run is not finished until NewFirst confirms the file.',
      ...want,
    }).select('id').single();
    if (error) {
      if (String(error.code) === '23505') return { action: 'race' };   // another event opened it first
      throw new Error(`open task: ${error.message}`);
    }
    await ev(data.id, 'created', { reason, source_ref: TASK_REF });
    return { action: 'opened', id: data.id };
  } catch (e) {
    console.warn('[positive_pay] Kat task not synced:', JSON.stringify({ reason, error: e.message }));
    return { action: 'error', error: e.message };
  }
}

module.exports = {
  NEWFIRST_BANK_ID, KAT, OUTSTANDING,
  accountEligibility, isOutstanding, planExport, buildFile, planOutcome, rejectionsByNumber, exceptions,
  loadState, status, prepare, rebuildFile, markUploaded, recordOutcome, cancel, setCutoff,
  katTask, syncKatTask, TASK_REF,
};
