// ============================================================================
// api/email_campaigns.js — community email blasts
// ----------------------------------------------------------------------------
// Mounted at /api/email-campaigns
//
// Endpoints:
//   POST   /                          — create a draft campaign
//   GET    /                          — list recent campaigns
//   GET    /:id                       — fetch one campaign + recipient counts
//   POST   /:id/preview               — compute recipient counts by community
//                                       + render sample emails for the top
//                                       3 communities (or the single targeted
//                                       one). Does NOT send anything.
//   POST   /:id/send-test             — send the rendered email to a single
//                                       test address (typically the operator)
//                                       before fanning out
//   POST   /:id/send                  — fan out + send to all recipients
//   DELETE /:id                       — cancel/delete a draft
//
// DESIGN:
// - Recipients computed AT SEND TIME from owners + current residents, not
//   pre-computed at draft time. This way the campaign is always sent against
//   the freshest roster — if a renter is added 5 minutes before send, they're
//   included.
// - Per-recipient row preserves audit trail.
// - Per-community render context lets a single all_communities campaign
//   produce N branded variants — Waterview homeowners get Waterview
//   letterhead, Canyon Gate homeowners get Canyon Gate letterhead, same
//   body content.
// - Resend is the vendor (already wired for forms@/letters/etc.).
// ============================================================================

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { sendEmail, isConfigured: emailConfigured } = require('../lib/notifications/email');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const BEDROCK_PHONE = '(832) 588-2485';
const BEDROCK_EMAIL = 'info@bedrocktx.com';

