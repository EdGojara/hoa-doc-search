// ============================================================================
// lib/manager/sweep.js  (Issue #27 Phase 1) — the bounded manager sweep
// ----------------------------------------------------------------------------
// Scheduler-controlled (job `manager_sweep`, off unless in SCHEDULER_ENABLED),
// default twice per business day. Database candidate discovery FIRST; with no
// candidates the run ends immediately. Steps 1-5 make ZERO model calls and take
// ZERO business actions: they only write Amanda's objective state (objectives /
// objective_events) and mark wakes consumed. Step 6 (agent execution) runs only
// with MANAGER_EXECUTE=on, limited to MANAGER_EXECUTORS (default request_invoice).
//
// Order, all sharing one candidate budget (MANAGER_MAX_CANDIDATES, default 40):
//   1. pending wakes (AP invoice / AP exception)          -> evaluate current row
//   2. BLOCKED objectives whose dependency is satisfied   -> re-evaluate once
//   3. open objectives with next_action_due soon/overdue  -> one note per change
//   4. board packets with a meeting inside the lead time, not final
//   5. re-check open subject objectives (oldest activity first) so finished
//      work resolves instead of going stale in the shadow view
// Unchanged state writes nothing (state hash), so repeated sweeps are silent.
// ============================================================================
const { KINDS, parseSubjectKey } = require('./subjects');
const { apply, markDue, OPEN } = require('./state');

const DEFAULTS = { maxCandidates: 40, lookaheadHours: 24, boardLeadDays: 7, urgentDays: 3 };
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
function config(env = process.env) {
  return {
    maxCandidates: num(env.MANAGER_MAX_CANDIDATES, DEFAULTS.maxCandidates),
    lookaheadHours: num(env.MANAGER_DUE_LOOKAHEAD_HOURS, DEFAULTS.lookaheadHours),
    boardLeadDays: num(env.MANAGER_BOARD_LEAD_DAYS, DEFAULTS.boardLeadDays),
    urgentDays: num(env.MANAGER_BOARD_URGENT_DAYS, DEFAULTS.urgentDays),
  };
}

async function q(p) { const { data, error } = await p; if (error) throw error; return data || []; }
async function loadSubject(supabase, kind, id) {
  const k = KINDS[kind];
  if (k.load) return k.load(supabase, id);
  const rows = await q(supabase.from(k.table).select(k.columns).eq('id', id).limit(1));
  return rows[0] || null;
}
function evaluate(kind, row, now, cfg) { return kind === 'board_packet' ? KINDS[kind].evaluate(row, now, { urgentDays: cfg.urgentDays }) : KINDS[kind].evaluate(row); }

// Is a recorded dependency met? Whitelisted conditions only (no free-form SQL).
async function dependencyMet(supabase, dep) {
  if (dep && dep.table === 'ap_intake_exceptions' && dep.condition === 'not_pending') {
    const rows = await q(supabase.from('ap_intake_exceptions').select('status').eq('id', dep.id).limit(1));
    return !rows[0] || rows[0].status !== 'pending';
  }
  if (dep && dep.table === 'board_packets' && dep.condition === 'final') {
    const rows = await q(supabase.from('board_packets').select('status').eq('id', dep.id).limit(1));
    return !rows[0] || ['final', 'distributed', 'archived'].includes(rows[0].status);
  }
  return false; // unknown condition: never guessed true
}

