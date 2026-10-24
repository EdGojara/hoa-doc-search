// ============================================================================
// lib/enforcement/fine_authority.js  (Ed 2026-10-24, Phase 1 fine safeguards)
// ----------------------------------------------------------------------------
// The ONE place that decides whether a fine may be assessed, who may approve
// it, and which fine-queue changes are allowed. Every fine path in
// api/enforcement.js calls into here; none of them decide on their own.
//
// Rules (Ed's decisions, binding):
//   1. Ed is the only fine approver for now. Named delegates can be added to
//      FINE_APPROVER_DELEGATES below later without touching any call site.
//   2. A fine needs the community's fines turned on AND a real board fine
//      schedule row for the violation's category with an amount for this
//      offense. Free-text "board resolution" / "override reason" text is never
//      accepted as a substitute.
//   3. "No fine may be posted without the required authorization, notice and
//      hearing process." There is no notice-and-hearing record yet, so posting
//      FAILS CLOSED until that workflow exists.
//   4. Staff preparation never creates a homeowner charge.
//
// Pure functions + injected database client, so tests run without Supabase.
// ============================================================================
const { OWNER_EMAIL } = require('../auth/owner_email');

// Future delegates: { email: 'name@bedrocktx.com', community_ids: ['<uuid>'] | '*' }.
// Empty on purpose: today only the owner approves fines.
const FINE_APPROVER_DELEGATES = [];

const _email = (user) => String((user && (user.email || (user.user && user.user.email))) || '').trim().toLowerCase();

// Accepts either user shape in this codebase: getAuthedUser ({ user, role,
// email }) or getActingUser ({ id, email, role, is_active }).
function isFineApprover(user, communityId) {
  if (!user || user.is_active === false) return false;
  const email = _email(user);
  if (!email) return false;
  if (user.role === 'admin' && email === OWNER_EMAIL) return true;
  return FINE_APPROVER_DELEGATES.some((d) => {
    if (!d || String(d.email || '').toLowerCase() !== email) return false;
    if (d.community_ids === '*') return true;
    return Array.isArray(d.community_ids) && !!communityId && d.community_ids.includes(communityId);
  });
}

function actorId(user) {
  if (!user) return null;
  return user.id || (user.user && user.user.id) || null;
}

function actorName(user) {
  if (!user) return 'Staff';
  return user.full_name || _email(user) || 'Staff';
}

const NOT_APPROVER = {
  error: 'fine_approver_only',
  message: 'Only the fine approver (Ed) can assess, approve or change a fine.',
};

const _refuse = (reason, message, extra = {}) => ({ ok: false, reason, message, ...extra });

function amountForOffense(row, offenseCount) {
  const n = Number(offenseCount) || 1;
  const raw = (n <= 1) ? row.first_offense_amount
            : (n === 2) ? row.second_offense_amount
            : (n === 3) ? row.third_offense_amount
            : row.recurring_offense_amount;
  const amt = raw == null ? null : Number(raw);
  return (Number.isFinite(amt) && amt > 0) ? amt : null;
}

// Decides whether THIS violation may be fined. Never trusts request text.
//   violation: { id, community_id, primary_category_id, current_stage,
//                resolved_at, quality_status }
// Returns { ok: true, amount, source, offense_count } or { ok: false, reason, message }.
async function checkFineAuthority({ supabase, violation, offenseCount = 1 }) {
  if (!violation || !violation.id) return _refuse('violation_not_found', 'The violation could not be found.');
  if (violation.quality_status === 'superseded') {
    return _refuse('violation_superseded', 'This violation was replaced by a corrected record and cannot be fined.');
  }
  if (violation.resolved_at || ['cured', 'closed', 'voided'].includes(violation.current_stage)) {
    return _refuse('violation_closed', 'This violation is closed and cannot be fined.');
  }
  if (violation.current_stage !== 'certified_209') {
    return _refuse('certified_notice_required', 'A fine can only follow a Certified §209 notice. This case is not at the Certified stage.');
  }
  if (!violation.community_id || !violation.primary_category_id) {
    return _refuse('violation_incomplete', 'This violation has no community or category, so no fine schedule applies.');
  }

  const { data: comm, error: cErr } = await supabase
    .from('communities').select('id, fines_enabled')
    .eq('id', violation.community_id).maybeSingle();
  if (cErr) {
    console.warn('[fine_authority] community lookup failed:', cErr.message);
    return _refuse('authority_check_failed', 'The fine settings could not be checked, so no fine was assessed. Try again.');
  }
  if (!comm || comm.fines_enabled !== true) {
    return _refuse('fines_not_enabled', 'This community does not have fines turned on. The board has not authorized fines here.');
  }

  const { data: rows, error: sErr } = await supabase
    .from('v_resolved_fine_schedule')
    .select('community_fines_enabled, effective_fines_enabled, first_offense_amount, second_offense_amount, third_offense_amount, recurring_offense_amount, source_row')
    .eq('community_id', violation.community_id)
    .eq('category_id', violation.primary_category_id);
  if (sErr) {
    console.warn('[fine_authority] schedule lookup failed:', sErr.message);
    return _refuse('authority_check_failed', 'The fine schedule could not be checked, so no fine was assessed. Try again.');
  }
  const row = (rows || [])[0];
  if (!row || !row.source_row || row.source_row === 'no_schedule') {
    return _refuse('no_fine_schedule', 'There is no board-approved fine schedule for this violation type in this community.');
  }
  if (row.effective_fines_enabled !== true) {
    return _refuse('category_fines_not_enabled', 'The board has not authorized fines for this violation type.');
  }
  const amount = amountForOffense(row, offenseCount);
  if (amount == null) {
    return _refuse('no_fine_amount', 'The fine schedule has no amount for this offense number.');
  }
  return { ok: true, amount, source: row.source_row, offense_count: Number(offenseCount) || 1 };
}