// ----------------------------------------------------------------------------
// Recipient resolver — pulls the recipient list for a given campaign scope +
// audience. Returns a deduped array of:
//   { email, full_name, first_name, contact_id, community_id,
//     community_name, community_legal_name, recipient_role }
//
// Dedupe key: lowercased email. When a person appears via multiple paths
// (owner AND resident of same property, or two properties in two
// communities), keep ONE row and prefer their most-recent residency
// community for branding.
// ----------------------------------------------------------------------------
// Page through ALL rows — Supabase/PostgREST silently caps any query at 1000
// rows. Without this a community over 1000 properties/owners drops recipients
// from every blast with no error (the Waterview 1171→1000 scar). Loops .range()
// until a short page; safety cap 100k.
async function _pageAll(buildQuery) {
  const out = [];
  for (let from = 0; from < 100000; from += 1000) {
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await buildQuery().range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
// Same, but chunk a large id list for the .in() filter (URL length + result cap).
async function _pageAllIn(table, selectStr, col, ids, applyExtra) {
  const out = [];
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    // eslint-disable-next-line no-await-in-loop
    const rows = await _pageAll(() => {
      const q = supabase.from(table).select(selectStr).in(col, chunk);
      return applyExtra ? applyExtra(q) : q;
    });
    out.push(...rows);
  }
  return out;
}

async function resolveRecipients({ scope, target_community_id, audience }) {
  // Step 1 — which communities are in scope?
  let communityIds = [];
  if (scope === 'single_community') {
    if (!target_community_id) return [];
    communityIds = [target_community_id];
  } else {
    const { data: comms } = await supabase
      .from('communities')
      .select('id')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('active', true);
    communityIds = (comms || []).map(c => c.id);
  }
  if (!communityIds.length) return [];

  // Step 2 — fetch community context for branding. Pull the full brand kit
  // so each rendered email uses the COMMUNITY's colors / logo / signoff,
  // not Bedrock's. Bedrock-as-invisible-plumbing principle.
  const { data: communityRows } = await supabase
    .from('communities')
    .select('id, name, legal_name, hoa_legal_name, brand_primary_color, brand_accent_color, brand_text_on_primary, logo_storage_path, logo_height_px, signoff_signature')
    .in('id', communityIds);
  const communityById = {};
  (communityRows || []).forEach(c => {
    communityById[c.id] = {
      id: c.id,
      name: c.name,
      legal_name: c.legal_name || c.hoa_legal_name || c.name,
      brand: {
        primary_color:   c.brand_primary_color,
        accent_color:    c.brand_accent_color,
        text_on_primary: c.brand_text_on_primary,
        logo_height_px:  c.logo_height_px,
      },
      logo_storage_path: c.logo_storage_path,
      signoff_signature: c.signoff_signature,
    };
  });

  // Step 3 — fetch properties in scope (paged — never cap at 1000)
  const properties = await _pageAll(() =>
    supabase.from('properties').select('id, community_id').in('community_id', communityIds));
  const propertyById = {};
  (properties || []).forEach(p => { propertyById[p.id] = p; });
  const propertyIds = Object.keys(propertyById);
  if (!propertyIds.length) return [];

  // Step 4a — owners (if included by audience)
  const includeOwners = audience === 'owners_and_residents' || audience === 'owners_only';
  let ownershipRows = [];
  if (includeOwners) {
    ownershipRows = await _pageAllIn(
      'property_ownerships',
      'property_id, contact_id, contacts:contact_id(id, full_name, preferred_name, primary_email)',
      'property_id', propertyIds, (q) => q.is('end_date', null));
  }

  // Step 4b — current residents (if included by audience)
  const includeResidents = audience === 'owners_and_residents' || audience === 'residents_only';
  let residencyRows = [];
  if (includeResidents) {
    residencyRows = await _pageAllIn(
      'property_residencies',
      'property_id, contact_id, residency_type, start_date, contacts:contact_id(id, full_name, preferred_name, primary_email)',
      'property_id', propertyIds, (q) => q.is('end_date', null));
  }

  // Step 5 — merge + dedupe by email, prefer residency community when both paths
  // are present, prefer most recent residency when person has multiple.
  // candidates: { email -> { ...record, residency_start_for_priority } }
  const byEmail = new Map();

  // Owners first (lower priority — residency overrides)
  for (const o of ownershipRows) {
    const c = o.contacts;
    if (!c?.primary_email) continue;
    const email = String(c.primary_email).toLowerCase().trim();
    if (!email || !email.includes('@')) continue;
    const prop = propertyById[o.property_id];
    const comm = prop ? communityById[prop.community_id] : null;
    if (!comm) continue;
    const fullName = c.full_name || c.preferred_name || '';
    const firstName = c.preferred_name || (fullName.split(/\s+/)[0] || '');
    byEmail.set(email, {
      email,
      full_name: fullName,
      first_name: firstName,
      contact_id: c.id,
      community_id: comm.id,
      community_name: comm.name,
      community_legal_name: comm.legal_name,
      brand: comm.brand,
      logo_storage_path: comm.logo_storage_path,
      signoff_signature: comm.signoff_signature,
      recipient_role: 'owner',
      _priority_date: null, // owner is fallback
    });
  }

  // Residents — override owner row if both present (residency-community wins
  // for branding, since the resident is the one living there). Also
  // multiple residencies → keep most recent.
  for (const r of residencyRows) {
    const c = r.contacts;
    if (!c?.primary_email) continue;
    const email = String(c.primary_email).toLowerCase().trim();
    if (!email || !email.includes('@')) continue;
    const prop = propertyById[r.property_id];
    const comm = prop ? communityById[prop.community_id] : null;
    if (!comm) continue;
    const fullName = c.full_name || c.preferred_name || '';
    const firstName = c.preferred_name || (fullName.split(/\s+/)[0] || '');
    const role = (() => {
      switch (r.residency_type) {
        case 'owner_occupied': return 'resident_owner_occupied';
        case 'renter':         return 'resident_renter';
        case 'family_member':  return 'resident_family';
        default:               return 'resident_other';
      }
    })();
    const startDate = r.start_date || '1900-01-01';
    const existing = byEmail.get(email);
    if (existing && existing._priority_date && startDate <= existing._priority_date) {
      continue; // keep the later residency
    }
    byEmail.set(email, {
      email,
      full_name: fullName,
      first_name: firstName,
      contact_id: c.id,
      community_id: comm.id,
      community_name: comm.name,
      community_legal_name: comm.legal_name,
      brand: comm.brand,
      logo_storage_path: comm.logo_storage_path,
      signoff_signature: comm.signoff_signature,
      recipient_role: role,
      _priority_date: startDate,
    });
  }

  // Strip helper field
  return Array.from(byEmail.values()).map(({ _priority_date, ...rest }) => rest);
}

// ----------------------------------------------------------------------------
// Template substitution — replaces {{var}} tokens with per-recipient values.
// ----------------------------------------------------------------------------
function substituteTemplate(template, ctx) {
  if (!template) return '';
  const vars = {
    community_name: ctx.community_name || '',
    community_legal_name: ctx.community_legal_name || ctx.community_name || '',
    recipient_first_name: ctx.first_name || 'there',
    recipient_full_name: ctx.full_name || '',
    bedrock_phone: BEDROCK_PHONE,
    bedrock_email: BEDROCK_EMAIL,
    today_date: new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'long', day: 'numeric', year: 'numeric' }),
  };
  return String(template).replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_match, key) => {
    return vars[key] != null ? String(vars[key]) : '';
  });
}

