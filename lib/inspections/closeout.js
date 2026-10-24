// ============================================================================
// lib/inspections/closeout.js  (Ed 2026-10-24, migration 546)
// ----------------------------------------------------------------------------
// The three inspection stages, mapped onto the EXISTING inspections.status
// values rather than a parallel state machine:
//
//   in_progress           status in_progress / paused, OR any tracked drive the
//                         inspector has not explicitly completed (completed_at
//                         empty), including one the stale-drive job auto-ended
//                         to 'captured' because the tablet closed.
//   inspection_completed  the inspector closed the drive: completed_at,
//                         completed_by_user_id and the counts are recorded and
//                         status becomes 'captured'.
//   review_completed      staff approved or dismissed every observation:
//                         review_completed_at / _by are recorded and status
//                         becomes 'closed' (the existing "Completed" state).
//
// HARD RULE (Ed): completing an inspection or a review never approves a
// violation, sends a letter or advances enforcement. Both writers here touch
// ONLY the inspections row (and close their own reminder work item). Letters
// keep moving through the existing Drafts -> Mail Queue flow.
//
// The actor is always the signed-in employee (api/_require_admin.js
// getAuthedUser). Nothing here accepts a name or user id from a request body.
//
// Pure functions first (tests/test_inspection_closeout.js), then the reads and
// writes. Every "all rows" read goes through lib/db/fetch_all.js.
// ============================================================================
const { fetchAllQuery } = require('../db/fetch_all');

const CENTRAL_TZ = 'America/Chicago';
// End-of-workday reminder and next-morning Amanda flag, Central time. The hours
// are read by lib/scheduler.js (targetHour) and can be moved with env vars.
const END_OF_WORKDAY_HOUR = Number(process.env.INSPECTION_REMINDER_HOUR || 17);
const MORNING_FLAG_HOUR = Number(process.env.INSPECTION_FLAG_HOUR || 8);
// A house within this many meters of the drive's GPS trail counts as visited
// (same radius as GET /inspections/:id/coverage).
const COVERAGE_RADIUS_M = 50;
// Reminders only ever go to staff mailboxes.
const STAFF_EMAIL_DOMAINS = String(process.env.INSPECTION_REMINDER_DOMAINS || 'bedrocktx.com')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
// Who Amanda flags a drive to (work_items.assigned_to).
const MANAGEMENT_ASSIGNEE = process.env.INSPECTION_FLAG_ASSIGNEE || 'Ed';
const AMANDA_ACTOR = 'Amanda (AI operations manager)';
// Reasons are free text from the inspector; keep them short.
const MAX_REASON = 300;
// Observation statuses that still need a staff decision.
const UNDECIDED = ['pending', 'deferred'];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
function centralDateKey(d = new Date()) {
  return new Date(d).toLocaleDateString('en-CA', { timeZone: CENTRAL_TZ });
}

function deriveStage(insp) {
  if (!insp) return null;
  if (insp.status === 'voided') return 'voided';
  if (insp.status === 'closed' && (insp.review_completed_at || !insp.closeout_tracked)) return 'review_completed';
  if (insp.completed_at) return 'inspection_completed';
  return 'in_progress';
}

const STAGE_LABEL = {
  in_progress: 'In progress',
  inspection_completed: 'Inspection completed',
  review_completed: 'Review completed',
  voided: 'Voided',
};

// Plain description of the stage for the UI: who and when.
function stageInfo(insp) {
  const stage = deriveStage(insp);
  const out = { stage, label: STAGE_LABEL[stage] || stage, tracked: !!(insp && insp.closeout_tracked) };
  if (!insp) return out;
  out.completed = insp.completed_at ? { at: insp.completed_at, by: insp.completed_by_name || null } : null;
  out.review_completed = insp.review_completed_at ? { at: insp.review_completed_at, by: insp.review_completed_by_name || null } : null;
  out.counts = insp.completed_at ? {
    inspected: insp.inspected_property_count,
    violations_identified: insp.violations_identified,
    skipped: insp.skipped_property_count,
  } : null;
  if (stage === 'review_completed' && !insp.review_completed_at) out.note = 'Completed before stage tracking began.';
  return out;
}

function cleanReason(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, MAX_REASON) : null;
}

// Haversine distance in meters.
function distM(lat1, lng1, lat2, lng2) {
  const R = 6371000; const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1); const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Which properties the GPS trail passed within radius of. Pings are bucketed
