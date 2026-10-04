// ============================================================================
// lib/feed/build.js  (Issue #29 Phase 1) — the read-only Operations Feed
// ----------------------------------------------------------------------------
// A READ MODEL, not a new store. Assembles what needs a person from records that
// already exist: Amanda's objectives (#27) plus the domain queues (AP intake
// exceptions, AP bills needing review or on hold, ACC decisions awaiting review,
// board packets near their meeting, failed scheduled jobs). An Amanda objective
// for a subject supersedes the raw domain row, so nothing appears twice.
//
// Deterministic: no model call, no write, no action. The summary is a template
// over counts. Every source is bounded; a failed source is reported in
// section_errors (unavailable != zero), and a capped source says so.
// Specialist identity is fixed by domain (AP -> Emma, ACC -> Annie, board ->
// Paige, violations -> Miranda, everything cross-cutting -> Amanda).
// ============================================================================
const roster = require('../team/roster');
const { sweepSchedule } = require('../manager/shadow');

const OPEN = ['open', 'waiting_resident', 'waiting_third_party', 'waiting_human'];
const PRI = { critical: 0, high: 1, normal: 2, low: 3 };
const CAP = { objectives: 200, exceptions: 100, invoices: 200, acc: 100, packets: 50, failures: 20, recent: 20 };
const DOMAIN_PERSONA = { ap: 'emma', acc: 'annie', board: 'paige', violations: 'miranda', legal: 'emma', accounting: 'emma', communications: 'amanda', ops: 'amanda' };
const LINKS = {
  ap: { label: 'Open Payables', href: '/#tab=ap' },
  acc: { label: 'Open ACC review', href: '/#tab=acc' },
  board: { label: 'Open Board packets', href: '/#tab=boardpackets' },
  objective: { label: 'Open in Objectives', href: '/admin/objectives' },
  failure: { label: 'Open system errors', href: '/admin/errors' },
};
const REASON_TEXT = { no_community: 'which community it belongs to', no_vendor: 'the vendor', vendor_ambiguous: 'which matching vendor it is', no_total: 'the bill total', no_date: 'the bill date', unreadable_attachment: 'a readable copy of the attachment', other: 'a person to look at it' };

