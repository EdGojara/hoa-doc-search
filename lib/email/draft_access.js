// ============================================================================
// lib/email/draft_access.js  (Ed 2026-10-16)
// ----------------------------------------------------------------------------
// Who may act on an outbound email draft (outbound_email_drafts) and on the
// Mission Control task that tracks a compose draft. ONE rule, checked
// server-side by every route that reads, edits, approves, sends, discards,
// redrafts or forwards a draft. Hiding a button is never the control.
//
// Ownership (stored on the row):
//   owner_user_id  the signed-in person who started the draft (migration 533).
//                  Stamped by the New Email window and by Amanda's email desk.
//   persona        the AI teammate it sends as: the responsible agent. Its
//                  Mission Control task is on that agent's list.
//   A draft with no owner_user_id was started by automation (an agent working
//   from intake, an ACC decision, a receipt) with no human starter.
//
// Who may act:
//   owner     (role admin AND OWNER_EMAIL)  every draft, including Tessa's.
//   admin     (role admin)                  every draft EXCEPT owner-only
//                                           personas (Tessa is Ed's private EA).
//   staff     (any other active user)       only drafts whose owner_user_id is
//                                           their own. Automation drafts (no
//                                           human starter) and other people's
//                                           drafts are refused (403).
//   signed out                              nothing (403 sign_in_required).
// There is no per-draft sharing yet; "explicitly authorized" today means the
// admin role. Roles come from api/_require_admin (user_profiles.role).
// ============================================================================
'use strict';

const roster = require('../team/roster');

function ownerEmail() { return (process.env.OWNER_EMAIL || 'egojara@bedrocktx.com').toLowerCase(); }
function isOwner(u) { return !!u && u.role === 'admin' && String(u.email || '').toLowerCase() === ownerEmail(); }
function isAdmin(u) { return !!u && u.role === 'admin'; }
function userId(u) { return (u && u.user && u.user.id) || null; }
function ownerOnlyPersona(p) { const m = roster.get(String(p || '').toLowerCase()); return !!(m && m.owner_only); }

/**
 * Decide one action on one draft. Returns { allowed, status, error, detail }.
 * `action` is for the message and the log only; every action uses the same rule.
 */
function decide(u, draft, action = 'act on') {
  if (!u) return { allowed: false, status: 403, error: 'sign_in_required', detail: 'Sign in to work with drafts.' };
  if (!draft) return { allowed: false, status: 404, error: 'not_found', detail: 'That draft was not found.' };
  if (ownerOnlyPersona(draft.persona)) {
    return isOwner(u) ? { allowed: true } : { allowed: false, status: 403, error: 'draft_forbidden', detail: 'This draft is in the owner’s private outbox.' };
  }
  if (isAdmin(u)) return { allowed: true };
  const me = userId(u);
  if (me && draft.owner_user_id && draft.owner_user_id === me) return { allowed: true };
  return { allowed: false, status: 403, error: 'draft_forbidden',
    detail: `You can only ${action} drafts you started. Ask the owner or an admin.` };
}

/** Route helper: sends the 403/404 and returns false when not allowed. */
function guard(req, res, u, draft, action) {
  const d = decide(u, draft, action);
  if (d.allowed) return true;
  console.warn('[draft_access] refused', JSON.stringify({ action, draft_id: draft && draft.id, user: u && u.email, role: u && u.role, error: d.error }));
  res.status(d.status).json({ error: d.error, detail: d.detail });
  return false;
}

/** May this user give a draft to `persona`? (Moving a draft into Tessa's outbox is owner-only.) */
function canUsePersona(u, persona) { return !ownerOnlyPersona(persona) || isOwner(u); }

/**
 * Narrow a list query to what this user may see. Applied to the query so a
 * staff user's list is filtered in the database, not after the fact.
 */
function scopeListQuery(q, u) {
  // persona <> 'tessa' alone would also drop rows with no persona (NULL), so say both.
  if (!isOwner(u)) q = q.or('persona.is.null,persona.neq.tessa');
  if (isAdmin(u)) return q;
  const me = userId(u);
  return me ? q.eq('owner_user_id', me) : q.eq('id', '00000000-0000-0000-0000-000000000000');
}

module.exports = { decide, guard, canUsePersona, scopeListQuery, isOwner, isAdmin, userId, ownerOnlyPersona };