// ----------------------------------------------------------------------------
// HTML letterhead wrapper — wraps the substituted body in branded letterhead
// with the community's name + Bedrock sign-off footer.
// ----------------------------------------------------------------------------
// Register-aware eyebrow text. The register stays as a tone classifier but
// it NO LONGER drives colors — the community's brand kit does. Bedrock-as-
// invisible-plumbing principle (Ed 2026-06-08): the email reads as the
// community, not as Bedrock.
const REGISTER_EYEBROW = {
  engagement:  'Community Update',
  operational: 'Community Notice',
  compliance:  'Official Notice',
};

// Neutral fallbacks for communities that haven't set a brand kit yet.
// Deliberately NOT Bedrock navy/gold — these are generic "a community"
// colors so even an unbranded email doesn't accidentally look like a
// Bedrock email.
const DEFAULT_BRAND = {
  primary_color:   '#2A4054',   // muted slate — generic, not Bedrock navy
  accent_color:    '#B5946B',   // warm tan — generic, not Bedrock gold
  text_on_primary: 'light',
  logo_height_px:  40,
};

function _isLightText(textOnPrimary) {
  return (textOnPrimary || DEFAULT_BRAND.text_on_primary) === 'light';
}

// Resolves a community logo storage path to a signed URL the email can embed.
// Falls back to null on any error so the renderer just shows the community
// name wordmark instead.
async function resolveLogoUrl(storagePath) {
  if (!storagePath) return null;
  try {
    // Logos live in the same 'documents' bucket as everything else
    // (matches api/communities.js logo upload path).
    const { data } = await supabase.storage
      .from('documents')
      .createSignedUrl(storagePath, 60 * 60 * 24 * 7); // 7-day signed URL
    return data?.signedUrl || null;
  } catch (e) {
    return null;
  }
}