async function runSweep({ supabase, now = Date.now(), env = process.env } = {}) {
  const cfg = config(env);
  const s = { ok: true, model_calls: 0, actions_executed: 0, candidates: 0, wakes: 0, execute_candidates: 0, no_action: 0, created: 0, updated: 0, resolved: 0, unchanged: 0, unblocked: 0, due_marked: 0, failed: 0, bounded: false, deferred: 0 };
  if (String(env.AMANDA_MANAGER || '').trim().toLowerCase() === 'off') return { ...s, fired: false, skipped: 'AMANDA_MANAGER=off' };
  let budget = cfg.maxCandidates;
  const take = (n) => { const k = Math.max(0, Math.min(n, budget)); budget -= k; return k; };
  const tally = (r) => { if (!r) return; if (r.outcome === 'execute_candidate') s.execute_candidates += 1; else if (r.outcome === 'no_action' || r.outcome === 'source_missing') s.no_action += 1; else if (r.outcome === 'unchanged' || r.changed === false) s.unchanged += 1; else if (r.outcome === 'resolved') s.resolved += 1; else if (r.created) s.created += 1; else s.updated += 1; };
  const seen = new Set();

  // 1. pending wakes
  const wakeCap = budget;
  const wakes = wakeCap ? await q(supabase.from('manager_wakes').select('id, kind, source_id, wake_reason').eq('status', 'pending').order('created_at', { ascending: true }).limit(wakeCap + 1)) : [];
  if (wakes.length > wakeCap) { s.bounded = true; s.deferred += wakes.length - wakeCap; }
  take(Math.min(wakes.length, wakeCap));
  for (const w of wakes.slice(0, wakeCap)) {
    s.candidates += 1; s.wakes += 1;
    try {
      const row = await loadSubject(supabase, w.kind, w.source_id);
      let r = { outcome: 'source_missing', objective_id: null };
      if (row) {
        const before = await q(supabase.from('objectives').select('id').eq('subject_key', `${w.kind}:${w.source_id}`).in('status', OPEN).limit(1));
        r = await apply(supabase, w.kind, w.source_id, evaluate(w.kind, row, now, cfg), { wakeReason: w.wake_reason, now, lookaheadHours: cfg.lookaheadHours });
        r.created = !before.length && r.changed && r.outcome !== 'resolved';
        seen.add(`${w.kind}:${w.source_id}`);
      }
      tally(r);
      await q(supabase.from('manager_wakes').update({ status: 'consumed', outcome: r.outcome, objective_id: r.objective_id || null, consumed_at: new Date(now).toISOString() }).eq('id', w.id));
    } catch (e) {
      s.failed += 1;
      console.warn('[manager.sweep] wake failed', JSON.stringify({ wake: w.id, error: e.message }));
      await supabase.from('manager_wakes').update({ status: 'failed', error: String(e.message).slice(0, 500), consumed_at: new Date(now).toISOString() }).eq('id', w.id);
    }
  }

  // 2. BLOCKED objectives whose dependency is now satisfied
  if (budget > 0) {
    const blocked = await q(supabase.from('objectives').select('*').eq('autonomy_class', 'BLOCK').in('status', OPEN).order('last_activity_at', { ascending: true }).limit(budget + 1));
    for (const o of blocked) {
      if (seen.has(o.subject_key)) continue;
      if (budget <= 0) { s.bounded = true; s.deferred += 1; continue; }
      const deps = Array.isArray(o.depends_on) ? o.depends_on : [];
      if (!deps.length) continue;
      take(1); s.candidates += 1;
      try {
        let met = true; for (const d of deps) if (!(await dependencyMet(supabase, d))) { met = false; break; }
        if (!met) { s.unchanged += 1; continue; }
        const sk = parseSubjectKey(o.subject_key); if (!sk) continue;
        const row = await loadSubject(supabase, sk.kind, sk.id);
        const c = row ? evaluate(sk.kind, row, now, cfg) : { action: 'clear', outcome: 'resolved', reason: 'source record no longer exists' };
        const r = await apply(supabase, sk.kind, sk.id, c, { wakeReason: 'dependency_satisfied', now, lookaheadHours: cfg.lookaheadHours });
        if (r.changed) s.unblocked += 1;
        tally(r); seen.add(o.subject_key);
      } catch (e) { s.failed += 1; console.warn('[manager.sweep] unblock failed', JSON.stringify({ objective: o.id, error: e.message })); }
    }
  }

  // 3. next_action_due soon / overdue
  if (budget > 0) {
    const horizon = new Date(now + cfg.lookaheadHours * 3600000).toISOString();
    const due = await q(supabase.from('objectives').select('*').in('status', OPEN).not('next_action_due', 'is', null).lte('next_action_due', horizon).order('next_action_due', { ascending: true }).limit(budget + 1));
    for (const o of due) {
      if (o.subject_key && seen.has(o.subject_key)) continue;
      if (budget <= 0) { s.bounded = true; s.deferred += 1; continue; }
      take(1); s.candidates += 1;
      try {
        const sk = parseSubjectKey(o.subject_key);
        if (sk) {
          const row = await loadSubject(supabase, sk.kind, sk.id);
          const c = row ? evaluate(sk.kind, row, now, cfg) : { action: 'clear', outcome: 'resolved', reason: 'source record no longer exists' };
          const r = await apply(supabase, sk.kind, sk.id, c, { wakeReason: 'next_action_due', now, lookaheadHours: cfg.lookaheadHours });
          tally(r); seen.add(o.subject_key);
        } else {
          const r = await markDue(supabase, o, { now, lookaheadHours: cfg.lookaheadHours });
          if (r.changed) s.due_marked += 1; else s.unchanged += 1;
        }
      } catch (e) { s.failed += 1; console.warn('[manager.sweep] due check failed', JSON.stringify({ objective: o.id, error: e.message })); }
    }
  }

  // 4. board packets with a meeting inside the lead time that are not final
  if (budget > 0) {
    const today = new Date(now).toISOString().slice(0, 10);
    const until = new Date(now + cfg.boardLeadDays * 86400000).toISOString().slice(0, 10);
    const packets = await q(supabase.from('board_packets').select(KINDS.board_packet.columns).in('status', ['draft', 'in_review']).gte('meeting_date', today).lte('meeting_date', until).order('meeting_date', { ascending: true }).limit(budget + 1));
    for (const p of packets) {
      if (seen.has(`board_packet:${p.id}`)) continue;
      if (budget <= 0) { s.bounded = true; s.deferred += 1; continue; }
      take(1); s.candidates += 1;
      try {
        const before = await q(supabase.from('objectives').select('id').eq('subject_key', `board_packet:${p.id}`).in('status', OPEN).limit(1));
        const r = await apply(supabase, 'board_packet', p.id, evaluate('board_packet', p, now, cfg), { wakeReason: 'board_packet_deadline', now, lookaheadHours: cfg.lookaheadHours });
        r.created = !before.length && r.changed && r.outcome !== 'resolved';
        tally(r); seen.add(`board_packet:${p.id}`);
      } catch (e) { s.failed += 1; console.warn('[manager.sweep] board packet failed', JSON.stringify({ packet: p.id, error: e.message })); }
    }
  }

  // 5. re-check open subject objectives so finished work resolves
  if (budget > 0) {
    const open = await q(supabase.from('objectives').select('*').in('status', OPEN).not('subject_key', 'is', null).order('last_activity_at', { ascending: true }).limit(budget + 1));
    for (const o of open) {
      if (seen.has(o.subject_key)) continue;
      if (budget <= 0) { s.bounded = true; s.deferred += 1; continue; }
      const sk = parseSubjectKey(o.subject_key); if (!sk) continue;
      take(1); s.candidates += 1;
      try {
        const row = await loadSubject(supabase, sk.kind, sk.id);
        const c = row ? evaluate(sk.kind, row, now, cfg) : { action: 'clear', outcome: 'resolved', reason: 'source record no longer exists' };
        tally(await apply(supabase, sk.kind, sk.id, c, { wakeReason: 'sweep_recheck', now, lookaheadHours: cfg.lookaheadHours }));
        seen.add(o.subject_key);
      } catch (e) { s.failed += 1; console.warn('[manager.sweep] recheck failed', JSON.stringify({ objective: o.id, error: e.message })); }
    }
  }

  // a per-item failure is recorded on that wake/objective; the run itself completed (ok stays true)
  // 6. execute: run the agents' existing capabilities on AI-owned items (Ed 2026-10-12).
  // Scheduled execution is OPT-IN (Ed 2026-10-15 scheduler safety audit): MANAGER_EXECUTE=on, and
  // then only the executors named in MANAGER_EXECUTORS (default: request_invoice, which only
  // queues a draft a person sends). resolve_community can load a bill through intake (which may
  // post its AP entry), and acc_reassess / legal_team make model calls; each needs naming.
  if (String(env.MANAGER_EXECUTE || '').trim().toLowerCase() === 'on') {
    try { s.execution = await executeAgentWork({ supabase, now, env, scheduled: true }); s.actions_executed += s.execution.executed; }
    catch (e) { s.ok = false; s.execution = { error: e.message }; }
  }
  return s;
}

