// ============================================================================
// lib/mission_control/operations.js — Mission Control OPERATIONS workspace
// ----------------------------------------------------------------------------
// Builds the operations nodes (tasks + deliverables) from the AUTHORITATIVE
// records, read when Mission Control is opened (no polling, no copies):
//   * Kat's accounting runs (accounting_runs: prepared / held) -> approvals for Ed
//   * the month-end close checklist (latest period_close_runs per open period,
//     owner overrides on period_closes) -> close blockers
//   * the proposed next-year budget (lib/statements/model.buildProposedBudgetModel
//     and the working forecast) -> budget decisions
//   * the balance sheet by fund -> offsetting interfund balances, negative funds
//   * work_items (manual and agent tasks, Mail Scan, email) -> tasks
// A derived item disappears when its source no longer reports it: an approved run,
// a passing control, a decided budget question. A derived decision that has no
// system record can be marked decided by a person: a work_items row with the same
// source_ref and status done/dismissed (who, when and the note are kept there).
// ============================================================================
'use strict';

const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ym = (d) => String(d).slice(0, 7);
const monthLabel = (d) => `${MON[Number(String(d).slice(5, 7)) - 1]} ${String(d).slice(0, 4)}`;
const money = (c) => (c == null ? 'n/a' : `${c < 0 ? '-' : ''}$${Math.abs(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const lastOfMonth = (d) => { const [y, m] = String(d).slice(0, 7).split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const OWNER = 'Ed';

// Which agent / person owns each close control's next step.
const CONTROL_OWNER = { 'DATA-02': OWNER, 'AP-02': OWNER };
const controlOwner = (code) => CONTROL_OWNER[code] || 'Kat';

async function must(q, what) { const { data, error } = await q; if (error) throw new Error(`${what}: ${error.message}`); return data; }

// ---- deliverables --------------------------------------------------------------
function closeKey(cid, d) { return `close:${cid}:${ym(d)}`; }
function packageKey(cid, d) { return `package:${cid}:${ym(d)}`; }
function budgetKey(cid, fy) { return `budget:${cid}:${fy}`; }

function deliverablesForPeriod(c, period, closeRow) {
  const closed = closeRow && closeRow.status === 'closed';
  const pe = period.period_end || lastOfMonth(period.period_start);
  return [
    { key: closeKey(c.id, period.period_start), kind: 'deliverable', workspace: 'operations', title: `${c.name} ${monthLabel(period.period_start)} financial close`,
      community: { id: c.id, name: c.name }, category: 'accounting', weight: 3, state: closed ? 'done' : 'open', status_label: closed ? `Closed ${closeRow.closed_at ? String(closeRow.closed_at).slice(0, 10) : ''}`.trim() : (closeRow ? closeRow.status.replace(/_/g, ' ') : 'open'),
      owner: 'Kat', why: 'The month is final only when every close control passes (or the owner overrides a block with a reason) and the period is closed.',
      evidence: 'The period is closed in Month-End Close (period_closes.status = closed, with the books fingerprint).',
      action: { label: 'Month-End Close', url: `/admin/accounting?community_id=${c.id}&view=close` }, blocks: [packageKey(c.id, period.period_start)] },
    { key: packageKey(c.id, period.period_start), kind: 'deliverable', workspace: 'operations', title: `${c.name} ${monthLabel(period.period_start)} board financial package`,
      community: { id: c.id, name: c.name }, category: 'board', weight: 5, state: closed ? 'done' : 'open', status_label: closed ? 'Final (period closed)' : 'Review draft',
      owner: OWNER, why: 'The board receives final statements only after the month is closed.',
      evidence: 'The month is closed; the package then prints without the DRAFT banner.',
      action: { label: 'Open the package (PDF)', url: `/api/financial-statements/${c.id}/render?format=pdf&statements=board_package&period_end=${pe}` }, blocks: [] },
  ];
}

// ---- Kat's runs ----------------------------------------------------------------
function runTasks(c, runs, controlKeyFor) {
  const out = [];
  for (const r of runs) {
    const t = r.totals || {};
    const exc = (r.exceptions || []).filter((e) => e.code !== 'owner_exception');
    const month = monthLabel(r.period_month);
    const target = controlKeyFor(r) || closeKey(c.id, r.period_month);
    if (r.process === 'bank_reconciliation') {
      const held = r.status === 'held';
      out.push({ key: `run:${r.id}`, kind: 'task', workspace: 'operations', category: 'bank_reconciliation', community: { id: c.id, name: c.name },
        title: held ? `Provide the ${t.account || 'bank'} ${month} statement` : `Approve Kat's ${t.account || 'bank'} ${month} reconciliation`,
        owner: OWNER, requested_by: 'Kat', state: 'needs_action', priority: 'high',
        why: held ? (r.held_reason || 'The statement is missing, so Kat cannot reconcile the account.')
          : `Kat reconciled the account: difference ${money(t.difference_cents)}, ${exc.length} open exception${exc.length === 1 ? '' : 's'}${exc.length ? ` (${[...new Set(exc.map((e) => e.code))].join(', ')})` : ''}. Nothing is stored until you approve.`,
        detail: exc.map((e) => e.text || e.code).slice(0, 12),
        next: held ? 'Kat re-prepares the reconciliation once the statement is imported.' : 'trustEd stores the reconciliation; the close checklist re-checks cash.',
        evidence: held ? 'The statement is imported for the month.' : 'A stored reconciliation for the account and month with a $0.00 difference.',
        action: { label: held ? 'Open Kat\'s run' : 'Review and approve', url: `/ed.html?run=${r.id}` }, source: { system: 'accounting_runs', ref: r.id }, blocks: [target] });
    } else if (r.process === 'interest') {
      const items = ((r.preview || {}).items) || [];
      const routine = items.filter((i) => !i.exception && i.interest_cents > 0);
      out.push({ key: `run:${r.id}`, kind: 'task', workspace: 'operations', category: 'homeowner_accounting', community: { id: c.id, name: c.name },
        title: `Review ${String(r.run_date || r.period_month).slice(5, 7)}/${String(r.run_date || r.period_month).slice(8, 10)} late interest (${routine.length} owners, ${money(routine.reduce((s, i) => s + i.interest_cents, 0))})`,
        owner: OWNER, requested_by: 'Kat', state: 'needs_action', priority: 'normal', blocking: false,
        why: `Kat prepared the run; ${items.filter((i) => i.exception).length} exception accounts are held (attorney, payment plan, bankruptcy) until their instructions are verified.`,
        next: 'Approved interest posts to the routine owners only; held owners stay held.', evidence: 'The run is approved and posted (accounting_runs status posted).',
        action: { label: 'Review the run', url: `/ed.html?run=${r.id}` }, source: { system: 'accounting_runs', ref: r.id }, blocks: [] });
    } else {
      out.push({ key: `run:${r.id}`, kind: 'task', workspace: 'operations', category: 'accounting', community: { id: c.id, name: c.name },
        title: `Approve Kat's ${month} ${r.process.replace(/_/g, ' ')}`, owner: OWNER, requested_by: 'Kat', state: 'needs_action',
        why: 'Kat prepared the entries; nothing posts until you approve.', next: 'The entries post and the close re-checks.', evidence: 'The run is posted.',
        action: { label: 'Review the run', url: `/ed.html?run=${r.id}` }, source: { system: 'accounting_runs', ref: r.id }, blocks: [closeKey(c.id, r.period_month)] });
    }
  }
  return out;
}