function specialist(personaKey) {
  const p = roster.get(personaKey) || roster.get('amanda');
  return { key: p.persona || personaKey, name: String(p.name || personaKey).split(' ')[0], role: p.title || '' };
}
const money = (c) => (c == null ? '' : `$${(Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const communityName = (row) => (row && row.communities && row.communities.name) || (row && row.community_name) || null;
const daysSince = (iso, now) => (iso ? Math.max(0, Math.floor((now - Date.parse(iso)) / 86400000)) : null);

async function buildFeed(supabase, { communityId = null, now = Date.now(), env = process.env } = {}) {
  const out = { phase: 1, model_calls: 0, actions: [], generated_at: new Date(now).toISOString(), community_id: communityId, section_errors: {}, capped: [], schedule: sweepSchedule(env) };
  const since = new Date(now - 24 * 3600000).toISOString();
  const today = new Date(now).toISOString().slice(0, 10);
  const lead = new Date(now + 7 * 86400000).toISOString().slice(0, 10);
  // community scope: that community's rows plus rows whose community is not yet identified
  const scope = (qb) => (communityId ? qb.or(`community_id.eq.${communityId},community_id.is.null`) : qb);
  const run = async (name, p, cap) => {
    const { data, error } = await p;
    if (error) { out.section_errors[name] = error.message; return null; }
    if (cap && (data || []).length >= cap) out.capped.push(name);
    return data || [];
  };

  const [objectives, resolved, wakes, exceptions, invoices, acc, packets, failures, lastSweep] = await Promise.all([
    run('objectives', scope(supabase.from('objectives')
      .select('id, title, status, autonomy_class, priority, blocked_reason, next_action, next_action_due, domain, subject_key, accountable_persona, community_id, last_activity_at, opened_at, communities:community_id(name)')
      .in('status', OPEN).order('last_activity_at', { ascending: false }).limit(CAP.objectives)), CAP.objectives),
    run('recent', scope(supabase.from('objectives').select('id, title, domain, closed_at, closed_reason, accountable_persona, community_id, communities:community_id(name)')
      .eq('status', 'resolved').gte('closed_at', since).order('closed_at', { ascending: false }).limit(CAP.recent))),
    run('wakes', scope(supabase.from('manager_wakes').select('outcome').eq('status', 'consumed').gte('consumed_at', since).limit(1000))),
    run('ap_exceptions', scope(supabase.from('ap_intake_exceptions').select('id, reason, vendor_name, invoice_number, total_cents, community_id, created_at, communities:community_id(name)')
      .eq('status', 'pending').order('created_at', { ascending: true }).limit(CAP.exceptions)), CAP.exceptions),
    run('ap_invoices', scope(supabase.from('ap_invoices').select('id, community_id, vendor_invoice_number, total_cents, status, needs_review, classification_reason, created_at, vendor:vendor_id(name), communities:community_id(name)')
      .in('status', ['awaiting_approval', 'on_hold']).order('created_at', { ascending: true }).limit(CAP.invoices)), CAP.invoices),
    run('acc', scope(supabase.from('acc_decisions').select('id, community_id, community_name, homeowner_address, project_summary, created_at, last_document_added_at')
      .eq('status', 'pending_review').order('created_at', { ascending: true }).limit(CAP.acc)), CAP.acc),
    run('board_packets', scope(supabase.from('board_packets').select('id, community_id, period_label, meeting_date, status, communities:community_id(name)')
      .in('status', ['draft', 'in_review']).gte('meeting_date', today).lte('meeting_date', lead).order('meeting_date', { ascending: true }).limit(CAP.packets)), CAP.packets),
    run('failures', supabase.from('cron_runs').select('id, job_name, started_at, error').eq('ok', false).gte('started_at', since).order('started_at', { ascending: false }).limit(CAP.failures)),
    run('last_sweep', supabase.from('cron_runs').select('started_at, ok').eq('job_name', 'manager_sweep').order('started_at', { ascending: false }).limit(1)),
  ]);

  const items = []; const covered = new Set();
  for (const o of objectives || []) {
    const overdue = o.next_action_due && Date.parse(o.next_action_due) < now;
    const amandas = o.accountable_persona === 'amanda' || !!o.subject_key;
    if (!amandas && o.status !== 'waiting_human' && !overdue) continue; // other open work stays in its own screen
    if (o.subject_key) covered.add(o.subject_key);
    items.push({ key: `objective:${o.id}`, kind: 'objective', specialist: specialist(DOMAIN_PERSONA[o.domain] || 'amanda'),
      title: o.title, detail: o.autonomy_class === 'BLOCK' ? (o.blocked_reason || 'Waiting on a dependency') : (o.next_action || ''),
      community: communityName(o), class: o.autonomy_class || (o.status === 'waiting_human' ? 'REVIEW' : 'ATTENTION'), priority: overdue ? 'high' : (o.priority || 'normal'),
      at: o.opened_at || o.last_activity_at, age_days: daysSince(o.opened_at || o.last_activity_at, now), overdue: !!overdue, link: LINKS.objective });
  }
  for (const e of exceptions || []) {
    if (covered.has(`ap_exception:${e.id}`)) continue;
    const blocked = ['no_community', 'no_vendor', 'vendor_ambiguous', 'no_total', 'no_date'].includes(e.reason);
    items.push({ key: `ap_exception:${e.id}`, kind: 'ap_exception', specialist: specialist('emma'),
      title: `Bill from ${e.vendor_name || 'an unknown vendor'}${e.invoice_number ? ` #${e.invoice_number}` : ''}${e.total_cents ? ` (${money(e.total_cents)})` : ''}`,
      detail: `Can't load it yet: needs ${REASON_TEXT[e.reason] || REASON_TEXT.other}.`, community: communityName(e) || (e.community_id ? null : 'Community not identified'),
      class: blocked ? 'BLOCK' : 'REVIEW', priority: 'normal', at: e.created_at, age_days: daysSince(e.created_at, now), link: LINKS.ap });
  }
  for (const i of invoices || []) {
    const hold = i.status === 'on_hold';
    if (!hold && !i.needs_review) continue;
    if (covered.has(`ap_invoice:${i.id}`)) continue;
    items.push({ key: `ap_invoice:${i.id}`, kind: 'ap_invoice', specialist: specialist('emma'),
      title: `${hold ? 'On hold' : 'Check coding'}: ${(i.vendor && i.vendor.name) || 'bill'}${i.vendor_invoice_number ? ` #${i.vendor_invoice_number}` : ''} (${money(i.total_cents)})`,
      detail: hold ? 'Held as a possible duplicate; a person confirms before it can move.' : (i.classification_reason || 'Flagged for review at intake.'),
      community: communityName(i), class: 'REVIEW', priority: hold ? 'high' : 'normal', at: i.created_at, age_days: daysSince(i.created_at, now), link: LINKS.ap });
  }
  for (const a of acc || []) {
    items.push({ key: `acc_decision:${a.id}`, kind: 'acc_decision', specialist: specialist('annie'),
      title: `ACC review: ${a.project_summary || 'application'}`.slice(0, 140), detail: a.homeowner_address ? `At ${a.homeowner_address}. Drafted and waiting for a reviewer.` : 'Drafted and waiting for a reviewer.',
      community: communityName(a), class: 'REVIEW', priority: 'normal', at: a.created_at, age_days: daysSince(a.created_at, now), link: LINKS.acc });
  }
  for (const p of packets || []) {
    if (covered.has(`board_packet:${p.id}`)) continue;
    const days = Math.round((Date.parse(`${p.meeting_date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000);
    items.push({ key: `board_packet:${p.id}`, kind: 'board_packet', specialist: specialist('paige'),
      title: `Board packet ${p.period_label || ''} still ${String(p.status).replace('_', ' ')}`.replace(/\s+/g, ' '),
      detail: days === 0 ? 'Meeting is today.' : `Meeting in ${days} day${days === 1 ? '' : 's'}.`, community: communityName(p),
      class: 'REVIEW', priority: days <= 3 ? 'high' : 'normal', at: p.meeting_date, age_days: null, link: LINKS.board });
  }
  for (const f of failures || []) {
    items.push({ key: `cron_run:${f.id}`, kind: 'cron_run', specialist: specialist('amanda'), title: `Scheduled job failed: ${f.job_name}`,
      detail: String(f.error || 'no error text').slice(0, 200), community: null, class: 'ATTENTION', priority: 'high', at: f.started_at, age_days: daysSince(f.started_at, now), link: LINKS.failure });
  }

  // ordering: priority, then oldest first (things that have waited longest), board packets by meeting date
  items.sort((a, b) => (PRI[a.priority] ?? 9) - (PRI[b.priority] ?? 9) || String(a.at || '').localeCompare(String(b.at || '')));
  const bySpecialist = {}; for (const i of items) bySpecialist[i.specialist.name] = (bySpecialist[i.specialist.name] || 0) + 1;
  const tally = {}; for (const w of wakes || []) tally[w.outcome || 'unknown'] = (tally[w.outcome || 'unknown'] || 0) + 1;
  out.needs = items.slice(0, 5);
  out.more = items.slice(5);
  out.total = items.length;
  out.by_specialist = bySpecialist;
  out.recent = (resolved || []).map((r) => ({ key: `objective:${r.id}`, title: r.title, when: r.closed_at, reason: r.closed_reason, community: communityName(r), specialist: specialist(DOMAIN_PERSONA[r.domain] || 'amanda') }));
  out.routine_24h = wakes ? (tally.execute_candidate || 0) : null;
  out.last_sweep = lastSweep && lastSweep[0] ? lastSweep[0] : null;
  out.summary = summarize(out);
  return out;
}

function summarize(f) {
  const parts = [];
  if (f.routine_24h) parts.push(`${f.routine_24h} routine bill${f.routine_24h === 1 ? '' : 's'} continued on the normal path`);
  if (f.recent && f.recent.length) parts.push(`${f.recent.length} item${f.recent.length === 1 ? '' : 's'} cleared`);
  const lead = parts.length ? `In the last 24 hours: ${parts.join(', ')}. ` : '';
  const capped = (f.capped || []).length ? '+' : '';
  if (!f.total) return `${lead}Nothing needs a person right now.`.trim();
  const who = Object.entries(f.by_specialist).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(', ');
  return `${lead}${f.total}${capped} item${f.total === 1 ? '' : 's'} need${f.total === 1 ? 's' : ''} a person (${who}).`;
}

// ---- detail drawer: one item's timeline from its own records ---------------
async function buildItem(supabase, key) {
  const m = /^(objective|ap_invoice|ap_exception|acc_decision|board_packet|cron_run):([0-9a-zA-Z-]{1,64})$/.exec(String(key || ''));
  if (!m) { const e = new Error('bad item key'); e.code = 'BAD_INPUT'; throw e; }
  const [, kind, id] = m;
  const one = async (p) => { const { data, error } = await p; if (error) throw error; return (data || [])[0] || null; };
  const many = async (p) => { const { data, error } = await p; if (error) throw error; return data || []; };
  const ev = (at, actor, text, source) => ({ at, actor, text, source });
  let head = null; let timeline = []; let link = null; let subjectKey = null;

  if (kind === 'objective') {
    const o = await one(supabase.from('objectives').select('id, title, status, autonomy_class, priority, blocked_reason, next_action, next_action_due, domain, subject_key, opened_at, closed_at, closed_reason, communities:community_id(name)').eq('id', id).limit(1));
    if (!o) return null;
    head = { title: o.title, status: o.status, class: o.autonomy_class, priority: o.priority, blocked_reason: o.blocked_reason, next_action: o.next_action, next_action_due: o.next_action_due, community: communityName(o), specialist: specialist(DOMAIN_PERSONA[o.domain] || 'amanda') };
    const events = await many(supabase.from('objective_events').select('at, actor, kind, summary').eq('objective_id', id).order('at', { ascending: true }).limit(100));
    timeline = events.map((x) => ev(x.at, x.actor, x.summary || x.kind, 'objective'));
    link = LINKS.objective; subjectKey = o.subject_key;
  }
  const sk = subjectKey ? /^([a-z_]+):(.+)$/.exec(subjectKey) : null;
  const sub = kind === 'objective' ? (sk ? { kind: sk[1], id: sk[2] } : null) : { kind, id };

  if (sub && sub.kind === 'ap_invoice') {
    const i = await one(supabase.from('ap_invoices').select('id, vendor_invoice_number, total_cents, status, needs_review, classification_reason, created_at, vendor:vendor_id(name), communities:community_id(name)').eq('id', sub.id).limit(1));
    if (i) {
      head = head || { title: `${(i.vendor && i.vendor.name) || 'Bill'}${i.vendor_invoice_number ? ` #${i.vendor_invoice_number}` : ''} (${money(i.total_cents)})`, status: i.status, community: communityName(i), specialist: specialist('emma') };
      head.facts = [`Status: ${String(i.status).replace(/_/g, ' ')}`, i.needs_review ? `Needs review: ${i.classification_reason || 'flagged at intake'}` : 'Coding: no review flag'];
      timeline.push(ev(i.created_at, 'Emma', 'Bill loaded', 'payables'));
      const appr = await many(supabase.from('ap_invoice_approvals').select('action, user_name, notes, created_at').eq('invoice_id', sub.id).order('created_at', { ascending: true }).limit(50));
      for (const a of appr) timeline.push(ev(a.created_at, a.user_name || 'staff', `${String(a.action).replace(/_/g, ' ')}${a.notes ? `: ${a.notes}` : ''}`, 'payables'));
      link = link || LINKS.ap;
    }
  } else if (sub && sub.kind === 'ap_exception') {
    const x = await one(supabase.from('ap_intake_exceptions').select('id, reason, status, vendor_name, invoice_number, total_cents, notes, created_at, resolved_at, resolved_by, communities:community_id(name)').eq('id', sub.id).limit(1));
    if (x) {
      head = head || { title: `Bill from ${x.vendor_name || 'an unknown vendor'}${x.invoice_number ? ` #${x.invoice_number}` : ''}${x.total_cents ? ` (${money(x.total_cents)})` : ''}`, status: x.status, community: communityName(x) || 'Community not identified', specialist: specialist('emma') };
      head.facts = [`Needs: ${REASON_TEXT[x.reason] || REASON_TEXT.other}`];
      timeline.push(ev(x.created_at, 'Emma', `Couldn't load: ${x.notes || x.reason}`, 'payables'));
      if (x.resolved_at) timeline.push(ev(x.resolved_at, x.resolved_by || 'staff', `Exception ${x.status}`, 'payables'));
      link = link || LINKS.ap;
    }
  } else if (sub && sub.kind === 'acc_decision') {
    const a = await one(supabase.from('acc_decisions').select('id, status, community_name, homeowner_address, project_summary, created_at, last_document_added_at').eq('id', sub.id).limit(1));
    if (a) {
      head = head || { title: `ACC review: ${a.project_summary || 'application'}`, status: a.status, community: a.community_name, specialist: specialist('annie') };
      head.facts = a.homeowner_address ? [`Address: ${a.homeowner_address}`] : [];
      timeline.push(ev(a.created_at, 'Annie', 'Application received and drafted for review', 'acc'));
      if (a.last_document_added_at) timeline.push(ev(a.last_document_added_at, 'Annie', 'More documents added', 'acc'));
      const fins = await many(supabase.from('acc_finalizations').select('version, decision_type, finalized_at').eq('acc_decision_id', sub.id).order('version', { ascending: true }).limit(10));
      for (const f of fins) timeline.push(ev(f.finalized_at, 'staff', `Finalized v${f.version}: ${String(f.decision_type || '').replace(/_/g, ' ')}`, 'acc'));
      link = link || LINKS.acc;
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
      link = link || LINKS.board;
    }
  } else if (kind === 'cron_run') {
    const r = await one(supabase.from('cron_runs').select('id, job_name, started_at, finished_at, ok, error').eq('id', id).limit(1));
    if (r) {
      head = { title: `Scheduled job failed: ${r.job_name}`, status: r.ok === false ? 'failed' : 'ok', community: null, specialist: specialist('amanda'), facts: [String(r.error || 'no error text').slice(0, 500)] };
      timeline.push(ev(r.started_at, 'scheduler', 'Run started', 'scheduler'));
      if (r.finished_at) timeline.push(ev(r.finished_at, 'scheduler', `Run ${r.ok === false ? 'failed' : 'finished'}`, 'scheduler'));
      link = LINKS.failure;
    }
  }
  if (!head) return null;
  timeline.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  return { key, kind, ...head, timeline, link, actions: [], model_calls: 0 };
}

module.exports = { buildFeed, buildItem, summarize, specialist, DOMAIN_PERSONA, LINKS };
