// =============================================================================
// Portal Admin — manage portal users, invitations, scope
// =============================================================================
// Mounted at /api/portal-admin in server.js.
//
// Today's job (project_portal_release_gates.md): manage WHO will have portal
// access, define their scope (which communities for boards, which properties
// for homeowners), generate magic-link invites. Actual auth enforcement on
// the portals comes in a follow-up commit; until then the existing staff
// gate still protects the portals — these tables just hold the data the
// auth layer will use when it ships.
//
// Endpoints:
//   GET    /api/portal-admin/users                       list portal users (with scope counts)
//   POST   /api/portal-admin/users                       create + invite
//   PATCH  /api/portal-admin/users/:id                   edit name / notes / status
//   POST   /api/portal-admin/users/:id/revoke            mark revoked (preserves audit trail)
//   POST   /api/portal-admin/users/:id/magic-link        generate fresh magic link
//   GET    /api/portal-admin/users/:id/scope             list communities + properties this user can see
//   POST   /api/portal-admin/users/:id/grant-community   grant a community
//   POST   /api/portal-admin/users/:id/grant-property    grant a property
//   POST   /api/portal-admin/users/:id/revoke-community  revoke a community grant
//   POST   /api/portal-admin/users/:id/revoke-property   revoke a property grant
//   POST   /api/portal-admin/users/auto-grant-property   match-or-create user from contact, grant their property
// =============================================================================

const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const router = express.Router();
router.use(express.json({ limit: '256kb' }));

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

function magicLinkUrl(req, token) {
  // Construct an absolute URL the email can carry. Render terminates SSL at
  // the edge; respect x-forwarded-proto.
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.get('host');
  return `${proto}://${host}/portal-login.html?token=${token}`;
}

async function logAudit(action, opts = {}) {
  try {
    await supabase.from('portal_audit_log').insert({
      portal_user_id: opts.portal_user_id || null,
      action,
      resource_type: opts.resource_type || null,
      resource_id: opts.resource_id || null,
      ip_address: opts.ip_address || null,
      user_agent: opts.user_agent || null,
      performed_by: opts.performed_by || null,
      notes: opts.notes || null,
    });
  } catch (e) { /* audit failure is non-fatal */ }
}

