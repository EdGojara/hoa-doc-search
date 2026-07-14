// ============================================================================
// /api/users — team management endpoints (admin-only)
// ----------------------------------------------------------------------------
// Lets Ed see and manage the Bedrock team's access without writing SQL.
//
// Routes:
//   GET   /api/users          → list all user_profiles
//   PATCH /api/users/:id      → update role and/or is_active
//
// All routes require the requester's user_profiles.role = 'admin'. The
// resolveUserRole helper in server.js does this from the Authorization
// Bearer JWT. Without admin role we 403.
//
// Future:
//   POST /api/users/invite    → send an invite email (deferred — for now
//                                Ed shares the /login.html link manually)
//   PATCH /api/users/:id with permissions JSONB for fine-grained gating
// ============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

const VALID_ROLES = new Set(['admin', 'staff', 'assistant']);

// Resolve the requester's role from the Authorization Bearer JWT. Duplicated
// from server.js because /api/users is mounted before the helper is defined,
// and we want this module to be self-contained.
async function resolveUserRole(req) {
  try {
    const auth = req.headers && req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return { role: 'unknown', user: null };
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return { role: 'unknown', user: null };
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('id, role, email')
      .eq('id', user.id)
      .maybeSingle();
    return { role: profile?.role || 'staff', user: profile, supabaseUserId: user.id };
  } catch (_) {
    return { role: 'unknown', user: null };
  }
}

async function requireAdmin(req, res) {
  const ctx = await resolveUserRole(req);
  if (ctx.role !== 'admin') {
    res.status(403).json({ error: 'admin role required' });
    return null;
  }
  return ctx;
}

// ----------------------------------------------------------------------------
// requireStaff — for endpoints staff (Karla, Laurie, anyone authenticated)
// can use as part of their normal workflow. Use this when the endpoint
// represents day-to-day work, NOT a setup / configuration / destructive
// action. Allows role='admin' OR role='staff'. Blocks role='assistant'
// (read-only tier) and unauthenticated.
//
// Ed 2026-06-16 audit class: previously misused requireAdmin on workflow
// endpoints like /api/builder-applications/upload-on-behalf, which is
// literally how Karla submits builder packets that came via email. The
// admin gate blocked the people the endpoint was designed for.
// ----------------------------------------------------------------------------
async function requireStaff(req, res) {
  const ctx = await resolveUserRole(req);
  if (ctx.role !== 'admin' && ctx.role !== 'staff') {
    res.status(403).json({ error: 'staff role required' });
    return null;
  }
  return ctx;
}