// Offense number for this case: prior cases for the same property and the same
// (alias-aware) category in the last 12 months, plus this one. Never counts the
// case itself, superseded (corrected-away) cases, or voided cases.
async function countOffenses({ supabase, violation, aliasIds, now = new Date() }) {
  const ids = (Array.isArray(aliasIds) && aliasIds.length) ? aliasIds : [violation.primary_category_id];
  const cutoff = new Date(now.getTime()); cutoff.setMonth(cutoff.getMonth() - 12);
  const { data, error } = await supabase
    .from('violations')
    .select('id, current_stage, quality_status, resolved_via')
    .eq('property_id', violation.property_id)
    .in('primary_category_id', ids)
    .gte('opened_at', cutoff.toISOString())
    .limit(500);
  if (error) throw new Error('prior offense lookup failed: ' + error.message);
  const priors = (data || []).filter((p) => p.id !== violation.id
    && p.quality_status !== 'superseded'
    && p.current_stage !== 'voided'
    && p.resolved_via !== 'voided');
  return priors.length + 1;
}

// Fine queue status changes. Allowed moves only; posting is closed until the
// notice-and-hearing record exists.
const QUEUE_TRANSITIONS = {
  queued: ['reversed', 'error'],
  error: ['queued', 'reversed'],
  posted: ['reversed'],
  reversed: [],
};
const QUEUE_STATUSES = ['queued', 'posted', 'reversed', 'error'];

// Plans a PATCH to one fine_posting_queue row. Pure: returns either
// { ok: false, status, body } (the HTTP refusal) or { ok: true, patch, statusChange }.
// Who acted always comes from the signed-in user; body.user_id is ignored.
function planFineQueuePatch({ user, entry, body, now = new Date() }) {
  const b = body || {};
  if (!user) return { ok: false, status: 403, body: { error: 'sign_in_required', message: 'Sign in to change the fine queue.' } };
  if (!entry) return { ok: false, status: 404, body: { error: 'not_found', message: 'That fine queue entry was not found.' } };
  const approver = isFineApprover(user, entry.community_id);
  const patch = { updated_at: now.toISOString() };
  let statusChange = null;

  if (b.status !== undefined && b.status !== null && b.status !== '') {
    if (!QUEUE_STATUSES.includes(b.status)) {
      return { ok: false, status: 400, body: { error: 'invalid_status', message: 'That is not a valid fine queue status.' } };
    }
    if (b.status !== entry.status) {
      if (!approver) return { ok: false, status: 403, body: NOT_APPROVER };
      if (b.status === 'posted') {
        return { ok: false, status: 409, body: {
          error: 'notice_and_hearing_not_recorded',
          message: 'This fine cannot be posted. No fine may be posted to a homeowner account until the required notice and hearing are recorded, and trustEd does not record them yet. Nothing was charged.',
        } };
      }
      const allowed = QUEUE_TRANSITIONS[entry.status] || [];
      if (!allowed.includes(b.status)) {
        return { ok: false, status: 409, body: {
          error: 'illegal_transition',
          message: `A fine that is ${entry.status} cannot be changed to ${b.status}.`,
        } };
      }
      patch.status = b.status;
      statusChange = { from: entry.status, to: b.status };
    }
  }
  if (b.vantaca_charge_ref !== undefined) {
    if (!approver) return { ok: false, status: 403, body: NOT_APPROVER };
    patch.vantaca_charge_ref = b.vantaca_charge_ref ? String(b.vantaca_charge_ref).slice(0, 200) : null;
  }
  if (b.notes !== undefined) patch.notes = b.notes == null ? null : String(b.notes).slice(0, 4000);
  if (Object.keys(patch).length === 1) {
    return { ok: false, status: 400, body: { error: 'nothing_to_change', message: 'No change was sent.' } };
  }
  return { ok: true, patch, statusChange, actor_id: actorId(user) };
}

module.exports = {
  FINE_APPROVER_DELEGATES,
  NOT_APPROVER,
  QUEUE_TRANSITIONS,
  isFineApprover,
  checkFineAuthority,
  countOffenses,
  amountForOffense,
  planFineQueuePatch,
  actorId,
  actorName,
};