// ----------------------------------------------------------------------------
// GET /api/portal-admin/users
// Query params: role (filter), status (filter), q (email/name search)
// ----------------------------------------------------------------------------
router.get('/users', async (req, res) => {
  try {
    let q = supabase
      .from('v_portal_users_summary')
      .select('*')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('invited_at', { ascending: false });

    if (req.query.role)   q = q.eq('role', req.query.role);
    if (req.query.status) q = q.eq('status', req.query.status);
    if (req.query.q) {
      const like = `%${String(req.query.q).replace(/[%_]/g, '')}%`;
      q = q.or(`email.ilike.${like},full_name.ilike.${like}`);
    }

    const { data, error } = await q;
    if (error) throw error;
    res.json({ users: data || [] });
  } catch (err) {
    console.error('[portal_admin] list users failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/portal-admin/users
// Body: { email, full_name?, role, community_ids?, property_ids?,
//         send_invite?, invited_by? }
//
// Creates the portal user, optionally grants initial scope, optionally
// generates + returns a magic link the operator can copy or email.
// ----------------------------------------------------------------------------
router.post('/users', async (req, res) => {
  try {
    const { email, full_name, role, community_ids, property_ids, send_invite, invited_by } = req.body || {};
    if (!email || !String(email).trim()) return res.status(400).json({ error: 'email is required' });
    if (!role) return res.status(400).json({ error: 'role is required' });
    const cleanEmail = String(email).toLowerCase().trim();

    // Idempotency: if a row already exists for this email, return it instead
    // of erroring out — operator can re-trigger invite link from there.
    const { data: existing } = await supabase
      .from('portal_users')
      .select('id')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('email', cleanEmail)
      .maybeSingle();

    let user;
    if (existing) {
      user = existing;
    } else {
      const insert = {
        management_company_id: BEDROCK_MGMT_CO_ID,
        email: cleanEmail,
        full_name: full_name && String(full_name).trim() || null,
        role,
        status: 'invited',
        invited_by: invited_by || null,
      };
      // If we know a contact with this email, link them
      const { data: contactMatch } = await supabase
        .from('contacts')
        .select('id')
        .eq('primary_email', cleanEmail)
        .maybeSingle();
      if (contactMatch && contactMatch.id) insert.contact_id = contactMatch.id;
      const { data: newUser, error: insErr } = await supabase
        .from('portal_users')
        .insert(insert)
        .select('id')
        .single();
      if (insErr) throw insErr;
      user = newUser;
      await logAudit('user_invited', { portal_user_id: user.id, performed_by: invited_by, notes: `role=${role}` });
    }

    // Grant initial scope
    if (Array.isArray(community_ids) && community_ids.length > 0) {
      const rows = community_ids.map((cid) => ({
        portal_user_id: user.id,
        community_id: cid,
        granted_by: invited_by || null,
      }));
      await supabase.from('portal_user_communities').upsert(rows, { onConflict: 'portal_user_id,community_id' });
    }
    if (Array.isArray(property_ids) && property_ids.length > 0) {
      const rows = property_ids.map((pid) => ({
        portal_user_id: user.id,
        property_id: pid,
        granted_by: invited_by || null,
      }));
      await supabase.from('portal_user_properties').upsert(rows, { onConflict: 'portal_user_id,property_id' });
    }

    // Generate magic link if requested
    let magicLink = null;
    if (send_invite) {
      const token = makeToken();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
      await supabase.from('portal_magic_links').insert({
        portal_user_id: user.id,
        token,
        purpose: 'invite',
        expires_at: expiresAt.toISOString(),
        created_by: invited_by || null,
      });
      magicLink = magicLinkUrl(req, token);
      await logAudit('magic_link_generated', { portal_user_id: user.id, performed_by: invited_by, notes: 'purpose=invite' });
    }

    res.json({ user_id: user.id, magic_link: magicLink });
  } catch (err) {
    console.error('[portal_admin] create user failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// PATCH /api/portal-admin/users/:id
// ----------------------------------------------------------------------------
router.patch('/users/:id', async (req, res) => {
  try {
    const allowed = ['full_name', 'notes', 'status', 'role'];
    const update = {};
    for (const k of allowed) if (k in (req.body || {})) update[k] = req.body[k];
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'no updatable fields' });

    const { data, error } = await supabase
      .from('portal_users')
      .update(update)
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .select()
      .single();
    if (error) throw error;
    res.json({ user: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/portal-admin/users/:id/revoke
// Marks the user revoked + revokes all active scope. Preserves the row
// for audit; doesn't delete history.
// ----------------------------------------------------------------------------
router.post('/users/:id/revoke', async (req, res) => {
  try {
    const revokedBy = (req.body && req.body.revoked_by) || null;
    const now = new Date().toISOString();

    await supabase
      .from('portal_users')
      .update({ status: 'revoked', revoked_at: now, revoked_by: revokedBy })
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);

    await supabase
      .from('portal_user_communities')
      .update({ revoked_at: now, revoked_by: revokedBy })
      .eq('portal_user_id', req.params.id)
      .is('revoked_at', null);

    await supabase
      .from('portal_user_properties')
      .update({ revoked_at: now, revoked_by: revokedBy })
      .eq('portal_user_id', req.params.id)
      .is('revoked_at', null);

    await logAudit('user_revoked', { portal_user_id: req.params.id, performed_by: revokedBy });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/portal-admin/users/:id/magic-link
// Generates a fresh magic link (invalidates any existing pending links).
// ----------------------------------------------------------------------------
router.post('/users/:id/magic-link', async (req, res) => {
  try {
    const purpose = (req.body && req.body.purpose) || 'login';
    const performedBy = (req.body && req.body.performed_by) || null;

    // Invalidate any unused pending links
    await supabase
      .from('portal_magic_links')
      .update({ used_at: new Date().toISOString(), used_user_agent: 'superseded_by_admin' })
      .eq('portal_user_id', req.params.id)
      .is('used_at', null);

    const token = makeToken();
    const ttlMs = purpose === 'invite' ? 7 * 24 * 60 * 60 * 1000 : 60 * 60 * 1000; // invite 7d, login 1h
    const expiresAt = new Date(Date.now() + ttlMs);
    await supabase.from('portal_magic_links').insert({
      portal_user_id: req.params.id,
      token,
      purpose,
      expires_at: expiresAt.toISOString(),
      created_by: performedBy,
    });
    await logAudit('magic_link_generated', { portal_user_id: req.params.id, performed_by: performedBy, notes: `purpose=${purpose}` });

    res.json({ token, magic_link: magicLinkUrl(req, token), expires_at: expiresAt.toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/portal-admin/users/:id/scope
// Returns: { communities: [...], properties: [...] }
// ----------------------------------------------------------------------------
router.get('/users/:id/scope', async (req, res) => {
  try {
    const { data: comms } = await supabase
      .from('portal_user_communities')
      .select('community_id, granted_at, revoked_at, communities:community_id(id, name)')
      .eq('portal_user_id', req.params.id);

    const { data: props } = await supabase
      .from('portal_user_properties')
      .select('property_id, granted_at, revoked_at, properties:property_id(id, street_address, unit, community_id, communities:community_id(name))')
      .eq('portal_user_id', req.params.id);

    res.json({
      communities: comms || [],
      properties: props || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/portal-admin/users/:id/grant-community
// Body: { community_id, granted_by? }
// ----------------------------------------------------------------------------
router.post('/users/:id/grant-community', async (req, res) => {
  try {
    const { community_id, granted_by } = req.body || {};
    if (!community_id) return res.status(400).json({ error: 'community_id required' });

    await supabase.from('portal_user_communities').upsert({
      portal_user_id: req.params.id,
      community_id,
      granted_by: granted_by || null,
      revoked_at: null,        // un-revoke if previously revoked
      revoked_by: null,
    }, { onConflict: 'portal_user_id,community_id' });

    await logAudit('community_granted', {
      portal_user_id: req.params.id,
      resource_type: 'community',
      resource_id: community_id,
      performed_by: granted_by,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/portal-admin/users/:id/revoke-community
// ----------------------------------------------------------------------------
router.post('/users/:id/revoke-community', async (req, res) => {
  try {
    const { community_id, revoked_by } = req.body || {};
    if (!community_id) return res.status(400).json({ error: 'community_id required' });

    await supabase
      .from('portal_user_communities')
      .update({ revoked_at: new Date().toISOString(), revoked_by: revoked_by || null })
      .eq('portal_user_id', req.params.id)
      .eq('community_id', community_id);

    await logAudit('community_revoked', {
      portal_user_id: req.params.id,
      resource_type: 'community',
      resource_id: community_id,
      performed_by: revoked_by,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/portal-admin/users/:id/grant-property
// ----------------------------------------------------------------------------
router.post('/users/:id/grant-property', async (req, res) => {
  try {
    const { property_id, granted_by } = req.body || {};
    if (!property_id) return res.status(400).json({ error: 'property_id required' });

    await supabase.from('portal_user_properties').upsert({
      portal_user_id: req.params.id,
      property_id,
      granted_by: granted_by || null,
      revoked_at: null,
      revoked_by: null,
    }, { onConflict: 'portal_user_id,property_id' });

    await logAudit('property_granted', {
      portal_user_id: req.params.id,
      resource_type: 'property',
      resource_id: property_id,
      performed_by: granted_by,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/portal-admin/users/:id/revoke-property
// ----------------------------------------------------------------------------
router.post('/users/:id/revoke-property', async (req, res) => {
  try {
    const { property_id, revoked_by } = req.body || {};
    if (!property_id) return res.status(400).json({ error: 'property_id required' });

    await supabase
      .from('portal_user_properties')
      .update({ revoked_at: new Date().toISOString(), revoked_by: revoked_by || null })
      .eq('portal_user_id', req.params.id)
      .eq('property_id', property_id);

    await logAudit('property_revoked', {
      portal_user_id: req.params.id,
      resource_type: 'property',
      resource_id: property_id,
      performed_by: revoked_by,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
