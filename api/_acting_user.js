// ============================================================================
// api/_acting_user.js
// ----------------------------------------------------------------------------
// Shared helper for capturing "who took this action" from the Supabase JWT.
// Returns { id, email, full_name, role, is_active } when the request has a
// valid Bearer token + an active user_profiles row, or null otherwise.
//
// This is the single source of truth for actor attribution across every
// action endpoint (ACC finalize, violation open, builder approve, AR
// adjust, etc.). The pattern:
//
//   const actor = await getActingUser(req);
//   if (!actor || actor.is_active === false) {
//     return res.status(401).json({ error: 'not_authenticated' });
//   }
//   // ...do the work, then stamp actor.id on the insert/update
//   await supabase.from('foo').insert({ ..., acted_by_user_id: actor.id });
//
// Until every action endpoint uses this helper, audit attribution is
// only partial. Migrate one endpoint at a time and verify each writes
// the FK before moving on.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function getActingUser(req) {
  try {
    const auth = req.headers && req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return null;
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('id, email, full_name, role, is_active')
      .eq('id', user.id)
      .maybeSingle();
    if (!profile) return null;
    return profile;
  } catch (_) {
    return null;
  }
}

// Convenience: return actor info or a 401 response. Use as:
//   const actor = await requireActingUser(req, res);
//   if (!actor) return; // 401 already sent
async function requireActingUser(req, res) {
  const actor = await getActingUser(req);
  if (!actor) {
    res.status(401).json({ error: 'authentication required' });
    return null;
  }
  if (actor.is_active === false) {
    res.status(403).json({ error: 'account_inactive' });
    return null;
  }
  return actor;
}

// Display name for letter signatures, response history, etc. Falls back
// gracefully through full_name → email local-part → "Bedrock staff".
function actorDisplayName(actor) {
  if (!actor) return 'Bedrock staff';
  if (actor.full_name && actor.full_name.trim()) return actor.full_name.trim();
  if (actor.email) {
    const local = String(actor.email).split('@')[0];
    if (local) return local;
  }
  return 'Bedrock staff';
}

module.exports = { getActingUser, requireActingUser, actorDisplayName };