// into ~0.001 degree cells (about 110 m) so a 1,500-house community with a
// long trail stays fast.
function routeCoveredIds(properties, pings, radiusM = COVERAGE_RADIUS_M) {
  const covered = new Set();
  if (!pings || !pings.length) return covered;
  const CELL = 0.001;
  const key = (la, ln) => `${Math.floor(la / CELL)}:${Math.floor(ln / CELL)}`;
  const grid = new Map();
  for (const p of pings) {
    const la = Number(p.latitude); const ln = Number(p.longitude);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) continue;
    const k = key(la, ln);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push([la, ln]);
  }
  for (const pr of properties || []) {
    const la = Number(pr.latitude); const ln = Number(pr.longitude);
    if (pr.latitude == null || pr.longitude == null || !Number.isFinite(la) || !Number.isFinite(ln)) continue;
    const ci = Math.floor(la / CELL); const cj = Math.floor(ln / CELL);
    let hit = false;
    for (let di = -1; di <= 1 && !hit; di++) {
      for (let dj = -1; dj <= 1 && !hit; dj++) {
        for (const [pla, pln] of grid.get(`${ci + di}:${cj + dj}`) || []) {
          if (distM(la, ln, pla, pln) <= radiusM) { hit = true; break; }
        }
      }
    }
    if (hit) covered.add(pr.id);
  }
  return covered;
}

// The completion counts. Server-side only; the browser never supplies counts.
//   inspected = photographed houses + houses the GPS trail passed, minus any
//               house the inspector explicitly marked skipped
//   violations_identified = observations on the drive that are not "clean"
//   skipped   = houses the inspector marked skipped (with their reason) +
//               houses neither photographed nor passed ("not visited")
function computeCloseout({ properties = [], photos = [], observations = [], pings = [], skipReasons = {}, generalReason = null, radiusM = COVERAGE_RADIUS_M } = {}) {
  const propIds = new Set(properties.map((p) => p.id));
  const photographed = new Set();
  for (const ph of photos) {
    const pid = ph.reviewer_confirmed_property_id || ph.polygon_match_property_id || null;
    if (pid && propIds.has(pid)) photographed.add(pid);
  }
  const passed = routeCoveredIds(properties, pings, radiusM);
  const general = cleanReason(generalReason);
  const explicit = new Map();
  for (const [pid, reason] of Object.entries(skipReasons || {})) {
    if (propIds.has(pid)) explicit.set(pid, cleanReason(reason));
  }
  const inspected = new Set();
  for (const id of photographed) if (!explicit.has(id)) inspected.add(id);
  for (const id of passed) if (!explicit.has(id)) inspected.add(id);

  const skipped = [];
  for (const p of properties) {
    if (inspected.has(p.id)) continue;
    const isExplicit = explicit.has(p.id);
    skipped.push({
      property_id: p.id,
      street_address: p.street_address || null,
      source: isExplicit ? 'inspector' : 'not_visited',
      reason: (isExplicit && explicit.get(p.id)) || general || null,
    });
  }
  skipped.sort((a, b) => String(a.street_address || '').localeCompare(String(b.street_address || ''), 'en', { numeric: true }));

  const identified = observations.filter((o) => o.severity !== 'clean');
  return {
    inspected_property_count: inspected.size,
    violations_identified: identified.length,
    skipped_property_count: skipped.length,
    skipped_properties: skipped,
    summary: {
      total_properties: properties.length,
      photographed_properties: photographed.size,
      route_covered_properties: passed.size,
      gps_points: pings.length,
      coverage_basis: pings.length ? 'photos_and_gps_trail' : 'photos_only',
      photos: photos.length,
      observations: observations.length,
      observations_pending_review: observations.filter((o) => UNDECIDED.includes(o.reviewer_status)).length,
      skipped_by_inspector: skipped.filter((s) => s.source === 'inspector').length,
      not_visited: skipped.filter((s) => s.source === 'not_visited').length,
      general_skip_reason: general,
      radius_m: radiusM,
    },
  };
}

