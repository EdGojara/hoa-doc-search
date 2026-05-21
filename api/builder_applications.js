// ============================================================================
// Builder ARC Applications API
// ----------------------------------------------------------------------------
// Mounted at /api/builder-applications.
//
// Companion to /api/applications (resident ACC modifications). Two front
// doors share this backend:
//   - Portal:  https://builders.bedrocktxai.com/{community-slug}/submit
//   - Email:   builders@bedrocktx.com (ingest handler converts → POST here)
//
// Public flow (builder portal or email ingest):
//   1. POST /                              → create submission, return reference number
//   2. POST /:id/attachments               → upload site plan + elevations + color board
//   3. GET  /public/status/:reference      → status check (reference-number gated)
//
// Manager flow (ARC Review tab):
//   4. GET  /                              → queue list (filterable by community/status/fast_track)
//   5. GET  /:id                           → full detail (application + assessments + responses + attachments + master_plan)
//   6. POST /:id/finalize                  → decision → render letter PDF → store in supabase → promote to builder_precedents
//   7. POST /:id/send                      → email letter PDF to builder, BCC Archive1Emails
//
// Deferred to follow-up commits:
//   - POST /:id/assess              (AI compliance pass — same triangulation pattern as ACC)
//   - POST /:id/match-master-plan   (fast-track precedent match)
//   - GET  /master-plans, etc.      (master plan library CRUD)
//
// All endpoints scoped to BEDROCK_MGMT_CO_ID (single-tenant for now;
// multi-tenant gate flips on franchise rollout).
// ============================================================================

const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const { safeErrorMessage } = require('./_safe_error');
const { renderBuilderLetterHTML } = require('../lib/builder_letter');
const { sendEmail } = require('../lib/notifications/email');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const EMBEDDING_MODEL = 'text-embedding-ada-002';
const SERVICE_TYPE = 'arc_builder_new_construction';
const STORAGE_BUCKET = 'documents';
const ARCHIVE_BCC = process.env.ARCHIVE_BCC_EMAIL || 'Archive1Emails@bedrocktx.com';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 12 },
});

const router = express.Router();

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function embed(text) {
  if (!text || !text.trim()) return null;
  try {
    const r = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text.replace(/\n+/g, ' ').slice(0, 8000),
    });
    return r.data[0].embedding;
  } catch (err) {
    console.warn('[builder_applications] embed failed:', err.message);
    return null;
  }
}

function communityReferencePrefix(community) {
  if (community.builder_arc_reference_prefix && community.builder_arc_reference_prefix.trim()) {
    return community.builder_arc_reference_prefix.trim().toUpperCase();
  }
  const slug = (community.slug || community.name || '').trim();
  // Take initials when slug is multi-word, else first 2-3 chars
  const words = slug.split(/[\s_-]+/).filter(Boolean);
  if (words.length >= 2) return words.map((w) => w[0]).join('').toUpperCase().slice(0, 4);
  return slug.slice(0, 3).toUpperCase();
}

async function nextBuilderReferenceNumber(community) {
  const year = new Date().getFullYear();
  const prefix = communityReferencePrefix(community);

  // Read-then-write — race-resistant under sequential staff usage. Multi-writer
  // races covered by reference_number UNIQUE constraint at the table level
  // (caller can retry on conflict; rare under expected volume).
  const { data: row } = await supabase
    .from('application_reference_counters')
    .select('counter')
    .eq('community_id', community.id)
    .eq('service_type', SERVICE_TYPE)
    .eq('year', year)
    .maybeSingle();

  const next = (row?.counter || 0) + 1;

  await supabase
    .from('application_reference_counters')
    .upsert({
      community_id: community.id,
      service_type: SERVICE_TYPE,
      year,
      counter: next,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'community_id,service_type,year' });

  return `${prefix}-BLD-${year}-${String(next).padStart(4, '0')}`;
}

// Lazy puppeteer (HTML → PDF) — same pattern as server.js:renderLetterPdfBuffer
async function renderBuilderLetterPdfBuffer(letterArgs) {
  const html = renderBuilderLetterHTML(letterArgs);
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--single-process'],
  });
  try {
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (_) { /* render anyway */ }
    return await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: true,
    });
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

function letterStoragePath({ communitySlug, year, referenceNumber }) {
  return `builders/${communitySlug}/${year}/${referenceNumber}.pdf`;
}