// ---- close checklist -----------------------------------------------------------
function closeTasks(c, period, run, closeRow) {
  if (!run) {
    return [{ key: `close:${c.id}:${ym(period.period_start)}:checklist`, kind: 'task', workspace: 'operations', category: 'accounting', community: { id: c.id, name: c.name },
      title: `Run the ${monthLabel(period.period_start)} close checklist`, owner: 'Kat', state: 'open', why: 'No checklist run is recorded for this month, so its blockers are unknown.',
      next: 'The checklist lists every blocker for the month.', evidence: 'A recorded checklist run (period_close_runs).',
      action: { label: 'Month-End Close', url: `/admin/accounting?community_id=${c.id}&view=close` }, blocks: [closeKey(c.id, period.period_start)] }];
  }
  const overridden = new Set(((closeRow && closeRow.overrides) || []).map((o) => o.control_code || o.code));
  const accepted = new Set(((closeRow && closeRow.accepted_warnings) || []).map((o) => o.control_code || o.code || o));
  const out = [];
  for (const r of run.results || []) {
    if (r.status !== 'BLOCK' && r.status !== 'WARNING') continue;
    if (r.status === 'BLOCK' && overridden.has(r.code)) continue;
    if (r.status === 'WARNING' && accepted.has(r.code)) continue;
    const block = r.status === 'BLOCK';
    const owner = controlOwner(r.code);
    out.push({ key: `close:${c.id}:${ym(period.period_start)}:${r.code}`, kind: 'task', workspace: 'operations', category: 'accounting', community: { id: c.id, name: c.name },
      title: `${monthLabel(period.period_start)} close: ${r.label}`, owner, requested_by: owner === OWNER ? 'Kat' : null,
      state: owner === OWNER ? 'needs_action' : 'in_progress', priority: block ? 'high' : 'normal', blocking: block,
      status_label: block ? 'Blocks the close' : 'Warning', why: r.explanation, next: r.action || (block ? 'The control passes and the close can proceed.' : 'Accept the warning or resolve it.'),
      evidence: `Close control ${r.code} passes on the next checklist run${block ? ' (or the owner overrides it with a reason)' : ' (or the warning is accepted)'}.`,
      checked_at: run.run_at, action: { label: (r.drill && r.drill.label) || 'Month-End Close', url: (r.drill && r.drill.href ? r.drill.href.replace('/accounting.html', '/admin/accounting') : `/admin/accounting?community_id=${c.id}&view=close`) },
      source: { system: 'period_close_runs', ref: run.id, control: r.code }, blocks: [closeKey(c.id, period.period_start)] });
  }
  // A missing statement holds up the cash reconciliation, which holds up the close.
  const stmt = out.find((t) => t.source.control === 'DATA-02'), cash = out.find((t) => t.source.control === 'CASH-01');
  if (stmt) {
    const names = String(stmt.why || '').split(': ').slice(1).join(': ').replace(/\.$/, '');
    stmt.title = `Provide the ${monthLabel(period.period_start)} statement${names ? `: ${names}` : ''}`;
    stmt.next = `Kat reconciles the account once the statement is in trustEd; the close re-checks cash.`;
    stmt.evidence = 'The statement for the month is imported and the close control DATA-02 passes.';
    if (cash) stmt.blocks = [cash.key];
  }
  return out;
}