// May staff mark the review complete? Only when every observation has a
// decision. Returns a plain-English reason when not.
function reviewGate(insp, observations = []) {
  if (!insp) return { allowed: false, code: 'not_found', reason: 'Inspection not found.' };
  if (insp.status === 'voided') return { allowed: false, code: 'voided', reason: 'This inspection was voided.' };
  if (insp.review_completed_at && insp.status === 'closed') return { allowed: false, code: 'already_review_completed', reason: 'The review is already complete.' };
  if (insp.closeout_tracked && !insp.completed_at) return { allowed: false, code: 'inspection_not_completed', reason: 'The inspector has not completed this inspection yet. Complete the inspection first.' };
  const pending = observations.filter((o) => o.reviewer_status === 'pending').length;
  const deferred = observations.filter((o) => o.reviewer_status === 'deferred').length;
  if (pending || deferred) {
    const n = pending + deferred;
    return { allowed: false, code: 'observations_pending', pending, deferred,
      reason: `${n} observation${n === 1 ? ' is' : 's are'} still waiting for a decision. Approve or dismiss ${n === 1 ? 'it' : 'each one'} first.` };
  }
  return { allowed: true, code: 'ok', pending: 0, deferred: 0, reason: null };
}

// Tracked drives still waiting on the inspector.
function isIncompleteDrive(d) {
  return !!(d && d.closeout_tracked && !d.completed_at && !['closed', 'voided'].includes(d.status));
}
// 5 PM: every incomplete drive gets one reminder today.
function remindersDue(drives = [], now = new Date()) {
  return drives.filter(isIncompleteDrive).map((d) => ({ drive: d, notice_date: centralDateKey(now) }));
}
// 8 AM: an incomplete drive started on an EARLIER Central day gets one flag today.
// A drive started this morning is not flagged (it is not "the next morning" yet).
function flagsDue(drives = [], now = new Date()) {
  const today = centralDateKey(now);
  return drives.filter((d) => isIncompleteDrive(d) && d.started_at && centralDateKey(d.started_at) < today)
    .map((d) => ({ drive: d, notice_date: today }));
}

// Simple, queue-ready shape (kept flat so the mailing/staff queue can add it
// later without depending on anything here).
function queueItems(rows = []) {
  const out = [];
  for (const r of rows) {
    if (!r || !r.closeout_tracked || ['closed', 'voided'].includes(r.status)) continue;
    const stage = deriveStage(r);
    out.push({
      kind: stage === 'in_progress' ? 'inspection_incomplete' : 'inspection_review_pending',
      inspection_id: r.id,
      community_id: r.community_id,
      stage,
      label: stage === 'in_progress' ? 'Inspection not completed by the inspector' : 'Inspection awaiting review completion',
      since: stage === 'in_progress' ? r.started_at : r.completed_at,
      inspector: r.device_label || null,
      href: '/#tab=inspect',
    });
  }
  return out;
}

function staffEmailAllowed(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return false;
  return STAFF_EMAIL_DOMAINS.includes(e.slice(at + 1));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
const INSPECTION_COLS = 'id, community_id, status, mode, route_label, device_label, operator_id, started_by_user_id, started_at, ended_at, closeout_tracked, completed_at, completed_by_user_id, completed_by_name, inspected_property_count, violations_identified, skipped_property_count, skipped_properties, closeout_summary, review_completed_at, review_completed_by_user_id, review_completed_by_name';

async function loadInspection(supabase, id) {
  const { data, error } = await supabase.from('inspections').select(INSPECTION_COLS).eq('id', id).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function loadObservations(supabase, inspectionId) {
  return fetchAllQuery(() => supabase.from('property_observations')
    .select('id, property_id, severity, reviewer_status').eq('inspection_id', inspectionId));
}

async function loadCloseoutInputs(supabase, insp) {
  const [properties, photos, observations, pings] = await Promise.all([
    fetchAllQuery(() => supabase.from('properties').select('id, street_address, latitude, longitude').eq('community_id', insp.community_id)),
    fetchAllQuery(() => supabase.from('inspection_photos').select('id, polygon_match_property_id, reviewer_confirmed_property_id').eq('inspection_id', insp.id)),
    loadObservations(supabase, insp.id),
    fetchAllQuery(() => supabase.from('inspection_route_traces').select('id, latitude, longitude').eq('inspection_id', insp.id)),
  ]);
  return { properties, photos, observations, pings };
}

// Counts for the confirm dialog. Read-only.
async function previewCloseout(supabase, inspectionId) {
  const insp = await loadInspection(supabase, inspectionId);
  if (!insp) return null;
  const inputs = await loadCloseoutInputs(supabase, insp);
  const c = computeCloseout(inputs);
  return { inspection: insp, stage: stageInfo(insp), ...c };
}

// ---------------------------------------------------------------------------
// Writes (inspections row only)
// ---------------------------------------------------------------------------
class CloseoutError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra || {}; }
}

