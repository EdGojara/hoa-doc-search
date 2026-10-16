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
//   AUTONOMOUS draft: created by an AI agent with no human starter
//                  (owner_user_id IS NULL) and not one of the human-started
//                  kinds (HUMAN_KINDS: the New Email window and Amanda's desk).
//                  The kind check keeps a human draft saved before migration 533
//                  (owner not yet stamped) from passing as autonomous.
//
// Who may act (Ed 2026-10-16, decided):
//   owner (Ed)  role admin AND OWNER_EMAIL  every draft, including Tessa's.
//   admin       role admin                  every draft EXCEPT owner-only
//                                           personas (Tessa is Ed's private EA).
//   staff       any other active user       drafts they personally started AND
//                                           autonomous AI-agent drafts. Never a
//                                           draft another person started.
//   Tessa (owner-only persona) drafts are Ed-only even with no owner_user_id:
//   the persona check runs BEFORE the autonomous rule.
//   signed out                              nothing (403 sign_in_required).
// The same rule covers open, edit, approve/send, discard, redraft and forward.
// Roles come from api/_require_admin (user_profiles.role).
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
const HUMAN_KINDS = ['compose', 'amanda_console', 'amanda_reply'];

/** No human starter: owner_user_id is null AND the kind is not a human-started one. */
function isAutonomous(draft) {
  if (!draft || draft.owner_user_id) return false;
  return !HUMAN_KINDS.includes(String(draft.draft_kind || ''));
}

function decide(u, draft, action = 'act on') {
  if (!u) return { allowed: false, status: 403, error: 'sign_in_required', detail: 'Sign in to work with drafts.' };
  if (!draft) return { allowed: false, status: 404, error: 'not_found', detail: 'That draft was not found.' };
  if (ownerOnlyPersona(draft.persona)) {
    return isOwner(u) ? { allowed: true } : { allowed: false, status: 403, error: 'draft_forbidden', detail: 'This draft is in the owner’s private outbox.' };
  }
  if (isAdmin(u)) return { allowed: true };
  const me = userId(u);
  if (me && draft.owner_user_id && draft.owner_user_id === me) return { allowed: true };
  if (isAutonomous(draft)) return { allowed: true };
  return { allowed: false, status: 403, error: 'draft_forbidden',
    detail: `You can only ${action} drafts you started or drafts an AI teammate prepared. This one was started by someone else; ask them or an admin.` };
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
 * Narrow a list query to what this user may see, in ONE .or() filter (two
 * .or() calls on one PostgREST query are not reliable). Filtered in the
 * database, not after the fact. ownerColumn:false is the pre-533 fallback
 * (autonomous drafts only, for staff).
 */
const NOT_TESSA = 'or(persona.is.null,persona.neq.tessa)';
function scopeListQuery(q, u, { ownerColumn = true } = {}) {
  if (isOwner(u)) return q;
  if (isAdmin(u)) return q.or('persona.is.null,persona.neq.tessa');
  const me = userId(u);
  const autonomous = `and(${ownerColumn ? 'owner_user_id.is.null,' : ''}draft_kind.not.in.(${HUMAN_KINDS.join(',')}),${NOT_TESSA})`;
  const mine = me && ownerColumn ? `and(owner_user_id.eq.${me},${NOT_TESSA}),` : '';
  return q.or(mine + autonomous);
}

module.exports = { HUMAN_KINDS, isAutonomous, decide, guard, canUsePersona, scopeListQuery, isOwner, isAdmin, userId, ownerOnlyPersona };
