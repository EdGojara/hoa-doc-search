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

  // Step 2 — fetch community context for branding
  const { data: communityRows } = await supabase
    .from('communities')
    .select('id, name, legal_name, hoa_legal_name')
    .in('id', communityIds);
  const communityById = {};
  (communityRows || []).forEach(c => {
    communityById[c.id] = {
      id: c.id,
      name: c.name,
      legal_name: c.legal_name || c.hoa_legal_name || c.name,
    };
  });

  // Step 3 — fetch properties in scope
  const { data: properties } = await supabase
    .from('properties')
    .select('id, community_id')
    .in('community_id', communityIds);
  const propertyById = {};
  (properties || []).forEach(p => { propertyById[p.id] = p; });
  const propertyIds = Object.keys(propertyById);
  if (!propertyIds.length) return [];

  // Step 4a — owners (if included by audience)
  const includeOwners = audience === 'owners_and_residents' || audience === 'owners_only';
  let ownershipRows = [];
  if (includeOwners) {
    const { data } = await supabase
      .from('property_ownerships')
      .select('property_id, contact_id, contacts:contact_id(id, full_name, preferred_name, primary_email)')
      .in('property_id', propertyIds)
      .is('end_date', null);
    ownershipRows = data || [];
  }

  // Step 4b — current residents (if included by audience)
  const includeResidents = audience === 'owners_and_residents' || audience === 'residents_only';
  let residencyRows = [];
  if (includeResidents) {
    const { data } = await supabase
      .from('property_residencies')
      .select('property_id, contact_id, residency_type, start_date, contacts:contact_id(id, full_name, preferred_name, primary_email)')
      .in('property_id', propertyIds)
      .is('end_date', null);
    residencyRows = data || [];
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
function wrapInLetterhead(bodyHtml, ctx) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0; padding:0; background:#f5f4ed; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; color:#1a1a1a;">
  <div style="max-width:600px; margin:0 auto; padding:24px 16px;">
    <!-- Community letterhead -->
    <div style="background:#0B1D34; color:#fff; padding:24px 28px; border-radius:10px 10px 0 0;">
      <div style="font-size:11px; letter-spacing:0.18em; color:#D4AF37; text-transform:uppercase; margin-bottom:6px;">Community Notice</div>
      <div style="font-family:Georgia,'Times New Roman',serif; font-size:22px; font-weight:500; line-height:1.2;">${escapeHtml(ctx.community_name || '')}</div>
      ${ctx.community_legal_name && ctx.community_legal_name !== ctx.community_name
        ? `<div style="font-size:12.5px; color:#cbd5e1; margin-top:4px;">${escapeHtml(ctx.community_legal_name)}</div>`
        : ''}
    </div>
    <!-- Body -->
    <div style="background:#fff; padding:32px 28px; border:1px solid #e5e3da; border-top:0; border-radius:0 0 10px 10px; font-size:15px; line-height:1.6; color:#222;">
      ${bodyHtml}
    </div>
    <!-- Bedrock sign-off footer -->
    <div style="text-align:center; padding:18px 16px 8px; font-size:11.5px; color:#6b7280; line-height:1.7;">
      <div style="margin-bottom:4px;">Sent on behalf of <strong>${escapeHtml(ctx.community_legal_name || ctx.community_name || '')}</strong></div>
      <div>by <strong>Bedrock Association Management, LLC</strong></div>
      <div style="margin-top:6px;">${BEDROCK_PHONE} · <a href="mailto:${BEDROCK_EMAIL}" style="color:#0B1D34;">${BEDROCK_EMAIL}</a></div>
      <div style="margin-top:10px; font-size:10.5px; color:#94a3b8; letter-spacing:0.18em; text-transform:uppercase;">Community. Simplified.</div>
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

    // Render sample emails — top 3 communities
    const sampleCount = campaign.scope === 'single_community' ? 1 : Math.min(3, communityBreakdown.length);
    const samples = communityBreakdown.slice(0, sampleCount).map(c => {
      // Use a representative recipient name (find first recipient in that community)
      const sampleRecipient = recipients.find(r => r.community_id === c.community_id) || {};
      const ctx = {
        community_name: c.community_name,
        community_legal_name: c.community_legal_name,
        first_name: sampleRecipient.first_name || 'there',
        full_name: sampleRecipient.full_name || '',
      };
      return {
        community_id: c.community_id,
        community_name: c.community_name,
        rendered_subject: substituteTemplate(campaign.subject_template, ctx),
        rendered_html: wrapInLetterhead(substituteTemplate(campaign.body_html_template, ctx), ctx),
      };
    });

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
    const ctx = {
      community_name: sampleRecipient.community_name,
      community_legal_name: sampleRecipient.community_legal_name,
      first_name: sampleRecipient.first_name || 'there',
      full_name: sampleRecipient.full_name || '',
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

    // Send loop — small concurrency (5 at a time) to be friendly to Resend
    let delivered = 0, failed = 0;
    const CONCURRENCY = 5;
    let cursor = 0;
    async function sendOne(r) {
      const ctx = {
        community_name: r.community_name,
        community_legal_name: r.community_legal_name,
        first_name: r.first_name || 'there',
        full_name: r.full_name || '',
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

module.exports = router;