// ---- execution -----------------------------------------------------------------
// Executors a SCHEDULED sweep may run (MANAGER_EXECUTORS, comma-separated). Default: drafts only.
const SAFE_DEFAULT_EXECUTORS = ['request_invoice'];
function scheduledExecutors(env = process.env) {
  const raw = String(env.MANAGER_EXECUTORS || '').trim();
  return new Set((raw ? raw.split(',') : SAFE_DEFAULT_EXECUTORS).map((x) => x.trim()).filter((x) => x && EXECUTORS[x]));
}
// The same classification Today shows decides what runs (lib/feed/build.js
// sections.ai_working + executorFor). Each item has ONE open work item (source_ref =
// the feed key, unique while open). Every attempt is an agent_touch event carrying
// the executor's idempotency key: a key that succeeded never runs again; a failure
// retries on the next sweep; three failures escalate to the owner. Executors only
// use existing capabilities and never post accounting, release payments, send
// email or decide an ACC application.
const EXEC_ACTOR = 'amanda-sweep';
async function ensureWorkItem(supabase, card) {
  const open = await q(supabase.from('work_items').select('id, status').eq('source_ref', card.key).in('status', ['new', 'in_progress', 'waiting']).limit(1));
  if (open[0]) return open[0];
  const { data, error } = await supabase.from('work_items').insert({
    source_type: 'agent', workspace: 'operations', item_type: card.kind, title: String(card.title || 'Agent work').slice(0, 300), summary: card.why ? String(card.why).slice(0, 1000) : null,
    assigned_to: (card.owner && card.owner.name) || null, status: 'in_progress', next_step: card.next_action ? String(card.next_action).slice(0, 500) : null, source_ref: card.key,
    community_name: card.community || null, created_by: EXEC_ACTOR, why: 'Assigned to an agent on Today (AI team working).', action_url: card.action ? card.action.href : null,
  }).select('id, status').single();
  if (error) { if (String(error.code) === '23505') return (await q(supabase.from('work_items').select('id, status').eq('source_ref', card.key).in('status', ['new', 'in_progress', 'waiting']).limit(1)))[0]; throw error; }
  await q(supabase.from('work_item_events').insert({ work_item_id: data.id, event: 'created', actor: EXEC_ACTOR, detail: { feed_key: card.key, agent: card.owner && card.owner.key } }));
  return data;
}
async function touch(supabase, workItemId, detail) {
  await q(supabase.from('work_item_events').insert({ work_item_id: workItemId, event: 'agent_touch', actor: EXEC_ACTOR, detail }));
}
const EXECUTORS = {
  // Amanda's legal team (research, verification, objective state). Saves only on change.
  legal_team: async (supabase, card, ex, deps) => {
    const r = await (deps.runLegalTeam || require('../legal/team').runLegalTeam)(supabase, ex.ref, { trigger: 'manager_sweep' });
    return { outcome: r && r.skipped ? `skipped: ${r.skipped}` : 'ran', status: 'in_progress' };
  },
  // Annie: re-review the case against its CURRENT documents (writes current_review_* only).
  acc_reassess: async (supabase, card, ex, deps) => {
    const r = await (deps.reassessCase || require('../acc/pending_intake').reassessCase)(ex.ref, 'agent_sweep');
    if (!r || !['reviewed'].includes(r.status)) throw new Error(`re-review ${(r && r.status) || 'failed'}${r && r.reason ? `: ${r.reason}` : ''}`);
    return { outcome: 'reviewed', recommendation: r.recommendation || null, documents: r.documents || 0, status: 'in_progress' };
  },
  // Emma: ask whoever forwarded a non-invoice for the invoice. A DRAFT in the outbox;
  // a person sends it. One draft per exception, ever (any status counts).
  request_invoice: async (supabase, card, ex, deps) => {
    const ref = `ap_exception:${ex.ref}`;
    const prior = await q(supabase.from('outbound_email_drafts').select('id, status').eq('source_email_ref', ref).eq('draft_kind', 'request_invoice').limit(1));
    if (prior[0]) return { outcome: 'draft_queued', draft_id: prior[0].id, existing: true, status: 'waiting' };
    const exc = (await q(supabase.from('ap_intake_exceptions').select('id, vendor_name, invoice_number, total_cents, community_id, email_message_id').eq('id', ex.ref).limit(1)))[0];
    if (!exc) throw new Error('exception not found');
    const msg = exc.email_message_id ? (await q(supabase.from('email_messages').select('sender_email, sender_name, subject').eq('id', exc.email_message_id).limit(1)))[0] : null;
    if (!msg || !msg.sender_email) throw new Error('no sender to ask');
    const amt = exc.total_cents ? ` (${(exc.total_cents / 100).toFixed(2)})` : '';
    const first = String(msg.sender_name || '').split(/\s+/)[0] || 'there';
    const body = `Hi ${first},\n\nThe attachment on "${msg.subject || 'your email'}" is a payment confirmation or receipt, not an invoice, so I couldn't load it for ${exc.vendor_name || 'this vendor'}${exc.invoice_number ? ` #${exc.invoice_number}` : ''}${amt}.\n\nCould you send me the invoice? If it has already been paid, a quick note on how and when it was paid lets me record it correctly.\n\nThank you,\nEmma`;
    const queue = deps.queueDraft || require('../email/outbound_drafts').queueDraft;
    const r = await queue({ communityId: exc.community_id || null, persona: 'emma', fromMailbox: 'emma@bedrocktx.com', toEmail: msg.sender_email, toName: msg.sender_name || null,
      subject: `Invoice needed: ${exc.vendor_name || 'bill'}${exc.invoice_number ? ` #${exc.invoice_number}` : ''}`, bodyText: body, relatedType: 'ap_intake_exception', relatedId: exc.id,
      sourceEmailRef: ref, draftKind: 'request_invoice', draftReason: 'Emma: the attachment was not an invoice; asking the sender for it. A person reviews and sends.', createdBy: EXEC_ACTOR });
    if (!r || !['queued', 'exists'].includes(r.status)) throw new Error(`draft not queued: ${(r && (r.error || r.reason || r.status)) || 'unknown'}`);
    return { outcome: 'draft_queued', draft_id: r.id || null, status: 'waiting' };
  },
  // Emma: establish the association from the property on the bill and the sender, then
  // load it through the normal path (promoteException: dedup, ownership, accrual rules).
  resolve_community: async (supabase, card, ex, deps) => {
    const exc = (await q(supabase.from('ap_intake_exceptions').select('id, status, vendor_name, extracted, email_message_id, suggested_vendor_id').eq('id', ex.ref).limit(1)))[0];
    if (!exc || exc.status !== 'pending') return { outcome: 'already_resolved', status: 'done' };
    const hint = String((exc.extracted && exc.extracted.community_hint) || '');
    const num = (/\b(\d{3,6})\s+([A-Za-z][A-Za-z ]{2,30})/.exec(hint) || []);
    let comms = [];
    if (num[1]) {
      const street = num[2].trim().split(/\s+/).slice(0, 2).join(' ');
      const props = await q(supabase.from('properties').select('community_id').ilike('street_address', `${num[1]} ${street}%`).limit(20));
      comms = [...new Set(props.map((p) => p.community_id))];
    }
    if (comms.length !== 1) return { outcome: comms.length ? 'ambiguous_property' : 'property_not_found', hint, status: 'waiting' };
    const own = await require('../accounting/ownership').accountingStatusFor(supabase, comms[0]);
    if (!own.enabled) return { outcome: 'out_of_scope', reason: `belongs to ${(own.community && own.community.name) || 'a community'} (${own.reason})`, status: 'done' };
    let vendorId = exc.suggested_vendor_id;
    if (!vendorId && exc.vendor_name) { const v = await (deps.resolveVendor || require('../ap/intake').resolveVendor)({ name: exc.vendor_name }); vendorId = v && v.vendor ? v.vendor.id : null; }
    if (!vendorId) return { outcome: 'vendor_not_matched', status: 'waiting' };
    const r = await (deps.promoteException || require('../ap/intake_exceptions').promoteException)(exc.id, { communityId: comms[0], vendorId, resolvedBy: 'emma-ai@bedrocktx.com' });
    if (!r || r.ok === false) throw new Error(`load refused: ${(r && (r.detail || r.error)) || 'unknown'}`);
    return { outcome: 'loaded', invoice_id: r.invoice_id || null, status: 'done' };
  },
};
async function executeAgentWork({ supabase, now = Date.now(), env = process.env, deps = {}, scheduled = false } = {}) {
  const max = num(env.MANAGER_MAX_EXECUTIONS, 10);
  const allowed = scheduledExecutors(env);
  const feed = await (deps.buildFeed || require('../feed/build').buildFeed)(supabase, { now, env });
  const cards = (feed.sections && feed.sections.ai_working) || [];
  const r = { cards: cards.length, executed: 0, already_done: 0, not_automated: 0, failed: 0, escalated: 0, deferred: 0, results: [] };
  let budget = max;
  for (const card of cards) {
    if (!card.executor) { r.not_automated += 1; continue; }
    if (scheduled && !allowed.has(card.executor.name)) { r.not_permitted = (r.not_permitted || 0) + 1; continue; }
    const wi = await ensureWorkItem(supabase, card);
    const prior = await q(supabase.from('work_item_events').select('detail').eq('work_item_id', wi.id).eq('event', 'agent_touch').limit(200));
    const mine = prior.filter((e) => e.detail && e.detail.key === card.executor.key);
    if (mine.some((e) => e.detail.ok === true)) { r.already_done += 1; continue; }
    const failures = mine.filter((e) => e.detail.ok === false).length;
    if (failures >= 3) { r.escalated += 1; continue; }
    if (budget <= 0) { r.deferred += 1; continue; }
    budget -= 1;
    try {
      const out = await EXECUTORS[card.executor.name](supabase, card, card.executor, deps);
      await touch(supabase, wi.id, { key: card.executor.key, action: card.executor.name, ok: true, ...out });
      const status = out.status === 'done' ? 'done' : out.status === 'waiting' ? 'waiting' : 'in_progress';
      await q(supabase.from('work_items').update({ status, completed_at: status === 'done' ? new Date(now).toISOString() : null, updated_at: new Date(now).toISOString() }).eq('id', wi.id));
      r.executed += 1; r.results.push({ key: card.key, action: card.executor.name, outcome: out.outcome });
    } catch (e) {
      await touch(supabase, wi.id, { key: card.executor.key, action: card.executor.name, ok: false, error: String(e.message || e).slice(0, 500), attempt: failures + 1 });
      r.failed += 1; r.results.push({ key: card.key, action: card.executor.name, error: e.message });
    }
  }
  return r;
}

module.exports = { executeAgentWork, EXECUTORS, runSweep, config, dependencyMet, DEFAULTS, scheduledExecutors, SAFE_DEFAULT_EXECUTORS };