// ----------------------------------------------------------------------------
// GET /api/users  — list all team members
// ----------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('id, email, full_name, role, is_active, last_sign_in_at, created_at, updated_at')
      .order('role', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({
      users: data || [],
      onboarding: {
        signin_url: '/login.html',
        instructions: [
          'Send the team member the sign-in URL.',
          'They sign in with their Microsoft 365 account (egojara@bedrocktx.com domain or whatever email you have on file).',
          'A user_profiles row is auto-created with role=staff.',
          'Come back to this page and change their role to admin or assistant if needed.',
          'When you want to revoke access, deactivate them here. Their Microsoft sign-in will still work but the app will refuse them.',
        ],
      },
    });
  } catch (err) {
    console.error('[users] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// PATCH /api/users/me/preferences — self-service preference update.
// Lets each user update their own preferences JSONB without needing admin.
// REGISTERED BEFORE /:id so 'me' is matched as a literal, not a UUID.
//
// Body: { home_tiles: ['inspect', 'drafts', ...] }
//   home_tiles array is whitelist-validated against HOME_TILE_CATALOG. Anything
//   not in the catalog is silently dropped so a tampered client can't inject
//   arbitrary keys that later get rendered as fetch targets.
//
// Returns: { preferences: <merged final state> }
// ----------------------------------------------------------------------------

// Canonical catalog of allowed home_tiles keys. Mirrors the frontend HOME_TILE_CATALOG.
// Keep in sync; any new tile must be added here AND on the frontend.
const HOME_TILE_CATALOG = new Set([
  'asked', 'inspect', 'drafts', 'mail_queue', 'manual_violation',
  'builder_arc', 'acc', 'owner_ar', 'docs', 'meetings', 'events',
  'vendor', 'community_profile', 'bedrock_office', 'forms_applications',
  'financial', 'board_packets', 'calendar', 'performance', 'quick',
  'accounting', 'home_sales',
  // Modules added 2026-07-14 so staff can pin any tool to home.
  'payables', 'collections', 'payment_plans', 'bank_setup', 'statement_tracker',
  'communications', 'lookup', 'homeowner_360', 'status', 'pool_access',
  'mail_scan', 'intake', 'blast',
]);

router.patch('/me/preferences', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const ctx = await resolveUserRole(req);
    if (!ctx.supabaseUserId) return res.status(401).json({ error: 'authentication required' });
    if (ctx.user && ctx.user.is_active === false) return res.status(403).json({ error: 'account deactivated' });

    const body = req.body || {};
    const prefsPatch = {};

    if (Array.isArray(body.home_tiles)) {
      // Whitelist filter + de-dupe + cap at 24 tiles (so a buggy client
      // can't push a 1000-tile array that bloats every /api/me response).
      const seen = new Set();
      const filtered = [];
      for (const k of body.home_tiles) {
        if (typeof k !== 'string') continue;
        if (!HOME_TILE_CATALOG.has(k)) continue;
        if (seen.has(k)) continue;
        seen.add(k);
        filtered.push(k);
        if (filtered.length >= 24) break;
      }
      prefsPatch.home_tiles = filtered;
    }

    if (Object.keys(prefsPatch).length === 0) {
      return res.status(400).json({ error: 'no recognized preferences provided' });
    }

    // Merge with existing preferences so we don't blow away other keys
    const { data: existing } = await supabase
      .from('user_profiles')
      .select('preferences')
      .eq('id', ctx.supabaseUserId)
      .maybeSingle();
    const currentPrefs = (existing && existing.preferences) || {};
    const newPrefs = { ...currentPrefs, ...prefsPatch };

    const { error: updErr } = await supabase
      .from('user_profiles')
      .update({ preferences: newPrefs, updated_at: new Date().toISOString() })
      .eq('id', ctx.supabaseUserId);
    if (updErr) {
      console.error('[users.me.preferences] update failed:', updErr.message);
      return res.status(500).json({ error: safeErrorMessage(updErr) });
    }

    res.json({ preferences: newPrefs });
  } catch (err) {
    console.error('[users.me.preferences]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// PATCH /api/users/:id  — change role and/or active status
// ----------------------------------------------------------------------------
router.patch('/:id', express.json({ limit: '32kb' }), async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  try {
    const body = req.body || {};
    const patch = {};
    if (body.role !== undefined) {
      if (!VALID_ROLES.has(body.role)) {
        return res.status(400).json({ error: `role must be one of: ${[...VALID_ROLES].join(', ')}` });
      }
      patch.role = body.role;
    }
    if (body.is_active !== undefined) {
      patch.is_active = !!body.is_active;
    }
    if (body.full_name !== undefined) {
      patch.full_name = String(body.full_name || '').slice(0, 200) || null;
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'no updatable fields provided' });
    }
    patch.updated_at = new Date().toISOString();

    // Safety guards on role/active changes:
    // 1) Don't let admin demote themselves — lockout risk.
    // 2) Don't let the LAST admin be demoted or deactivated — locks the
    //    company out of user management.
    if (ctx.supabaseUserId === req.params.id) {
      if (patch.role && patch.role !== 'admin') {
        return res.status(400).json({ error: 'You cannot demote yourself from admin. Have another admin do it.' });
      }
      if (patch.is_active === false) {
        return res.status(400).json({ error: 'You cannot deactivate yourself.' });
      }
    }
    if (patch.role && patch.role !== 'admin') {
      const { count: otherAdmins } = await supabase
        .from('user_profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'admin')
        .eq('is_active', true)
        .neq('id', req.params.id);
      if ((otherAdmins || 0) === 0) {
        return res.status(400).json({ error: 'This is the last active admin. Promote someone else to admin first.' });
      }
    }
    if (patch.is_active === false) {
      const { data: existing } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', req.params.id)
        .maybeSingle();
      if (existing?.role === 'admin') {
        const { count: otherAdmins } = await supabase
          .from('user_profiles')
          .select('id', { count: 'exact', head: true })
          .eq('role', 'admin')
          .eq('is_active', true)
          .neq('id', req.params.id);
        if ((otherAdmins || 0) === 0) {
          return res.status(400).json({ error: 'This is the last active admin. Promote someone else to admin first.' });
        }
      }
    }

    const { data, error } = await supabase
      .from('user_profiles')
      .update(patch)
      .eq('id', req.params.id)
      .select('id, email, full_name, role, is_active, last_sign_in_at, created_at, updated_at')
      .single();
    if (error) throw error;
    res.json({ user: data });
  } catch (err) {
    console.error('[users] patch failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router, resolveUserRole, requireAdmin, requireStaff };