function wrapInLetterhead(bodyHtml, ctx) {
  const brand = ctx.brand || DEFAULT_BRAND;
  const primary   = brand.primary_color   || DEFAULT_BRAND.primary_color;
  const accent    = brand.accent_color    || DEFAULT_BRAND.accent_color;
  const isLight   = _isLightText(brand.text_on_primary);
  const bandText  = isLight ? '#ffffff' : '#0a0a0a';
  const subText   = isLight ? 'rgba(255,255,255,0.7)' : 'rgba(10,10,10,0.6)';
  const eyebrow   = REGISTER_EYEBROW[ctx.register] || REGISTER_EYEBROW.operational;
  const isCompliance = ctx.register === 'compliance';
  const bodyBorder = isCompliance
    ? `2px solid ${accent}`
    : `1px solid #e5e3da`;
  const signoff   = ctx.signoff_signature
    || `The ${escapeHtml(ctx.community_name || 'Community')} Board`;

  // Logo block — community logo if set, otherwise community name as wordmark
  const logoBlock = ctx.logo_url
    ? `<img src="${escapeHtml(ctx.logo_url)}" alt="${escapeHtml(ctx.community_name || '')}" style="max-height:${brand.logo_height_px || 40}px; display:block; margin-bottom:12px; max-width:240px;">`
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0; padding:0; background:#f5f4ed; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; color:#1a1a1a;">
  <div style="max-width:600px; margin:0 auto; padding:24px 16px;">

    <!-- COMMUNITY letterhead — community brand is hero -->
    <div style="background:${primary}; color:${bandText}; padding:26px 30px; border-radius:10px 10px 0 0;">
      ${logoBlock}
      <div style="font-size:11px; letter-spacing:0.18em; color:${accent}; text-transform:uppercase; margin-bottom:8px; font-weight:600;">${eyebrow}</div>
      <div style="font-family:Georgia,'Times New Roman',serif; font-size:24px; font-weight:500; line-height:1.2; color:${bandText};">${escapeHtml(ctx.community_name || '')}</div>
      ${ctx.community_legal_name && ctx.community_legal_name !== ctx.community_name
        ? `<div style="font-size:12.5px; color:${subText}; margin-top:6px;">${escapeHtml(ctx.community_legal_name)}</div>`
        : ''}
    </div>

    <!-- Body -->
    <div style="background:#fff; padding:32px 30px; border:${bodyBorder}; border-top:0; border-radius:0 0 10px 10px; font-size:15px; line-height:1.6; color:#222;">
      ${bodyHtml}
      <div style="margin-top:24px; padding-top:18px; border-top:1px solid #e5e3da; font-size:14px; color:#555;">
        <div>Thanks,</div>
        <div style="margin-top:4px; font-weight:500; color:#1a1a1a;">${signoff}</div>
      </div>
    </div>

    <!-- BEDROCK attribution — small, at bottom. Invisible plumbing. -->
    <div style="text-align:center; padding:22px 16px 4px; font-size:11px; color:#6b7280; line-height:1.7;">
      <div style="display:inline-flex; align-items:center; gap:8px; padding:6px 12px; border-radius:999px; background:rgba(11,29,52,0.04); border:1px solid rgba(11,29,52,0.08);">
        <span style="display:inline-block; width:6px; height:8px; background:#D4AF37; border-radius:1px;"></span>
        <span>Community management by <strong style="color:#0B1D34;">Bedrock Association Management</strong></span>
      </div>
      <div style="margin-top:10px; font-size:10.5px;">
        ${BEDROCK_PHONE} · <a href="mailto:${BEDROCK_EMAIL}" style="color:#0B1D34;">${BEDROCK_EMAIL}</a>
      </div>
      ${isCompliance ? `<div style="margin-top:10px; font-size:10px; color:#94a3b8; letter-spacing:0.05em;">Official correspondence — please retain for your records.</div>` : ''}
    </div>

  </div>
</body></html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ----------------------------------------------------------------------------
// POST /api/email-campaigns — create a draft
// ----------------------------------------------------------------------------
router.post('/', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const scope = b.scope || 'single_community';
    if (!['single_community', 'all_communities'].includes(scope)) {
      return res.status(400).json({ error: 'invalid_scope' });
    }
    if (scope === 'single_community' && !b.target_community_id) {
      return res.status(400).json({ error: 'target_community_id_required_for_single_community' });
    }
    if (!b.subject_template || !String(b.subject_template).trim()) {
      return res.status(400).json({ error: 'subject_template_required' });
    }
    if (!b.body_html_template || !String(b.body_html_template).trim()) {
      return res.status(400).json({ error: 'body_html_template_required' });
    }
    const audience = b.audience || 'owners_and_residents';
    if (!['owners_and_residents', 'owners_only', 'residents_only'].includes(audience)) {
      return res.status(400).json({ error: 'invalid_audience' });
    }
    const register = b.register || 'operational';
    if (!['engagement', 'operational', 'compliance'].includes(register)) {
      return res.status(400).json({ error: 'invalid_register' });
    }
    const { data, error } = await supabase
      .from('email_campaigns')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        scope,
        target_community_id: scope === 'single_community' ? b.target_community_id : null,
        subject_template: String(b.subject_template).trim(),
        body_html_template: String(b.body_html_template),
        body_text_template: b.body_text_template || null,
        audience,
        register,
        created_by: b.created_by || null,
        notes: b.notes || null,
        status: 'draft',
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ campaign: data });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /api/email-campaigns — list
// ----------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const { data, error } = await supabase
      .from('email_campaigns')
      .select('id, scope, target_community_id, subject_template, audience, status, total_recipients, delivered_count, failed_count, sent_at, created_by, created_at')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ campaigns: data || [] });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /api/email-campaigns/:id