// ---- budget decisions ------------------------------------------------------------
function budgetNodes(c, fy, models, wf, projectCount) {
  const key = budgetKey(c.id, fy);
  const nodes = [{ key, kind: 'deliverable', workspace: 'operations', category: 'budget', community: { id: c.id, name: c.name }, title: `${c.name} proposed ${fy} budget`, weight: 5,
    owner: OWNER, state: 'open', status_label: 'Draft', why: 'The board adopts the budget; the draft is complete only when its funding decisions are made.',
    evidence: 'The draft is approved in trustEd (community_budgets status approved).',
    action: { label: 'Open the budget', url: `/admin/accounting?community_id=${c.id}&view=budget` }, blocks: [] }];
  const add = (k, title, why, next, opts = {}) => nodes.push({ key: `${key}:${k}`, kind: 'task', workspace: 'operations', category: 'budget', community: { id: c.id, name: c.name },
    title, owner: OWNER, state: 'needs_action', priority: opts.blocking === false ? 'normal' : 'high', blocking: opts.blocking !== false, why, next,
    evidence: opts.evidence || 'The draft budget reflects the decision, or the decision is recorded here with a note.',
    action: { label: 'Open the budget', url: `/admin/accounting?community_id=${c.id}&view=budget` }, source: { system: 'proposed_budget', ref: `${key}:${k}` }, blocks: [key], decidable: true });
  for (const l of (wf && wf.lines) || []) {
    if (l.kind === 'interfund_transfer' && l.transfer && l.transfer.status === 'needs_board_decision') {
      add(`transfer:${l.account_number}`, `Decide the ${fy} reserve contribution (${money(l.transfer.final_cents)} is provisional)`,
        `${l.account_number} ${l.account_name}: ${money(l.transfer.final_cents)} from ${l.transfer.from_fund_code} to ${l.transfer.to_fund_code} is carried from the ${fy - 1} budget. It needs a board decision (reserve study or explicit decision). The ${fy - 1} contribution recorded so far: ${money(Math.abs(l.base_year.ytd_actual_cents || 0))}.`,
        'The transfer amount is set; Operating transfer out and Reserve transfer in follow automatically.');
    }
  }
  if (projectCount === 0) add('reserve-projects', `Select the ${fy} reserve projects (none selected)`, `No capital project is planned for ${fy}, so reserve expenditures are $0.00. Reserve spending comes only from projects you select.`,
    'The projects total by GL account into the Reserve budget and the PDF.', { evidence: 'At least one planned project is saved, or "no projects" is recorded here as the decision.' });
  for (const m of models) {
    for (const w of m.warnings || []) {
      if (w.code === 'fund_balance_negative') add(`deficit:${m.fund}`, `Resolve the ${fy} ${m.subtitle.split(' Fund')[0]} Fund deficit`, w.text, 'The proposed budget no longer leaves the fund negative, or the deficit is accepted with a reason.');
    }
    if (m.fund === 'OPR' && !m.summary) {
      for (const s of m.sections) if (s.key === 'expense') for (const g of s.groups) for (const l of g.lines) {
        const proj = l.values.proj || 0, prop = l.values.prop || 0;
        if (proj > 0 && Math.abs(prop - proj) >= Math.max(1000000, Math.round(proj * 0.2))) {
          add(`assumption:${l.account_number}`, `Confirm the ${fy} assumption for ${l.account_number} ${l.account_name}`,
            `Proposed ${money(prop)} vs ${fy - 1} projected ${money(proj)} (${prop > proj ? '+' : ''}${Math.round(((prop - proj) / proj) * 100)}%).`, 'The amount is confirmed or changed in the draft.', { blocking: false });
        }
      }
    }
  }
  return nodes;
}

