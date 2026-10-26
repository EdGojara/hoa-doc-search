// ============================================================================
// lib/feed/build.js  (Issue #29 Phase 1 + refinement) — the read-only Operations Feed
// ----------------------------------------------------------------------------
// A READ MODEL, not a new store. Every surfaced item answers WHAT, WHY and WHERE:
// a title, a one-line reason, and "Take action" = a navigation link to the EXACT
// controlled record (Payables bill, ACC decision, intake-exception row). Nothing
// here acts: no writes, no model calls, no buttons that change state.
//
// Three lanes (audit of the live feed, #29):
//   now     Needs you now        true human exceptions / decisions
//   waiting Waiting on something blocked on a vendor, homeowner or missing piece
//   policy  Policy / Ed decision the system cannot safely infer the rule
// Daily feed = ACTIVE communities only. Routine AP approvals, approved-flag
// residue, inactive-community residue and ACC duplicates/legacy are counted in
// `elsewhere` (where they live) and never mutated here.
//
// Rules (deterministic, no invented thresholds):
//   AP bill   on_hold (W-9 hold -> policy, else waiting) | cutover_review PENDING |
//             awaiting_approval with no human approval row AND (first bill from
//             this vendor in this community OR due_date < today). needs_review
//             alone (line-level credit / magnitude confirmations) is not enough.
//   ACC       pending_review, active community with ARC on, not a same-address
//             follow-up of a case decided in the prior 30 days, not legacy (no
//             thread, never touched) or incomplete (no AI recommendation):
//             new documents unreviewed | homeowner wrote after the last update |
//             no decision yet -> now;  more-info requested, nothing new -> waiting
//   Intake    pending, community active or not yet identified: missing piece or
//             reimbursement coding -> waiting; otherwise -> now
//   Objective Amanda-owned (or waiting on a human / overdue): BLOCK -> waiting
//   Packets   draft / in review, meeting within 7 days -> now
//   Jobs      scheduled job failed in the last 24h -> now
// Failure semantics: a source that does not answer is reported (unavailable is
// not clear); a capped source is flagged.
// ============================================================================
const roster = require('../team/roster');
const { sweepSchedule } = require('../manager/shadow');

