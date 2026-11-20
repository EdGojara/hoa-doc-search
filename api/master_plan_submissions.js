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
const { publicUpload } = require('../lib/uploads/public_upload');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const STORAGE_BUCKET = 'documents';
const { BEDROCK_MGMT_CO_ID } = require('../lib/company');

// Master plan PDFs are larger than per-lot PDFs (full plan set with all
// elevations, often 40-150 pages, can be 12+ MB). Generous limits.
// Public (no-login) builder intake.
const upload = publicUpload({
  route: 'master-plan-submissions.public',
  fileSize: 40 * 1024 * 1024,
  files: 6,
  maxTotalBytes: 150 * 1024 * 1024,
});

// ----------------------------------------------------------------------------
// Reference number minting: SCR-MPS-2026-NNNN
// ----------------------------------------------------------------------------
async function nextReferenceNumber(community) {
  const year = new Date().getFullYear();
  const prefix = (community.builder_arc_reference_prefix
    || (community.slug || community.name || '').split(/[\s_-]+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase().slice(0, 4)
    || 'BLD').trim().toUpperCase();
  // Atomic counter via migration 225 RPC. Drift-protected across all four
  // tables that share application_reference_counters.
  const { data: counter, error } = await supabase.rpc('next_application_counter', {
    p_community_id: community.id,
    p_service_type: 'master_plan_submission',
    p_year:         year,
    p_prefix:       prefix,
    p_infix:        '-MPS-',
  });
  if (error) throw new Error(`reference number allocation failed: ${error.message}`);
  if (typeof counter !== 'number' || counter < 1) {
    throw new Error(`reference number allocation returned invalid value: ${counter}`);
  }
  return `${prefix}-MPS-${year}-${String(counter).padStart(4, '0')}`;
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
// Public path for builder intake (no staff cookie). The bare path is
// reserved for staff list / staff actions and stays cookie-gated.
router.post('/public', upload.array('files', 6), async (req, res) => {
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

    // Optional portal_user link from authenticated session (if any).
    //
    // This required './portal/_cookie', a module that has never existed, for a
    // function named decodeCookie that has never existed either. The require sat
    // inside a bare try/catch, so it threw MODULE_NOT_FOUND on every submission
    // and was swallowed: portalUserId was ALWAYS null and every master plan
    // submission lost its link to the builder's portal account. Nothing ever
    // surfaced, because a silent catch around a missing module looks exactly
    // like "no session". (Found 2026-08-21 by scripts/check_requires_tracked.js.)
    //
    // The real resolver is exported from api/portal.js. Required lazily to keep
    // the two modules from importing each other at load time.
    let portalUserId = null;
    try {
      const { resolvePortalUser } = require('./portal');
      const { portalUserId: id } = resolvePortalUser(req) || {};
      if (id) portalUserId = id;
    } catch (e) {
      console.warn('[master_plan_submissions] portal session lookup failed:', e.message);
    }

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

    // Fire-and-forget RECEIPT to the builder so they know it landed without
    // having to email and ask (Ed 2026-06-18: Teresa C. emailed to verify her
    // 6/12 submissions — there was no confirmation back to her). Best-effort.
    (async () => {
      try {
        const { sendEmail, isConfigured } = require('../lib/notifications/email');
        if (!isConfigured() || !b.submitter_email) return;
        const firstName = (b.submitter_name || '').trim().split(/\s+/)[0] || 'there';
        const planLine = planNumbers.length
          ? `Plans: ${planNumbers.join(', ')}.`
          : '';
        const attLine = uploadedAttachments.length
          ? `${uploadedAttachments.length} file${uploadedAttachments.length === 1 ? '' : 's'} came through.`
          : 'No files were attached — reply to this email if you meant to include plans.';
        await sendEmail({
          to: b.submitter_email,
          bcc: 'acc@bedrocktx.com',
          subject: `Got it — master plan submission received (${referenceNumber})`,
          html: `<p>Hi ${firstName},</p>
            <p>Confirming we received your master plan submission for <strong>${community.name}</strong>. Here's your reference number to hold onto:</p>
            <p style="font-size:18px; font-weight:700; color:#0B1D34; margin:14px 0;">${referenceNumber}</p>
            <p>${b.submission_title ? `<strong>${b.submission_title}</strong> — ` : ''}${attLine} ${planLine}</p>
            <p>It's in our review queue now and we'll follow up as it's processed. Questions in the meantime — just reply here or reach us at <a href="mailto:builders@bedrocktx.com">builders@bedrocktx.com</a>.</p>
            <p style="margin-top:18px;">Bedrock Association Management<br>
            <span style="color:#94a3b8; font-size:12px;">community simplified.</span></p>`,
          text: `Hi ${firstName},\n\nConfirming we received your master plan submission for ${community.name}. Reference: ${referenceNumber}. ${attLine} ${planLine}\n\nIt's in our review queue now and we'll follow up as it's processed. Questions — reply here or builders@bedrocktx.com.\n\nBedrock Association Management\ncommunity simplified.`,
        });
      } catch (e) {
        console.warn('[master_plan_submissions] builder receipt email failed:', e.message);
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
// ----------------------------------------------------------------------------
// MASTER PLAN SETS (Ed 2026-11-20): review and approve a builder's related
// submissions together (e.g. Lennar's nine Woodbridge plans for Still Creek
// Ranch) on one screen, with one owner action.
//
//   GET  /set?refs=REF,REF,...       staff: plans, drawings, Annie's review, issues
//   POST /set/approve                OWNER ONLY (Ed's signed-in account):
//        { refs[], conditions[], to[], cc[] }
//        1. each submission through finalizeSubmission (plans into the catalog,
//           approved at the community, its own letter, status + decided_by),
//        2. ONE combined approval letter for the set,
//        3. ONE email from Annie's Microsoft 365 mailbox (approved signature)
//           to the builder and developer contacts: the letter attached, the
//           approved drawings linked (the set is too large to attach),
//        4. the outbound email and the decision recorded on every submission.
//   Nothing is approved until Ed presses Approve; the page never decides.
// ----------------------------------------------------------------------------
const SET_STATUSES_OPEN = ['received', 'under_review', 'info_requested'];
const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Standard conditions, from the Still Creek Ranch Design Guidelines (2019)
// and Declaration; prefilled on the page and editable before approval.
const SCR_STANDARD_CONDITIONS = [
  'Front-loaded garages shall not protrude more than 15 feet from the front plane of the main house (Design Guidelines, Garages); each lot submission shall show this dimension.',
  'Main roof pitch shall be between 5:12 and 12:12, patio and shed roofs at least 3:12, with earth-tone shingles and fascia at least 6 inches nominal (Design Guidelines, Roof Form).',
  'First-floor front and side walls shall be brick, stone or stucco; on two-story homes the front elevation shall be predominantly masonry with a corner wrap of at least 2 feet (Design Guidelines, Exterior Materials).',
  'Roof penetrations shall not be visible from the front street, and reflective glass is prohibited (Design Guidelines).',
  'Each lot submission shall identify the approved plan, elevation, and exterior materials and colors.',
];

function setRefs(raw) {
  return [...new Set(String(raw || '').split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z0-9]+-MPS-\d{4}-\d{4}$/.test(x)))].slice(0, 40);
}

async function loadSet(refs) {
  const { data, error } = await supabase
    .from('master_plan_submissions')
    .select(`id, reference_number, submission_title, plan_numbers_proposed, submitter_name, submitter_email, status,
      submitted_at, decided_at, decided_by, decision_notes, extracted_plans, plans_extracted_at, ai_extraction, letter_pdf_path,
      community_id, builder_company_id,
      community:communities(id, name, slug),
      builder_company:builder_companies(id, company_name, primary_contact_name, primary_contact_email, mailing_address)`)
    .in('reference_number', refs)
    .order('reference_number');
  if (error) throw error;
  return data || [];
}

function setIssues(subs) {
  const out = [];
  for (const s of subs) {
    const rv = (s.ai_extraction && s.ai_extraction.annie_review) || null;
    if (!Array.isArray(s.extracted_plans) || !s.extracted_plans.length) out.push({ ref: s.reference_number, severity: 'blocking', text: 'No plan/elevation list has been read from the drawings yet.' });
    if (!rv) out.push({ ref: s.reference_number, severity: 'blocking', text: 'Annie has not reviewed this plan yet.' });
    if (rv && rv.recommendation && !/^approve/.test(rv.recommendation)) out.push({ ref: s.reference_number, severity: 'blocking', text: `Annie recommends: ${rv.recommendation.replace(/_/g, ' ')}.` });
    for (const i of (rv && rv.issues) || []) if (i.severity === 'blocking') out.push({ ref: s.reference_number, severity: 'blocking', text: i.text });
    if (!SET_STATUSES_OPEN.includes(s.status)) out.push({ ref: s.reference_number, severity: 'blocking', text: `Already ${s.status}${s.decided_at ? ' on ' + String(s.decided_at).slice(0, 10) : ''}.` });
    // The drawings vs the portal entry and vs Annie's read: a mismatch is shown, not hidden.
    const proposed = (Array.isArray(s.plan_numbers_proposed) ? s.plan_numbers_proposed : []).map((x) => String(x).toUpperCase());
    const read = [...new Set((s.extracted_plans || []).map((p) => String(p.plan_number || '').toUpperCase()))];
    if (proposed.length && read.length && !read.some((r) => proposed.some((p) => r.startsWith(p)))) out.push({ ref: s.reference_number, severity: 'check', text: `Plan number on the portal (${proposed.join(', ')}) does not match the drawings (${read.join(', ')}).` });
    if (rv && Array.isArray(rv.elevations) && rv.elevations.length) {
      const ext = [...new Set((s.extracted_plans || []).map((p) => String(p.elevation || '').toUpperCase()))].sort().join(', ');
      const ann = [...new Set(rv.elevations.map((e) => String(e).toUpperCase()))].sort().join(', ');
      if (ext && ann && ext !== ann) out.push({ ref: s.reference_number, severity: 'check', text: `Elevations read differently: plan list ${ext}; Annie's review ${ann}. Confirm against the drawings; the approval uses the plan list.` });
    }
    const t = String(s.submission_title || '').toLowerCase().replace(/[^a-z]/g, '');
    const n = [...new Set((s.extracted_plans || []).map((p) => String(p.plan_name || '').toLowerCase().replace(/[^a-z]/g, '')))];
    if (t && n.length && !n.includes(t)) out.push({ ref: s.reference_number, severity: 'check', text: `Plan name on the portal ("${s.submission_title}") differs from the drawings ("${[...new Set((s.extracted_plans || []).map((p) => p.plan_name))].join(', ')}"); the letter uses the drawings.` });
  }
  return out;
}

router.get('/set', async (req, res) => {
  try {
    const refs = setRefs(req.query.refs);
    if (!refs.length) return res.status(400).json({ error: 'refs_required' });
    const subs = await loadSet(refs);
    const missing = refs.filter((r) => !subs.some((s) => s.reference_number === r));
    const items = [];
    for (const s of subs) {
      const { data: atts, error: ae } = await supabase.from('master_plan_submission_attachments')
        .select('id, storage_bucket, storage_path, original_filename, mime_type, size_bytes').eq('submission_id', s.id).order('uploaded_at');
      if (ae) throw ae;
      const files = [];
      for (const a of atts || []) {
        const { data: sg } = await supabase.storage.from(a.storage_bucket || STORAGE_BUCKET).createSignedUrl(a.storage_path, 60 * 60 * 4);
        files.push({ name: a.original_filename, size_bytes: a.size_bytes, url: sg && sg.signedUrl });
      }
      items.push({
        id: s.id, reference_number: s.reference_number, title: s.submission_title, status: s.status, submitted_at: s.submitted_at,
        decided_at: s.decided_at, decided_by: s.decided_by, plans: s.extracted_plans || [],
        review: (s.ai_extraction && s.ai_extraction.annie_review) || null, files,
      });
    }
    const first = subs[0] || {};
    const sameGroup = subs.every((s) => s.community_id === first.community_id && s.builder_company_id === first.builder_company_id);
    const issues = setIssues(subs);
    if (!sameGroup) issues.unshift({ ref: '*', severity: 'blocking', text: 'These submissions are not all from the same builder and community.' });
    for (const r of missing) issues.unshift({ ref: r, severity: 'blocking', text: 'Submission not found.' });
    const recs = items.map((i) => (i.review && i.review.recommendation) || 'not reviewed');
    res.json({
      community: first.community || null, builder: first.builder_company || null, items, issues, missing,
      recommendation: recs.every((r) => r === 'approve') ? 'approve' : recs.every((r) => /^approve/.test(r)) ? 'approve_with_conditions' : 'needs_attention',
      proposed_conditions: first.community && /still creek/i.test(first.community.name) ? SCR_STANDARD_CONDITIONS : [],
      proposed_to: [...new Set(subs.map((s) => s.submitter_email).filter(Boolean))],
      ready: !issues.some((i) => i.severity === 'blocking'),
    });
  } catch (err) {
    console.error('[master_plan_submissions] set load failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/set/approve', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const { requireOwner } = require('./_require_admin');
    const owner = await requireOwner(req, res); if (!owner) return;
    const b = req.body || {};
    const refs = setRefs(Array.isArray(b.refs) ? b.refs.join(',') : b.refs);
    const conditions = (Array.isArray(b.conditions) ? b.conditions : []).map((c) => String(c).trim()).filter(Boolean);
    const to = [...new Set((b.to || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
    const cc = [...new Set((b.cc || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))].filter((x) => !to.includes(x));
    if (!refs.length) return res.status(400).json({ error: 'refs_required' });
    if (!to.length || [...to, ...cc].some((x) => !EMAIL_RX.test(x))) return res.status(400).json({ error: 'valid recipient emails are required' });

    // Everything is checked before anything is approved.
    const subs = await loadSet(refs);
    if (subs.length !== refs.length) return res.status(409).json({ error: 'some submissions were not found', missing: refs.filter((r) => !subs.some((s) => s.reference_number === r)) });
    const blocking = setIssues(subs).filter((i) => i.severity === 'blocking');
    if (blocking.length) return res.status(409).json({ error: 'the set is not ready to approve', issues: blocking });
    const first = subs[0];
    if (!subs.every((s) => s.community_id === first.community_id && s.builder_company_id === first.builder_company_id)) return res.status(409).json({ error: 'mixed builders or communities' });

    const decidedBy = owner.full_name || 'Ed Gojara';
    const action = conditions.length ? 'approve_with_conditions' : 'approve';
    const results = [];
    for (const s of subs) {
      const r = await finalizeSubmission(s.id, { action, approved_plans: s.extracted_plans, conditions: conditions.length ? conditions : null, decided_by: decidedBy, notify: false });
      results.push({ ref: s.reference_number, status: r.status, plans: (r.created_master_plan_ids || []).length });
    }

    // One combined letter for the set.
    const allPlans = subs.flatMap((s) => s.extracted_plans);
    const names = [...new Set(allPlans.map((p) => p.plan_name).filter(Boolean))];
    const setRef = `${subs[0].reference_number} to ${subs[subs.length - 1].reference_number}`;
    const title = String(b.title || '').trim() || `${names.length} master plans (${names.join(', ')})`;
    const pdf = await renderMasterPlanLetterPdfBuffer({
      community: first.community.name, builder_company_name: first.builder_company.company_name,
      builder_contact_name: subs[0].submitter_name || first.builder_company.primary_contact_name || '',
      builder_mailing_address: first.builder_company.mailing_address || '',
      submission_title: title, reference_number: setRef, approved_plans: allPlans,
      decision_type: conditions.length ? 'approved_with_conditions' : 'approved', conditions: conditions.length ? conditions : null, signer_name: decidedBy,
    });
    const year = new Date().getFullYear();
    const letterName = `${subs[0].reference_number}_to_${subs[subs.length - 1].reference_number.split('-').pop()}_approval.pdf`;
    const letterPath = `builders/${first.community.slug}/master-plan-submissions/${year}/${letterName}`;
    const up = await supabase.storage.from(STORAGE_BUCKET_LETTER).upload(letterPath, pdf, { contentType: 'application/pdf', upsert: true });
    if (up.error) throw new Error('combined letter upload: ' + up.error.message);

    // Approved drawings: linked (the full set is far over email size limits).
    const links = [];
    for (const s of subs) {
      const { data: atts } = await supabase.from('master_plan_submission_attachments').select('storage_bucket, storage_path, original_filename').eq('submission_id', s.id).order('uploaded_at');
      for (const a of atts || []) {
        const { data: sg } = await supabase.storage.from(a.storage_bucket || STORAGE_BUCKET).createSignedUrl(a.storage_path, 60 * 60 * 24 * 30);
        if (sg && sg.signedUrl) links.push({ name: a.original_filename, url: sg.signedUrl });
      }
    }
    const g = require('../lib/email/graph_send');
    const { buildPersonaEmail } = require('../lib/email/persona_signature');
    const subject = `${first.community.name} – ${first.builder_company.company_name} master plans approved (${setRef})`;
    const body = [
      'Hello,',
      `The ${first.community.name} Architectural Review Committee has approved the following ${first.builder_company.company_name} master plans${conditions.length ? ', subject to the conditions in the attached letter' : ''}:`,
      names.map((n) => `• ${n}: elevations ${[...new Set(allPlans.filter((p) => p.plan_name === n).map((p) => p.elevation))].join(', ')}`).join('\n'),
      'The approval letter is attached. The approved drawings are available at the links below for the next 30 days.',
      links.map((l) => `${l.name}: ${l.url}`).join('\n'),
      'Lot submissions that use these plans can now be made through the builder portal.',
      'Thank you,',
    ].join('\n\n');
    const built = buildPersonaEmail('annie', body, first.community.name);
    const sent = await g.sendAs({
      from: g.ANNIE_MAILBOX, to: to.join(','), cc: cc.length ? cc.join(',') : undefined, subject, html: built.html,
      attachments: [...(built.attachments || []), { '@odata.type': '#microsoft.graph.fileAttachment', name: letterName, contentType: 'application/pdf', contentBytes: pdf.toString('base64') }],
      communityId: first.community_id,
    });
    if (!sent || !sent.sent) return res.status(502).json({ error: 'plans approved but the email was not accepted', results, letter_path: letterPath, send: sent });

    const now = new Date().toISOString();
    const log = await supabase.from('email_messages').insert({
      mailbox: g.ANNIE_MAILBOX, direction: 'outbound', sender_email: g.ANNIE_MAILBOX, sender_name: 'Annie Reeves (Bedrock AI)',
      recipients: [...to, ...cc], subject, body_preview: body.slice(0, 400), body_full: body, classification: 'outbound_reply', classification_confidence: 'high',
      persona: 'annie', community_id: first.community_id, triage_status: 'handled', record_ownership: 'association_record', reviewed_at: now, received_at: now,
      ai_summary: `Master plan set ${setRef} approved by ${decidedBy}; approval letter sent to ${[...to, ...cc].join(', ')}`,
    });
    if (log.error) console.warn('[master_plan_submissions] set email log failed:', log.error.message);
    for (const s of subs) {
      const ax = { ...(s.ai_extraction || {}), set_decision: { set: setRef, approved_by: decidedBy, approved_at: now, letter_path: letterPath, emailed_to: to, cc, internet_message_id: sent.internetMessageId || null } };
      const u = await supabase.from('master_plan_submissions').update({ ai_extraction: ax }).eq('id', s.id);
      if (u.error) console.warn('[master_plan_submissions] set record failed:', s.reference_number, u.error.message);
    }
    res.json({ ok: true, results, letter_path: letterPath, emailed_to: to, cc, internet_message_id: sent.internetMessageId || null });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.error('[master_plan_submissions] set approve failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /api/master-plan-submissions/:id/letter — the letter's permanent address.
//
// Same fix, same reason as builder-applications/:id/letter. The stored
// letter_signed_url is a 30-DAY signed URL captured at decision time, and
// master-plan-submissions-admin.html renders it straight into an href — so the
// link quietly dies a month after the decision while the PDF sits safely in
// storage forever. Re-sign on every hit instead of handing out URLs with a
// shelf life. (Ed 2026-07-15: "i don't want letter to disappear they should
// stay available".)
router.get('/:id/letter', async (req, res, next) => {
  try {
    const { data: sub, error } = await supabase
      .from('master_plan_submissions')
      .select('letter_pdf_path')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!sub || !sub.letter_pdf_path) return res.status(404).json({ error: 'no_letter_on_file', detail: 'No decision letter has been generated for this submission yet.' });
    const { data: signed, error: sErr } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(sub.letter_pdf_path, 60 * 10);
    if (sErr || !signed || !signed.signedUrl) throw new Error((sErr && sErr.message) || 'could not sign the letter');
    return res.redirect(302, signed.signedUrl);
  } catch (err) {
    console.error('[master_plan_submissions] letter fetch failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

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
// POST /:id/extract-plans — staff — read the submitted PDF and return the
// structured plan/elevation rows so the approval screen pre-fills (Ed
// 2026-06-18: no retyping what's already in the document). Caches the result on
// the submission; pass ?force=1 to re-read.
// ----------------------------------------------------------------------------
router.post('/:id/extract-plans', async (req, res) => {
  try {
    const { data: submission, error } = await supabase
      .from('master_plan_submissions')
      .select('id, extracted_plans')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!submission) return res.status(404).json({ error: 'submission not found' });

    if (!req.query.force && Array.isArray(submission.extracted_plans) && submission.extracted_plans.length) {
      return res.json({ plans: submission.extracted_plans, cached: true });
    }

    const { data: atts } = await supabase
      .from('master_plan_submission_attachments')
      .select('storage_bucket, storage_path, original_filename, mime_type')
      .eq('submission_id', submission.id)
      .order('uploaded_at', { ascending: true });
    const pdf = (atts || []).find((a) =>
      (a.mime_type || '').includes('pdf') || /\.pdf$/i.test(a.original_filename || a.storage_path || ''));
    if (!pdf) return res.json({ plans: [], source: 'none' });

    const { data: blob, error: dlErr } = await supabase.storage
      .from(pdf.storage_bucket || STORAGE_BUCKET)
      .download(pdf.storage_path);
    if (dlErr || !blob) return res.status(502).json({ error: 'could not download the submitted PDF' });
    const buffer = Buffer.from(await blob.arrayBuffer());

    const { extractPlansFromPdf } = require('../lib/master_plan_extract');
    const { plans, source } = await extractPlansFromPdf(buffer, pdf.original_filename);

    // Best-effort cache — never block the response on the write (and don't
    // fail if migration 230 hasn't landed yet; the feature still pre-fills,
    // it just re-reads each open until the column exists).
    try {
      const { error: cacheErr } = await supabase.from('master_plan_submissions')
        .update({ extracted_plans: plans, plans_extracted_at: new Date().toISOString() })
        .eq('id', submission.id);
      if (cacheErr) console.warn('[master_plan_submissions] extracted_plans cache write skipped:', cacheErr.message);
    } catch (e) {
      console.warn('[master_plan_submissions] extracted_plans cache write threw:', e.message);
    }

    res.json({ plans, source, cached: false });
  } catch (err) {
    console.error('[master_plan_submissions] extract-plans failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /:id/finalize — staff-only — approve, approve with conditions, or deny.
//
// Body:
//   action            'approve' | 'approve_with_conditions' | 'deny' | 'request_more_info'
//   approved_plans    [ { plan_number, plan_name, elevation, elevation_orientation,
//                         square_footage, stories } ]  — required for approve / approve_with_conditions
//   conditions        string or array — required for approve_with_conditions
//   denial_reasons    string or array — required for deny
//   decided_by        staff signer name (required)
//
// On approve / approve_with_conditions:
//   1. For each approved_plans entry, INSERT into master_plans with
//      status='approved' (deduped on the existing unique constraint;
//      conflicts are skipped, not errored).
//   2. Capture the resulting master_plan_id list onto the submission row.
//   3. Render the master plan letter HTML via lib/master_plan_letter.
//   4. Convert to PDF via Puppeteer (same launch pattern as
//      builder_applications.js).
//   5. Upload PDF to storage under
//      builders/{slug}/master-plan-submissions/{year}/{ref}.pdf (overwrite ok).
//   6. Create a 30-day signed URL for the letter.
//   7. Update submission row: status, decided_at, decided_by, letter_pdf_path,
//      letter_signed_url, letter_signed_url_expires_at, created_master_plan_ids.
//   8. Send email notification to the builder (best-effort, won't block).
// ----------------------------------------------------------------------------
const { renderMasterPlanLetterHTML } = require('../lib/master_plan_letter');
const STORAGE_BUCKET_LETTER = 'documents';

async function renderMasterPlanLetterPdfBuffer(letterArgs) {
  const html = renderMasterPlanLetterHTML(letterArgs);
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
    return Buffer.from(await page.pdf({
      format: 'Letter', printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 }, preferCSSPageSize: true,
    }));
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

// One decision path for a master plan submission. The single-submission route
// and the set approval both call it (Ed 2026-11-20).
//   opts: { action, approved_plans, conditions, denial_reasons, decided_by, notify }
// Approvals also record the plans as approved AT THIS COMMUNITY
// (master_plan_community_approvals): per-lot builder letters validate against
// that, and the June approvals only got it through a later bulk fix.
async function finalizeSubmission(id, opts = {}) {
  const { action, approved_plans, conditions, denial_reasons, decided_by, notify = true } = opts;
  const bad = (msg, code = 400) => Object.assign(new Error(msg), { statusCode: code });
  if (!action) throw bad('action is required');
  const validActions = ['approve', 'approve_with_conditions', 'deny', 'request_more_info'];
  if (!validActions.includes(action)) throw bad('invalid action');
  if (!decided_by) throw bad('decided_by is required');
  if (action === 'approve_with_conditions' && !conditions) throw bad('conditions are required for approve_with_conditions');
  if (action === 'deny' && !denial_reasons) throw bad('denial_reasons are required for deny');
  if ((action === 'approve' || action === 'approve_with_conditions') && (!Array.isArray(approved_plans) || approved_plans.length === 0)) {
    throw bad('approved_plans array is required for approval');
  }

  const { data: submission, error: loadErr } = await supabase
    .from('master_plan_submissions')
    .select(`*,
      community:communities(id, name, slug),
      builder_company:builder_companies(id, company_name, primary_contact_name, primary_contact_email, mailing_address)
    `)
    .eq('id', id)
    .single();
  if (loadErr) throw loadErr;
  if (!submission) throw bad('submission not found', 404);

  const responseType = action === 'approve' ? 'approved'
                    : action === 'approve_with_conditions' ? 'approved_with_conditions'
                    : action === 'deny' ? 'denied'
                    : 'info_requested';
  const conditionsText = typeof conditions === 'string' ? conditions : Array.isArray(conditions) ? conditions.join('\n') : null;

  // Create master_plans rows for approved batches.
  const createdMasterPlanIds = [];
  if (action === 'approve' || action === 'approve_with_conditions') {
    for (const p of approved_plans) {
      const planNumber = String(p.plan_number || '').trim().toUpperCase();
      const elevation = String(p.elevation || '').trim().toUpperCase();
      if (!planNumber || !elevation) continue;
      const { data: row, error: planErr } = await supabase
        .from('master_plans')
        .insert({
          builder_company_id: submission.builder_company_id,
          plan_number: planNumber,
          plan_name: p.plan_name || null,
          elevation,
          elevation_orientation: p.elevation_orientation || null,
          square_footage: p.square_footage || null,
          stories: p.stories || null,
          default_materials: {},
          status: 'approved',
          notes: `Approved via ${submission.reference_number} on ${new Date().toISOString().slice(0, 10)}.`,
          first_approval_application_id: null,
        })
        .select('id')
        .single();
      if (planErr) {
        // Unique constraint conflict: plan already in catalog. Link the existing row.
        if (planErr.code === '23505') {
          const { data: existing } = await supabase
            .from('master_plans')
            .select('id')
            .eq('builder_company_id', submission.builder_company_id)
            .eq('plan_number', planNumber)
            .eq('elevation', elevation)
            .eq('elevation_orientation', p.elevation_orientation || 'standard')
            .maybeSingle();
          if (existing) createdMasterPlanIds.push(existing.id);
        } else {
          console.warn('[master_plan_submissions] master_plan insert failed:', planErr.message);
        }
        continue;
      }
      if (row?.id) createdMasterPlanIds.push(row.id);
    }
    // Approved at THIS community (the per-lot validator reads this).
    for (const mpId of createdMasterPlanIds) {
      const { error: caErr } = await supabase.from('master_plan_community_approvals').insert({
        master_plan_id: mpId, community_id: submission.community_id, approved_at: new Date().toISOString(),
        approved_by: decided_by, approval_notes: `Approved via ${submission.reference_number}`, conditions: conditionsText,
      });
      if (caErr && caErr.code !== '23505') console.warn('[master_plan_submissions] community approval insert failed:', caErr.message);
    }
  }

  let letterPath = null, signedUrl = null, signedUrlExpiresAt = null;
  if (action !== 'request_more_info') {
    const letterArgs = {
      community: submission.community.name,
      builder_company_name: submission.builder_company.company_name,
      builder_contact_name: submission.builder_company.primary_contact_name || submission.submitter_name || '',
      builder_mailing_address: submission.builder_company.mailing_address || '',
      submission_title: submission.submission_title,
      reference_number: submission.reference_number,
      approved_plans: action === 'deny' ? [] : approved_plans,
      decision_type: responseType,
      conditions, denial_reasons,
      signer_name: decided_by,
    };
    const pdfBuffer = await renderMasterPlanLetterPdfBuffer(letterArgs);
    const year = new Date().getFullYear();
    const storagePath = `builders/${submission.community.slug}/master-plan-submissions/${year}/${submission.reference_number}.pdf`;
    const up = await supabase.storage.from(STORAGE_BUCKET_LETTER)
      .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true });
    if (up.error) throw new Error('letter upload: ' + up.error.message);
    const { data: signed } = await supabase.storage.from(STORAGE_BUCKET_LETTER)
      .createSignedUrl(storagePath, 60 * 60 * 24 * 30);
    letterPath = storagePath;
    signedUrl = signed?.signedUrl || null;
    signedUrlExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  }

  const finalStatus = responseType;
  const { error: upErr } = await supabase
    .from('master_plan_submissions')
    .update({
      status: finalStatus,
      decided_at: new Date().toISOString(),
      decided_by,
      decision_notes: conditionsText
        || (typeof denial_reasons === 'string' ? denial_reasons : Array.isArray(denial_reasons) ? denial_reasons.join('\n') : null),
      letter_pdf_path: letterPath,
      letter_signed_url: signedUrl,
      letter_signed_url_expires_at: signedUrlExpiresAt,
      created_master_plan_ids: createdMasterPlanIds,
    })
    .eq('id', submission.id);
  if (upErr) throw new Error('decision record not saved: ' + upErr.message);

  if (notify) {
    // Fire-and-forget email notification to the builder with the letter link.
    (async () => {
      try {
        const { sendEmail, isConfigured } = require('../lib/notifications/email');
        if (!isConfigured()) return;
        const subjBase = responseType === 'denied' ? 'Update on master plan submission'
                       : responseType === 'approved_with_conditions' ? 'Master plan approval (with conditions)'
                       : 'Master plan approved';
        await sendEmail({
          to: submission.submitter_email,
          subject: `${subjBase} — ${submission.reference_number}`,
          html: `<p>The ${submission.community.name} Architectural Control Committee has issued a decision on your master plan submission (${submission.reference_number}).</p>
            <p>${signedUrl ? `Letter on file: <a href="${signedUrl}">download PDF</a> (link valid 30 days).` : 'The decision letter is on file in your builder portal.'}</p>
            <p>${(createdMasterPlanIds.length && (responseType.startsWith('approved')))
                ? `${createdMasterPlanIds.length} plan/elevation entries were added to the ${submission.community.name} approved catalog and will be available in the per-lot construction submission dropdown immediately.`
                : ''}</p>`,
          text: `Decision issued for master plan submission ${submission.reference_number}. ${signedUrl ? 'Letter: ' + signedUrl : ''}`,
        });
      } catch (e) {
        console.warn('[master_plan_submissions] decision email failed:', e.message);
      }
    })();
  }

  return { submission, status: finalStatus, letter_pdf_path: letterPath, letter_signed_url: signedUrl, created_master_plan_ids: createdMasterPlanIds };
}

router.post('/:id/finalize', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const r = await finalizeSubmission(req.params.id, { ...(req.body || {}), notify: true });
    res.json({
      ok: true,
      reference_number: r.submission.reference_number,
      status: r.status,
      letter_signed_url: r.letter_signed_url,
      created_master_plan_ids: r.created_master_plan_ids,
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.error('[master_plan_submissions] finalize failed:', err.message);
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
