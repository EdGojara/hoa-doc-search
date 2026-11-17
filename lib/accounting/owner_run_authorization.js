// ============================================================================
// Owner-authorized, agent-executed accounting runs (migration 566, Ed 2026-11-17).
// Reuses the conversion mechanism (lib/onboarding/owner_authorization.js, migrations 554-556):
// the same request email from Tessa, the same verified reply from the owner's own mailbox
// (exact request, AuthAs Internal, unexpired) and the same permanent evidence record.
//
//   verify    each run in the package is checked BEFORE it is offered: prepared, no blocking
//             exception, every included entry balanced, not already posted (same source
//             reference), and no posted entry with the same date, amount and accounts.
//   request   ONE email lists every run and the exact entries to post; the database records
//             each run's fingerprint (owner_authorization_request_runs).
//   authorize the owner replies "approved" (verified exactly as for conversions).
//   execute   Kat posts each run through monthly_runs.approveAndPost with the
//             owner_authorization channel; the database approves a run only if it is still
//             prepared and unchanged (accounting_run_approve_delegated). Results are verified
//             and the owner gets one completion note.
// A chat message, an API flag or an agent's say-so is never an authorization.
// ============================================================================
const crypto = require('crypto');
const AGENT_ID = 'ai-team:kat';
const AGENT_LABEL = 'Kat Reed (AI accounting manager), executing the owner\'s email authorization';
const usd = (c) => (Number(c) < 0 ? '-' : '') + '$' + (Math.abs(Number(c)) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PROCESS_LABEL = { journal_entry: 'Journal entries', cutoff_adjustment: 'Cutoff accruals', reclassification: 'Reclassifications',
  bank_reconciliation: 'Bank reconciliation', account_reconciliation: 'Account reconciliation (review; nothing posts)', interest: 'Homeowner interest', recognition: 'Revenue recognition' };

// The postable units of a run for the given include list: { id, label, amount_cents, entries:[{posting_date, source_reference, lines}] }.
function selectedUnits(run, include) {
  const pv = run.preview || {}; const inc = new Set(include || []);
  if (run.process === 'bank_reconciliation') {
    return (pv.proposals || []).filter((p) => inc.has(p.id)).map((p) => ({ id: p.id, label: p.description, amount_cents: p.amount_cents,
      entries: [{ posting_date: p.posting_date, source_reference: p.source_reference, lines: p.lines || [] }] }));
  }
  if (['journal_entry', 'cutoff_adjustment', 'reclassification'].includes(run.process)) {
    const units = (pv.items || []).filter((i) => inc.has(i.id)).map((i) => ({ id: i.id, label: i.label, amount_cents: i.amount_cents, already: !!i.already, entries: i.entries || [] }));
    for (const a of (pv.additions || []).filter((x) => inc.has(x.id))) units.push({ id: a.id, label: a.text, amount_cents: null, entries: [], addition: true });
    return units;
  }
  return [];
}
function allIds(run) {
  const pv = run.preview || {};
  if (run.process === 'bank_reconciliation') return (pv.proposals || []).map((p) => p.id);
  if (['journal_entry', 'cutoff_adjustment', 'reclassification'].includes(run.process)) return [...(pv.additions || []).map((a) => a.id), ...(pv.items || []).filter((i) => !i.already).map((i) => i.id)];
  return [];
}

// Pure checks on one run + include list. `posted` = { sourceRefs:Set, similar:(entry)=>[refs] }.
function verifyRun(run, include, posted = { sourceRefs: new Set(), similar: () => [] }) {
  const problems = []; const notes = [];
  if (run.status !== 'prepared') problems.push(`run is ${run.status}, not prepared`);
  const blocking = (run.exceptions || []).filter((e) => e && (e.severity === 'blocking' || ['period_closed', 'balance_mismatch'].includes(e.code)));   // same rule as monthly_runs BLOCKING
  if (blocking.length) problems.push(`blocking exception: ${blocking.map((b) => b.text).join('; ').slice(0, 300)}`);
  const ids = new Set(allIds(run));
  for (const id of include || []) if (!ids.has(id)) problems.push(`item ${id} is not in this run`);
  const units = selectedUnits(run, include);
  for (const u of units) {
    if (u.already) problems.push(`${u.label}: already posted`);
    for (const e of u.entries) {
      const dr = (e.lines || []).reduce((s, l) => s + Number(l.debit_cents || 0), 0);
      const cr = (e.lines || []).reduce((s, l) => s + Number(l.credit_cents || 0), 0);
      if (dr !== cr || dr <= 0) problems.push(`${u.label}: entry does not balance (debits ${usd(dr)}, credits ${usd(cr)})`);
      if ((e.lines || []).some((l) => Number(l.debit_cents || 0) > 0 && Number(l.credit_cents || 0) > 0)) problems.push(`${u.label}: a line has both a debit and a credit`);
      if (e.source_reference && posted.sourceRefs.has(e.source_reference)) problems.push(`${u.label}: already in the GL (${e.source_reference})`);
      const sim = posted.similar(e) || [];
      if (sim.length) problems.push(`${u.label}: a posted entry with the same date, amount and accounts exists (${sim.join(', ')}); possible duplicate`);
    }
  }
  if (run.process === 'account_reconciliation') notes.push('review only: approving records your review; nothing posts');
  const open = (run.exceptions || []).filter((e) => e && e.severity !== 'blocking' && e.severity !== 'info').length;
  if (open) notes.push(`${open} open item(s) stay open; they are not authorized by this request`);
  return { ok: !problems.length, problems, notes, units };
}

// Database facts for the duplicate checks of a set of runs.
async function postedFacts(supabase, runs) {
  const refs = []; const dates = new Set(); const community = new Set();
  for (const { run, include } of runs) for (const u of selectedUnits(run, include)) for (const e of u.entries) { if (e.source_reference) refs.push(e.source_reference); if (e.posting_date) dates.add(e.posting_date); community.add(run.community_id); }
  const sourceRefs = new Set();
  for (let i = 0; i < refs.length; i += 100) {
    const { data, error } = await supabase.from('journal_entries').select('source_reference').in('source_reference', refs.slice(i, i + 100)).neq('status', 'voided');
    if (error) throw error; for (const r of data || []) sourceRefs.add(r.source_reference);
  }
  const sigs = new Map();   // "community|date|total|accounts" -> [references]
  if (dates.size) {
    const { data: jes, error } = await supabase.from('journal_entries').select('id, reference, community_id, posting_date, total_debits_cents, status')
      .in('community_id', [...community]).in('posting_date', [...dates]).eq('status', 'posted').limit(2000);
    if (error) throw error;
    const ids = (jes || []).map((j) => j.id);
    const linesBy = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      const { data: ls, error: le } = await supabase.from('journal_entry_lines').select('journal_entry_id, debit_cents, credit_cents, chart_of_accounts(account_number)').in('journal_entry_id', ids.slice(i, i + 100));
      if (le) throw le; for (const l of ls || []) { if (!linesBy.has(l.journal_entry_id)) linesBy.set(l.journal_entry_id, []); linesBy.get(l.journal_entry_id).push(l); }
    }
    for (const j of jes || []) {
      const accts = [...new Set((linesBy.get(j.id) || []).map((l) => l.chart_of_accounts && l.chart_of_accounts.account_number))].sort().join(',');
      const k = `${j.community_id}|${j.posting_date}|${j.total_debits_cents}|${accts}`;
      if (!sigs.has(k)) sigs.set(k, []); sigs.get(k).push(j.reference);
    }
  }
  return (communityId) => ({ sourceRefs, similar: (e) => {
    const dr = (e.lines || []).reduce((s, l) => s + Number(l.debit_cents || 0), 0);
    const accts = [...new Set((e.lines || []).map((l) => String(l.account_number)))].sort().join(',');
    return sigs.get(`${communityId}|${e.posting_date}|${dr}|${accts}`) || [];
  } });
}

