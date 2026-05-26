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

module.exports = { router };