const OPEN = ['open', 'waiting_resident', 'waiting_third_party', 'waiting_human'];
const PRI = { critical: 0, high: 1, normal: 2, low: 3 };
const CAP = { objectives: 200, exceptions: 100, invoices: 300, acc: 100, packets: 50, failures: 20, recent: 20 };
const DUP_WINDOW_DAYS = 30; // same-address follow-up window used in the #29 audit
const DOMAIN_PERSONA = { ap: 'emma', acc: 'annie', board: 'paige', violations: 'miranda', legal: 'emma', accounting: 'emma', communications: 'amanda', ops: 'amanda' };
const MISSING = { no_community: 'which community it belongs to', no_vendor: 'the vendor', vendor_ambiguous: 'which matching vendor it is', no_total: 'the bill total', no_date: 'the bill date' };
const REASON_TEXT = { ...MISSING, unreadable_attachment: 'a readable copy of the attachment', other: 'a person to look at it' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "Take action" destinations: the exact controlled record (navigation only).
const DEST = {
  invoice: (id) => ({ label: 'Take action', href: `/#tab=ap&invoice=${id}`, where: 'Payables · this bill' }),
  decision: (id) => ({ label: 'Take action', href: `/#tab=acc&decision=${id}`, where: 'ACC review · this application' }),
  exception: (id) => ({ label: 'Take action', href: `/admin/ap?exception=${id}`, where: 'Payables exceptions · this bill' }),
  packets: () => ({ label: 'Take action', href: '/#tab=boardpackets', where: 'Board packets' }),
  objectives: () => ({ label: 'Open objectives', href: '/admin/objectives', where: 'Objectives' }),
  errors: () => ({ label: 'Take action', href: '/admin/errors', where: 'System errors' }),
  homeSales: () => ({ label: 'Take action', href: '/home_sales.html', where: 'Home Sales · builder assessments' }),
  kat: () => ({ label: "Review in Kat's tile", href: '/ed.html', where: "Command Center · Kat's accounting runs" }),
  payables: () => ({ label: 'Open approval queue', href: '/#tab=ap', where: 'Payables · approval queue' }),
  legalReview: (id) => ({ label: 'Open Legal Invoice Review', href: id ? `/app/financial/legal?id=${id}` : '/app/financial/legal', where: 'Legal Invoice Review' }),
};
function destForSubject(subjectKey) {
  const m = /^([a-z_]+):(.+)$/.exec(String(subjectKey || ''));
  if (!m || !UUID.test(m[2])) return DEST.objectives();
  if (m[1] === 'ap_invoice') return DEST.invoice(m[2]);
  if (m[1] === 'ap_exception') return DEST.exception(m[2]);
  if (m[1] === 'board_packet') return DEST.packets();
  return DEST.objectives();
}

function specialist(personaKey) {
  const p = roster.get(personaKey) || roster.get('amanda');
  return { key: p.persona || personaKey, name: String(p.name || personaKey).split(' ')[0], role: p.title || '' };
}
const money = (c) => (c == null ? '' : `$${(Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const communityName = (row) => (row && row.communities && row.communities.name) || (row && row.community_name) || null;
const daysSince = (iso, now) => (iso ? Math.max(0, Math.floor((now - Date.parse(iso)) / 86400000)) : null);
const cap = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
const fmtDate =(iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric' }) : '');
function holdReason(notes) {
  const lines = String(notes || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const h = lines.reverse().find((l) => /hold/i.test(l));
  if (!h) return 'On hold; the reason is not recorded on the bill.';
  const at = h.search(/on hold/i);
  return cap((at >= 0 ? h.slice(at) : h.replace(/^Emma:\s*/i, '')).slice(0, 240));
}

// Is this community in the DAILY feed for this domain? Unknown community = yes (it still needs placing).
function activeFor(c, domain) {
  if (!c) return true;
  if (c.is_demo) return false;
  if (c.management_status && c.management_status !== 'active') return false;
  if (domain === 'ap' && c.financials_active === false) return false;
  if (domain === 'acc' && c.arc_active === false) return false;
  return true;
}

async function buildFeed(supabase, { communityId = null, now = Date.now(), env = process.env } = {}) {
  const out = { phase: 1, model_calls: 0, actions: [], generated_at: new Date(now).toISOString(), community_id: communityId, section_errors: {}, capped: [], schedule: sweepSchedule(env) };
  const since = new Date(now - 24 * 3600000).toISOString();
  const today = new Date(now).toISOString().slice(0, 10);
  const lead = new Date(now + 7 * 86400000).toISOString().slice(0, 10);
  const scope = (qb) => (communityId ? qb.or(`community_id.eq.${communityId},community_id.is.null`) : qb);
  const run = async (name, p, cap) => {
    const { data, error } = await p;
    if (error) { out.section_errors[name] = error.message; return null; }
    if (cap && (data || []).length >= cap) out.capped.push(name);
    return data || [];
  };

  const [comms, objectives, resolved, wakes, exceptions, invoices, acc, packets, failures, lastSweep] = await Promise.all([
    run('communities', supabase.from('communities').select('id, name, management_status, financials_active, arc_active, is_demo').limit(500)),
    run('objectives', scope(supabase.from('objectives')
      .select('id, title, status, autonomy_class, priority, blocked_reason, next_action, next_action_due, domain, subject_key, subject_refs, owner_key, owner_kind, accountable_persona, community_id, last_activity_at, opened_at, communities:community_id(name)')
      .in('status', OPEN).order('last_activity_at', { ascending: false }).limit(CAP.objectives)), CAP.objectives),
    run('recent', scope(supabase.from('objectives').select('id, title, domain, closed_at, closed_reason, accountable_persona, community_id, communities:community_id(name)')
      .eq('status', 'resolved').gte('closed_at', since).order('closed_at', { ascending: false }).limit(CAP.recent))),
    run('wakes', scope(supabase.from('manager_wakes').select('outcome').eq('status', 'consumed').gte('consumed_at', since).limit(1000))),
    run('ap_exceptions', scope(supabase.from('ap_intake_exceptions').select('id, reason, vendor_name, invoice_number, total_cents, community_id, notes, created_at, communities:community_id(name)')
      .eq('status', 'pending').order('created_at', { ascending: true }).limit(CAP.exceptions)), CAP.exceptions),
    run('ap_invoices', scope(supabase.from('ap_invoices').select('id, community_id, vendor_id, vendor_invoice_number, total_cents, status, needs_review, cutover_review, due_date, notes, created_at, vendor:vendor_id(name), communities:community_id(name)')
      .in('status', ['awaiting_approval', 'on_hold']).order('created_at', { ascending: true }).limit(CAP.invoices)), CAP.invoices),
    run('acc', scope(supabase.from('acc_decisions').select('id, community_id, community_name, homeowner_address, project_summary, decision_type, ai_recommendation, current_ai_recommendation, conversation_id, last_document_added_at, current_review_at, letter_draft_saved_at, finalization_id, created_at, updated_at')
      .eq('status', 'pending_review').order('created_at', { ascending: true }).limit(CAP.acc)), CAP.acc),
    run('board_packets', scope(supabase.from('board_packets').select('id, community_id, period_label, meeting_date, status, communities:community_id(name)')
      .in('status', ['draft', 'in_review']).gte('meeting_date', today).lte('meeting_date', lead).order('meeting_date', { ascending: true }).limit(CAP.packets)), CAP.packets),
    run('failures', supabase.from('cron_runs').select('id, job_name, started_at, error').eq('ok', false).gte('started_at', since).order('started_at', { ascending: false }).limit(CAP.failures)),
    run('last_sweep', supabase.from('cron_runs').select('started_at, ok').eq('job_name', 'manager_sweep').order('started_at', { ascending: false }).limit(1)),
  ]);
  // Kat's prepared accounting runs wait for the owner (bank reconciliations, interest,
  // recognition): posting stays the owner's control, so they belong under decisions.
  const katRuns = await run('accounting_runs', scope(supabase.from('accounting_runs').select('id, community_id, process, period_month, prepared_at').eq('status', 'prepared').order('period_month', { ascending: true }).limit(200)));
  const C = Object.fromEntries((comms || []).map((c) => [c.id, c]));
  if (!comms) out.section_errors.communities = out.section_errors.communities || 'communities unavailable';

  // ---- dependent reads (bounded by the candidate sets above) ----------------
  const awaiting = (invoices || []).filter((i) => i.status === 'awaiting_approval' && activeFor(C[i.community_id], 'ap'));
  const approvedIds = new Set();
  if (awaiting.length) {
    const a = await run('ap_approvals', supabase.from('ap_invoice_approvals').select('invoice_id, action').in('invoice_id', awaiting.map((i) => i.id)).in('action', ['approved', 'released_for_payment']).limit(2000));
    for (const r of a || []) approvedIds.add(r.invoice_id);
  }
  // first-payee: is there any EARLIER bill from this vendor in this community? (one tiny bounded read per candidate)
  const firstPayee = new Set();
  const fpCandidates = awaiting.filter((i) => !approvedIds.has(i.id) && i.vendor_id && i.cutover_review !== 'PENDING');
  await Promise.all(fpCandidates.map(async (i) => {
    const { data, error } = await supabase.from('ap_invoices').select('id').eq('vendor_id', i.vendor_id).eq('community_id', i.community_id).lt('created_at', i.created_at).limit(1);
    if (error) { out.section_errors.first_payee = error.message; return; }
    if (!(data || []).length) firstPayee.add(i.id);
  }));
  const accActive = (acc || []).filter((a) => activeFor(C[a.community_id], 'acc'));
  const addrs = [...new Set(accActive.map((a) => a.homeowner_address).filter(Boolean))];
  const decidedByAddr = {};
  if (addrs.length) {
    const d = await run('acc_siblings', supabase.from('acc_decisions').select('homeowner_address, community_id, created_at, decided_at, status').in('homeowner_address', addrs).eq('status', 'decided').limit(1000));
    for (const r of d || []) (decidedByAddr[`${r.community_id}|${r.homeowner_address}`] = decidedByAddr[`${r.community_id}|${r.homeowner_address}`] || []).push(r);
  }
  const convs = [...new Set(accActive.map((a) => a.conversation_id).filter(Boolean))];
  const lastInbound = {};
  if (convs.length) {
    const m = await run('acc_email', supabase.from('email_messages').select('conversation_id, received_at, created_at').in('conversation_id', convs).eq('direction', 'inbound').limit(2000));
    for (const r of m || []) { const t = r.received_at || r.created_at; if (!lastInbound[r.conversation_id] || t > lastInbound[r.conversation_id]) lastInbound[r.conversation_id] = t; }
  }

  // Each legal objective's own invoice and review, so a card whose underlying work is
  // already done (bill paid, treatment approved) reads as completed, not as a task.
  const legalIds = [...new Set((objectives || []).filter((o) => /^legal\./.test(o.owner_key || '') && o.subject_refs && o.subject_refs.id).map((o) => o.subject_refs.id))];
  const subjectState = {};
  if (legalIds.length) {
    const [inv, rv] = await Promise.all([
      run('legal_invoices', supabase.from('ap_invoices').select('id, status').in('id', legalIds).limit(500)),
      run('legal_reviews', supabase.from('legal_invoice_reviews').select('ap_invoice_id, status').in('ap_invoice_id', legalIds).limit(500)),
    ]);
    for (const r of inv || []) subjectState[r.id] = { invoice_status: r.status };
    for (const r of rv || []) subjectState[r.ap_invoice_id] = { ...(subjectState[r.ap_invoice_id] || {}), review_status: r.status };
  }

  // ---- assemble ---------------------------------------------------------------
  const items = []; const covered = new Set();
  const elsewhere = { ap_routine_in_payables: 0, ap_approved_awaiting_release: 0, inactive_community: 0, acc_possible_duplicates: 0, acc_legacy_or_incomplete: 0 };
  const add = (it) => items.push(it);

  for (const o of objectives || []) {
    const overdue = o.next_action_due && Date.parse(o.next_action_due) < now;
    const amandas = o.accountable_persona === 'amanda' || !!o.subject_key;
    if (!amandas && o.status !== 'waiting_human' && !overdue) continue;
    if (o.subject_key) covered.add(o.subject_key);
    const blocked = o.autonomy_class === 'BLOCK';
    add({ key: `objective:${o.id}`, kind: 'objective', lane: blocked ? 'waiting' : 'now', specialist: specialist(DOMAIN_PERSONA[o.domain] || 'amanda'),
      title: o.title, why: blocked ? (o.blocked_reason || 'Waiting on a dependency.') : (o.next_action || 'Needs a person.'),
      community: communityName(o), priority: overdue ? 'high' : (o.priority || 'normal'), at: o.opened_at || o.last_activity_at, age_days: daysSince(o.opened_at || o.last_activity_at, now), action: destForSubject(o.subject_key),
      meta: { owner_key: o.owner_key || null, owner_kind: o.owner_kind || null, autonomy_class: o.autonomy_class || null, status: o.status, next_action: o.next_action || null, next_action_due: o.next_action_due || null,
        last_activity_at: o.last_activity_at || null, subject_key: o.subject_key || null, subject_id: (o.subject_refs && o.subject_refs.id) || null, persona: o.accountable_persona || null, ...((o.subject_refs && subjectState[o.subject_refs.id]) || {}) } });
  }

  for (const i of invoices || []) {
    if (covered.has(`ap_invoice:${i.id}`)) continue;
    const c = C[i.community_id];
    if (!activeFor(c, 'ap')) { elsewhere.inactive_community += 1; continue; }
    const vendor = (i.vendor && i.vendor.name) || 'bill';
    const label = `${vendor}${i.vendor_invoice_number ? ` #${i.vendor_invoice_number}` : ''} (${money(i.total_cents)})`;
    const base = { kind: 'ap_invoice', key: `ap_invoice:${i.id}`, specialist: specialist('emma'), community: communityName(i), at: i.created_at, age_days: daysSince(i.created_at, now), action: DEST.invoice(i.id),
      meta: { cutover: i.cutover_review === 'PENDING', first_payee: firstPayee.has(i.id), past_due: !!(i.due_date && i.due_date < today), last_activity_at: i.created_at } };
    if (i.status === 'on_hold') {
      const reason = holdReason(i.notes);
      const w9 = /\bW-?9\b/i.test(reason);
      add({ ...base, lane: w9 ? 'policy' : 'waiting', title: `On hold: ${label}`, why: reason, priority: w9 ? 'high' : 'normal',
        policy_note: w9 ? 'Held for a W-9; the standing rule says a W-9 is informational and never blocks payment. Ed decides.' : null });
      continue;
    }
    if (approvedIds.has(i.id)) { elsewhere.ap_approved_awaiting_release += 1; continue; }
    if (i.cutover_review === 'PENDING') { add({ ...base, lane: 'now', title: `Pre-cutover bill: ${label}`, why: 'Dated before this community\'s GL cutover; a person decides how it posts.', priority: 'high' }); continue; }
    const pastDue = i.due_date && i.due_date < today;
    const first = firstPayee.has(i.id);
    if (first || pastDue) {
      const why = [first ? 'First bill from this vendor for this community' : null, pastDue ? `past due since ${fmtDate(`${i.due_date}T12:00:00Z`)} and not approved` : null].filter(Boolean).join('; ');
      add({ ...base, lane: 'now', title: `${pastDue ? 'Past due' : 'New payee'}: ${label}`, why: why.charAt(0).toUpperCase() + why.slice(1) + '.', priority: pastDue ? 'high' : 'normal' });
      continue;
    }
    elsewhere.ap_routine_in_payables += 1;
  }

  for (const e of exceptions || []) {
    if (covered.has(`ap_exception:${e.id}`)) continue;
    if (!activeFor(C[e.community_id], 'ap')) { elsewhere.inactive_community += 1; continue; }
    const reimb = /^reimbursement:/i.test(String(e.notes || ''));
    const waiting = !!MISSING[e.reason] || reimb;
    const label = `${e.vendor_name || 'an unknown vendor'}${e.invoice_number ? ` #${e.invoice_number}` : ''}${e.total_cents ? ` (${money(e.total_cents)})` : ''}`;
    add({ key: `ap_exception:${e.id}`, kind: 'ap_exception', lane: waiting ? 'waiting' : 'now', specialist: specialist('emma'),
      title: `Bill couldn't load: ${label}`,
      why: reimb ? 'Waiting on the expense account to charge (no coding instruction from staff).' : MISSING[e.reason] ? `Waiting on ${MISSING[e.reason]}.` : (cap(String(e.notes || '').replace(/\s*\[.*$/, '')) || `Needs ${REASON_TEXT[e.reason] || REASON_TEXT.other}.`),
      community: communityName(e) || (e.community_id ? null : 'Community not identified'), priority: 'normal', at: e.created_at, age_days: daysSince(e.created_at, now), action: DEST.exception(e.id),
      meta: { exception_id: e.id, reason: e.reason || null, reimbursement: reimb, missing: MISSING[e.reason] || null, not_invoice: /not an invoice/i.test(String(e.notes || '')), handoff: /amanda handoff/i.test(String(e.notes || '')), last_activity_at: e.created_at } });
  }

  for (const a of acc || []) {
    if (!activeFor(C[a.community_id], 'acc')) { elsewhere.inactive_community += 1; continue; }
    const sibs = decidedByAddr[`${a.community_id}|${a.homeowner_address}`] || [];
    const followUpOfDecided = sibs.some((s) => s.created_at < a.created_at && Date.parse(a.created_at) - Date.parse(s.decided_at || s.created_at) <= DUP_WINDOW_DAYS * 86400000);
    if (followUpOfDecided) { elsewhere.acc_possible_duplicates += 1; continue; }
    const neverTouched = !a.conversation_id && Math.abs(Date.parse(a.updated_at) - Date.parse(a.created_at)) < 60000 && !a.last_document_added_at && !a.letter_draft_saved_at;
    const incomplete = !a.ai_recommendation && !a.current_ai_recommendation;
    if (neverTouched || incomplete) { elsewhere.acc_legacy_or_incomplete += 1; continue; }
    const base = { key: `acc_decision:${a.id}`, kind: 'acc_decision', specialist: specialist('annie'), community: communityName(a), at: a.created_at, age_days: daysSince(a.created_at, now), action: DEST.decision(a.id),
      title: `ACC: ${a.project_summary || 'application'}`.slice(0, 140) };
    const newDocs = a.last_document_added_at && (!a.current_review_at || a.last_document_added_at > a.current_review_at);
    const inbound = a.conversation_id && lastInbound[a.conversation_id] && lastInbound[a.conversation_id] > a.updated_at;
    const am = (state) => ({ state, decision_id: a.id, last_document_added_at: a.last_document_added_at || null, updated_at: a.updated_at, last_activity_at: [a.updated_at, a.current_review_at, a.letter_draft_saved_at].filter(Boolean).sort().pop() || a.created_at });
    if (newDocs) { add({ ...base, lane: 'now', why: `New documents arrived ${fmtDate(a.last_document_added_at)} and haven't been reviewed.`, priority: 'normal', meta: am('new_documents') }); continue; }
    if (inbound) { add({ ...base, lane: 'now', why: `The homeowner wrote again on ${fmtDate(lastInbound[a.conversation_id])}.`, priority: 'normal', meta: am('homeowner_wrote') }); continue; }
    if (a.decision_type === 'request_more_info') { add({ ...base, lane: 'waiting', why: `More information requested; nothing new from the homeowner since ${fmtDate(a.updated_at)}.`, priority: 'low', meta: am('info_requested') }); continue; }
    if (!a.decision_type && !a.finalization_id) { add({ ...base, lane: 'now', why: `No decision has been sent yet (recommendation: ${String(a.current_ai_recommendation || a.ai_recommendation).replace(/_/g, ' ')}).`, priority: 'normal', meta: am(a.letter_draft_saved_at ? 'drafted' : 'not_drafted') }); continue; }
    add({ ...base, lane: 'now', why: 'Drafted and waiting for a reviewer.', priority: 'normal', meta: am('drafted') });
  }

  for (const p of packets || []) {
    if (covered.has(`board_packet:${p.id}`)) continue;
    if (!activeFor(C[p.community_id], 'board')) { elsewhere.inactive_community += 1; continue; }
    const days = Math.round((Date.parse(`${p.meeting_date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000);
    add({ key: `board_packet:${p.id}`, kind: 'board_packet', lane: 'now', specialist: specialist('paige'),
      title: `Board packet ${p.period_label || ''} still ${String(p.status).replace('_', ' ')}`.replace(/\s+/g, ' '),
      why: days === 0 ? 'The meeting is today.' : `The meeting is in ${days} day${days === 1 ? '' : 's'}.`, community: communityName(p),
      priority: days <= 3 ? 'high' : 'normal', at: p.meeting_date, age_days: null, action: DEST.packets() });
  }
  for (const f of failures || []) {
    add({ key: `cron_run:${f.id}`, kind: 'cron_run', lane: 'now', specialist: specialist('amanda'), title: `Scheduled job failed: ${f.job_name}`,
      why: String(f.error || 'no error text').slice(0, 200), community: null, priority: 'high', at: f.started_at, age_days: daysSince(f.started_at, now), action: DEST.errors(),
      meta: { job: f.job_name, failures_24h: (failures || []).filter((x) => x.job_name === f.job_name).length, last_activity_at: f.started_at } });
  }

  // Builder assessment coverage (GitHub #96): per configured community, from builder_coverage_status
  // (migrations 500/501). Not installed yet -> nothing (never a false alert); a real error -> section_errors.
  const bc = await builderCoverageItems(supabase, { communityId, today, out });
  for (const it of bc) add({ ...it, specialist: specialist(DOMAIN_PERSONA.accounting), action: DEST.homeSales() });

  const order = (a, b) => (PRI[a.priority] ?? 9) - (PRI[b.priority] ?? 9) || String(a.at || '').localeCompare(String(b.at || ''));
  out.lanes = { now: items.filter((i) => i.lane === 'now').sort(order), waiting: items.filter((i) => i.lane === 'waiting').sort(order), policy: items.filter((i) => i.lane === 'policy').sort(order) };
  out.counts = { now: out.lanes.now.length, waiting: out.lanes.waiting.length, policy: out.lanes.policy.length };
  out.total = items.length;
  out.elsewhere = elsewhere;
  const bySpecialist = {}; for (const i of out.lanes.now) bySpecialist[i.specialist.name] = (bySpecialist[i.specialist.name] || 0) + 1;
  out.by_specialist = bySpecialist;
  const tally = {}; for (const w of wakes || []) tally[w.outcome || 'unknown'] = (tally[w.outcome || 'unknown'] || 0) + 1;
  out.recent = (resolved || []).map((r) => ({ key: `objective:${r.id}`, title: r.title, when: r.closed_at, reason: r.closed_reason, community: communityName(r), specialist: specialist(DOMAIN_PERSONA[r.domain] || 'amanda') }));
  out.routine_24h = wakes ? (tally.execute_candidate || 0) : null;
  out.last_sweep = lastSweep && lastSweep[0] ? lastSweep[0] : null;
  // Ownership (Ed 2026-10-12): who acts next. The owner sees only decisions that
  // need the owner's authority; everything else names the agent or the outside party.
  out.sections = buildSections(items, out.recent, now, { sweepScheduled: !!(out.schedule && out.schedule.scheduled) });
  const PROC = { bank_reconciliation: 'bank reconciliation', interest: 'interest run', recognition: 'assessment recognition run' };
  const byProc = {};
  for (const r of katRuns || []) { if (!activeFor(C[r.community_id], 'accounting')) continue; (byProc[r.process] = byProc[r.process] || []).push(r); }
  for (const [proc, rs] of Object.entries(byProc)) {
    const label = PROC[proc] || proc.replace(/_/g, ' ');
    out.sections.decisions.push({ key: `group:kat_${proc}`, kind: 'group', bucket: 'decision', decision_type: 'accounting_run', owner: OWNER, specialist: specialist('kat'), priority: 'normal',
      title: `Approve ${rs.length} prepared ${label}${rs.length === 1 ? '' : 's'}`, why: 'Kat prepared each one; nothing posts until you approve it.', next_action: "Review and approve in Kat's tile.", action: DEST.kat(),
      members: rs.map((r) => ({ key: `accounting_run:${r.id}`, title: `${label} · ${String(r.period_month).slice(0, 7)}`, community: (C[r.community_id] || {}).name || null, action: DEST.kat(), amount_cents: 0 })) });
  }
  // Collections notices (mig 515): a verified batch waits for an authorized approver; a
  // batch that failed Kat's check is Amanda's to fix; an approved or printed batch waits
  // on the office to print, mail and record the USPS tracking. Before mig 515: nothing.
  {
    const { data: cb, error: cbe } = await scope(supabase.from('collection_notice_batches').select('id, community_id, status, notice_date, verification')
      .in('status', ['verified', 'verification_failed', 'approved', 'printed']).order('notice_date', { ascending: true }).limit(50));
    if (cbe && !/does not exist|schema cache|not find/i.test(cbe.message)) out.section_errors.collection_batches = cbe.message;
    const dest = { label: 'Open Collections', href: '/admin/accounting', where: 'Accounting · Homeowners · Collections' };
    const rows = (cb || []).filter((b) => activeFor(C[b.community_id], 'accounting'));
    const ready = rows.filter((b) => b.status === 'verified');
    if (ready.length) out.sections.decisions.push({ key: 'group:collections_approval', kind: 'group', bucket: 'decision', decision_type: 'collections_approval', owner: OWNER, specialist: specialist('amanda'), priority: 'normal',
      title: `Approve ${ready.length} collections notice batch${ready.length === 1 ? '' : 'es'}`, why: 'Amanda prepared them and Kat verified every amount against the ledger; nothing prints, mails or charges until approved.', next_action: 'Review and approve in Collections.', action: dest,
      members: ready.map((b) => ({ key: `collections_batch:${b.id}`, title: `${(b.verification && b.verification.notices) || 0} notice(s) dated ${b.notice_date}`, community: (C[b.community_id] || {}).name || null, action: dest, amount_cents: (b.verification && b.verification.total_due_cents) || 0 })) });
    for (const b of rows.filter((x) => x.status === 'verification_failed')) out.sections.ai_working.push({ key: `collections_batch:${b.id}`, kind: 'collections_batch', title: `Collections batch dated ${b.notice_date} failed verification`, why: `${(b.verification && b.verification.failed) || 0} notice(s) no longer tie to the ledger or a restriction now applies.`,
      owner: specialist('amanda'), specialist: specialist('amanda'), next_action: 'Cancel or re-date the failing notices and re-verify.', community: (C[b.community_id] || {}).name || null, action: dest, executor: null, gap: 'fixing a failed collections batch is not automated' });
    for (const b of rows.filter((x) => ['approved', 'printed'].includes(x.status))) out.sections.waiting.push({ key: `collections_batch:${b.id}`, kind: 'collections_batch', title: `Collections notices dated ${b.notice_date}: ${b.status === 'approved' ? 'print and mail' : 'record the USPS tracking numbers'}`,
      why: 'The notices must be mailed on their notice date; the homeowner fee posts only when a mailing is recorded.', owner: specialist('amanda'), specialist: specialist('amanda'), waiting_on: 'the office', follow_up: b.notice_date, community: (C[b.community_id] || {}).name || null, action: dest });
  }
  // Time & attendance (mig 547): this is the in-app notification for the owner. Corrections and
  // overtime requests wait for a decision; missing punches and overtime past the weekly limit
  // without approval are surfaced here. Read-only; before 547 is applied there is nothing.
  {
    const ta = await require('../time_attendance/read_model').ownerAlerts(supabase, { now });
    if (ta.error) out.section_errors.time_attendance = ta.error;
    const dest = { label: 'Open Team time', href: '/app/time-admin', where: 'Time & attendance' };
    const reqs = [...ta.pending_corrections.map((c) => ({ key: `time_correction:${c.id}`, title: `${c.employee}: ${c.kind === 'add_punch' ? 'add a missing punch' : c.kind === 'change_time' ? 'change a punch time' : 'remove a punch'}`, community: null, action: dest, amount_cents: 0 })),
      ...ta.pending_overtime.map((r) => ({ key: `overtime_request:${r.id}`, title: `${r.employee}: ${Math.round(r.extra_minutes / 6) / 10} h overtime, week of ${r.week_start}`, community: null, action: dest, amount_cents: 0 }))];
    if (reqs.length) out.sections.decisions.push({ key: 'group:time_requests', kind: 'group', bucket: 'decision', decision_type: 'time_approval', owner: OWNER, specialist: specialist('amanda'), priority: 'normal',
      title: `Decide ${reqs.length} time request${reqs.length === 1 ? '' : 's'}`, why: 'Nothing applies until you decide; the original punch is never changed.', next_action: 'Approve or reject each with a reason in Team time.', action: dest, members: reqs });
    const exc = [...ta.missing_punches.map((m) => ({ key: `time_missing:${m.user_id}:${m.date}`, title: `${m.employee}: missing ${m.code === 'missing_out' ? 'clock-out' : 'clock-in'} on ${m.date}`, community: null, action: dest, amount_cents: 0 })),
      ...ta.unapproved_overtime.map((u) => ({ key: `time_overtime:${u.user_id}:${u.week_start}`, title: `${u.employee}: ${u.message}`, community: null, action: dest, amount_cents: 0 }))];
    if (exc.length) out.sections.decisions.push({ key: 'group:time_exceptions', kind: 'group', bucket: 'decision', decision_type: 'time_exception', owner: OWNER, specialist: specialist('amanda'), priority: 'normal',
      title: `${exc.length} time exception${exc.length === 1 ? '' : 's'} to look at`, why: 'Missing punches keep hours out of payroll until corrected; overtime without approval is still recorded and paid.', next_action: 'Review in Team time.', action: dest, members: exc });
  }
  if (elsewhere.ap_approved_awaiting_release) out.sections.decisions.push({ key: 'group:ap_release', kind: 'group', bucket: 'decision', decision_type: 'payment_release', owner: OWNER, specialist: specialist('emma'), priority: 'normal',
    title: `Release ${elsewhere.ap_approved_awaiting_release} approved bill${elsewhere.ap_approved_awaiting_release === 1 ? '' : 's'} in Payables`, why: 'Approved on the normal path; releasing payment is your control.', next_action: 'Release in the Payables approval queue.', action: DEST.payables(), members: [] });
  await applyExecution(supabase, out, now, run);
  out.section_counts = { decisions: out.sections.decisions.length, ai_working: out.sections.ai_working.length, waiting: out.sections.waiting.length, completed: out.sections.completed.length };
  out.summary = summarize(out);
  return out;
}

// ---- ownership ------------------------------------------------------------------
// Buckets: 'decision' (the owner's authority: payment release, billback treatment
// approval, pre-cutover posting, a final ACC decision, a policy call, a job that
// keeps failing), 'ai' (an agent completes it under existing policy; a failed or
// unresolved lookup is the agent's next step, never the owner's), 'waiting' (an
// outside party or document), 'done' (the underlying work already happened).
// Pure: the record decides, never the wording. Unknown kinds stay with the owner.
const DAY = 86400000;
const plus = (iso, days) => (iso ? new Date(Date.parse(iso) + days * DAY).toISOString() : null);
const OWNER = { key: 'owner', name: 'You', role: 'Owner' };
function classifyItem(it, now = Date.now()) {
  const m = it.meta || {};
  const agent = it.specialist;
  const last = m.last_activity_at || it.at || null;
  const r = (bucket, o) => ({ bucket, owner: bucket === 'decision' ? OWNER : agent, last_activity: last, ...o });
  if (it.kind === 'objective') {
    const k = m.owner_key || '';
    if (k === 'legal.payment') {
      if (['paid', 'voided'].includes(m.invoice_status)) return r('done', { reason: `bill already ${m.invoice_status}` });
      return r('decision', { decision_type: 'payment_release', next_action: 'Release the payment in the approval queue (payment release stays yours).' });
    }
    if (k === 'legal.recovery' && /^approval required/i.test(it.title || '')) {
      if (m.review_status === 'approved') return r('done', { reason: 'treatment already approved' });
      return r('decision', { decision_type: 'billback_approval', next_action: 'Review the evidence and approve the homeowner chargebacks (Legal Invoice Review).' });
    }
    if (k === 'legal.documentation') {
      const missing = /:\s*([1-9]\d*) missing/i.exec(it.title || '');
      if (missing) return r('waiting', { waiting_on: 'the missing document', next_action: it.why || 'Obtain the missing document.', follow_up: m.next_action_due || plus(last, 7) });
      if (['paid'].includes(m.invoice_status) && /\b0 missing\b/i.test(it.title || '')) return r('done', { reason: 'bill paid; nothing missing, only an unchecked source' });
      return r('ai', { next_action: 'Search the sources the system could not reach (OneDrive retained evidence) and record what was found.' });
    }
    if (k === 'ap.intake') return r('ai', { next_action: m.next_action || it.why });
    if (k === 'legal.recovery') return r('ai', { next_action: 'Apply the documented policy (bankruptcy matters stay association expense) or obtain the record; only a question outside policy comes to you, as one decision.' });
    if (m.autonomy_class === 'BLOCK' || /^waiting/.test(m.status || '')) return r('waiting', { waiting_on: it.why || 'a dependency', next_action: m.next_action || it.why, follow_up: m.next_action_due || plus(last, 7) });
    return r('ai', { next_action: m.next_action || it.why || 'Complete the next step.' });
  }
  if (it.kind === 'ap_invoice') {
    if (m.cutover) return r('decision', { decision_type: 'cutover_posting', next_action: 'Decide how this pre-cutover bill posts.' });
    if (it.lane === 'policy') return r('decision', { decision_type: 'policy', next_action: it.policy_note || 'Policy call.' });
    if (it.lane === 'waiting') return r('waiting', { waiting_on: it.why, next_action: it.why, follow_up: plus(last, 7) });
    if (m.past_due) return r('decision', { decision_type: 'payment_release', next_action: 'Past due: approve and release, or tell Emma to hold.' });
    if (m.first_payee) return r('ai', { next_action: 'Verify the new payee (W-9, remit address, independent contact) and route the bill onto the normal approval path; you still release the payment.' });
    return r('ai', { next_action: it.why });
  }
  if (it.kind === 'ap_exception') {
    if (m.not_invoice) return r('ai', { next_action: 'Ask the sender for the actual invoice, then load it; the payment still needs your release.' });
    if (m.handoff) return r('ai', { next_action: 'Match the receipt to the card charge, code it and load it for approval.' });
    if (m.reimbursement) return r('ai', { next_action: 'Propose the expense account from the vendor history and load it for approval; ask the requester only if history is unclear.' });
    if (m.missing === MISSING.no_community) return r('ai', { next_action: 'Identify the association from the bill, sender and payment account; ask the sender only if the evidence conflicts.' });
    if (m.missing) return r('ai', { next_action: `Establish ${m.missing} from the bill and records; ask the sender only if it cannot be found.` });
    return r('ai', { next_action: it.why || 'Load the bill or record why it cannot be loaded.' });
  }
  if (it.kind === 'acc_decision') {
    if (m.state === 'info_requested') return r('waiting', { waiting_on: 'the homeowner', next_action: 'Annie follows up with the homeowner if nothing arrives.', follow_up: plus(m.updated_at || last, 14) });
    if (m.state === 'new_documents') return r('ai', { next_action: 'Review the new documents against the guidelines and update the recommendation.' });
    if (m.state === 'homeowner_wrote') return r('ai', { next_action: 'Read the homeowner\'s message and update the recommendation or draft the reply.' });
    if (m.state === 'not_drafted') return r('ai', { next_action: 'Draft the letter for the recommended outcome; the subjective decision then comes to you to approve.' });
    return r('decision', { decision_type: 'acc_decision', next_action: 'Approve or change Annie\'s drafted ACC decision.' });
  }
  if (it.kind === 'board_packet') return r('ai', { next_action: 'Finish the packet; distribution to the board waits for your approval.' });
  if (it.kind === 'cron_run') {
    if ((m.failures_24h || 0) >= 3) return r('decision', { decision_type: 'repeated_failure', next_action: `${m.job} failed ${m.failures_24h} times in 24 hours; retries are not fixing it.` });
    return r('ai', { next_action: 'Retry on the next run and diagnose the error; escalate if it keeps failing.' });
  }
  if (it.lane === 'policy') return r('decision', { decision_type: 'policy', next_action: it.why });
  if (it.lane === 'waiting') return r('waiting', { waiting_on: it.why, next_action: it.why, follow_up: plus(last, 7) });
  return r('decision', { decision_type: 'other', next_action: it.why });
}
// ---- execution (Ed 2026-10-12) -------------------------------------------------
// Which EXISTING capability can execute an AI-owned item, and its idempotency key:
// the same key never runs twice once it has succeeded (lib/manager/sweep.js records
// it on work_item_events). null = no automatic step exists; the card says so.
function executorFor(it) {
  const m = it.meta || {};
  if (it.kind === 'objective' && /^legal\.(recovery|documentation)$/.test(m.owner_key || '') && m.subject_id) {
    return { name: 'legal_team', key: `legal_team:${m.subject_id}:${m.last_activity_at || ''}`, ref: m.subject_id };
  }
  if (it.kind === 'acc_decision' && m.state === 'new_documents' && m.decision_id) {
    return { name: 'acc_reassess', key: `acc_reassess:${m.decision_id}:${m.last_document_added_at || ''}`, ref: m.decision_id };
  }
  if (it.kind === 'ap_exception' && m.exception_id && m.not_invoice) return { name: 'request_invoice', key: `request_invoice:${m.exception_id}`, ref: m.exception_id };
  if (it.kind === 'ap_exception' && m.exception_id && m.missing === MISSING.no_community) return { name: 'resolve_community', key: `resolve_community:${m.exception_id}`, ref: m.exception_id };
  return null;
}
function gapFor(it) {
  const m = it.meta || {};
  if (it.kind === 'acc_decision' && m.state === 'homeowner_wrote') return 'drafting a reply to the homeowner is not automated';
  if (it.kind === 'acc_decision') return 'drafting the decision letter is not automated';
  if (it.kind === 'ap_invoice') return 'new-payee verification is not automated';
  if (it.kind === 'ap_exception' && m.reimbursement) return 'choosing the expense account for a reimbursement needs a person';
  if (it.kind === 'ap_exception' && m.handoff) return 'matching a receipt to a card charge is not automated';
  return 'no agent capability exists for this step';
}
const EXEC_TEXT = {
  legal_team: (d) => `ran the legal review${d && d.outcome ? ` (${d.outcome})` : ''}`,
  acc_reassess: (d) => `re-reviewed the current documents${d && d.recommendation ? ` (now: ${String(d.recommendation).replace(/_/g, ' ')})` : ''}`,
  request_invoice: () => 'drafted the request for the invoice; it waits in the outbox for a person to send',
  resolve_community: (d) => (d && d.outcome === 'loaded' ? 'identified the association and loaded the bill' : `checked the association (${(d && d.outcome) || 'no result'})`),
};
// Status from what actually happened, never from the assignment alone.
async function applyExecution(supabase, out, now, run) {
  const S = out.sections; if (!S) return;
  const cards = S.ai_working;
  const keys = cards.map((c) => c.key);
  let items = []; let events = [];
  if (keys.length) {
    items = (await run('agent_work_items', supabase.from('work_items').select('id, source_ref, status, updated_at').eq('source_type', 'agent').in('source_ref', keys).order('updated_at', { ascending: false }).limit(500))) || [];
    const ids = items.map((w) => w.id);
    if (ids.length) events = (await run('agent_events', supabase.from('work_item_events').select('work_item_id, event, detail, created_at').in('work_item_id', ids).eq('event', 'agent_touch').order('created_at', { ascending: false }).limit(1000))) || [];
  }
  const wiBy = {}; for (const w of items) if (!wiBy[w.source_ref]) wiBy[w.source_ref] = w;
  const evBy = {}; for (const e of events) (evBy[e.work_item_id] = evBy[e.work_item_id] || []).push(e);
  const sweepOn = !!(out.schedule && out.schedule.scheduled);
  const keep = [];
  for (const c of cards) {
    const w = wiBy[c.key]; const ev = (w && evBy[w.id]) || [];
    c.work_item_id = w ? w.id : null;
    if (!c.executor) { c.status = 'not_automated'; c.status_text = `No automatic step exists: ${c.gap}. A person completes it.`; keep.push(c); continue; }
    const mine = ev.filter((e) => e.detail && e.detail.key === c.executor.key);
    const ok = mine.find((e) => e.detail.ok === true);
    const failures = mine.filter((e) => e.detail.ok === false).length;
    if (ok) {
      c.execution = { action: c.executor.name, at: ok.created_at, outcome: ok.detail.outcome || null };
      if (ok.detail.outcome === 'out_of_scope') { S.completed.push({ ...c, bucket: 'done', reason: ok.detail.reason || 'out of scope (former client)' }); continue; }
      c.status = ok.detail.outcome === 'draft_queued' ? 'awaiting_send' : 'executed';
      c.status_text = `${c.owner.name} ${(EXEC_TEXT[c.executor.name] || (() => 'ran'))(ok.detail)} on ${fmtDate(ok.created_at)}.`;
    } else if (failures >= 3) {
      c.status = 'escalated'; c.status_text = `The automatic step failed ${failures} times (last: ${String((mine[0].detail || {}).error || 'error').slice(0, 120)}). A person needs to look.`;
      S.decisions.push({ ...c, bucket: 'decision', decision_type: 'repeated_failure', owner: OWNER, next_action: c.status_text }); continue;
    } else if (failures) {
      c.status = 'retrying'; c.status_text = `The automatic step failed ${failures} time${failures === 1 ? '' : 's'}; it retries on the next sweep (last: ${String((mine[0].detail || {}).error || 'error').slice(0, 120)}).`;
    } else {
      c.status = 'queued'; c.status_text = sweepOn ? 'Runs on the next agent sweep.' : 'Not run yet: the agents\' sweep is not scheduled in production, so nothing is executing.';
    }
    keep.push(c);
  }
  S.ai_working = keep;
}

const GROUP_TITLE = {
  payment_release: (n, c) => `Release ${n} approved-path payment${n === 1 ? '' : 's'} (${money(c)})`,
  billback_approval: (n, c) => `Approve ${n} homeowner legal billback${n === 1 ? '' : 's'} (${money(c)})`,
};
// The FIRST amount in the title is the one the decision is about: "Approval required:
// $4345.46 homeowner chargebacks on ... ($4740.61)" is $4,345.46 of chargebacks, not
// the invoice total in parentheses (Ed 2026-10-12: the grouped total overstated the
// billbacks by 280595's $395.15 association share). "Payment awaiting release: X
// ($170.00)" has a single amount.
const amountOf = (t) => { const m = /\$([\d,]+(?:\.\d{1,2})?)/.exec(String(t || '')); return m ? Math.round(Number(m[1].replace(/,/g, '')) * 100) : 0; };
function buildSections(items, recent, now = Date.now(), { sweepScheduled = false } = {}) {
  const S = { decisions: [], ai_working: [], waiting: [], completed: [] };
  const groups = {}; const bySubject = {};
  for (const it of items) {
    const c = classifyItem(it, now);
    const card = { ...it, bucket: c.bucket, owner: c.owner, next_action: c.next_action || null, last_activity: c.last_activity || null, follow_up: c.follow_up || null, waiting_on: c.waiting_on || null, decision_type: c.decision_type || null };
    if (c.bucket === 'ai') { card.executor = executorFor(it); if (!card.executor) card.gap = gapFor(it); }
    delete card.meta;
    if (c.bucket === 'done') { S.completed.push({ ...card, reason: c.reason }); continue; }
    if (c.bucket === 'ai') {
      const age = card.last_activity ? (now - Date.parse(card.last_activity)) / DAY : null;
      card.status = age != null && age > 3 ? 'stale' : 'assigned';
      card.status_text = card.status === 'stale' ? `No recorded activity since ${fmtDate(card.last_activity)}${sweepScheduled ? '' : ' (the agents\' sweep is off, so this only moves when triggered)'}` : `Assigned ${fmtDate(card.at)}`;
    }
    if (c.bucket === 'waiting') card.follow_up_due = !!(card.follow_up && Date.parse(card.follow_up) < now);
    // One underlying issue, one card: agent/waiting cards on the same subject merge.
    const sk = (it.meta && (it.meta.subject_id || it.meta.subject_key)) || null;
    if (sk && c.bucket !== 'decision') {
      const prev = bySubject[sk];
      if (prev) {
        if (card.bucket === 'waiting' && prev.bucket === 'ai') {
          // the outside dependency governs: the waiting card leads, the agent card folds into it
          const arr = S.ai_working; const at = arr.indexOf(prev); if (at >= 0) arr.splice(at, 1);
          card.also = [{ title: prev.title, why: prev.why, key: prev.key }].concat(prev.also || []);
          bySubject[sk] = card; S.waiting.push(card); continue;
        }
        prev.also = (prev.also || []).concat([{ title: card.title, why: card.why, key: card.key }]); continue;
      }
      bySubject[sk] = card;
    }
    if (c.bucket === 'decision' && GROUP_TITLE[c.decision_type]) {
      const g = groups[c.decision_type] || (groups[c.decision_type] = { key: `group:${c.decision_type}`, kind: 'group', bucket: 'decision', decision_type: c.decision_type, owner: OWNER, specialist: card.specialist, members: [], action: card.action, priority: 'normal' });
      const sid = it.meta && it.meta.subject_id;
      const memberAction = c.decision_type === 'billback_approval' ? DEST.legalReview(sid) : c.decision_type === 'payment_release' ? DEST.payables() : card.action;
      if (!g.members.length) g.action = c.decision_type === 'billback_approval' ? DEST.legalReview(null) : c.decision_type === 'payment_release' ? DEST.payables() : card.action;
      g.members.push({ key: card.key, title: card.title, community: card.community, action: memberAction, amount_cents: amountOf(card.title) });
      continue;
    }
    S[c.bucket === 'decision' ? 'decisions' : c.bucket === 'ai' ? 'ai_working' : 'waiting'].push(card);
  }
  for (const g of Object.values(groups)) {
    const total = g.members.reduce((t, x) => t + x.amount_cents, 0);
    g.title = GROUP_TITLE[g.decision_type](g.members.length, total);
    g.why = g.decision_type === 'payment_release' ? 'Each bill is on the normal approval path; releasing payment is your control.' : 'Each treatment is researched and verified; approving homeowner charges is your control.';
    g.next_action = g.decision_type === 'payment_release' ? 'Review and release in the approval queue.' : 'Open each in Legal Invoice Review and approve.';
    g.total_cents = total;
    S.decisions.push(g);
  }
  for (const r of recent || []) S.completed.push({ ...r, bucket: 'done' });
  const pri = (a, b) => (PRI[a.priority] ?? 9) - (PRI[b.priority] ?? 9) || String(a.at || '').localeCompare(String(b.at || ''));
  S.decisions.sort(pri); S.ai_working.sort((a, b) => (a.status === 'stale' ? -1 : 0) - (b.status === 'stale' ? -1 : 0) || pri(a, b));
  S.waiting.sort((a, b) => String(a.follow_up || '9').localeCompare(String(b.follow_up || '9')));
  return S;
}

const NOT_INSTALLED = /does not exist|PGRST202|Could not find the function|42P01|42883/i;
async function builderCoverageItems(supabase, { communityId, today, out }) {
  let q = supabase.from('transfer_proration_builders').select('community_id, communities:community_id(name)').eq('active', true).order('community_id').limit(50);
  if (communityId) q = q.eq('community_id', communityId);
  const { data: rules, error } = await q;
  if (error) { if (!NOT_INSTALLED.test(`${error.code || ''} ${error.message || ''}`)) out.section_errors.builder_coverage = error.message; return []; }
  const items = []; const seen = new Set();
  for (const r of rules || []) {
    if (seen.has(r.community_id)) continue; seen.add(r.community_id);
    const { data: s, error: e } = await supabase.rpc('builder_coverage_status', { p_community_id: r.community_id, p_as_of: today });
    if (e) { if (!NOT_INSTALLED.test(`${e.code || ''} ${e.message || ''}`)) out.section_errors.builder_coverage = e.message; continue; }
    const name = (r.communities && r.communities.name) || null;
    if (!s || !s.applies || !s.converted) continue;
    const red = (s.lots || []).filter((l) => l.severity === 'red'); const amber = (s.lots || []).filter((l) => l.severity === 'amber');
    if (s.accrual_active === false) {
      items.push({ key: `builder_accrual_activation:${r.community_id}`, kind: 'builder_coverage', lane: 'policy', community: name, title: 'Builder billing not activated since the conversion',
        why: 'The conversion is posted; the periodic builder assessment billing starts only when an admin activates it.', priority: 'normal', at: s.conversion_as_of, age_days: null });
    }
    if (red.length || amber.length || s.staged_run) {
      const yearEnd = red.some((l) => l.reason === 'behind');
      items.push({ key: `builder_coverage:${r.community_id}`, kind: 'builder_coverage', lane: 'now', community: name,
        title: s.staged_run ? 'Builder assessment accrual stopped part-way' : `Builder assessments ${red.length ? 'not covered' : 'behind'} for ${red.length + amber.length} lot${red.length + amber.length === 1 ? '' : 's'}`,
        why: s.staged_run ? `The run through ${s.staged_run.through_date} has months still pending; run it again to finish (it never posts twice).`
          : `Expected through ${s.expected_through}; ${[...red, ...amber].slice(0, 4).map((l) => `${l.street_address} (${l.covered_through ? `through ${l.covered_through}` : 'no coverage'}${l.reason && l.reason !== 'behind' ? `, ${l.reason.replace(/_/g, ' ')}` : ''})`).join('; ')}${red.length + amber.length > 4 ? '; ...' : ''}.${yearEnd ? ' The year has closed without full coverage.' : ''}`,
        priority: red.length || s.staged_run ? 'high' : 'normal', at: s.expected_through, age_days: null });
    }
    for (const i of s.open_reconciling_items || []) {
      items.push({ key: `reconciling_item:${i.id}`, kind: 'reconciling_item', lane: 'waiting', community: name,
        title: i.kind === 'deferral_residue' ? `Conversion reconciling item: $${(Number(i.amount_cents) / 100).toFixed(2)} in ${i.account_number} outside the release schedule` : `Conversion reconciling item: ${(i.detail && i.detail.lot) || 'a builder lot'} has no resolved builder position`,
        why: 'Recorded by the conversion and carried separately until a person resolves it with a note.', priority: 'normal', at: i.created_at, age_days: null });
    }
  }
  return items;
}

function summarize(f) {
  if (f.section_counts) {
    const k = f.section_counts; const capped = (f.capped || []).length ? '+' : '';
    if (!k.decisions && !k.ai_working && !k.waiting) return 'Nothing needs a person right now.';
    return `${k.decisions}${capped} decision${k.decisions === 1 ? '' : 's'} for you · ${k.ai_working} with the AI team · ${k.waiting} waiting on others.`;
  }
  const c = f.counts || { now: 0, waiting: 0, policy: 0 };
  const plus = (f.capped || []).length ? '+' : '';
  if (!c.now && !c.waiting && !c.policy) return 'Nothing needs a person right now.';
  const parts = [];
  if (c.now) {
    const who = Object.entries(f.by_specialist || {}).sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n} ${k}`).join(', ');
    parts.push(`${c.now}${plus} need${c.now === 1 ? 's' : ''} you now${who ? ` (${who})` : ''}`);
  }
  if (c.waiting) parts.push(`${c.waiting} waiting on something`);
  if (c.policy) parts.push(`${c.policy} for your decision`);
  return `${parts.join(' · ')}.`;
}

// ---- detail drawer: one item's timeline from its own records ---------------
async function buildItem(supabase, key) {
  const m = /^(objective|ap_invoice|ap_exception|acc_decision|board_packet|cron_run):([0-9a-zA-Z-]{1,64})$/.exec(String(key || ''));
  if (!m) { const e = new Error('bad item key'); e.code = 'BAD_INPUT'; throw e; }
  const [, kind, id] = m;
  const one = async (p) => { const { data, error } = await p; if (error) throw error; return (data || [])[0] || null; };
  const many = async (p) => { const { data, error } = await p; if (error) throw error; return data || []; };
  const ev = (at, actor, text, source) => ({ at, actor, text, source });
  let head = null; let timeline = []; let action = null; let subjectKey = null;

  if (kind === 'objective') {
    const o = await one(supabase.from('objectives').select('id, title, status, autonomy_class, priority, blocked_reason, next_action, next_action_due, domain, subject_key, opened_at, closed_at, closed_reason, communities:community_id(name)').eq('id', id).limit(1));
    if (!o) return null;
    head = { title: o.title, status: o.status, class: o.autonomy_class, priority: o.priority, blocked_reason: o.blocked_reason, next_action: o.next_action, next_action_due: o.next_action_due, community: communityName(o), specialist: specialist(DOMAIN_PERSONA[o.domain] || 'amanda') };
    const events = await many(supabase.from('objective_events').select('at, actor, kind, summary').eq('objective_id', id).order('at', { ascending: true }).limit(100));
    timeline = events.map((x) => ev(x.at, x.actor, x.summary || x.kind, 'objective'));
    action = destForSubject(o.subject_key); subjectKey = o.subject_key;
  }
  const sk = subjectKey ? /^([a-z_]+):(.+)$/.exec(subjectKey) : null;
  const sub = kind === 'objective' ? (sk ? { kind: sk[1], id: sk[2] } : null) : { kind, id };

  if (sub && sub.kind === 'ap_invoice') {
    const i = await one(supabase.from('ap_invoices').select('id, vendor_invoice_number, total_cents, status, needs_review, classification_reason, due_date, cutover_review, notes, created_at, vendor:vendor_id(name), communities:community_id(name)').eq('id', sub.id).limit(1));
    if (i) {
      head = head || { title: `${(i.vendor && i.vendor.name) || 'Bill'}${i.vendor_invoice_number ? ` #${i.vendor_invoice_number}` : ''} (${money(i.total_cents)})`, status: i.status, community: communityName(i), specialist: specialist('emma') };
      head.facts = [`Status: ${String(i.status).replace(/_/g, ' ')}`, i.due_date ? `Due: ${i.due_date}` : null, i.status === 'on_hold' ? `Hold: ${holdReason(i.notes)}` : null, i.cutover_review === 'PENDING' ? 'Pre-cutover review pending' : null].filter(Boolean);
      timeline.push(ev(i.created_at, 'Emma', 'Bill loaded', 'payables'));
      const appr = await many(supabase.from('ap_invoice_approvals').select('action, user_name, notes, created_at').eq('invoice_id', sub.id).order('created_at', { ascending: true }).limit(50));
      for (const a of appr) timeline.push(ev(a.created_at, a.user_name || 'staff', `${String(a.action).replace(/_/g, ' ')}${a.notes ? `: ${a.notes}` : ''}`, 'payables'));
      action = action || DEST.invoice(sub.id);
    }
  } else if (sub && sub.kind === 'ap_exception') {
    const x = await one(supabase.from('ap_intake_exceptions').select('id, reason, status, vendor_name, invoice_number, total_cents, notes, created_at, resolved_at, resolved_by, communities:community_id(name)').eq('id', sub.id).limit(1));
    if (x) {
      head = head || { title: `Bill from ${x.vendor_name || 'an unknown vendor'}${x.invoice_number ? ` #${x.invoice_number}` : ''}${x.total_cents ? ` (${money(x.total_cents)})` : ''}`, status: x.status, community: communityName(x) || 'Community not identified', specialist: specialist('emma') };
      head.facts = [`Needs: ${REASON_TEXT[x.reason] || REASON_TEXT.other}`];
      timeline.push(ev(x.created_at, 'Emma', `Couldn't load: ${x.notes || x.reason}`, 'payables'));
      if (x.resolved_at) timeline.push(ev(x.resolved_at, x.resolved_by || 'staff', `Exception ${x.status}`, 'payables'));
      action = action || DEST.exception(sub.id);
    }
  } else if (sub && sub.kind === 'acc_decision') {
    const a = await one(supabase.from('acc_decisions').select('id, status, community_name, project_summary, decision_type, created_at, updated_at, last_document_added_at, current_review_at').eq('id', sub.id).limit(1));
    if (a) {
      head = head || { title: `ACC: ${a.project_summary || 'application'}`, status: a.status, community: a.community_name, specialist: specialist('annie') };
      head.facts = [a.decision_type ? `Decision so far: ${String(a.decision_type).replace(/_/g, ' ')}` : 'No decision sent yet'];
      timeline.push(ev(a.created_at, 'Annie', 'Application received and drafted for review', 'acc'));
      if (a.last_document_added_at) timeline.push(ev(a.last_document_added_at, 'homeowner', 'More documents added', 'acc'));
      if (a.current_review_at) timeline.push(ev(a.current_review_at, 'Annie', 'Reviewed', 'acc'));
      const fins = await many(supabase.from('acc_finalizations').select('version, decision_type, finalized_at').eq('acc_decision_id', sub.id).order('version', { ascending: true }).limit(10));
      for (const f of fins) timeline.push(ev(f.finalized_at, 'staff', `Finalized v${f.version}: ${String(f.decision_type || '').replace(/_/g, ' ')}`, 'acc'));
      action = action || DEST.decision(sub.id);
    }
  } else if (sub && sub.kind === 'board_packet') {
    const p = await one(supabase.from('board_packets').select('id, period_label, meeting_date, status, created_at, updated_at, communities:community_id(name)').eq('id', sub.id).limit(1));
    if (p) {
      head = head || { title: `Board packet ${p.period_label || ''}`.trim(), status: p.status, community: communityName(p), specialist: specialist('paige') };
      head.facts = [`Meeting: ${p.meeting_date || 'not set'}`, `Status: ${String(p.status).replace('_', ' ')}`];
      timeline.push(ev(p.created_at, 'staff', 'Packet started', 'board'));
      if (p.updated_at && p.updated_at !== p.created_at) timeline.push(ev(p.updated_at, 'staff', 'Last edited', 'board'));
      const dist = await many(supabase.from('board_packet_distribution_log').select('distributed_at').eq('packet_id', sub.id).limit(200));
      if (dist.length) timeline.push(ev(dist[dist.length - 1].distributed_at, 'staff', `Distributed to ${dist.length} recipient${dist.length === 1 ? '' : 's'}`, 'board'));
      action = action || DEST.packets();
    }
  } else if (kind === 'cron_run') {
    const r = await one(supabase.from('cron_runs').select('id, job_name, started_at, finished_at, ok, error').eq('id', id).limit(1));
    if (r) {
      head = { title: `Scheduled job failed: ${r.job_name}`, status: r.ok === false ? 'failed' : 'ok', community: null, specialist: specialist('amanda'), facts: [String(r.error || 'no error text').slice(0, 500)] };
      timeline.push(ev(r.started_at, 'scheduler', 'Run started', 'scheduler'));
      if (r.finished_at) timeline.push(ev(r.finished_at, 'scheduler', `Run ${r.ok === false ? 'failed' : 'finished'}`, 'scheduler'));
      action = DEST.errors();
    }
  }
  if (!head) return null;
  timeline.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  return { key, kind, ...head, timeline, action, link: action, actions: [], model_calls: 0 };
}

module.exports = { classifyItem, buildSections, executorFor, applyExecution, builderCoverageItems, buildFeed, buildItem, summarize, specialist, activeFor, holdReason, DEST, DOMAIN_PERSONA };