async function uploadLetterPdf({ pdfBuffer, communitySlug, referenceNumber }) {
  const year = new Date().getFullYear();
  const path = letterStoragePath({ communitySlug, year, referenceNumber });
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, pdfBuffer, { contentType: 'application/pdf', upsert: true });
  if (error) throw new Error(`storage upload failed: ${error.message}`);
  // Signed URL for the manager preview + email link (30-day window matches
  // the enforcement letter pattern in api/enforcement.js).
  const { data: signed, error: signErr } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(path, 60 * 60 * 24 * 30);
  return {
    path,
    signed_url: signErr ? null : (signed?.signedUrl || null),
    signed_url_expires_at: signErr ? null : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function emailSubjectFor(application, responseType) {
  const ref = application.reference_number || '';
  const propertyShort = (application.street_address || '').split(',')[0];
  if (responseType === 'denied') {
    return `Update on new construction submission ${ref} — ${propertyShort}`;
  }
  if (responseType === 'approved_with_conditions') {
    return `Conditional approval — new construction at ${propertyShort} (${ref})`;
  }
  if (responseType === 'info_requested') {
    return `Additional information requested — ${ref}`;
  }
  return `Approved — new construction at ${propertyShort} (${ref})`;
}

// Build the plaintext fallback for email clients that strip HTML.
function plaintextFromHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/p>/g, '\n\n')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Check whether an application matches an existing approved master plan
// (same builder + same plan/elevation + community in the approval list).
// Returns the master_plan_id if matched, null otherwise. Called after intake.
async function tryMatchMasterPlan({ communityId, builderCompanyId, planNumber, elevation }) {
  if (!builderCompanyId || !planNumber || !elevation) return null;
  try {
    const { data, error } = await supabase
      .from('master_plans')
      .select('id, master_plan_community_approvals!inner(community_id, retired_at)')
      .eq('builder_company_id', builderCompanyId)
      .eq('plan_number', planNumber)
      .eq('elevation', elevation)
      .eq('status', 'approved')
      .eq('master_plan_community_approvals.community_id', communityId)
      .is('master_plan_community_approvals.retired_at', null)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.warn('[builder_applications] master plan match query failed:', error.message);
      return null;
    }
    return data?.id || null;
  } catch (err) {
    console.warn('[builder_applications] master plan match threw:', err.message);
    return null;
  }
}

async function fetchCommunity(communityIdOrSlug) {
  const query = supabase
    .from('communities')
    .select('id, name, slug, builder_arc_active, builder_arc_fee_cents, builder_arc_sla_business_days, builder_arc_fast_track_business_days, builder_arc_design_guidelines_url, builder_arc_reference_prefix')
    .eq('management_company_id', BEDROCK_MGMT_CO_ID);
  if (/^[0-9a-f-]{36}$/i.test(communityIdOrSlug)) {
    return await query.eq('id', communityIdOrSlug).maybeSingle();
  }
  return await query.eq('slug', communityIdOrSlug).maybeSingle();
}