function actorFields(actor) {
  if (!actor || !actor.user || !actor.user.id) throw new CloseoutError(403, 'sign_in_required', 'Sign in to complete this.');
  return { id: actor.user.id, name: actor.full_name || actor.email || null };
}

async function closeFlagWorkItem(supabase, inspectionId, actorName, logger = console) {
  const ref = `inspection-closeout:${inspectionId}`;
  const { data: rows, error } = await supabase.from('work_items').select('id').eq('source_ref', ref).in('status', ['new', 'in_progress', 'waiting']).limit(1);
  if (error) { logger.warn(`[closeout] flag lookup failed: ${error.message}`); return null; }
  const wi = (rows || [])[0];
  if (!wi) return null;
  const { error: ue } = await supabase.from('work_items').update({ status: 'done', completed_at: new Date().toISOString() }).eq('id', wi.id);
  if (ue) { logger.warn(`[closeout] flag close failed: ${ue.message}`); return null; }
  const { error: ee } = await supabase.from('work_item_events').insert({ work_item_id: wi.id, event: 'closed_by_evidence', actor: actorName || 'trustEd', detail: { inspection_id: inspectionId, detail: 'the inspector completed the inspection' } });
  if (ee) logger.warn(`[closeout] flag close event not recorded: ${ee.message}`);
  return wi.id;
}

// Stage 2. Records the employee, time and counts. Touches nothing else.
async function completeInspection({ supabase, inspectionId, actor, skipReasons = {}, generalReason = null, now = new Date(), logger = console }) {
  const who = actorFields(actor);
  const insp = await loadInspection(supabase, inspectionId);
  if (!insp) throw new CloseoutError(404, 'not_found', 'Inspection not found.');
  if (insp.status === 'voided') throw new CloseoutError(409, 'voided', 'This inspection was voided.');
  if (insp.completed_at) throw new CloseoutError(409, 'already_completed', `Already completed by ${insp.completed_by_name || 'a staff member'}.`, { completed_at: insp.completed_at, completed_by_name: insp.completed_by_name });
  if (insp.status === 'closed') throw new CloseoutError(409, 'already_closed', 'This inspection is already closed.');
  const inputs = await loadCloseoutInputs(supabase, insp);
  const c = computeCloseout({ ...inputs, skipReasons, generalReason });
  const at = new Date(now).toISOString();
  const patch = {
    completed_at: at,
    completed_by_user_id: who.id,
    completed_by_name: who.name,
    inspected_property_count: c.inspected_property_count,
    violations_identified: c.violations_identified,
    skipped_property_count: c.skipped_property_count,
    skipped_properties: c.skipped_properties,
    closeout_summary: c.summary,
    closeout_tracked: true,
    updated_at: at,
  };
  // Driving stops; later statuses (captured / ai_analyzed) are kept as they are.
  if (['in_progress', 'paused'].includes(insp.status)) patch.status = 'captured';
  if (!insp.ended_at) patch.ended_at = at;
  const { data, error } = await supabase.from('inspections').update(patch)
    .eq('id', insp.id).is('completed_at', null).select(INSPECTION_COLS).maybeSingle();
  if (error) throw error;
  if (!data) throw new CloseoutError(409, 'already_completed', 'Someone else just completed this inspection.');
  await closeFlagWorkItem(supabase, insp.id, who.name, logger);
  return { inspection: data, stage: stageInfo(data), counts: c };
}

// Stage 3. Refused while any observation is undecided. Touches nothing else.
async function completeReview({ supabase, inspectionId, actor, now = new Date() }) {
  const who = actorFields(actor);
  const insp = await loadInspection(supabase, inspectionId);
  if (!insp) throw new CloseoutError(404, 'not_found', 'Inspection not found.');
  const observations = await loadObservations(supabase, insp.id);
  const gate = reviewGate(insp, observations);
  if (!gate.allowed) throw new CloseoutError(409, gate.code, gate.reason, { pending: gate.pending || 0, deferred: gate.deferred || 0 });
  const at = new Date(now).toISOString();
  const patch = { status: 'closed', review_completed_at: at, review_completed_by_user_id: who.id, review_completed_by_name: who.name, updated_at: at };
  if (!insp.ended_at) patch.ended_at = at;
  const { data, error } = await supabase.from('inspections').update(patch).eq('id', insp.id).neq('status', 'voided').select(INSPECTION_COLS).maybeSingle();
  if (error) throw error;
  if (!data) throw new CloseoutError(409, 'voided', 'This inspection was voided.');
  return { inspection: data, stage: stageInfo(data), observations: observations.length };
}

