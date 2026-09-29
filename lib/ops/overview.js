// ============================================================================
// lib/ops/overview.js — what operational work is waiting, per community
// (Issue #6, Operations slice)
// ----------------------------------------------------------------------------
// Two layers, same shape as lib/community/data_readiness.js:
//   fetchOps(supabase)            bounded, ordered, read-only queries across
//                                 the portfolio; each returns { ok, rows } or
//                                 { ok:false, error }. A failed read is never
//                                 turned into zero rows.
//   evaluateOps(communities, facts, now)  PURE grouping + rules
//                                 (tests/test_ops_overview.js).
//
// Rules (Ed / ChatGPT, Issue #6):
// - Read-only. This does not reuse /api/enforcement/drafts (unchecked count
//   error) or /mail-queue/summary (locked block swallows errors); it reads the
//   same tables itself and reports failures.
// - Printed letters with no mailed_at are "mailing not recorded", never "not
//   mailed": Ed, 2026-09-29, "some of that is they were mailed just not
//   confirmed in the system".
// - Certified §209, fines and 10-day self-help are human-only (Ed's rule): this
//   file only counts them; the page shows no action for them beyond "view".
// - Overdue only against a stored time: respond_by_at, sla_due_at,
//   cure_period_ends_at, or the community's stored builder ARC review target
//   (business days; weekends excluded, holidays are not in the data).
// - Leaving communities and prospects are listed but never counted as action.
// ============================================================================
const { fetchAllQuery } = require('../db/fetch_all');

const LETTER_TYPES = ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209', 'letter_postcard_reminder'];

// key, title, where the work is done, whether the page may offer an action
const AREAS = [
  ['calls_overdue', 'Callbacks past due', '/#tab=calls'],
  ['builder_overdue', 'Builder ARC past review target', '/builder-arc-review.html'],
  ['work_overdue', 'Mail and tasks past SLA', '/#tab=status'],
  ['certified_cure_ended', 'Certified §209: cure period ended', '/#tab=cures', { humanOnly: true }],
  ['letters_unrecorded', 'Printed, mailing not recorded', '/#tab=inspect'],
  ['letters_draft', 'Letters awaiting approval', '/#tab=inspect'],
  ['acc_pending', 'ACC applications to review', '/#tab=acc'],
  ['email_drafts', 'Email drafts awaiting your send', '/admin/draft-queue'],
  ['letters_print', 'Approved letters ready to print', '/#tab=inspect'],
  // A courtesy cure ending is the normal pipeline (the next drive-by settles
  // it), so it's shown but not counted as action; live it's ~500 cases and
  // would bury everything else.
  ['courtesy_cure_ended', 'Courtesy cure ended, awaiting next inspection', '/#tab=cures', { informational: true }],
  ['calls_open', 'Open callbacks (not yet due)', '/#tab=calls', { informational: true }], // not yet due: in progress, not an exception
  ['builder_open', 'Builder ARC in review', '/builder-arc-review.html', { informational: true }], // within its review target
  ['certified_open', 'Certified §209 open', '/#tab=cures', { humanOnly: true, informational: true }],
  ['work_open', 'Mail and tasks open', '/#tab=status', { informational: true }], // not past SLA
  ['rentals_payment', 'Amenity rentals awaiting payment', '/amenity-rentals-review.html'],
];
const AREA_INDEX = Object.fromEntries(AREAS.map((a, i) => [a[0], i]));
// Which facts feed which areas (a failed fact makes these areas unknown).
const FACT_FOR = {
  letters: ['letters_unrecorded', 'letters_draft', 'letters_print'],
  violations: ['certified_cure_ended', 'courtesy_cure_ended', 'certified_open'],
  acc: ['acc_pending'],
  builder: ['builder_overdue', 'builder_open'],
  calls: ['calls_overdue', 'calls_open'],
  drafts: ['email_drafts'],
  work: ['work_overdue', 'work_open'],
  rentals: ['rentals_payment'],
};
const FACT_LABEL = {
  letters: 'enforcement letters', violations: 'violations', acc: 'ACC applications', builder: 'builder ARC queue',
  calls: 'calls', drafts: 'email drafts', work: 'mail and tasks', rentals: 'amenity rentals',
};

function chicagoDate(d) { return new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }
// Weekdays elapsed after the start date up to and including today (Chicago).
function businessDaysSince(startIso, now) {
  if (!startIso) return null;
  const start = new Date(chicagoDate(startIso) + 'T12:00:00Z');
  const end = new Date(chicagoDate(now || Date.now()) + 'T12:00:00Z');
  let n = 0;
  for (let d = new Date(start); d < end;) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) n += 1;
  }
  return n;
}
function lifecycleGroup(c) {
  const ms = c && c.management_status;
  if (ms === 'terminating' || ms === 'terminated') return 'leaving';
  if (ms === 'prospect') return 'prospect';
  return 'managed';
}