// ============================================================================
// POST /api/builder-applications
// Body: {
//   community_id | community_slug,        REQUIRED
//   builder_company_id | builder_company_name,  REQUIRED (id wins; name auto-resolves/creates)
//   submitter_email, submitter_name, submitter_phone,
//   source: 'portal' | 'email' | 'manual_entry' | 'csv_bulk_import',
//   lot_number, block_number?, section_number?, street_address, lot_type?,
//   plan_number, plan_name?, elevation, elevation_orientation?, square_footage?, stories?,
//   materials: { ... full material spec, stored in application_data },
//   target_construction_start_date?, estimated_completion_date?,
//   builder_acknowledgments: { compliance: bool, change_control: bool, signed_by, signed_at },
//   portal_user_id?,
// }
// Returns: { ok, application_id, reference_number, status }
// ============================================================================
router.post('/', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const body = req.body || {};

    const communityKey = body.community_id || body.community_slug;
    if (!communityKey) return res.status(400).json({ error: 'community_id or community_slug is required' });

    const { data: community, error: cErr } = await fetchCommunity(communityKey);
    if (cErr) throw cErr;
    if (!community) return res.status(404).json({ error: 'community not found' });
    if (!community.builder_arc_active) {
      return res.status(403).json({ error: 'builder ARC is not active for this community yet' });
    }

    // Required fields
    const required = ['submitter_email', 'lot_number', 'street_address', 'plan_number', 'elevation'];
    for (const k of required) {
      if (!body[k] || !String(body[k]).trim()) {
        return res.status(400).json({ error: `${k} is required` });
      }
    }

    // Resolve or create the builder company
    let builderCompanyId = body.builder_company_id;
    if (!builderCompanyId) {
      if (!body.builder_company_name) {
        return res.status(400).json({ error: 'builder_company_id or builder_company_name is required' });
      }
      const { data: bc } = await supabase
        .from('builder_companies')
        .select('id')
        .eq('management_company_id', BEDROCK_MGMT_CO_ID)
        .ilike('company_name', body.builder_company_name.trim())
        .maybeSingle();
      if (bc) {
        builderCompanyId = bc.id;
      } else {
        // Auto-create the builder company so first-time intake doesn't bounce
        const { data: newBc, error: bErr } = await supabase
          .from('builder_companies')
          .insert({
            management_company_id: BEDROCK_MGMT_CO_ID,
            company_name: body.builder_company_name.trim(),
            primary_contact_email: body.submitter_email,
            primary_contact_name: body.submitter_name || null,
            primary_contact_phone: body.submitter_phone || null,
            primary_email_domain: (body.submitter_email || '').split('@')[1] || null,
            notes: 'Auto-created from first submission intake. Edit details in admin.',
          })
          .select('id')
          .single();
        if (bErr) throw bErr;
        builderCompanyId = newBc.id;
      }
    }

    // Reference number (atomic per community/year)
    const referenceNumber = await nextBuilderReferenceNumber(community);

    // Insert the application
    const insertRow = {
      community_id: community.id,
      builder_company_id: builderCompanyId,
      master_plan_id: body.master_plan_id || null,
      reference_number: referenceNumber,
      submitter_email: String(body.submitter_email).toLowerCase().trim(),
      submitter_name: body.submitter_name || null,
      submitter_phone: body.submitter_phone || null,
      portal_user_id: body.portal_user_id || null,
      source: body.source || 'portal',
      lot_number: body.lot_number,
      block_number: body.block_number || null,
      section_number: body.section_number || null,
      street_address: body.street_address,
      lot_type: body.lot_type || null,
      plan_number: body.plan_number,
      plan_name: body.plan_name || null,
      elevation: body.elevation,
      elevation_orientation: body.elevation_orientation || null,
      square_footage: body.square_footage || null,
      stories: body.stories || null,
      application_data: body.materials || body.application_data || {},
      builder_acknowledgments: body.builder_acknowledgments || {},
      target_construction_start_date: body.target_construction_start_date || null,
      estimated_completion_date: body.estimated_completion_date || null,
      status: 'received',
    };

    const { data: app, error: aErr } = await supabase
      .from('builder_applications')
      .insert(insertRow)
      .select('*')
      .single();
    if (aErr) throw aErr;

    // Auto-match against the master plan library. If this builder + plan + elevation
    // is already approved at this community, flip the fast-track flag immediately
    // so the reviewer sees it on the queue without manual work.
    let matchedMasterPlanId = null;
    if (!body.master_plan_id) {
      matchedMasterPlanId = await tryMatchMasterPlan({
        communityId: community.id,
        builderCompanyId: builderCompanyId,
        planNumber: app.plan_number,
        elevation: app.elevation,
      });
      if (matchedMasterPlanId) {
        await supabase
          .from('builder_applications')
          .update({
            master_plan_id: matchedMasterPlanId,
            fast_track: true,
            fast_track_reason: 'Matched approved master plan for this community',
          })
          .eq('id', app.id);
      }
    }

    res.json({
      ok: true,
      application_id: app.id,
      reference_number: app.reference_number,
      status: app.status,
      fast_track: !!matchedMasterPlanId,
      master_plan_id: matchedMasterPlanId,
      community: { id: community.id, name: community.name, slug: community.slug },
    });
  } catch (err) {
    console.error('[builder_applications] intake failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/builder-applications/:id/attachments
// Multipart upload. Fields: kind (form field per file via fieldname),
//   files attached as 'files'. kind values per migration 080 CHECK constraint.
// ============================================================================
router.post('/:id/attachments', upload.array('files', 12), async (req, res) => {
  try {
    const { data: app, error } = await supabase
      .from('builder_applications')
      .select('id, community_id, reference_number, communities:community_id(slug)')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    if (!app) return res.status(404).json({ error: 'application not found' });

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'no files uploaded' });
    // kinds[] is a parallel array (one per file). Body comes either as
    // 'kinds' (array) or 'kind' (single value applied to all files).
    let kinds = [];
    if (Array.isArray(req.body.kinds)) kinds = req.body.kinds;
    else if (typeof req.body.kinds === 'string') kinds = [req.body.kinds];
    else if (req.body.kind) kinds = files.map(() => req.body.kind);
    else kinds = files.map(() => 'other');

    const year = new Date().getFullYear();
    const slug = app.communities?.slug || 'unknown';

    const inserted = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const kind = kinds[i] || 'other';
      const safeName = (f.originalname || `file_${i}.bin`).replace(/[^\w.\-]+/g, '_');
      const path = `builders/${slug}/${year}/${app.reference_number}/${kind}/${Date.now()}_${safeName}`;
      const up = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(path, f.buffer, { contentType: f.mimetype || 'application/octet-stream', upsert: false });
      if (up.error) {
        console.warn('[builder_applications] storage upload failed:', up.error.message);
        continue;
      }
      const { data: row } = await supabase
        .from('builder_application_attachments')
        .insert({
          application_id: app.id,
          kind,
          storage_bucket: STORAGE_BUCKET,
          storage_path: path,
          original_filename: f.originalname || null,
          mime_type: f.mimetype || null,
          size_bytes: f.size || null,
          uploaded_by: req.body.uploaded_by || null,
        })
        .select('id, kind, original_filename, size_bytes, uploaded_at')
        .single();
      if (row) inserted.push(row);
    }

    res.json({ ok: true, uploaded: inserted });
  } catch (err) {
    console.error('[builder_applications] attachment upload failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// GET /api/builder-applications
// Query: community_id?, builder_company_id?, status?, fast_track? (1|0),
//        limit? (default 50), offset?, q? (free-text search on ref/address/submitter)
// Returns: { items: [...], total }
// ============================================================================
router.get('/', async (req, res) => {
  try {
    let q = supabase
      .from('v_builder_queue')
      .select('*', { count: 'exact' })
      .order('submitted_at', { ascending: false });

    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    if (req.query.builder_company_id) q = q.eq('builder_company_id', req.query.builder_company_id);
    if (req.query.status) q = q.eq('status', req.query.status);
    if (req.query.fast_track === '1') q = q.eq('fast_track', true);
    if (req.query.q) {
      const like = `%${String(req.query.q).replace(/[%_]/g, '')}%`;
      q = q.or(`reference_number.ilike.${like},street_address.ilike.${like},submitter_email.ilike.${like},submitter_name.ilike.${like}`);
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    q = q.range(offset, offset + limit - 1);

    const { data, count, error } = await q;
    if (error) throw error;
    res.json({ items: data || [], total: count || 0, limit, offset });
  } catch (err) {
    console.error('[builder_applications] queue list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// GET /api/builder-applications/:id
// Returns full detail: application + community + builder_company + master_plan
//          + attachments + assessments + responses (latest first)
// ============================================================================
router.get('/:id', async (req, res) => {
  try {
    const [appResp, assessResp, respResp, attResp] = await Promise.all([
      supabase
        .from('builder_applications')
        .select(`
          *,
          community:communities(id, name, slug, builder_arc_design_guidelines_url, builder_arc_fee_cents, enforcement_authority_citation),
          builder_company:builder_companies(id, company_name, primary_contact_name, primary_contact_email, mailing_address),
          master_plan:master_plans!master_plan_id(id, plan_number, plan_name, elevation, status)
        `)
        .eq('id', req.params.id)
        .maybeSingle(),
      supabase
        .from('builder_application_assessments')
        .select('*')
        .eq('application_id', req.params.id)
        .order('run_at', { ascending: false }),
      supabase
        .from('builder_application_responses')
        .select('*')
        .eq('application_id', req.params.id)
        .order('decided_at', { ascending: false }),
      supabase
        .from('builder_application_attachments')
        .select('id, kind, original_filename, mime_type, size_bytes, storage_bucket, storage_path, uploaded_at, uploaded_by')
        .eq('application_id', req.params.id)
        .order('uploaded_at'),
    ]);

    if (appResp.error) throw appResp.error;
    if (!appResp.data) return res.status(404).json({ error: 'application not found' });

    res.json({
      application: appResp.data,
      assessments: assessResp.data || [],
      responses: respResp.data || [],
      attachments: attResp.data || [],
    });
  } catch (err) {
    console.error('[builder_applications] detail failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/builder-applications/:id/finalize
// Body: {
//   action: 'approve' | 'approve_with_conditions' | 'deny' | 'request_more_info',
//   conditions?:    string | string[],    REQUIRED when approve_with_conditions
//   denial_reasons?: string | string[],   REQUIRED when deny
//   message_to_builder?: string,
//   decided_by: string,                  REQUIRED
//   promote_to_precedent?: boolean,      defaults true; skipped on request_more_info
// }
//
// Atomic flow (matches the lesson from the DRV pipeline audit — render+upload
// FIRST, only THEN write the response row; if render fails, application stays
// in 'under_review' and no orphaned response row).
//
// 1) Validate
// 2) Load application + community + builder
// 3) Render letter HTML → PDF buffer
// 4) Upload PDF to documents bucket
// 5) Insert builder_application_responses row (with letter_pdf_path + signed_url)
// 6) Update builder_applications row (status, decided_at, decided_by)
// 7) Promote to builder_precedents (best-effort; failure logged not thrown)
// 8) Log to interactions (so the universal memory sink captures this letter)
// 9) Return application + response + signed URL
// ============================================================================
router.post('/:id/finalize', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const {
      action,
      conditions,
      denial_reasons,
      message_to_builder,
      decided_by,
      promote_to_precedent,
    } = req.body || {};

    if (!action) return res.status(400).json({ error: 'action is required' });
    const validActions = ['approve', 'approve_with_conditions', 'deny', 'request_more_info'];
    if (!validActions.includes(action)) return res.status(400).json({ error: 'invalid action' });
    if (!decided_by) return res.status(400).json({ error: 'decided_by is required' });
    if (action === 'approve_with_conditions' && !conditions) {
      return res.status(400).json({ error: 'conditions are required for approve_with_conditions' });
    }
    if (action === 'deny' && !denial_reasons) {
      return res.status(400).json({ error: 'denial_reasons are required for deny' });
    }

    // Load application + community + builder
    const { data: app, error: loadErr } = await supabase
      .from('builder_applications')
      .select(`
        *,
        community:communities(id, name, slug, enforcement_authority_citation),
        builder_company:builder_companies(id, company_name, primary_contact_name, primary_contact_email, mailing_address)
      `)
      .eq('id', req.params.id)
      .single();
    if (loadErr) throw loadErr;
    if (!app) return res.status(404).json({ error: 'application not found' });

    const responseType = action === 'approve' ? 'approved'
                       : action === 'approve_with_conditions' ? 'approved_with_conditions'
                       : action === 'deny' ? 'denied'
                       : 'info_requested';

    let letterPath = null;
    let signedUrl = null;
    let signedUrlExpiresAt = null;

    // request_more_info doesn't render a formal letter — managers handle that via direct email.
    if (action !== 'request_more_info') {
      const letterArgs = {
        community: app.community.name,
        builder_company_name: app.builder_company.company_name,
        builder_contact_name: app.builder_company.primary_contact_name || app.submitter_name || '',
        builder_mailing_address: app.builder_company.mailing_address || '',
        property_address: app.street_address,
        lot_number: app.lot_number,
        block_number: app.block_number,
        section_number: app.section_number,
        plan_number: app.plan_number,
        plan_name: app.plan_name,
        elevation: app.elevation,
        elevation_orientation: app.elevation_orientation,
        materials: app.application_data || {},
        reference_number: app.reference_number,
        decision_type: responseType,
        conditions,
        denial_reasons,
        signer_name: decided_by,
      };

      const pdfBuffer = await renderBuilderLetterPdfBuffer(letterArgs);
      const uploaded = await uploadLetterPdf({
        pdfBuffer,
        communitySlug: app.community.slug,
        referenceNumber: app.reference_number,
      });
      letterPath = uploaded.path;
      signedUrl = uploaded.signed_url;
      signedUrlExpiresAt = uploaded.signed_url_expires_at;
    }

    // Insert response row
    const { data: response, error: respErr } = await supabase
      .from('builder_application_responses')
      .insert({
        application_id: app.id,
        response_type: responseType,
        message_to_builder: message_to_builder || null,
        conditions: typeof conditions === 'string' ? conditions
                    : Array.isArray(conditions) ? conditions.join('\n') : null,
        denial_reasons: typeof denial_reasons === 'string' ? denial_reasons
                        : Array.isArray(denial_reasons) ? denial_reasons.join('\n') : null,
        decided_by,
        decided_at: new Date().toISOString(),
        letter_pdf_path: letterPath,
        letter_signed_url: signedUrl,
        letter_signed_url_expires_at: signedUrlExpiresAt,
        email_subject: emailSubjectFor(app, responseType),
        email_bcc_archive: true,
      })
      .select('*')
      .single();
    if (respErr) throw respErr;

    // Update application row
    const appStatus = responseType === 'approved' ? 'approved'
                    : responseType === 'approved_with_conditions' ? 'approved_with_conditions'
                    : responseType === 'denied' ? 'denied'
                    : 'info_requested';
    await supabase
      .from('builder_applications')
      .update({
        status: appStatus,
        decided_at: new Date().toISOString(),
        decided_by,
      })
      .eq('id', app.id);

    // Promote to precedent (best-effort; do not fail finalize on promotion error)
    let precedentId = null;
    const shouldPromote = (promote_to_precedent !== false) && responseType !== 'info_requested';
    if (shouldPromote) {
      try {
        const summary = message_to_builder
          ? message_to_builder.replace(/\s+/g, ' ').slice(0, 400)
          : `${app.builder_company.company_name} — Plan ${app.plan_number} Elevation ${app.elevation} at ${app.street_address}; ${responseType}.`;
        const embedSource = [
          summary,
          `Plan ${app.plan_number} Elevation ${app.elevation}`,
          conditions,
          denial_reasons,
          JSON.stringify(app.application_data || {}).slice(0, 4000),
        ].filter(Boolean).join(' — ').slice(0, 6000);
        const embedding = await embed(embedSource);

        const { data: precRow } = await supabase
          .from('builder_precedents')
          .insert({
            application_id: app.id,
            community_id: app.community_id,
            builder_company_id: app.builder_company_id,
            property_id: app.property_id,
            master_plan_id: app.master_plan_id,
            reference_number: app.reference_number,
            decision_type: responseType === 'info_requested' ? 'approved' : responseType,
            plan_number: app.plan_number,
            elevation: app.elevation,
            summary,
            reasoning: message_to_builder || null,
            conditions: typeof conditions === 'string' ? conditions
                        : Array.isArray(conditions) ? conditions.join('\n') : null,
            materials_snapshot: app.application_data || {},
            decided_at: new Date().toISOString(),
            embedding,
            embedding_model: embedding ? EMBEDDING_MODEL : null,
            extraction_confidence: 1.0,
          })
          .select('id')
          .single();
        precedentId = precRow?.id || null;
      } catch (err) {
        console.error('[builder_applications] precedent promotion failed:', err.message);
      }
    }

    // Log to interactions table (universal memory sink).
    // type='letter_other' is the closest entry in the existing CHECK list;
    // reference_number lives in original_external_id so we can match it on /send.
    try {
      await supabase.from('interactions').insert({
        community_id: app.community_id,
        property_id: app.property_id,
        type: 'letter_other',
        direction: 'outbound',
        status: 'draft',
        subject: emailSubjectFor(app, responseType),
        content: message_to_builder || null,
        delivery_method: 'email',
        attachments: letterPath ? [{
          type: 'pdf',
          storage_path: letterPath,
          label: 'Builder ARC decision letter',
          bucket: STORAGE_BUCKET,
        }] : null,
        source: 'forward',
        original_external_id: app.reference_number,
        notes: `Builder ARC ${responseType} — ${app.builder_company.company_name} • Plan ${app.plan_number} Elevation ${app.elevation} • ${app.street_address}`,
      });
    } catch (err) {
      // Non-fatal: log + continue. Finalize already succeeded by this point.
      console.warn('[builder_applications] interactions insert failed:', err.message);
    }

    res.json({
      ok: true,
      application: { id: app.id, status: appStatus, reference_number: app.reference_number },
      response,
      letter_signed_url: signedUrl,
      precedent_id: precedentId,
    });
  } catch (err) {
    console.error('[builder_applications] finalize failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/builder-applications/:id/send
// Body: { response_id? — defaults to latest response for this application,
//         to? — override recipient (defaults to builder primary contact email),
//         additional_recipients? — array of cc emails }
//
// Sends the letter PDF via Resend. Captures email_message_id + email_sent_at.
// Flips associated interaction row to status='approved' so the audit trail
// reflects the actual send.
// ============================================================================
router.post('/:id/send', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const { data: app, error: aErr } = await supabase
      .from('builder_applications')
      .select(`
        *,
        community:communities(id, name, slug),
        builder_company:builder_companies(id, company_name, primary_contact_email, primary_contact_name, mailing_address)
      `)
      .eq('id', req.params.id)
      .single();
    if (aErr) throw aErr;
    if (!app) return res.status(404).json({ error: 'application not found' });

    // Load the response row
    let response;
    if (req.body.response_id) {
      const { data } = await supabase
        .from('builder_application_responses')
        .select('*')
        .eq('id', req.body.response_id)
        .eq('application_id', app.id)
        .single();
      response = data;
    } else {
      const { data } = await supabase
        .from('builder_application_responses')
        .select('*')
        .eq('application_id', app.id)
        .order('decided_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      response = data;
    }
    if (!response) return res.status(404).json({ error: 'no response found for this application' });
    if (response.email_sent_at) return res.status(400).json({ error: 'already sent', email_sent_at: response.email_sent_at });
    if (!response.letter_pdf_path) return res.status(400).json({ error: 'no letter PDF on record (request_more_info responses do not generate a letter)' });

    // Download the PDF from storage and re-encode for Resend
    const { data: dl, error: dlErr } = await supabase.storage
      .from(STORAGE_BUCKET)
      .download(response.letter_pdf_path);
    if (dlErr) throw new Error(`failed to read letter PDF: ${dlErr.message}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    const b64 = buf.toString('base64');

    const toEmail = req.body.to || app.builder_company.primary_contact_email || app.submitter_email;
    const bcc = [ARCHIVE_BCC];

    // Render a minimal HTML email body that points to the attached PDF — actual
    // detail is in the letter. Voice matches the letter (warm on approval,
    // matter-of-fact on conditions, respectful on denial).
    const greetingName = app.builder_company.primary_contact_name || app.submitter_name || 'Team';
    const propertyShort = (app.street_address || '').split(',')[0];
    const decisionLine = response.response_type === 'denied'
      ? `Please find attached the management team's response to the new construction submission for ${propertyShort} (${app.reference_number}).`
      : response.response_type === 'approved_with_conditions'
      ? `Please find attached the conditional approval letter for ${propertyShort} (${app.reference_number}). Conditions are listed in the letter.`
      : `Please find attached the approval letter for ${propertyShort} (${app.reference_number}).`;

    const html = `
      <p>${greetingName},</p>
      <p>${decisionLine}</p>
      ${response.message_to_builder ? `<p>${response.message_to_builder.replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>` : ''}
      <p>Reference: <strong>${app.reference_number}</strong></p>
      <p>Questions or revised submissions: reply to this email or use <a href="https://builders.bedrocktxai.com">builders.bedrocktxai.com</a>.</p>
      <p style="color:#555; font-size:11px; margin-top:24px;">
        Sent on behalf of the ${app.community.name} Architectural Control Committee by Bedrock Association Management.
      </p>
    `;

    const send = await sendEmail({
      to: toEmail,
      subject: response.email_subject || emailSubjectFor(app, response.response_type),
      html,
      text: plaintextFromHtml(html),
      attachments: [{
        filename: `${app.reference_number}.pdf`,
        content: b64,
      }],
      replyTo: 'builders@bedrocktx.com',
      tags: [
        { name: 'module', value: 'arc_builder' },
        { name: 'community', value: app.community.slug || 'unknown' },
        { name: 'decision', value: response.response_type },
      ],
    });

    // Update the response row regardless of send outcome — record what was attempted
    await supabase
      .from('builder_application_responses')
      .update({
        email_sent_at: send.ok ? new Date().toISOString() : null,
        email_message_id: send.vendor_message_id || null,
      })
      .eq('id', response.id);

    // Flip the interaction status to 'sent' so the audit trail aligns.
    // Status enum: draft → approved → sent (CHECK in migration 050).
    if (send.ok) {
      await supabase
        .from('interactions')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
        })
        .eq('community_id', app.community_id)
        .eq('type', 'letter_other')
        .eq('original_external_id', app.reference_number);
    }

    if (!send.ok) {
      return res.status(send.skipped ? 503 : 502).json({
        ok: false,
        skipped: !!send.skipped,
        error: send.error || 'email send failed',
        hint: send.skipped ? 'Set RESEND_API_KEY + RESEND_FROM_EMAIL in env to enable email.' : null,
      });
    }

    res.json({
      ok: true,
      sent_to: toEmail,
      bcc,
      message_id: send.vendor_message_id || null,
      sent_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[builder_applications] send failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/builder-applications/:id/promote-to-master
// Body: { promoted_by: string, notes?: string, also_approve_other_communities?: UUID[] }
//
// Promotes the application's plan + elevation + materials into the master plan
// library, then approves it at the application's community. Idempotent: if a
// master plan already exists for (builder, plan, elevation), we attach the
// community to the existing master plan rather than creating a duplicate.
//
// Side effects:
//   - master_plans row (or reuse)
//   - master_plan_community_approvals row
//   - builder_applications.master_plan_id linked
// ============================================================================
router.post('/:id/promote-to-master', express.json({ limit: '128kb' }), async (req, res) => {
  try {
    const { promoted_by, notes, also_approve_other_communities } = req.body || {};
    if (!promoted_by) return res.status(400).json({ error: 'promoted_by is required' });

    const { data: app, error: aErr } = await supabase
      .from('builder_applications')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (aErr) throw aErr;
    if (!app) return res.status(404).json({ error: 'application not found' });
    if (!['approved', 'approved_with_conditions'].includes(app.status)) {
      return res.status(400).json({ error: 'application must be approved before promotion to master plan library' });
    }

    // Look up or create the master plan
    let masterPlanId;
    const { data: existing } = await supabase
      .from('master_plans')
      .select('id')
      .eq('builder_company_id', app.builder_company_id)
      .eq('plan_number', app.plan_number)
      .eq('elevation', app.elevation)
      .eq('elevation_orientation', app.elevation_orientation || 'standard')
      .maybeSingle();

    if (existing) {
      masterPlanId = existing.id;
      // Make sure it's marked approved (it may have been a draft)
      await supabase
        .from('master_plans')
        .update({
          status: 'approved',
          default_materials: app.application_data || {},
          square_footage: app.square_footage || null,
          stories: app.stories || null,
        })
        .eq('id', masterPlanId);
    } else {
      const { data: newPlan, error: mpErr } = await supabase
        .from('master_plans')
        .insert({
          builder_company_id: app.builder_company_id,
          plan_number: app.plan_number,
          plan_name: app.plan_name,
          elevation: app.elevation,
          elevation_orientation: app.elevation_orientation || 'standard',
          square_footage: app.square_footage,
          stories: app.stories,
          default_materials: app.application_data || {},
          status: 'approved',
          first_approval_application_id: app.id,
          notes: notes || null,
        })
        .select('id')
        .single();
      if (mpErr) throw mpErr;
      masterPlanId = newPlan.id;
    }

    // Approve at the application's community
    await supabase
      .from('master_plan_community_approvals')
      .upsert({
        master_plan_id: masterPlanId,
        community_id: app.community_id,
        approved_by: promoted_by,
        approval_notes: notes || null,
      }, { onConflict: 'master_plan_id,community_id' });

    // Optionally approve at other communities at the same time
    const extraCommunities = Array.isArray(also_approve_other_communities)
      ? also_approve_other_communities.filter(Boolean)
      : [];
    for (const cid of extraCommunities) {
      if (cid === app.community_id) continue;
      await supabase
        .from('master_plan_community_approvals')
        .upsert({
          master_plan_id: masterPlanId,
          community_id: cid,
          approved_by: promoted_by,
          approval_notes: 'Approved alongside primary promotion',
        }, { onConflict: 'master_plan_id,community_id' });
    }

    // Link the application to the master plan
    await supabase
      .from('builder_applications')
      .update({ master_plan_id: masterPlanId })
      .eq('id', app.id);

    res.json({
      ok: true,
      master_plan_id: masterPlanId,
      communities_approved: 1 + extraCommunities.length,
    });
  } catch (err) {
    console.error('[builder_applications] promote-to-master failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// GET /api/builder-applications/master-plans
// Query: builder_company_id?, community_id?, status? (draft|approved|retired)
// Returns master plans + their community approvals.
// ============================================================================
router.get('/master-plans', async (req, res) => {
  try {
    let q = supabase
      .from('master_plans')
      .select(`
        *,
        builder_company:builder_companies(id, company_name),
        community_approvals:master_plan_community_approvals(community_id, approved_at, approved_by, retired_at)
      `)
      .order('plan_number');

    if (req.query.builder_company_id) q = q.eq('builder_company_id', req.query.builder_company_id);
    if (req.query.status) q = q.eq('status', req.query.status);

    const { data, error } = await q;
    if (error) throw error;

    let plans = data || [];
    if (req.query.community_id) {
      plans = plans.filter((p) => (p.community_approvals || [])
        .some((a) => a.community_id === req.query.community_id && !a.retired_at));
    }

    res.json({ master_plans: plans, total: plans.length });
  } catch (err) {
    console.error('[builder_applications] master plans list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/builder-applications/master-plans/:id/retire
// Body: { retired_by, retired_reason, community_id? }
// If community_id given, retire ONLY that community approval (leaves the master
// plan active for other communities). Without it, retire the master plan globally.
// ============================================================================
router.post('/master-plans/:id/retire', express.json({ limit: '128kb' }), async (req, res) => {
  try {
    const { retired_by, retired_reason, community_id } = req.body || {};
    if (!retired_by) return res.status(400).json({ error: 'retired_by is required' });

    if (community_id) {
      await supabase
        .from('master_plan_community_approvals')
        .update({
          retired_at: new Date().toISOString(),
          retired_by,
          retired_reason: retired_reason || null,
        })
        .eq('master_plan_id', req.params.id)
        .eq('community_id', community_id);
    } else {
      await supabase
        .from('master_plans')
        .update({ status: 'retired' })
        .eq('id', req.params.id);
    }

    res.json({ ok: true, scope: community_id ? 'community' : 'global' });
  } catch (err) {
    console.error('[builder_applications] master plan retire failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// GET /api/builder-applications/public/community/:slug
// Public endpoint — returns the community's builder-ARC config so the
// /builders/:slug submission form can render the right copy + guidelines link.
// Returns 404 if the community doesn't exist OR has builder ARC turned off
// (kill switch: builder_arc_active=FALSE), preventing form-submission attempts
// against a non-enabled community.
// ============================================================================
router.get('/public/community/:slug', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('communities')
      .select('id, name, slug, builder_arc_active, builder_arc_fee_cents, builder_arc_sla_business_days, builder_arc_fast_track_business_days, builder_arc_design_guidelines_url')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('slug', req.params.slug)
      .maybeSingle();
    if (error) throw error;
    if (!data || !data.builder_arc_active) return res.status(404).json({ error: 'community not accepting builder submissions' });
    res.json({
      community: {
        id: data.id,
        name: data.name,
        slug: data.slug,
        fee_cents: data.builder_arc_fee_cents,
        sla_business_days: data.builder_arc_sla_business_days,
        fast_track_business_days: data.builder_arc_fast_track_business_days,
        design_guidelines_url: data.builder_arc_design_guidelines_url,
      },
    });
  } catch (err) {
    console.error('[builder_applications] community lookup failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// GET /api/builder-applications/public/status/:reference
// Public endpoint — anyone with the reference number can check status.
// No PII surfaced beyond what the builder already knew (their own submission).
// ============================================================================
router.get('/public/status/:reference', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('builder_applications')
      .select('reference_number, status, fast_track, submitted_at, decided_at, community:communities(name)')
      .eq('reference_number', req.params.reference)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not found' });
    res.json({
      reference_number: data.reference_number,
      status: data.status,
      fast_track: data.fast_track,
      submitted_at: data.submitted_at,
      decided_at: data.decided_at,
      community: data.community?.name || null,
    });
  } catch (err) {
    console.error('[builder_applications] status check failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