// ---------------------------------------------------------------------------
// Reminders (scheduler jobs). Staff only; logged once per drive per day.
// ---------------------------------------------------------------------------
async function openTrackedDrives(supabase) {
  return fetchAllQuery(() => supabase.from('inspections').select(INSPECTION_COLS)
    .eq('closeout_tracked', true).is('completed_at', null).not('status', 'in', '(closed,voided)'));
}

// Claim today's slot. Returns the notice row, or null when it already exists.
async function claimNotice(supabase, row) {
  const { data, error } = await supabase.from('inspection_closeout_notices').insert(row).select('id').single();
  if (error) {
    if (String(error.code) === '23505') return null;   // already sent today
    throw error;
  }
  return data;
}
async function finishNotice(supabase, id, patch, logger = console) {
  const { error } = await supabase.from('inspection_closeout_notices').update(patch).eq('id', id);
  if (error) logger.warn(`[closeout] notice ${id} outcome not recorded: ${error.message}`);
}

async function resolveInspector(supabase, drive) {
  for (const id of [drive.started_by_user_id, drive.operator_id]) {
    if (!id || !/^[0-9a-f-]{36}$/i.test(String(id))) continue;
    const { data, error } = await supabase.from('user_profiles').select('id, email, full_name, is_active').eq('id', id).maybeSingle();
    if (error) throw error;
    if (data && data.is_active !== false && data.email) return data;
  }
  return null;
}