// ----------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const { data: campaign, error } = await supabase
      .from('email_campaigns')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!campaign) return res.status(404).json({ error: 'not_found' });
    // Recipient counts by status (only meaningful after preview/send)
    const { data: stats } = await supabase
      .from('email_campaign_recipients')
      .select('status', { count: 'exact', head: false })
      .eq('campaign_id', req.params.id);
    res.json({ campaign, recipient_status_counts: stats || [] });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /api/email-campaigns/:id/preview
// Resolves recipients (without sending), returns counts by community + a
// sample rendered email for each of the top 3 communities (or the single
// one for single-community scope).
// ----------------------------------------------------------------------------
router.post('/:id/preview', async (req, res) => {
  try {
    const { data: campaign } = await supabase
      .from('email_campaigns')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!campaign) return res.status(404).json({ error: 'not_found' });

    const recipients = await resolveRecipients({
      scope: campaign.scope,
      target_community_id: campaign.target_community_id,
      audience: campaign.audience,
    });
    // Aggregate by community
    const byCommunity = new Map();
    for (const r of recipients) {
      const key = r.community_id;
      if (!byCommunity.has(key)) byCommunity.set(key, {
        community_id: key,
        community_name: r.community_name,
        community_legal_name: r.community_legal_name,
        recipient_count: 0,
        by_role: {},
      });
      const entry = byCommunity.get(key);
      entry.recipient_count += 1;
      entry.by_role[r.recipient_role] = (entry.by_role[r.recipient_role] || 0) + 1;
    }
    const communityBreakdown = Array.from(byCommunity.values())
      .sort((a, b) => b.recipient_count - a.recipient_count);

    // Render sample emails — top 3 communities. async map because we need
    // to resolve the community logo signed URL per sample.
    const sampleCount = campaign.scope === 'single_community' ? 1 : Math.min(3, communityBreakdown.length);
    const samples = await Promise.all(
      communityBreakdown.slice(0, sampleCount).map(async (c) => {
        const sampleRecipient = recipients.find(r => r.community_id === c.community_id) || {};
        const logoUrl = await resolveLogoUrl(sampleRecipient.logo_storage_path);
        const ctx = {
          community_name: c.community_name,
          community_legal_name: c.community_legal_name,
          first_name: sampleRecipient.first_name || 'there',
          full_name: sampleRecipient.full_name || '',
          register: campaign.register || 'operational',
          brand: sampleRecipient.brand || null,
          logo_url: logoUrl,
          signoff_signature: sampleRecipient.signoff_signature || null,
        };
        return {
          community_id: c.community_id,
          community_name: c.community_name,
          rendered_subject: substituteTemplate(campaign.subject_template, ctx),
          rendered_html: wrapInLetterhead(substituteTemplate(campaign.body_html_template, ctx), ctx),
        };
      })
    );

    res.json({
      total_recipients: recipients.length,
      community_count: communityBreakdown.length,
      community_breakdown: communityBreakdown,
      samples,
    });
  } catch (err) {
    console.error('[email-campaigns] preview failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /api/email-campaigns/:id/send-test
// Sends ONE rendered variant (using the first community in scope) to a
// single test address. Lets the operator preview the actual delivered
// email before fanning out to everyone.
// Body: { to_email, sample_community_id? }
// ----------------------------------------------------------------------------
router.post('/:id/send-test', express.json(), async (req, res) => {
  try {
    if (!emailConfigured()) return res.status(503).json({ error: 'email_not_configured' });
    const b = req.body || {};
    if (!b.to_email) return res.status(400).json({ error: 'to_email_required' });
    const { data: campaign } = await supabase
      .from('email_campaigns')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!campaign) return res.status(404).json({ error: 'not_found' });

    // Resolve recipients just to pick the community context for the sample
    const recipients = await resolveRecipients({
      scope: campaign.scope,
      target_community_id: campaign.target_community_id,
      audience: campaign.audience,
    });
    let sampleRecipient = recipients[0] || null;
    if (b.sample_community_id) {
      sampleRecipient = recipients.find(r => r.community_id === b.sample_community_id) || sampleRecipient;
    }
    if (!sampleRecipient) {
      return res.status(400).json({ error: 'no_recipients_to_render_against' });
    }
    const logoUrl = await resolveLogoUrl(sampleRecipient.logo_storage_path);
    const ctx = {
      community_name: sampleRecipient.community_name,
      community_legal_name: sampleRecipient.community_legal_name,
      first_name: sampleRecipient.first_name || 'there',
      full_name: sampleRecipient.full_name || '',
      register: campaign.register || 'operational',
      brand: sampleRecipient.brand || null,
      logo_url: logoUrl,
      signoff_signature: sampleRecipient.signoff_signature || null,
    };
    const subject = '[TEST] ' + substituteTemplate(campaign.subject_template, ctx);
    const html = wrapInLetterhead(substituteTemplate(campaign.body_html_template, ctx), ctx);
    const sendResult = await sendEmail({ to: b.to_email, subject, html });
    if (!sendResult || sendResult.ok === false) {
      return res.status(500).json({ error: sendResult?.error || 'send_failed' });
    }
    res.json({ ok: true, sent_to: b.to_email, rendered_for_community: sampleRecipient.community_name });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /api/email-campaigns/:id/send
// Fans out to all recipients, rendering per their community.
// ----------------------------------------------------------------------------
router.post('/:id/send', async (req, res) => {
  try {
    if (!emailConfigured()) return res.status(503).json({ error: 'email_not_configured' });
    const { data: campaign } = await supabase
      .from('email_campaigns')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!campaign) return res.status(404).json({ error: 'not_found' });
    if (campaign.status !== 'draft') {
      return res.status(409).json({ error: 'campaign_not_in_draft_status', status: campaign.status });
    }
    // Flip to 'sending' before fan-out so accidental double-clicks 409
    await supabase
      .from('email_campaigns')
      .update({ status: 'sending', updated_at: new Date().toISOString() })
      .eq('id', campaign.id);

    const recipients = await resolveRecipients({
      scope: campaign.scope,
      target_community_id: campaign.target_community_id,
      audience: campaign.audience,
    });

    // Insert recipient rows in batches so audit trail exists even if send
    // partially fails. Batch of 500.
    const recipientRows = recipients.map(r => ({
      campaign_id: campaign.id,
      contact_id: r.contact_id,
      email: r.email,
      recipient_full_name: r.full_name,
      recipient_first_name: r.first_name,
      community_id: r.community_id,
      community_name: r.community_name,
      community_legal_name: r.community_legal_name,
      recipient_role: r.recipient_role,
      status: 'queued',
    }));
    for (let i = 0; i < recipientRows.length; i += 500) {
      const batch = recipientRows.slice(i, i + 500);
      const { error } = await supabase.from('email_campaign_recipients').upsert(batch, { onConflict: 'campaign_id,email' });
      if (error) console.warn('[email-campaigns] recipient batch insert failed:', error.message);
    }

    // Cache signed logo URLs per community so we don't re-sign once per
    // recipient. Same logo URL is valid for all recipients at a given
    // community within the same fan-out window.
    const logoUrlCache = new Map();
    async function getLogoFor(storagePath) {
      if (!storagePath) return null;
      if (logoUrlCache.has(storagePath)) return logoUrlCache.get(storagePath);
      const url = await resolveLogoUrl(storagePath);
      logoUrlCache.set(storagePath, url);
      return url;
    }

    // Send loop — small concurrency (5 at a time) to be friendly to Resend
    let delivered = 0, failed = 0;
    const CONCURRENCY = 5;
    let cursor = 0;
    async function sendOne(r) {
      const logoUrl = await getLogoFor(r.logo_storage_path);
      const ctx = {
        community_name: r.community_name,
        community_legal_name: r.community_legal_name,
        first_name: r.first_name || 'there',
        full_name: r.full_name || '',
        register: campaign.register || 'operational',
        brand: r.brand || null,
        logo_url: logoUrl,
        signoff_signature: r.signoff_signature || null,
      };
      const subject = substituteTemplate(campaign.subject_template, ctx);
      const html = wrapInLetterhead(substituteTemplate(campaign.body_html_template, ctx), ctx);
      try {
        const result = await sendEmail({ to: r.email, subject, html });
        if (result?.ok) {
          delivered++;
          await supabase.from('email_campaign_recipients').update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            rendered_subject: subject,
            resend_message_id: result.vendor_message_id || null,
          }).eq('campaign_id', campaign.id).eq('email', r.email);
        } else {
          failed++;
          await supabase.from('email_campaign_recipients').update({
            status: 'failed',
            error: result?.error || 'unknown',
            rendered_subject: subject,
          }).eq('campaign_id', campaign.id).eq('email', r.email);
        }
      } catch (e) {
        failed++;
        await supabase.from('email_campaign_recipients').update({
          status: 'failed',
          error: e.message,
        }).eq('campaign_id', campaign.id).eq('email', r.email);
      }
    }
    async function worker() {
      while (cursor < recipients.length) {
        const i = cursor++;
        if (i >= recipients.length) break;
        await sendOne(recipients[i]);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    const finalStatus = failed === 0 ? 'sent' : (delivered === 0 ? 'failed' : 'partial_failure');
    await supabase.from('email_campaigns').update({
      status: finalStatus,
      sent_at: new Date().toISOString(),
      total_recipients: recipients.length,
      delivered_count: delivered,
      failed_count: failed,
      updated_at: new Date().toISOString(),
    }).eq('id', campaign.id);

    res.json({
      ok: true,
      total: recipients.length,
      delivered,
      failed,
      status: finalStatus,
    });
  } catch (err) {
    console.error('[email-campaigns] send failed:', err.message);
    // Mark failed so it can be retried/diagnosed
    await supabase.from('email_campaigns')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// DELETE /api/email-campaigns/:id
// ----------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const { data: campaign } = await supabase
      .from('email_campaigns')
      .select('id, status')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!campaign) return res.status(404).json({ error: 'not_found' });
    if (campaign.status === 'sent' || campaign.status === 'sending') {
      return res.status(409).json({ error: 'cannot_delete_sent_or_in_progress' });
    }
    const { error } = await supabase
      .from('email_campaigns')
      .delete()
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Expose the recipient resolver for reuse (e.g. agenda/meeting-notice blasts)
// without duplicating the properties→owners/residents→deduped-emails logic.
router.resolveRecipients = resolveRecipients;
module.exports = router;