async function loadRuns(supabase, list) {
  const out = [];
  for (const x of list) {
    const { data, error } = await supabase.from('accounting_runs').select('*').eq('id', x.run_id).single();
    if (error) throw error;
    out.push({ run: data, include: x.include == null ? allIds(data) : x.include });
  }
  return out;
}

// Verify a package of runs: [{ run_id, include? }] (include omitted = every unposted item).
async function verifyPackage(supabase, list) {
  const runs = await loadRuns(supabase, list);
  const facts = await postedFacts(supabase, runs);
  return runs.map(({ run, include }) => ({ run, include, ...verifyRun(run, include, facts(run.community_id)) }));
}

function renderPackage({ subject, verified, communityNames, expiresAt }) {
  const sections = verified.map((v, n) => {
    const r = v.run; const head = `${n + 1}. ${communityNames[r.community_id] || ''} · ${PROCESS_LABEL[r.process] || r.process} · ${String(r.period_month).slice(0, 7)} · run ${r.id.slice(0, 8)}`;
    const rows = v.units.map((u) => {
      const lines = u.entries.flatMap((e) => (e.lines || []).map((l) => `      ${e.posting_date || ''}  ${l.account_number}${l.fund_code ? ' [' + l.fund_code + ']' : ''}  ${l.debit_cents ? 'Dr ' + usd(l.debit_cents) : 'Cr ' + usd(l.credit_cents)}`));
      return [`   - ${u.label}${u.amount_cents != null ? ' · ' + usd(u.amount_cents) : ''}`, ...lines].join('\n');
    });
    return [head, ...(rows.length ? rows : ['   - (nothing posts)']), ...v.notes.map((t) => `   Note: ${t}`)].join('\n');
  });
  const text = [`Ed,`, ``, `Kat has ${verified.length} accounting run${verified.length === 1 ? '' : 's'} ready. Each was checked before this email: still prepared, balanced, not already in the GL, no posted entry with the same date, amount and accounts.`, ``,
    `Reply "approved" to authorize exactly the runs and entries below. Kat then posts them, verifies the results and reports back. If any run changes before then, it is not posted. Reply anything else (or nothing) and nothing happens. This request expires ${expiresAt}.`, ``, ...sections, ``, `Tessa`].join('\n');
  const html = `<p>Ed,</p><p>Kat has <b>${verified.length}</b> accounting run${verified.length === 1 ? '' : 's'} ready. Each was checked before this email: still prepared, balanced, not already in the GL, no posted entry with the same date, amount and accounts.</p>`
    + `<p>Reply <b>"approved"</b> to authorize exactly the runs and entries below. Kat then posts them, verifies the results and reports back. If any run changes before then, it is not posted. Reply anything else (or nothing) and nothing happens. This request expires ${esc(expiresAt)}.</p>`
    + `<pre style="font-family:Consolas,monospace;font-size:12px;white-space:pre-wrap">${esc(sections.join('\n\n'))}</pre><p>Tessa</p>`;
  return { subject, text, html };
}