function fmtCentral(iso) {
  return iso ? new Date(iso).toLocaleString('en-US', { timeZone: CENTRAL_TZ, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' Central' : 'today';
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function communityNames(supabase, ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const { data, error } = await supabase.from('communities').select('id, name').in('id', uniq).limit(500);
  if (error) throw error;
  return new Map((data || []).map((c) => [c.id, c.name]));
}

async function runInspectorReminders({ supabase, now = new Date(), send = null, logger = console } = {}) {
  const sendEmail = send || require('../notifications/email').sendEmail;
  const drives = await openTrackedDrives(supabase);
  const due = remindersDue(drives, now);
  const names = await communityNames(supabase, due.map((x) => x.drive.community_id));
  const s = { fired: true, incomplete: due.length, sent: 0, already_today: 0, skipped: 0, failed: 0 };
  for (const { drive, notice_date } of due) {
    const person = await resolveInspector(supabase, drive);
    const email = person && person.email;
    const allowed = staffEmailAllowed(email);
    const claim = await claimNotice(supabase, {
      inspection_id: drive.id, community_id: drive.community_id, kind: 'inspector_reminder', notice_date,
      recipient: email || null, channel: 'staff_email', outcome: 'pending',
      detail: { started_at: drive.started_at, status: drive.status, device_label: drive.device_label || null },
    });
    if (!claim) { s.already_today += 1; continue; }
    if (!allowed) {
      s.skipped += 1;
      await finishNotice(supabase, claim.id, { outcome: 'skipped', detail: { reason: email ? 'not_a_staff_mailbox' : 'no_inspector_on_record', started_at: drive.started_at } }, logger);
      continue;
    }
    const community = names.get(drive.community_id) || 'the community';
    const first = String(person.full_name || '').split(/\s+/)[0] || 'there';
    const subject = `Reminder: complete your ${community} inspection`;
    const text = `Hi ${first},\n\nYour ${community} inspection started ${fmtCentral(drive.started_at)} has not been completed yet. When you are done with the drive, open the Inspect tab and tap Complete inspection so the office can start the review.\n\nIf you are still driving, finish the route first. Completing it does not approve any violation or send any letter.\n\nBedrock operations (trustEd)`;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a2230;">${text.split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px;">${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}</div>`;
    let r;
    try { r = await sendEmail({ to: email, subject, html, text, tags: [{ name: 'module', value: 'inspections' }, { name: 'event', value: 'closeout_reminder' }] }); }
    catch (e) { r = { ok: false, error: e.message }; }
    if (r && r.ok) {
      s.sent += 1;
      await finishNotice(supabase, claim.id, { outcome: 'sent', sent_at: new Date().toISOString(), detail: { vendor_message_id: r.vendor_message_id || null, started_at: drive.started_at } }, logger);
    } else {
      const skippedSend = !!(r && r.skipped);
      if (skippedSend) s.skipped += 1; else s.failed += 1;
      await finishNotice(supabase, claim.id, { outcome: skippedSend ? 'skipped' : 'failed', detail: { reason: (r && r.error) || 'send_failed', started_at: drive.started_at } }, logger);
    }
  }
  return s;
}

async function runManagementFlags({ supabase, now = new Date(), logger = console } = {}) {
  const drives = await openTrackedDrives(supabase);
  const due = flagsDue(drives, now);
  const names = await communityNames(supabase, due.map((x) => x.drive.community_id));
  const s = { fired: true, flagged: 0, already_today: 0, failed: 0 };
  for (const { drive, notice_date } of due) {
    const claim = await claimNotice(supabase, {
      inspection_id: drive.id, community_id: drive.community_id, kind: 'management_flag', notice_date,
      recipient: MANAGEMENT_ASSIGNEE, channel: 'work_item', outcome: 'pending',
      detail: { started_at: drive.started_at, status: drive.status, device_label: drive.device_label || null },
    });
    if (!claim) { s.already_today += 1; continue; }
    const community = names.get(drive.community_id) || 'a community';
    const who = drive.device_label || 'the inspector';
    const title = `${community} inspection not completed (started ${new Date(drive.started_at).toLocaleDateString('en-US', { timeZone: CENTRAL_TZ, month: 'short', day: 'numeric' })})`;
    const summary = `${who} started this drive ${fmtCentral(drive.started_at)} and has not tapped Complete inspection. The inspector was reminded at the end of the workday. Observations from the drive cannot finish review until it is completed.`;
    const ref = `inspection-closeout:${drive.id}`;
    try {
      const { data: open, error: oe } = await supabase.from('work_items').select('id').eq('source_ref', ref).in('status', ['new', 'in_progress', 'waiting']).limit(1);
      if (oe) throw oe;
      let wid = open && open[0] && open[0].id;
      if (wid) {
        const { error: ue } = await supabase.from('work_items').update({ title, summary }).eq('id', wid);
        if (ue) throw ue;
        const { error: ee } = await supabase.from('work_item_events').insert({ work_item_id: wid, event: 'agent_touch', actor: AMANDA_ACTOR, detail: { inspection_id: drive.id, notice_date } });
        if (ee) logger.warn(`[closeout] flag event not recorded: ${ee.message}`);
      } else {
        const { data: wi, error: ie } = await supabase.from('work_items').insert({
          source_type: 'agent', workspace: 'operations', item_type: 'task', module_key: 'inspections', horizon: 'now', status: 'new', urgency: 'normal',
          community_id: drive.community_id || null, community_name: names.get(drive.community_id) || null,
          title, summary, next_step: 'Ask the inspector to open the drive in the Inspect tab and tap Complete inspection.',
          assigned_to: MANAGEMENT_ASSIGNEE, requested_by: AMANDA_ACTOR, created_by: AMANDA_ACTOR, source_ref: ref, record_ownership: 'workpaper',
          action_url: '/#tab=inspect', why: 'Ed 2026-10-24: a drive still incomplete the morning after it started is flagged for management.',
        }).select('id').single();
        if (ie) throw ie;
        wid = wi.id;
        const { error: ee } = await supabase.from('work_item_events').insert({ work_item_id: wid, event: 'created', actor: AMANDA_ACTOR, detail: { inspection_id: drive.id, source_ref: ref } });
        if (ee) logger.warn(`[closeout] flag event not recorded: ${ee.message}`);
      }
      s.flagged += 1;
      await finishNotice(supabase, claim.id, { outcome: 'sent', sent_at: new Date().toISOString(), work_item_id: wid }, logger);
    } catch (e) {
      s.failed += 1;
      logger.warn(`[closeout] flag for ${drive.id} failed: ${e.message}`);
      await finishNotice(supabase, claim.id, { outcome: 'failed', detail: { reason: e.message, started_at: drive.started_at } }, logger);
    }
  }
  return s;
}

module.exports = {
  END_OF_WORKDAY_HOUR, MORNING_FLAG_HOUR, COVERAGE_RADIUS_M, STAFF_EMAIL_DOMAINS, MANAGEMENT_ASSIGNEE, AMANDA_ACTOR, INSPECTION_COLS,
  centralDateKey, deriveStage, stageInfo, STAGE_LABEL, computeCloseout, routeCoveredIds, reviewGate,
  isIncompleteDrive, remindersDue, flagsDue, queueItems, staffEmailAllowed,
  loadInspection, previewCloseout, completeInspection, completeReview, closeFlagWorkItem,
  runInspectorReminders, runManagementFlags, CloseoutError,
};