// ---- balance-sheet decisions (interfund, negative funds) --------------------------
function balanceNodes(c, bs, pkgKey) {
  const nodes = [];
  if (!bs) return nodes;
  const lines = new Map();
  for (const s of bs.sections) for (const g of s.groups) for (const l of g.lines) if (l.account_number) lines.set(l.account_number, l);
  const bal = (n) => { const l = lines.get(n); return l ? (l.values.total || 0) : 0; };
  const pairs = (bs.interfund && bs.interfund.pairs) || [];
  for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++) {
    const a = pairs[i], b = pairs[j];
    const fa = a.label.split(' owes ')[0], ta = a.label.split(' owes ')[1], fb = b.label.split(' owes ')[0], tb = b.label.split(' owes ')[1];
    if (fa !== tb || ta !== fb) continue;
    const va = bal(a.receivable.number), vb = bal(b.receivable.number);
    if (va && vb) {
      nodes.push({ key: `interfund:${c.id}:${a.receivable.number}:${b.receivable.number}`, kind: 'task', workspace: 'operations', category: 'accounting', community: { id: c.id, name: c.name },
        title: `Confirm and settle offsetting interfund balances (${a.label} ${money(va)}; ${b.label} ${money(vb)})`, owner: OWNER, requested_by: 'Kat', state: 'needs_action', priority: 'high',
        why: `Both directions carry a balance between the same two funds at ${bs.period ? bs.period.as_of || '' : ''}. Netting needs evidence of the transfers' purpose; until then both are presented gross.`,
        next: `If confirmed, Kat settles them, leaving ${money(Math.abs(va - vb))} owed by ${va > vb ? fa : fb}.`, evidence: 'One side of the pair is settled to $0.00 in the GL.',
        action: { label: 'Balance sheet', url: `/admin/accounting?community_id=${c.id}&view=bs` }, source: { system: 'balance_sheet', ref: `${a.receivable.number}/${b.receivable.number}` }, blocks: [pkgKey], decidable: true });
    }
  }
  const eq = bs.sections.find((s) => s.key === 'equity');
  for (const col of bs.columns || []) {
    if (!/^fund:/.test(col.key) || /OPR|RES/.test(col.key)) continue;
    const v = eq && eq.total.values[col.key];
    if (v != null && v < 0) nodes.push({ key: `fundneg:${c.id}:${col.key}`, kind: 'task', workspace: 'operations', category: 'accounting', community: { id: c.id, name: c.name },
      title: `Resolve the negative ${col.label} fund balance (${money(v)})`, owner: OWNER, requested_by: 'Kat', state: 'needs_action', priority: 'high',
      why: `${col.label} shows a deficit of ${money(v)} at ${bs.period ? bs.period.as_of || '' : ''}, driven by balances carried from the conversion. Confirm what is owed and to whom before the board package is final.`,
      next: 'Kat records the confirmed treatment; the fund balance follows.', evidence: 'The fund balance is no longer negative, or the treatment is recorded here with a note.',
      action: { label: 'Balance sheet', url: `/admin/accounting?community_id=${c.id}&view=bs` }, source: { system: 'balance_sheet', ref: col.key }, blocks: [pkgKey], decidable: true });
  }
  return nodes;
}