function emptyAreas() {
  const o = {};
  for (const [k] of AREAS) o[k] = { count: 0, oldest: null };
  return o;
}
function bump(bucket, key, at) {
  const a = bucket.areas[key];
  a.count += 1;
  if (at && (!a.oldest || at < a.oldest)) a.oldest = at;
}

// ---------------------------------------------------------------------------
// Pure evaluation
// ---------------------------------------------------------------------------
function evaluateOps(communities, facts, now) {
  const nowIso = new Date(now || Date.now()).toISOString();
  const byId = new Map();
  for (const c of communities) byId.set(c.id, { community: { id: c.id, name: c.name, management_status: c.management_status, management_end_date: c.management_end_date || null }, group: lifecycleGroup(c), areas: emptyAreas() });
  const unassigned = { community: { id: null, name: 'Bedrock / no community' }, group: 'managed', areas: emptyAreas() };
  const bucketFor = (cid) => (cid && byId.get(cid)) || (cid ? null : unassigned); // unknown community ids (e.g. demo) are dropped
  const unknown = new Set();
  const problems = [];
  for (const [fact, areas] of Object.entries(FACT_FOR)) {
    if (!facts[fact] || !facts[fact].ok) {
      areas.forEach((a) => unknown.add(a));
      problems.push({ key: fact, label: FACT_LABEL[fact], message: `Couldn’t load ${FACT_LABEL[fact]}. Those counts are unknown, not zero.`, error: (facts[fact] && facts[fact].error) || 'not loaded' });
    }
  }
  const rows = (k) => (facts[k] && facts[k].ok ? facts[k].rows : []);

  for (const r of rows('letters')) {
    const b = bucketFor(r.community_id); if (!b) continue;
    if (r.status === 'draft') bump(b, 'letters_draft', r.created_at);
    else if (!r.printed_at && (r.status === 'approved' || r.status === 'sent')) bump(b, 'letters_print', r.created_at);
    else if (r.printed_at && !r.mailed_at && r.status !== 'rejected') bump(b, 'letters_unrecorded', r.printed_at);
  }
  for (const v of rows('violations')) {
    const b = bucketFor(v.community_id); if (!b) continue;
    const ended = v.cure_period_ends_at && v.cure_period_ends_at < nowIso;
    if (v.current_stage === 'certified_209') { bump(b, 'certified_open', v.certified_notice_date || v.current_stage_started_at); if (ended) bump(b, 'certified_cure_ended', v.cure_period_ends_at); }
    else if (ended) bump(b, 'courtesy_cure_ended', v.cure_period_ends_at);
  }
  for (const a of rows('acc')) { const b = bucketFor(a.community_id); if (b) bump(b, 'acc_pending', a.created_at); }
  for (const x of rows('builder')) {
    const b = bucketFor(x.community_id); if (!b) continue;
    const c = communities.find((cc) => cc.id === x.community_id) || {};
    const target = x.fast_track ? c.builder_arc_fast_track_business_days : c.builder_arc_sla_business_days;
    const age = businessDaysSince(x.submitted_at, now);
    if (target != null && age != null && age > Number(target)) bump(b, 'builder_overdue', x.submitted_at);
    else bump(b, 'builder_open', x.submitted_at);
  }
  for (const c of rows('calls')) {
    const b = bucketFor(c.community_id); if (!b) continue;
    if (c.respond_by_at && c.respond_by_at < nowIso) bump(b, 'calls_overdue', c.respond_by_at); else bump(b, 'calls_open', c.respond_by_at || c.started_at);
  }
  for (const d of rows('drafts')) { const b = bucketFor(d.community_id); if (b) bump(b, 'email_drafts', d.created_at); }
  for (const w of rows('work')) {
    const b = bucketFor(w.community_id); if (!b) continue;
    if (w.sla_due_at && w.sla_due_at < nowIso) bump(b, 'work_overdue', w.sla_due_at); else bump(b, 'work_open', w.received_at || w.created_at);
  }
  for (const r of rows('rentals')) { const b = bucketFor(r.community_id); if (b) bump(b, 'rentals_payment', r.created_at); }

  const actionable = (key) => !(AREAS[AREA_INDEX[key]][3] || {}).informational;
  const needs = (b) => AREAS.reduce((s, [k]) => s + (actionable(k) ? b.areas[k].count : 0), 0);
  const all = [...byId.values()];
  const managed = all.filter((b) => b.group === 'managed');
  if (AREAS.some(([k]) => unassigned.areas[k].count)) managed.push(unassigned);
  for (const b of all.concat([unassigned])) b.needs_action = needs(b);
  managed.sort((a, b) => b.needs_action - a.needs_action || String(a.community.name).localeCompare(String(b.community.name)));

  // Attention list: one item per area across managed communities (never
  // leaving/prospect), worst area first, with the communities named.
  const items = [];
  AREAS.forEach(([key, title, href, opts], rank) => {
    if ((opts || {}).informational) return;
    const hits = managed.filter((b) => b.areas[key].count);
    const total = hits.reduce((s, b) => s + b.areas[key].count, 0);
    if (!total) return;
    const oldest = hits.map((b) => b.areas[key].oldest).filter(Boolean).sort()[0] || null;
    items.push({ key, title, count: total, oldest, href, humanOnly: !!(opts || {}).humanOnly, rank,
      communities: hits.sort((a, b) => b.areas[key].count - a.areas[key].count).map((b) => ({ name: b.community.name, count: b.areas[key].count })) });
  });
  const quiet = AREAS.filter(([k, , , o]) => !(o || {}).informational && !unknown.has(k) && !items.some((i) => i.key === k)).map(([k, t]) => ({ key: k, title: t }));

  return {
    generated_at: nowIso,
    areas: AREAS.map(([key, title, href, opts]) => ({ key, title, href, humanOnly: !!(opts || {}).humanOnly, informational: !!(opts || {}).informational, unknown: unknown.has(key) })),
    items,
    quiet,
    problems,
    managed,
    other: all.filter((b) => b.group !== 'managed').sort((a, b) => String(a.community.name).localeCompare(String(b.community.name))),
  };
}

