// ============================================================================
// api/master_plan_submissions.js — builder-side master plan submissions
// ----------------------------------------------------------------------------
// Mounted at /api/master-plan-submissions
//
// Different from /api/builder-applications:
//   • Builder-applications = per-lot submissions (lot, block, section,
//     address required, references an already-approved master_plan).
//   • Master-plan-submissions = a builder proposes adding NEW master plans
//     to the catalog. No lot. The submission has multiple plans + elevations
//     in one PDF. On approval, the extracted plans become master_plans rows.
//
// Endpoints:
//   POST   /                            — create submission (multipart, with PDF)
//   GET    /                            — list submissions (filter by community/builder/status)
//   GET    /:id                         — detail
//   GET    /public/community/:slug      — community settings for the builder form
//                                         (review fee, design guidelines, etc.)
//
// Extract + finalize endpoints (staff-side AI extraction + approval flow)
// are queued for the next session. For now, staff can use the existing
// /api/builder-applications/master-plans/bulk-extract on the attached PDF
// directly, then mark this submission approved via PATCH.
// ============================================================================

const express = require('express');
const multer = require('multer');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const STORAGE_BUCKET = 'documents';
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

// Master plan PDFs are larger than per-lot PDFs (full plan set with all
// elevations, often 40-150 pages, can be 12+ MB). Generous limits.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: 6 },
});