// ---- work_items ------------------------------------------------------------------
function workItemNodes(rows, workspace) {
  return (rows || []).filter((w) => (w.workspace || 'operations') === workspace).map((w) => ({
    key: `wi:${w.id}`, kind: 'task', workspace, category: w.item_type || w.source_type, community: w.community_id ? { id: w.community_id, name: w.community_name } : (w.community_name ? { id: null, name: w.community_name } : null),
    title: w.title, owner: w.assigned_to || 'Unassigned', requested_by: w.requested_by || (w.source_type === 'mail_scan' ? 'Mail Scan' : w.source_type === 'email' ? 'Email intake' : w.created_by || null),
    state: w.status === 'done' || w.status === 'dismissed' ? 'done' : w.status === 'waiting' ? 'waiting' : w.status === 'in_progress' ? 'in_progress' : (w.assigned_to === OWNER ? 'needs_action' : 'open'),
    priority: w.urgency || 'normal', due: w.sla_due_at || null, why: w.why || w.summary || null, next: w.next_step || null, evidence: w.evidence_required || null,
    action: w.action_url ? { label: 'Open', url: w.action_url } : { label: 'Team Status board', url: '/#tab=status' },
    module_key: w.module_key || null, source: { system: 'work_items', ref: w.id, source_ref: w.source_ref || null }, blocks: Array.isArray(w.blocks) ? w.blocks : [], editable: true,
  }));
}

// ---- agent objectives (lib/manager) --------------------------------------------------
const cap = (x) => (x ? String(x).charAt(0).toUpperCase() + String(x).slice(1) : null);
function objectiveNodes(rows, C = new Map()) {
  return (rows || []).map((o) => {
    const ownerAction = /^(approval required|payment awaiting release)/i.test(o.title || '') || o.autonomy_class === 'BLOCK';
    const subj = String(o.subject_key || '');
    const id = subj.split(':')[1] || null;
    const legal = /^legal_/.test(subj) && /^[0-9a-f-]{36}$/i.test(id || '');
    const payment = /^legal_invoice:/.test(subj);
    const c = o.community_id ? C.get(o.community_id) : null;
    return { key: `objective:${o.id}`, kind: 'task', workspace: 'operations', category: o.domain || 'agent',
      community: c ? { id: c.id, name: c.name } : null, title: o.title,
      owner: ownerAction ? OWNER : cap(o.accountable_persona || o.owner_persona) || 'Agent', requested_by: cap(o.accountable_persona || o.owner_persona),
      state: ownerAction ? 'needs_action' : 'in_progress', priority: o.priority || 'normal', blocking: false, due: o.next_action_due || null,
      why: o.blocked_reason || o.goal || null, next: o.next_action || null,
      evidence: payment ? 'The payment is released in the approval queue.' : legal ? 'The agents\' workflow closes this when its records show the work done (approved treatment and posted charges, or the evidence found).' : 'The owning agent closes it from its own records.',
      action: legal && !payment ? { label: 'Open in Legal Invoice Review', url: `/app/financial/legal?id=${id}` } : payment ? { label: 'Approval queue', url: '/ed.html' } : null,
      source: { system: 'objectives', ref: o.id, subject: subj } };
  });
}