// ---------------------------------------------------------------------------
// Reads (portfolio-wide, filtered to open states, ordered + paginated)
// ---------------------------------------------------------------------------
async function attempt(fn) {
  try { return { ok: true, rows: await fn() }; } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

async function fetchOps(supabase, communityIds, now) {
  const nowIso = new Date(now || Date.now()).toISOString();
  const ids = communityIds;
  const inIds = (q) => q.or(`community_id.in.(${ids.join(',')}),community_id.is.null`);
  const [letters, violations, acc, builder, calls, drafts, work, rentals] = await Promise.all([
    attempt(async () => {
      const a = await fetchAllQuery(() => inIds(supabase.from('interactions').select('id, community_id, status, created_at, printed_at, mailed_at').in('type', LETTER_TYPES).in('status', ['draft', 'approved', 'sent'])), { orderBy: 'id' });
      // printed + not mailed can sit in other non-rejected statuses too
      const b = await fetchAllQuery(() => inIds(supabase.from('interactions').select('id, community_id, status, created_at, printed_at, mailed_at').in('type', LETTER_TYPES).not('printed_at', 'is', null).is('mailed_at', null).neq('status', 'rejected')), { orderBy: 'id' });
      const seen = new Set(); return a.concat(b).filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
    }),
    attempt(async () => {
      const cert = await fetchAllQuery(() => supabase.from('violations').select('id, community_id, current_stage, current_stage_started_at, cure_period_ends_at, certified_notice_date').in('community_id', ids).eq('current_stage', 'certified_209').is('resolved_at', null), { orderBy: 'id' });
      const court = await fetchAllQuery(() => supabase.from('violations').select('id, community_id, current_stage, current_stage_started_at, cure_period_ends_at, certified_notice_date').in('community_id', ids).in('current_stage', ['courtesy_1', 'courtesy_2']).is('resolved_at', null).lt('cure_period_ends_at', nowIso), { orderBy: 'id' });
      return cert.concat(court);
    }),
    attempt(() => fetchAllQuery(() => supabase.from('acc_decisions').select('id, community_id, created_at').in('community_id', ids).eq('status', 'pending_review'), { orderBy: 'id' })),
    attempt(() => fetchAllQuery(() => supabase.from('v_builder_queue').select('application_id, community_id, status, submitted_at, fast_track').in('community_id', ids).eq('status', 'received'), { orderBy: 'application_id' })),
    attempt(() => fetchAllQuery(() => inIds(supabase.from('homeowner_calls').select('id, community_id, follow_up_status, respond_by_at, started_at').in('follow_up_status', ['open', 'in_progress'])), { orderBy: 'id' })),
    attempt(() => fetchAllQuery(() => inIds(supabase.from('outbound_email_drafts').select('id, community_id, created_at').eq('status', 'draft')), { orderBy: 'id' })),
    attempt(() => fetchAllQuery(() => inIds(supabase.from('work_items').select('id, community_id, status, sla_due_at, received_at, created_at').not('status', 'in', '(done,closed,resolved,cancelled,completed)')), { orderBy: 'id' })),
    attempt(() => fetchAllQuery(() => supabase.from('v_amenity_rental_queue').select('id, community_id, status, created_at').in('community_id', ids).eq('status', 'pending_payment'), { orderBy: 'id' })),
  ]);
  return { letters, violations, acc, builder, calls, drafts, work, rentals };
}

const COMMUNITY_SELECT = 'id, name, active, is_demo, management_company_id, management_status, management_end_date, builder_arc_sla_business_days, builder_arc_fast_track_business_days';

module.exports = { AREAS, LETTER_TYPES, COMMUNITY_SELECT, evaluateOps, fetchOps, businessDaysSince, lifecycleGroup };
