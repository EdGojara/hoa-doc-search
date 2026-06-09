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
const { sendEmail } = require('../lib/notifications/email');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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

// ============================================================================
// GET /api/portal-admin/community/:communityId/module-config
// ----------------------------------------------------------------------------
// Returns the current per-tile visibility config for a community plus the
// community-wide kill switch (portal_active). Used by the admin Tile
// Visibility panel to render the per-tile dropdowns.
//
// Response shape:
//   {
//     community: { id, name, slug, portal_active, portal_welcome_message },
//     module_config: { <module_key>: { status: 'live'|'coming_soon'|'hidden'|'maintenance',
//                                       notes?: <string>, link?: <override-url> } }
//   }
//
// The canonical list of available module keys lives in public/portal.html
// (MODULES array) — this endpoint just returns what's currently stored. The
// admin UI is responsible for showing tiles that exist in the canonical list
// but are missing from the config (treated as 'coming_soon' by default at
// render time).
// ============================================================================
router.get('/community/:communityId/module-config', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('communities')
      .select('id, name, slug, portal_active, portal_module_config, portal_welcome_message')
      .eq('id', req.params.communityId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'community_not_found' });
    res.json({
      community: {
        id: data.id,
        name: data.name,
        slug: data.slug,
        portal_active: data.portal_active === true,
        portal_welcome_message: data.portal_welcome_message || '',
      },
      module_config: data.portal_module_config || {},
    });
  } catch (err) {
    console.error('[portal_admin] get module-config failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PATCH /api/portal-admin/community/:communityId/module-config
// ----------------------------------------------------------------------------
// Body:
//   {
//     module_config?: { <key>: { status, notes?, link? } },   // FULL replace
//     module_patch?:  { <key>: { status, notes?, link? } },   // MERGE
//     portal_active?:  bool,                                  // kill switch
//     portal_welcome_message?: <string>,                      // banner copy
//     updated_by?: <staff label>
//   }
//
// Pick one of module_config (full replace) OR module_patch (merge into
// existing). The admin UI uses module_patch for per-tile toggles so a single
// tile change doesn't risk overwriting other tiles set in a parallel tab.
//
// Status validation: only allows the four canonical states. Anything else
// rejected with 400.
// ============================================================================
const ALLOWED_TILE_STATUSES = ['live', 'coming_soon', 'hidden', 'maintenance'];

router.patch('/community/:communityId/module-config', async (req, res) => {
  try {
    const communityId = req.params.communityId;
    const body = req.body || {};
    const { module_config, module_patch, portal_active, portal_welcome_message, updated_by } = body;

    // Validate status values in either shape
    const validateCfg = (cfg) => {
      if (!cfg || typeof cfg !== 'object') return null;
      for (const key of Object.keys(cfg)) {
        const v = cfg[key];
        if (!v || typeof v !== 'object') return `invalid value for ${key}`;
        if (v.status && !ALLOWED_TILE_STATUSES.includes(v.status)) {
          return `invalid status "${v.status}" for ${key} (allowed: ${ALLOWED_TILE_STATUSES.join(', ')})`;
        }
      }
      return null;
    };
    const cfgErr = validateCfg(module_config) || validateCfg(module_patch);
    if (cfgErr) return res.status(400).json({ error: cfgErr });

    // Fetch current row (needed for merge OR for diff logging)
    const { data: current } = await supabase
      .from('communities')
      .select('id, portal_module_config, portal_active, portal_welcome_message')
      .eq('id', communityId)
      .maybeSingle();
    if (!current) return res.status(404).json({ error: 'community_not_found' });

    const update = {};
    let newCfg = null;
    if (module_config) {
      newCfg = module_config; // full replace
    } else if (module_patch) {
      newCfg = { ...(current.portal_module_config || {}) };
      // Per-key merge: shallow assign on each tile key so existing tiles not in
      // the patch keep their settings.
      for (const k of Object.keys(module_patch)) {
        newCfg[k] = { ...(newCfg[k] || {}), ...(module_patch[k] || {}) };
      }
    }
    if (newCfg) update.portal_module_config = newCfg;
    if (typeof portal_active === 'boolean') update.portal_active = portal_active;
    if (typeof portal_welcome_message === 'string') update.portal_welcome_message = portal_welcome_message;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'nothing_to_update' });
    }

    const { error: upErr } = await supabase
      .from('communities')
      .update(update)
      .eq('id', communityId);
    if (upErr) throw upErr;

    // Audit log — note this isn't tied to a specific portal_user (community-
    // level admin action), so portal_user_id is null. Notes string summarizes
    // what changed for forensic readability.
    const changedFields = [];
    if (newCfg) changedFields.push('module_config');
    if (typeof portal_active === 'boolean') changedFields.push(`portal_active=${portal_active}`);
    if (typeof portal_welcome_message === 'string') changedFields.push('welcome_message');
    await logAudit('community_portal_config_changed', {
      resource_type: 'community',
      resource_id: communityId,
      performed_by: updated_by || null,
      notes: changedFields.join('; '),
    });

    res.json({
      ok: true,
      community_id: communityId,
      module_config: newCfg || current.portal_module_config || {},
      portal_active: ('portal_active' in update) ? update.portal_active : current.portal_active,
    });
  } catch (err) {
    console.error('[portal_admin] patch module-config failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GET /api/portal-admin/communities
// ----------------------------------------------------------------------------
// Lightweight list of communities for the admin UI dropdowns. Returns
// id + name + slug + a count of properties (helps operator pick a target
// for bulk-invite). Hard cap at 500 — Bedrock has 7 today, would never
// approach the cap.
// ============================================================================
// ACC committee + workflow admin (Phase 1C — Ed 2026-06-09)
// ----------------------------------------------------------------------------
// PATCH  /api/portal-admin/community/:cid/arc-workflow  — set workflow + min approvals
// GET    /api/portal-admin/community/:cid/arc-committee — list committee members
// POST   /api/portal-admin/community/:cid/arc-committee — add a member
// DELETE /api/portal-admin/community/:cid/arc-committee/:memberId — remove
// ============================================================================
const ARC_WORKFLOWS = ['bedrock_only', 'acc_majority', 'acc_unanimous'];

router.patch('/community/:cid/arc-workflow', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.workflow && !ARC_WORKFLOWS.includes(b.workflow)) {
      return res.status(400).json({ error: 'invalid_workflow', allowed: ARC_WORKFLOWS });
    }
    const patch = {};
    if (b.workflow) patch.arc_approval_workflow = b.workflow;
    if (typeof b.min_approvals === 'number' && b.min_approvals >= 0) patch.arc_acc_min_approvals = b.min_approvals;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'nothing_to_update' });
    const { error } = await supabase.from('communities').update(patch).eq('id', req.params.cid);
    if (error) throw error;
    res.json({ ok: true, ...patch });
  } catch (err) {
    console.error('[portal_admin] arc-workflow patch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/community/:cid/arc-committee', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('community_arc_committee')
      .select(`
        id, contact_id, position_title, is_chair, is_active,
        term_starts_at, term_ends_at, added_at, notes,
        contact:contact_id (full_name, primary_email, primary_phone)
      `)
      .eq('community_id', req.params.cid)
      .is('removed_at', null)
      .order('is_chair', { ascending: false });
    if (error) throw error;
    res.json({ committee: data || [] });
  } catch (err) {
    console.error('[portal_admin] arc-committee list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/community/:cid/arc-committee', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.contact_id) return res.status(400).json({ error: 'contact_id_required' });
    const { error } = await supabase.from('community_arc_committee').insert({
      community_id: req.params.cid,
      contact_id: b.contact_id,
      position_title: b.position_title || null,
      is_chair: !!b.is_chair,
      term_starts_at: b.term_starts_at || null,
      term_ends_at: b.term_ends_at || null,
      added_by: b.added_by || 'admin_ui',
      notes: b.notes || null,
    });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[portal_admin] arc-committee add failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/community/:cid/arc-committee/:memberId', async (req, res) => {
  try {
    const b = req.body || {};
    const { error } = await supabase
      .from('community_arc_committee')
      .update({ removed_at: new Date().toISOString(), removed_by: b.removed_by || 'admin_ui', is_active: false })
      .eq('id', req.params.memberId)
      .eq('community_id', req.params.cid);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[portal_admin] arc-committee remove failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
router.get('/communities', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('communities')
      .select('id, name, slug, portal_active, portal_module_config')
      .order('name', { ascending: true })
      .limit(500);
    if (error) throw error;
    res.json({ communities: data || [] });
  } catch (err) {
    console.error('[portal_admin] list communities failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GET /api/portal-admin/community/:communityId/adoption
// ----------------------------------------------------------------------------
// Returns the per-community portal-adoption funnel + per-contact status table.
// This is the operational view that lets Bedrock staff actually ROLL OUT the
// portal to a whole community at once instead of inviting one homeowner at
// a time via the create-user POST.
//
// Response shape:
//   {
//     community: { id, name, slug },
//     summary: {
//       total_contacts: <int>,
//       with_email:     <int>,   // contacts that CAN be invited
//       invited:        <int>,   // portal_users created for any of them
//       logged_in_ever: <int>,   // portal_users.first_login_at IS NOT NULL
//       active_30d:     <int>,   // portal_users.last_login_at within 30d
//     },
//     contacts: [
//       { contact_id, name, email, property_id, property_address,
//         portal_user_id, portal_status, invited_at, first_login_at,
//         last_login_at, login_count }
//     ]
//   }
//
// Notes:
//   - "Current" residency = property_residencies.end_date IS NULL.
//   - Contacts WITHOUT a current residency in this community are excluded —
//     we don't show ex-owners on a current-adoption view. (They're still in
//     the audit trail via portal_audit_log if they ever had access.)
//   - Hard-capped at 2000 rows for safety. At scale-50 communities with 1000+
//     doors, pagination becomes worth adding. Today's largest community is
//     ~250 doors so we're nowhere near the cap.
// ============================================================================
router.get('/community/:communityId/adoption', async (req, res) => {
  try {
    const communityId = req.params.communityId;
    if (!communityId) return res.status(400).json({ error: 'community_id_required' });

    // Verify community exists
    const { data: community, error: cErr } = await supabase
      .from('communities')
      .select('id, name, slug')
      .eq('id', communityId)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!community) return res.status(404).json({ error: 'community_not_found' });

    // Step 1: properties in this community
    const { data: properties } = await supabase
      .from('properties')
      .select('id, street_address')
      .eq('community_id', communityId)
      .limit(2000);
    const propertyIds = (properties || []).map((p) => p.id);
    const propertyById = Object.fromEntries((properties || []).map((p) => [p.id, p]));
    if (propertyIds.length === 0) {
      return res.json({
        community,
        summary: { total_contacts: 0, with_email: 0, invited: 0, logged_in_ever: 0, active_30d: 0 },
        contacts: [],
      });
    }

    // Step 2: current residencies (one row per resident on a property)
    const { data: residencies } = await supabase
      .from('property_residencies')
      .select('contact_id, property_id, residency_type')
      .in('property_id', propertyIds)
      .is('end_date', null)
      .limit(2000);
    const contactIds = Array.from(new Set((residencies || []).map((r) => r.contact_id).filter(Boolean)));

    // Step 3: contact details (only for current residents we just found)
    const { data: contacts } = contactIds.length
      ? await supabase
          .from('contacts')
          .select('id, full_name, preferred_name, primary_email')
          .in('id', contactIds)
          .limit(2000)
      : { data: [] };
    const contactById = Object.fromEntries((contacts || []).map((c) => [c.id, c]));

    // Step 4: portal_users for these contacts (matched by contact_id OR email)
    const emails = Array.from(new Set(
      (contacts || []).map((c) => (c.primary_email || '').toLowerCase().trim()).filter(Boolean)
    ));
    const { data: pUsersByContact } = contactIds.length
      ? await supabase
          .from('portal_users')
          .select('id, email, contact_id, status, invited_at, first_login_at, last_login_at, login_count')
          .eq('management_company_id', BEDROCK_MGMT_CO_ID)
          .in('contact_id', contactIds)
          .limit(2000)
      : { data: [] };
    const { data: pUsersByEmail } = emails.length
      ? await supabase
          .from('portal_users')
          .select('id, email, contact_id, status, invited_at, first_login_at, last_login_at, login_count')
          .eq('management_company_id', BEDROCK_MGMT_CO_ID)
          .in('email', emails)
          .limit(2000)
      : { data: [] };
    // Merge both lookups by id, contact_id-first wins (more specific match)
    const portalUserByContactId = {};
    const portalUserByEmail = {};
    for (const u of (pUsersByContact || [])) {
      if (u.contact_id) portalUserByContactId[u.contact_id] = u;
      if (u.email) portalUserByEmail[u.email.toLowerCase()] = u;
    }
    for (const u of (pUsersByEmail || [])) {
      if (u.email && !portalUserByEmail[u.email.toLowerCase()]) {
        portalUserByEmail[u.email.toLowerCase()] = u;
      }
    }

    // Step 5: assemble per-contact rows + summary stats
    const now = Date.now();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    let with_email = 0;
    let invited = 0;
    let logged_in_ever = 0;
    let active_30d = 0;

    const rows = (residencies || []).map((r) => {
      const c = contactById[r.contact_id];
      if (!c) return null; // contact deleted, residency stale
      const email = (c.primary_email || '').toLowerCase().trim();
      const property = propertyById[r.property_id] || {};
      const u = portalUserByContactId[c.id] || (email ? portalUserByEmail[email] : null);

      if (email) with_email++;
      if (u) {
        invited++;
        if (u.first_login_at) logged_in_ever++;
        if (u.last_login_at && (now - new Date(u.last_login_at).getTime()) <= THIRTY_DAYS_MS) {
          active_30d++;
        }
      }

      return {
        contact_id: c.id,
        name: c.preferred_name || c.full_name || '',
        email: c.primary_email || '',
        residency_type: r.residency_type || null,
        property_id: r.property_id,
        property_address: property.street_address || '',
        portal_user_id: u ? u.id : null,
        portal_status: u ? u.status : null,
        invited_at: u ? u.invited_at : null,
        first_login_at: u ? u.first_login_at : null,
        last_login_at: u ? u.last_login_at : null,
        login_count: u ? (u.login_count || 0) : 0,
      };
    }).filter(Boolean);

    res.json({
      community,
      summary: {
        total_contacts: rows.length,
        with_email,
        invited,
        logged_in_ever,
        active_30d,
      },
      contacts: rows,
    });
  } catch (err) {
    console.error('[portal_admin] adoption query failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// POST /api/portal-admin/community/:communityId/bulk-invite
// ----------------------------------------------------------------------------
// Body: { contact_ids: [<uuid>, <uuid>, ...], invited_by?: <staff label> }
//
// For each contact_id:
//   - Look up the contact + their current residency in this community
//   - Idempotent: skip if portal_user already exists (returns reason)
//   - Create portal_user (role=homeowner, status=invited)
//   - Grant their current property via portal_user_properties
//   - Generate 7-day invite magic link + EMAIL it via sendEmail
//   - Log audit entries
//
// Returns:
//   { ok: true,
//     invited: <N successfully invited + emailed>,
//     skipped: <N skipped>,
//     results: [{ contact_id, status: 'invited'|'skipped', reason?: <string>,
//                 portal_user_id?: <id>, email_sent?: bool }],
//     community: { id, name } }
//
// Concurrency: emails sent in batches of 5 to avoid hammering Resend.
// On the order of 50-500 homeowners per community — handles in seconds.
// ============================================================================
router.post('/community/:communityId/bulk-invite', async (req, res) => {
  try {
    const communityId = req.params.communityId;
    if (!communityId) return res.status(400).json({ error: 'community_id_required' });
    const { contact_ids, invited_by } = req.body || {};
    if (!Array.isArray(contact_ids) || contact_ids.length === 0) {
      return res.status(400).json({ error: 'contact_ids_required' });
    }
    if (contact_ids.length > 1000) {
      // Safety cap — bulk inviting >1000 in one request risks Resend rate
      // limits and is almost certainly a copy/paste mistake.
      return res.status(400).json({ error: 'contact_ids_too_many', max: 1000, got: contact_ids.length });
    }

    // Fetch community context
    const { data: community } = await supabase
      .from('communities')
      .select('id, name, slug, hoa_legal_name')
      .eq('id', communityId)
      .maybeSingle();
    if (!community) return res.status(404).json({ error: 'community_not_found' });

    // Fetch all contacts in one shot (idempotent membership check below)
    const { data: contacts } = await supabase
      .from('contacts')
      .select('id, full_name, preferred_name, primary_email')
      .in('id', contact_ids);
    const contactById = Object.fromEntries((contacts || []).map((c) => [c.id, c]));

    // Fetch current residencies for these contacts to find their property in
    // THIS community (a contact may own elsewhere; we only grant the in-community
    // property to avoid accidentally granting cross-community access).
    const { data: residencies } = await supabase
      .from('property_residencies')
      .select('contact_id, property_id, properties:property_id(id, street_address, community_id)')
      .in('contact_id', contact_ids)
      .is('end_date', null);
    // Build a map: contact_id -> property in THIS community (the first match;
    // a contact with two properties in the same community is rare and either
    // works for invite purposes).
    const propertyForContact = {};
    for (const r of (residencies || [])) {
      if (r.properties && r.properties.community_id === communityId) {
        if (!propertyForContact[r.contact_id]) {
          propertyForContact[r.contact_id] = {
            property_id: r.property_id,
            street_address: r.properties.street_address || '',
          };
        }
      }
    }

    // Fetch existing portal_users by email (for idempotency check)
    const lowerEmails = (contacts || [])
      .map((c) => (c.primary_email || '').toLowerCase().trim())
      .filter(Boolean);
    const { data: existingUsers } = lowerEmails.length
      ? await supabase
          .from('portal_users')
          .select('id, email, contact_id, status')
          .eq('management_company_id', BEDROCK_MGMT_CO_ID)
          .in('email', lowerEmails)
      : { data: [] };
    const existingByEmail = {};
    const existingByContactId = {};
    for (const u of (existingUsers || [])) {
      if (u.email) existingByEmail[u.email.toLowerCase()] = u;
      if (u.contact_id) existingByContactId[u.contact_id] = u;
    }

    // Per-contact processing — but we batch the actual email send in groups
    // of 5 to keep Resend happy. The DB writes (insert user, grant property,
    // insert magic_link) are all individual rows and are fine to do in a loop.
    const results = [];
    const toEmail = []; // queue of { user_id, email, full_name, token }

    for (const cid of contact_ids) {
      const c = contactById[cid];
      if (!c) { results.push({ contact_id: cid, status: 'skipped', reason: 'contact_not_found' }); continue; }
      const email = (c.primary_email || '').toLowerCase().trim();
      if (!email || !email.includes('@')) {
        results.push({ contact_id: cid, status: 'skipped', reason: 'no_email' });
        continue;
      }

      const prop = propertyForContact[cid];
      if (!prop) {
        // Contact isn't a current resident in THIS community — refuse to grant
        // access. Avoids accidentally inviting an ex-owner whose record is stale.
        results.push({ contact_id: cid, status: 'skipped', reason: 'no_current_residency_in_community' });
        continue;
      }

      // Idempotency: if portal_user already exists for this email or contact,
      // skip (operator can use resend-invite endpoint instead).
      const existing = existingByEmail[email] || existingByContactId[cid];
      if (existing) {
        results.push({
          contact_id: cid, status: 'skipped',
          reason: 'already_invited',
          portal_user_id: existing.id,
          portal_status: existing.status,
        });
        continue;
      }

      // Create portal_user
      let userId;
      try {
        const { data: newUser, error: insErr } = await supabase
          .from('portal_users')
          .insert({
            management_company_id: BEDROCK_MGMT_CO_ID,
            email,
            full_name: c.preferred_name || c.full_name || null,
            role: 'homeowner',
            status: 'invited',
            contact_id: cid,
            invited_by: invited_by || null,
          })
          .select('id')
          .single();
        if (insErr) throw insErr;
        userId = newUser.id;
      } catch (e) {
        results.push({ contact_id: cid, status: 'skipped', reason: 'insert_failed', detail: e.message });
        continue;
      }

      // Grant the property
      try {
        await supabase.from('portal_user_properties').upsert({
          portal_user_id: userId,
          property_id: prop.property_id,
          granted_by: invited_by || null,
          revoked_at: null,
          revoked_by: null,
        }, { onConflict: 'portal_user_id,property_id' });
      } catch (e) {
        console.warn(`[portal_admin] bulk-invite grant-property failed for ${userId}: ${e.message}`);
        // Don't bail — user exists, we just couldn't grant. Operator can fix manually.
      }

      // Generate magic link (7-day for invite)
      const token = makeToken();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      try {
        await supabase.from('portal_magic_links').insert({
          portal_user_id: userId,
          token,
          purpose: 'invite',
          expires_at: expiresAt.toISOString(),
          created_by: invited_by || null,
        });
      } catch (e) {
        results.push({ contact_id: cid, status: 'skipped', reason: 'magic_link_failed', detail: e.message });
        continue;
      }

      await logAudit('user_invited', { portal_user_id: userId, performed_by: invited_by, notes: `via=bulk_invite community=${community.slug}` });
      await logAudit('magic_link_generated', { portal_user_id: userId, performed_by: invited_by, notes: 'purpose=invite via=bulk_invite' });

      toEmail.push({
        user_id: userId,
        email,
        full_name: c.preferred_name || c.full_name || '',
        property_address: prop.street_address,
        token,
      });
      results.push({
        contact_id: cid, status: 'invited',
        portal_user_id: userId,
        email_queued: true,
      });
    }

    // Send emails in batches of 5 to avoid Resend rate limits and to
    // surface failures progressively rather than all-at-end. Mutates
    // `results` with email_sent: bool per row.
    const emailResultByUserId = {};
    const BATCH = 5;
    for (let i = 0; i < toEmail.length; i += BATCH) {
      const slice = toEmail.slice(i, i + BATCH);
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(slice.map(async (item) => {
        const url = magicLinkUrl(req, item.token);
        const firstName = (item.full_name || '').split(/\s+/)[0] || '';
        try {
          await sendEmail({
            to: item.email,
            subject: `Welcome to your ${community.name} homeowner portal`,
            html: `
              <p>Hi${firstName ? ' ' + escapeHtml(firstName) : ''},</p>
              <p>Bedrock Association Management is rolling out the homeowner portal for <strong>${escapeHtml(community.name)}</strong>. You're invited!</p>
              <p>You'll find your account balance, compliance status, governing documents, board meeting schedule, and quick ways to submit ARC requests or reserve the clubhouse — all in one place for ${escapeHtml(item.property_address || 'your home')}.</p>
              <p style="margin: 22px 0;">
                <a href="${escapeHtml(url)}" style="display:inline-block; background:#1A3050; color:white; padding:13px 24px; border-radius:7px; text-decoration:none; font-weight:500; font-family: Inter, Arial, sans-serif;">
                  Set up your portal access →
                </a>
              </p>
              <p style="font-size:13px; color:#666;">This invite link is valid for 7 days. If you need a fresh one, just reply to this email and we'll send another.</p>
              <p style="font-size:12px; color:#888;">Or paste this URL in your browser:<br><span style="font-family:monospace; font-size:11px; word-break:break-all;">${escapeHtml(url)}</span></p>
              <p style="color:#555; font-size:11px; margin-top:26px; padding-top:14px; border-top:1px solid #ddd;">
                Bedrock Association Management · (832) 588-2485 · info@bedrocktx.com · bedrocktx.com
              </p>
            `,
            tags: [
              { name: 'module', value: 'portal_admin' },
              { name: 'event', value: 'bulk_invite' },
              { name: 'community', value: community.slug || '' },
            ],
          });
          emailResultByUserId[item.user_id] = { sent: true };
          await logAudit('magic_link_sent', { portal_user_id: item.user_id, notes: 'via=bulk_invite' });
        } catch (e) {
          console.warn(`[portal_admin] bulk-invite email failed for user ${item.user_id}: ${e.message}`);
          emailResultByUserId[item.user_id] = { sent: false, error: e.message };
        }
      }));
    }

    // Stitch email-send results back into the per-contact results
    for (const r of results) {
      if (r.portal_user_id && emailResultByUserId[r.portal_user_id]) {
        r.email_sent = !!emailResultByUserId[r.portal_user_id].sent;
        if (!r.email_sent) r.email_error = emailResultByUserId[r.portal_user_id].error || 'unknown';
      }
    }

    const invitedCount = results.filter((r) => r.status === 'invited').length;
    const skippedCount = results.filter((r) => r.status === 'skipped').length;
    res.json({
      ok: true,
      invited: invitedCount,
      skipped: skippedCount,
      community: { id: community.id, name: community.name },
      results,
    });
  } catch (err) {
    console.error('[portal_admin] bulk-invite failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// POST /api/portal-admin/users/:id/resend-invite
// ----------------------------------------------------------------------------
// For users with status=invited who didn't act on the original invite.
// Generates a FRESH 7-day magic link (invalidating any prior pending links
// for this user) and emails it. Idempotent — calling multiple times just
// re-sends.
//
// Body: { invited_by?: <staff label> }
// ============================================================================
router.post('/users/:id/resend-invite', async (req, res) => {
  try {
    const userId = req.params.id;
    const invitedBy = req.body?.invited_by || null;

    const { data: user } = await supabase
      .from('portal_users')
      .select('id, email, full_name, status, contact_id')
      .eq('id', userId)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    if (user.status === 'revoked') return res.status(400).json({ error: 'user_is_revoked' });

    // Find the property tied to this user (for the email context line)
    let propertyAddress = '';
    let communityName = '';
    try {
      const { data: scope } = await supabase
        .from('portal_user_properties')
        .select('properties:property_id(street_address, communities:community_id(name))')
        .eq('portal_user_id', userId)
        .is('revoked_at', null)
        .limit(1)
        .maybeSingle();
      if (scope?.properties) {
        propertyAddress = scope.properties.street_address || '';
        communityName = scope.properties.communities?.name || '';
      }
    } catch (_) { /* not fatal */ }

    // Invalidate prior pending links
    await supabase
      .from('portal_magic_links')
      .update({ used_at: new Date().toISOString(), used_user_agent: 'superseded_by_resend' })
      .eq('portal_user_id', userId)
      .is('used_at', null);

    // Generate fresh 7-day link
    const token = makeToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await supabase.from('portal_magic_links').insert({
      portal_user_id: userId,
      token,
      purpose: 'invite',
      expires_at: expiresAt.toISOString(),
      created_by: invitedBy,
    });
    await logAudit('magic_link_generated', { portal_user_id: userId, performed_by: invitedBy, notes: 'purpose=invite via=resend' });

    // Email it
    const url = magicLinkUrl(req, token);
    const firstName = (user.full_name || '').split(/\s+/)[0] || '';
    let emailSent = false;
    let emailError = null;
    try {
      await sendEmail({
        to: user.email,
        subject: `Your ${communityName || 'Bedrock'} homeowner portal invitation`,
        html: `
          <p>Hi${firstName ? ' ' + escapeHtml(firstName) : ''},</p>
          <p>Here's a fresh link to set up your homeowner portal access${communityName ? ' for <strong>' + escapeHtml(communityName) + '</strong>' : ''}${propertyAddress ? ' — ' + escapeHtml(propertyAddress) : ''}.</p>
          <p style="margin: 22px 0;">
            <a href="${escapeHtml(url)}" style="display:inline-block; background:#1A3050; color:white; padding:13px 24px; border-radius:7px; text-decoration:none; font-weight:500; font-family: Inter, Arial, sans-serif;">
              Set up your portal access →
            </a>
          </p>
          <p style="font-size:13px; color:#666;">This invite link is valid for 7 days. Replies come to our team if you need help.</p>
          <p style="font-size:12px; color:#888;">Or paste this URL in your browser:<br><span style="font-family:monospace; font-size:11px; word-break:break-all;">${escapeHtml(url)}</span></p>
          <p style="color:#555; font-size:11px; margin-top:26px; padding-top:14px; border-top:1px solid #ddd;">
            Bedrock Association Management · (832) 588-2485 · info@bedrocktx.com
          </p>
        `,
        tags: [
          { name: 'module', value: 'portal_admin' },
          { name: 'event', value: 'invite_resent' },
        ],
      });
      emailSent = true;
      await logAudit('magic_link_sent', { portal_user_id: userId, notes: 'via=resend' });
    } catch (e) {
      console.warn(`[portal_admin] resend-invite email failed for ${userId}: ${e.message}`);
      emailError = e.message;
    }

    res.json({
      ok: true,
      portal_user_id: userId,
      email_sent: emailSent,
      email_error: emailError,
      magic_link: url, // returned for operator convenience (can paste manually if email failed)
      expires_at: expiresAt.toISOString(),
    });
  } catch (err) {
    console.error('[portal_admin] resend-invite failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
