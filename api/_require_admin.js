// ============================================================================
// api/_require_admin.js  (Ed 2026-07-07)
// ----------------------------------------------------------------------------
// Per-user gate for admin-only endpoints. The staff HMAC cookie only proves
// "some staffer" — it does NOT identify WHICH user. To restrict a feature to
// the owner (Ed), we verify the Supabase JWT (Authorization: Bearer) and check
// the user_profiles.role. Ed is the sole 'admin'; everyone else is 'staff'.
//
//   const { requireAdmin } = require('./_require_admin');
//   const admin = await requireAdmin(req, res); if (!admin) return; // 403 sent
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Verify the Bearer JWT and load the profile. Returns { user, role, full_name,
// email } or null (no/invalid token, no profile, or deactivated).
async function getAuthedUser(req) {
  try {
    const auth = (req.headers && req.headers.authorization) || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return null;
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('role, is_active, full_name, email')
      .eq('id', user.id)
      .maybeSingle();
    if (!profile || profile.is_active === false) return null;
    return { user, role: profile.role || 'staff', full_name: profile.full_name, email: profile.email || user.email };
  } catch (_) {
    return null;
  }
}

// Gate helper: sends a 403 and returns null when the caller isn't an active
// admin; otherwise returns the authed user object.
async function requireAdmin(req, res) {
  const u = await getAuthedUser(req);
  if (!u || u.role !== 'admin') {
    res.status(403).json({ error: 'admin_only', detail: 'This feature is limited to the account owner.' });
    return null;
  }
  return u;
}

module.exports = { getAuthedUser, requireAdmin };