// One request for a verified package. Refuses if any run fails verification.
async function requestPackage({ supabase, rpc, send, list, ownerEmail, fromMailbox, summary, hours = 72 }) {
  const verified = await verifyPackage(supabase, list);
  const bad = verified.filter((v) => !v.ok);
  if (bad.length) throw Object.assign(new Error('not requested; fix first: ' + bad.map((v) => `${v.run.id.slice(0, 8)} ${v.problems.join('; ')}`).join(' | ')), { code: 'verification_failed', verified });
  const cids = [...new Set(verified.map((v) => v.run.community_id))];
  const { data: comms, error } = await supabase.from('communities').select('id, name').in('id', cids);
  if (error) throw error;
  const names = Object.fromEntries((comms || []).map((c) => [c.id, c.name]));
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  const subject = `Owner authorization ${code}: ${verified.length} accounting run${verified.length === 1 ? '' : 's'} (${cids.map((c) => names[c]).join(', ')})`;
  const r = await rpc('owner_authorization_request_runs', { p_subject: subject, p_summary: summary, p_runs: verified.map((v) => ({ run_id: v.run.id, include: v.include })), p_owner_email: ownerEmail, p_requested_by: AGENT_ID, p_hours: hours });
  const expiresAt = new Date(Date.now() + hours * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const mail = renderPackage({ subject, verified, communityNames: names, expiresAt });
  const sent = await send({ from: fromMailbox, to: ownerEmail, subject: mail.subject, text: mail.text, html: mail.html });
  if (!sent || !sent.internetMessageId || !sent.conversationId) throw new Error('the request email was not sent with a message identity; nothing can authorize it');
  await rpc('owner_authorization_sent', { p_id: r.id, p_message_id: sent.internetMessageId, p_conversation_id: sent.conversationId });
  return { id: r.id, subject, runs: verified.length, items_sha256: r.items_sha256 };
}

// Execute an AUTHORIZED package: post each run under the authorization, verify, close.
async function executePackage({ supabase, rpc, authorization, approveAndPost }) {
  const results = [];
  for (const item of authorization.items || []) {
    try {
      const out = await approveAndPost(supabase, { run_id: item.run_id, approval: { channel: 'owner_authorization', authorization_id: authorization.id } });
      const { data: after, error } = await supabase.from('accounting_runs').select('status, result').eq('id', item.run_id).single();
      if (error) throw error;
      const ok = after.status === 'posted';
      results.push({ run_id: item.run_id, process: item.process, ok, status: after.status, posted_entries: ((after.result || {}).posted_entries || []).length, detail: ok ? null : 'run did not reach posted' });
      void out;
    } catch (e) { results.push({ run_id: item.run_id, process: item.process, ok: false, error: e.message }); }
  }
  const execution = { posted: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results, executed_by: AGENT_ID };
  if (!execution.failed) await rpc('owner_authorization_mark_executed', { p_id: authorization.id, p_execution: execution });
  return execution;
}

function renderCompletion(authorization, execution) {
  const lines = execution.results.map((r) => `- run ${String(r.run_id).slice(0, 8)} ${PROCESS_LABEL[r.process] || r.process}: ${r.ok ? `posted (${r.posted_entries} entr${r.posted_entries === 1 ? 'y' : 'ies'})` : 'NOT posted: ' + (r.error || r.detail)}`);
  const text = [`Ed,`, ``, `Kat executed your authorization ${authorization.id.slice(0, 8)}: ${execution.posted} run(s) posted, ${execution.failed} not posted.`, ``, ...lines, ``,
    execution.failed ? 'The runs not posted stay as they were; nothing else was changed.' : 'Every authorized run posted and was checked.', ``, `Tessa`].join('\n');
  return { subject: `Done: ${authorization.subject}`, text, html: `<pre style="font-family:Consolas,monospace;font-size:12px;white-space:pre-wrap">${esc(text)}</pre>` };
}

module.exports = { AGENT_ID, AGENT_LABEL, selectedUnits, allIds, verifyRun, verifyPackage, postedFacts, renderPackage, requestPackage, executePackage, renderCompletion };
