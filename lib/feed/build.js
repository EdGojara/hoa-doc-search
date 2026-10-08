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
      .select('id, title, status, autonomy_class, priority, blocked_reason, next_action, next_action_due, domain, subject_key, accountable_persona, community_id, last_activity_at, opened_at, communities:community_id(name)')
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
      community: communityName(o), priority: overdue ? 'high' : (o.priority || 'normal'), at: o.opened_at || o.last_activity_at, age_days: daysSince(o.opened_at || o.last_activity_at, now), action: destForSubject(o.subject_key) });
  }

  for (const i of invoices || []) {
    if (covered.has(`ap_invoice:${i.id}`)) continue;
    const c = C[i.community_id];
    if (!activeFor(c, 'ap')) { elsewhere.inactive_community += 1; continue; }
    const vendor = (i.vendor && i.vendor.name) || 'bill';
    const label = `${vendor}${i.vendor_invoice_number ? ` #${i.vendor_invoice_number}` : ''} (${money(i.total_cents)})`;
    const base = { kind: 'ap_invoice', key: `ap_invoice:${i.id}`, specialist: specialist('emma'), community: communityName(i), at: i.created_at, age_days: daysSince(i.created_at, now), action: DEST.invoice(i.id) };
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
      community: communityName(e) || (e.community_id ? null : 'Community not identified'), priority: 'normal', at: e.created_at, age_days: daysSince(e.created_at, now), action: DEST.exception(e.id) });
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
    if (newDocs) { add({ ...base, lane: 'now', why: `New documents arrived ${fmtDate(a.last_document_added_at)} and haven't been reviewed.`, priority: 'normal' }); continue; }
    if (inbound) { add({ ...base, lane: 'now', why: `The homeowner wrote again on ${fmtDate(lastInbound[a.conversation_id])}.`, priority: 'normal' }); continue; }
    if (a.decision_type === 'request_more_info') { add({ ...base, lane: 'waiting', why: `More information requested; nothing new from the homeowner since ${fmtDate(a.updated_at)}.`, priority: 'low' }); continue; }
    if (!a.decision_type && !a.finalization_id) { add({ ...base, lane: 'now', why: `No decision has been sent yet (recommendation: ${String(a.current_ai_recommendation || a.ai_recommendation).replace(/_/g, ' ')}).`, priority: 'normal' }); continue; }
    add({ ...base, lane: 'now', why: 'Drafted and waiting for a reviewer.', priority: 'normal' });
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
      why: String(f.error || 'no error text').slice(0, 200), community: null, priority: 'high', at: f.started_at, age_days: daysSince(f.started_at, now), action: DEST.errors() });
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
  out.summary = summarize(out);
  return out;
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

module.exports = { builderCoverageItems, buildFeed, buildItem, summarize, specialist, activeFor, holdReason, DEST, DOMAIN_PERSONA };