// ---- assemble --------------------------------------------------------------------
async function loadOperations(supabase, { now = new Date(), cache = null, refresh = false, actor = null } = {}) {
  const problems = [];
  const attempt = async (label, fn, fallback) => { try { return await fn(); } catch (e) { problems.push({ source: label, message: e.message }); console.warn('[mission_control] source failed', label, e.message); return fallback; } };
  const nodes = [];
  const demo = await attempt('demo guard', async () => require('../demo/demo_guard').demoCommunityIds(), []);
  const comms = (await attempt('communities', () => must(supabase.from('communities').select('id, name, gl_cutover_date').not('gl_cutover_date', 'is', null).limit(200), 'communities'), [])).filter((c) => !demo.includes(c.id));
  const C = new Map(comms.map((c) => [c.id, c]));
  const today = now.toISOString().slice(0, 10);
  const thisMonth = `${today.slice(0, 7)}-01`;

  // Open periods where the close process is in use (a checklist run exists).
  const runs = await attempt('close runs', () => must(supabase.from('period_close_runs').select('id, community_id, period_id, period_start, period_end, run_at, results').order('run_at', { ascending: false }).limit(300), 'period_close_runs'), []);
  const latest = new Map(); for (const r of runs) if (!latest.has(r.period_id)) latest.set(r.period_id, r);
  const closes = await attempt('period closes', () => must(supabase.from('period_closes').select('period_id, community_id, period_start, period_end, status, overrides, accepted_warnings, closed_at').limit(500), 'period_closes'), []);
  const closeBy = new Map(closes.map((x) => [x.period_id, x]));
  const activeCommunities = new Set([...latest.values()].map((r) => r.community_id).filter((id) => C.has(id)));

  // Refresh (owner): Kat re-runs the checklist for each open month before reading it.
  if (refresh) {
    const svc = require('../close/service');
    for (const cid of activeCommunities) {
      const periods = await attempt('periods', () => must(supabase.from('accounting_periods').select('id, period_start').eq('community_id', cid).gte('period_start', `${String(C.get(cid).gl_cutover_date).slice(0, 7)}-01`).lt('period_start', thisMonth).order('period_start'), 'accounting_periods'), []);
      for (const p of periods) {
        const cr = closeBy.get(p.id);
        if (cr && cr.status === 'closed') continue;
        await attempt(`close checklist ${p.period_start}`, async () => { const r = await svc.runChecklist(supabase, cid, p.id, { name: 'Kat (AI accountant), refreshed from Mission Control' + (actor ? ` by ${actor}` : ''), user_id: null, role: 'staff' }); return r; }, null);
      }
    }
    return loadOperations(supabase, { now, cache, refresh: false, actor });
  }

  const periodsByCommunity = new Map();
  for (const cid of activeCommunities) {
    const c = C.get(cid);
    const periods = await attempt('periods', () => must(supabase.from('accounting_periods').select('id, period_start').eq('community_id', cid).gte('period_start', `${String(c.gl_cutover_date).slice(0, 7)}-01`).lt('period_start', thisMonth).order('period_start'), 'accounting_periods'), []);
    periodsByCommunity.set(cid, periods);
    for (const p of periods) {
      const cr = closeBy.get(p.id) || null;
      nodes.push(...deliverablesForPeriod(c, p, cr));
      if (cr && cr.status === 'closed') continue;
      nodes.push(...closeTasks(c, p, latest.get(p.id) || null, cr));
    }
  }

  // Kat's runs awaiting Ed (prepared / held), for every community.
  const kat = await attempt('accounting runs', () => must(supabase.from('accounting_runs').select('id, community_id, process, period_month, run_date, status, subject_id, totals, exceptions, held_reason, preview, created_at').in('status', ['prepared', 'held']).order('period_month').limit(200), 'accounting_runs'), []);
  const byCommunity = new Map(); for (const r of kat) { if (!C.has(r.community_id)) continue; (byCommunity.get(r.community_id) || byCommunity.set(r.community_id, []).get(r.community_id)).push(r); }
  const keys = new Set(nodes.map((n) => n.key));
  for (const [cid, rs] of byCommunity) {
    const c = C.get(cid);
    nodes.push(...runTasks(c, rs, (r) => { const k = `close:${cid}:${ym(r.period_month)}:CASH-01`; return keys.has(k) ? k : null; }));
  }

  // Next-year budget drafts (cached: the model reads the GL and the forecast).
  const fy = now.getUTCFullYear() + 1;
  const drafts = await attempt('budgets', () => must(supabase.from('community_budgets').select('community_id').eq('fiscal_year', fy).eq('status', 'draft').limit(100), 'community_budgets'), []);
  await Promise.all([Promise.all(drafts.map(async (d) => {
    const c = C.get(d.community_id); if (!c) return;
    const asOf = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
    const built = await attempt(`budget ${c.name}`, async () => {
      const ck = `budget:${c.id}:${fy}:${asOf}`;
      const hit = cache && cache.get(ck);
      if (hit) return hit;
      const M = require('../statements/model'); const D = require('../forecast/working_forecast_data'); const W = require('../forecast/working_forecast');
      const funds = await must(supabase.from('account_funds').select('fund_code, display_order').eq('community_id', c.id).eq('is_active', true).order('display_order'), 'account_funds');
      const [models, wfInput, projects] = await Promise.all([
        Promise.all(funds.map((f) => M.buildProposedBudgetModel(supabase, { community_id: c.id, target_year: fy, as_of: asOf, fund: f.fund_code, now }))),
        D.loadWorkingForecastInput(supabase, { community_id: c.id, target_year: fy, as_of: asOf }),
        must(supabase.from('reserve_budget_items').select('id').eq('community_id', c.id).eq('fiscal_year', fy).limit(500), 'reserve_budget_items'),
      ]);
      const wf = W.buildWorkingForecast(wfInput, { now });
      const hasReserve = models.some((m) => m.reserve_plan);
      const v = { models, wf, projectCount: hasReserve ? projects.length : null };
      if (cache) cache.set(ck, v);
      return v;
    }, null);
    if (built) nodes.push(...budgetNodes(c, fy, built.models, built.wf, built.projectCount));
  })), Promise.all([...activeCommunities].map(async (cid) => {
    // Balance-sheet decisions at the latest open month of each active community.
    const periods = periodsByCommunity.get(cid) || [];
    const open = periods.filter((p) => !(closeBy.get(p.id) && closeBy.get(p.id).status === 'closed'));
    if (!open.length) return;
    const last = open[open.length - 1]; const pe = lastOfMonth(last.period_start);
    const bs = await attempt('balance sheet', async () => {
      const ck = `bs:${cid}:${pe}`; const hit = cache && cache.get(ck); if (hit) return hit;
      const v = await require('../statements/model').buildBalanceSheetModel(supabase, { community_id: cid, as_of: pe, view: 'fund', now });
      if (cache) cache.set(ck, v); return v;
    }, null);
    nodes.push(...balanceNodes(C.get(cid), bs, packageKey(cid, last.period_start)));
  }))]);

  // Manual / agent / intake tasks.
  const wi = await attempt('work items', async () => {
    const r = await supabase.from('work_items').select('*').in('status', ['new', 'in_progress', 'waiting']).order('received_at', { ascending: false }).limit(500);
    if (r.error) throw new Error(r.error.message); return r.data;
  }, []);
  nodes.push(...workItemNodes(wi, 'operations'));

  // The agents' own open activities (objectives: Emma, Amanda, Kat). Each is ONE item: an
  // approval when the work is ready for the owner, otherwise the agent's open work with the
  // specific next action and the evidence it is missing. Closed by the agents' workflow.
  const objs = await attempt('agent objectives', async () => {
    const r = await supabase.from('objectives').select('id, community_id, title, goal, owner_persona, accountable_persona, status, next_action, next_action_due, autonomy_class, priority, blocked_reason, subject_key, domain, updated_at')
      .eq('status', 'open').order('updated_at', { ascending: false }).limit(300);
    if (r.error) throw new Error(r.error.message); return r.data;
  }, []);
  nodes.push(...objectiveNodes(objs, C));

  // Derived decisions a person recorded as decided (work_items with the same source_ref).
  const derivedKeys = nodes.filter((n) => n.decidable).map((n) => n.key);
  if (derivedKeys.length) {
    const decided = await attempt('decisions', async () => {
      const r = await supabase.from('work_items').select('source_ref, status, notes, updated_at, assigned_to').in('source_ref', derivedKeys).in('status', ['done', 'dismissed']).order('updated_at', { ascending: false }).limit(500);
      if (r.error) throw new Error(r.error.message); return r.data;
    }, []);
    const D = new Map(); for (const d of decided) if (!D.has(d.source_ref)) D.set(d.source_ref, d);
    for (const n of nodes) { const d = D.get(n.key); if (d) { n.state = 'done'; n.status_label = 'Decided'; n.resolution = { note: d.notes, at: d.updated_at, by: d.assigned_to }; } }
  }
  return { nodes, problems };
}

module.exports = { loadOperations, objectiveNodes, runTasks, closeTasks, budgetNodes, balanceNodes, workItemNodes, deliverablesForPeriod, closeKey, packageKey, budgetKey };