// ----------------------------------------------------------------------------
// Reference number minting: SCR-MPS-2026-NNNN
// ----------------------------------------------------------------------------
async function nextReferenceNumber(community) {
  const year = new Date().getFullYear();
  const prefix = (community.builder_arc_reference_prefix
    || (community.slug || community.name || '').split(/[\s_-]+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase().slice(0, 4)
    || 'BLD').trim().toUpperCase();

  const { data: row } = await supabase
    .from('application_reference_counters')
    .select('counter')
    .eq('community_id', community.id)
    .eq('service_type', 'master_plan_submission')
    .eq('year', year)
    .maybeSingle();
  const next = (row?.counter || 0) + 1;

  await supabase
    .from('application_reference_counters')
    .upsert({
      community_id: community.id,
      service_type: 'master_plan_submission',
      year,
      counter: next,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'community_id,service_type,year' });

  return `${prefix}-MPS-${year}-${String(next).padStart(4, '0')}`;
}

// ----------------------------------------------------------------------------
// POST / — create a master plan submission
//
// Multipart fields:
//   community_slug          (required)
//   builder_company_name    (required)
//   submitter_email         (required)
//   submitter_name          (optional)
//   submitter_phone         (optional)
//   submission_title        (required) — e.g., "Lennar Classic 4 Side Q3 Addition"
//   plan_numbers_proposed   (required) — JSON array string OR comma-separated
//   description             (optional)
//   builder_acknowledgments (JSON string)
//   files                   (multipart, 1+ PDFs)
// ----------------------------------------------------------------------------
router.post('/', upload.array('files', 6), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.community_slug)       return res.status(400).json({ error: 'community_slug is required' });
    if (!b.builder_company_name) return res.status(400).json({ error: 'builder_company_name is required' });
    if (!b.submitter_email)      return res.status(400).json({ error: 'submitter_email is required' });
    if (!b.submission_title)     return res.status(400).json({ error: 'submission_title is required' });

    // Resolve community
    const { data: community, error: commErr } = await supabase
      .from('communities')
      .select('id, name, slug, builder_arc_reference_prefix, builder_arc_fee_cents, builder_arc_design_guidelines_url, management_company_id')
      .eq('slug', b.community_slug)
      .maybeSingle();
    if (commErr) throw commErr;
    if (!community) return res.status(404).json({ error: 'community not found' });
    if (community.management_company_id !== BEDROCK_MGMT_CO_ID) {
      return res.status(403).json({ error: 'community is not Bedrock-managed' });
    }

    // Resolve builder
    const { data: builder } = await supabase
      .from('builder_companies')
      .select('id, company_name')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .ilike('company_name', b.builder_company_name)
      .maybeSingle();
    if (!builder) return res.status(404).json({ error: 'builder company not recognized' });

    // Parse plan_numbers_proposed (accepts JSON array OR comma-separated string)
    let planNumbers = [];
    if (b.plan_numbers_proposed) {
      try {
        const parsed = JSON.parse(b.plan_numbers_proposed);
        if (Array.isArray(parsed)) planNumbers = parsed;
      } catch (_) {
        planNumbers = String(b.plan_numbers_proposed).split(/[,\s]+/).filter(Boolean);
      }
    }
    planNumbers = planNumbers.map((p) => String(p).trim()).filter(Boolean);

    // Mint reference number FIRST so we can use it in the storage path
    const referenceNumber = await nextReferenceNumber(community);

    // Optional portal_user link from authenticated session (if any)
    let portalUserId = null;
    try {
      const { decodeCookie } = require('./portal/_cookie');
      const decoded = decodeCookie && decodeCookie(req);
      if (decoded?.portal_user_id) portalUserId = decoded.portal_user_id;
    } catch (_) {}

    // Parse acknowledgments (optional JSON)
    let acknowledgments = {};
    if (b.builder_acknowledgments) {
      try { acknowledgments = JSON.parse(b.builder_acknowledgments); } catch (_) {}
    }

    // Create the submission row
    const { data: submission, error: insErr } = await supabase
      .from('master_plan_submissions')
      .insert({
        community_id: community.id,
        builder_company_id: builder.id,
        reference_number: referenceNumber,
        submitter_email: String(b.submitter_email).trim(),
        submitter_name: b.submitter_name || null,
        submitter_phone: b.submitter_phone || null,
        portal_user_id: portalUserId,
        source: 'portal',
        submission_title: String(b.submission_title).trim(),
        plan_numbers_proposed: planNumbers,
        description: b.description || null,
        builder_acknowledgments: acknowledgments,
        status: 'received',
      })
      .select('id, reference_number')
      .single();
    if (insErr) throw insErr;

    // Upload attachments
    const files = req.files || [];
    const uploadedAttachments = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const safeName = (f.originalname || `plan_${i}.pdf`).replace(/[^\w.\-]+/g, '_');
      const storagePath = `builders/${community.slug}/master-plan-submissions/${new Date().getFullYear()}/${submission.reference_number}/${Date.now()}_${i}_${safeName}`;

      const up = await supabase.storage.from(STORAGE_BUCKET)
        .upload(storagePath, f.buffer, { contentType: f.mimetype || 'application/pdf', upsert: false });
      if (up.error) {
        console.warn('[master_plan_submissions] storage upload failed:', up.error.message);
        continue;
      }
      const { data: attRow, error: attErr } = await supabase
        .from('master_plan_submission_attachments')
        .insert({
          submission_id: submission.id,
          kind: 'master_plan_pdf',
          storage_bucket: STORAGE_BUCKET,
          storage_path: storagePath,
          original_filename: f.originalname || null,
          mime_type: f.mimetype || null,
          size_bytes: f.size || null,
          uploaded_by: b.submitter_email || null,
        })
        .select('id, kind, original_filename, size_bytes')
        .single();
      if (attErr) {
        try { await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]); } catch (_) {}
        console.warn('[master_plan_submissions] attachment insert failed:', attErr.message);
        continue;
      }
      uploadedAttachments.push(attRow);
    }

    // Fire-and-forget notification to Bedrock ARC inbox so staff know a new
    // submission landed. Best-effort — don't block the response on email.
    (async () => {
      try {
        const { sendEmail, isConfigured } = require('../lib/notifications/email');
        if (!isConfigured()) return;
        const subject = `[${referenceNumber}] New master plan submission — ${builder.company_name} at ${community.name}`;
        const planList = planNumbers.length ? planNumbers.join(', ') : '(not specified at submission time)';
        await sendEmail({
          to: 'acc@bedrocktx.com',
          subject,
          html: `<p>A new master plan submission has been received.</p>
            <ul>
              <li><strong>Reference:</strong> ${referenceNumber}</li>
              <li><strong>Community:</strong> ${community.name}</li>
              <li><strong>Builder:</strong> ${builder.company_name}</li>
              <li><strong>Submitter:</strong> ${b.submitter_name || ''} &lt;${b.submitter_email}&gt;</li>
              <li><strong>Title:</strong> ${b.submission_title}</li>
              <li><strong>Plans proposed:</strong> ${planList}</li>
              <li><strong>Attachments:</strong> ${uploadedAttachments.length}</li>
            </ul>
            <p>Review in trustEd Admin &gt; ARC review queue.</p>`,
          text: `New master plan submission ${referenceNumber}\nCommunity: ${community.name}\nBuilder: ${builder.company_name}\nSubmitter: ${b.submitter_email}\nTitle: ${b.submission_title}\nPlans proposed: ${planList}\n`,
        });
      } catch (e) {
        console.warn('[master_plan_submissions] notify email failed:', e.message);
      }
    })();

    res.json({
      submission_id: submission.id,
      reference_number: submission.reference_number,
      attachments: uploadedAttachments,
    });
  } catch (err) {
    console.error('[master_plan_submissions] create failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET / — list submissions
//   ?community_id=  optional
//   ?builder_company_id= optional
//   ?status= optional
// ----------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    let q = supabase
      .from('master_plan_submissions')
      .select(`
        id, reference_number, submission_title, plan_numbers_proposed,
        submitter_name, submitter_email, status,
        submitted_at, decided_at, decided_by,
        community:communities(id, name, slug),
        builder_company:builder_companies(id, company_name)
      `)
      .order('submitted_at', { ascending: false })
      .limit(200);
    if (req.query.community_id)        q = q.eq('community_id', req.query.community_id);
    if (req.query.builder_company_id)  q = q.eq('builder_company_id', req.query.builder_company_id);
    if (req.query.status)              q = q.eq('status', req.query.status);

    const { data, error } = await q;
    if (error) throw error;
    res.json({ submissions: data || [] });
  } catch (err) {
    console.error('[master_plan_submissions] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /:id — detail
// ----------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const { data: submission, error } = await supabase
      .from('master_plan_submissions')
      .select(`
        *,
        community:communities(id, name, slug),
        builder_company:builder_companies(id, company_name, primary_contact_name, primary_contact_email)
      `)
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!submission) return res.status(404).json({ error: 'submission not found' });

    const { data: attachments } = await supabase
      .from('master_plan_submission_attachments')
      .select('id, kind, storage_path, original_filename, mime_type, size_bytes, uploaded_at')
      .eq('submission_id', submission.id)
      .order('uploaded_at', { ascending: true });

    res.json({ submission, attachments: attachments || [] });
  } catch (err) {
    console.error('[master_plan_submissions] detail failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /public/community/:slug — surfaces community context for the builder
// submission form (review fee, design guidelines URL, etc.). Mirrors the
// /api/builder-applications/public/community/:slug shape.
// ----------------------------------------------------------------------------
router.get('/public/community/:slug', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('communities')
      .select('id, name, slug, builder_arc_fee_cents, builder_arc_design_guidelines_url')
      .eq('slug', req.params.slug)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'community not found' });
    res.json({
      community: {
        id: data.id, name: data.name, slug: data.slug,
        fee_cents: data.builder_arc_fee_cents || null,
        design_guidelines_url: data.builder_arc_design_guidelines_url || null,
      },
    });
  } catch (err) {
    console.error('[master_plan_submissions] public/community failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
