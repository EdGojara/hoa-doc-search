// ============================================================================
// approve_lennar_backfill_lots.js
// ----------------------------------------------------------------------------
// Generate approval letters + finalize the 7 Lennar / Still Creek Ranch lots
// that were backfilled from Richelle's 2026-06-10 email (SCR-BLD-2026-0001
// through 0007). Treats them as retroactive approvals matching the normal
// post-portal workflow, so by the time Richelle logs into the portal she
// sees all 7 in the Decided / letter-on-file section.
//
// For each lot:
//   1. Load application + community + builder relationships
//   2. Map the backfill materials shape (brick/paint/shingles strings) to
//      the renderer's expected keys (brick_color + brick_manufacturer split,
//      trim_color = the exterior paint, roof_color = the shingle color).
//   3. Render the gold-standard builder letter HTML via lib/builder_letter
//      (Rabbit Creek 2023 quality floor — plan + elevation + every approved
//      material + change-control language + post-construction walk note).
//   4. Convert HTML → PDF via Puppeteer (same launch args as
//      api/builder_applications.js renderBuilderLetterPdfBuffer).
//   5. Upload PDF to storage at builders/{slug}/{year}/{ref}.pdf, create
//      signed URL good for 30 days.
//   6. Insert builder_application_responses row with response_type='approved'.
//   7. Update builder_applications.status = 'approved' + decided_at/decided_by.
//
// Skips lots already in 'approved' status (idempotent — safe to re-run).
//
// Usage: node scripts/approve_lennar_backfill_lots.js
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config();

const { renderBuilderLetterHTML } = require('../lib/builder_letter');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const STORAGE_BUCKET = 'documents';
const DECIDED_BY = 'Bedrock Association Management — ARC Review';

const REFS = [
  'SCR-BLD-2026-0001',
  'SCR-BLD-2026-0002',
  'SCR-BLD-2026-0003',
  'SCR-BLD-2026-0004',
  'SCR-BLD-2026-0005',
  'SCR-BLD-2026-0006',
  'SCR-BLD-2026-0007',
];

// Map the backfill materials shape (free-text "Claymex- Germantown" strings
// from the paper ARC form) to the renderer's structured keys. Renderer reads
// brick_color + brick_manufacturer separately; we split heuristically on dash.
function mapMaterialsForRenderer(applicationData) {
  const d = applicationData || {};
  const mapped = {};

  if (d.brick) {
    // "Claymex- Germantown" or "Claymex Oxford" or "Triangle- Knob Hill"
    const m = String(d.brick).match(/^([^\-]+?)(?:\s*-\s*|\s+)(.+)$/);
    if (m) {
      mapped.brick_manufacturer = m[1].trim();
      mapped.brick_color = m[2].trim();
    } else {
      mapped.brick_color = String(d.brick).trim();
    }
  }

  // The Still Creek ARC form has "EXT. PAINT" which on a full-brick-standard
  // Lennar is the trim/accent color, not body. Render as Trim color.
  if (d.paint) mapped.trim_color = String(d.paint).trim();

  if (d.shingles) {
    mapped.roof_color = String(d.shingles).trim();
    mapped.roof_material = 'composition_shingle';  // standard for Lennar / Still Creek
  }

  return mapped;
}

async function renderPdf(letterArgs) {
  const html = renderBuilderLetterHTML(letterArgs);
  const puppeteer = require('puppeteer');
  // Fall back to system Chrome (or Edge) when puppeteer's bundled Chromium
  // isn't installed locally. Production has it bundled via Render; only
  // matters for this local backfill run.
  const fs = require('fs');
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const executablePath = candidates.find((p) => fs.existsSync(p));
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--single-process'],
  });
  try {
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (_) {}
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

async function uploadLetter(pdfBuffer, communitySlug, referenceNumber) {
  const year = new Date().getFullYear();
  const storagePath = `builders/${communitySlug}/${year}/${referenceNumber}.pdf`;
  const up = await supabase.storage.from(STORAGE_BUCKET)
    .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true });
  if (up.error) throw new Error('letter upload: ' + up.error.message);
  const { data: signed } = await supabase.storage.from(STORAGE_BUCKET)
    .createSignedUrl(storagePath, 60 * 60 * 24 * 30);
  return {
    path: storagePath,
    signed_url: signed?.signedUrl || null,
    signed_url_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

async function processOne(ref) {
  const { data: app, error } = await supabase
    .from('builder_applications')
    .select(`
      *,
      community:communities(id, name, slug, builder_arc_fee_cents),
      builder_company:builder_companies(id, company_name, primary_contact_name, primary_contact_email, mailing_address)
    `)
    .eq('reference_number', ref)
    .single();
  if (error) { console.log(`${ref}: load failed — ${error.message}`); return; }
  // Re-render every time for backfill — Ed iterates on letter format.
  // Production finalize endpoint guards against re-decisions; this script is
  // for ops-side re-rendering of the same approved decision.

  const mappedMaterials = mapMaterialsForRenderer(app.application_data);
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
    materials: mappedMaterials,
    reference_number: app.reference_number,
    decision_type: 'approved',
    signer_name: DECIDED_BY,
    review_fee_cents: app.community?.builder_arc_fee_cents ?? null,
  };

  console.log(`\n${ref}: rendering letter for ${app.street_address} (Plan ${app.plan_number}-${app.elevation}${app.elevation_orientation ? ' ' + app.elevation_orientation : ''})`);
  const pdfBuffer = await renderPdf(letterArgs);
  const uploaded = await uploadLetter(pdfBuffer, app.community.slug, app.reference_number);
  console.log(`  ✓ rendered ${(pdfBuffer.length / 1024).toFixed(0)} KB PDF · uploaded ${uploaded.path}`);

  // Idempotent: if a response already exists for this app + 'approved',
  // update the letter pointers; otherwise insert. Lets Ed iterate on letter
  // format without piling up duplicate response rows.
  const { data: existingResp } = await supabase
    .from('builder_application_responses')
    .select('id')
    .eq('application_id', app.id)
    .eq('response_type', 'approved')
    .maybeSingle();
  const respPayload = {
    application_id: app.id,
    response_type: 'approved',
    decided_by: DECIDED_BY,
    decided_at: new Date().toISOString(),
    letter_pdf_path: uploaded.path,
    letter_signed_url: uploaded.signed_url,
    letter_signed_url_expires_at: uploaded.signed_url_expires_at,
    email_subject: `ARC Approval — ${app.street_address} (${app.reference_number})`,
    email_bcc_archive: true,
  };
  const respErr = existingResp
    ? (await supabase.from('builder_application_responses').update(respPayload).eq('id', existingResp.id)).error
    : (await supabase.from('builder_application_responses').insert(respPayload)).error;
  if (respErr) { console.log(`  ✗ response write: ${respErr.message}`); return; }

  const { error: updErr } = await supabase
    .from('builder_applications')
    .update({
      status: 'approved',
      decided_at: new Date().toISOString(),
      decided_by: DECIDED_BY,
    })
    .eq('id', app.id);
  if (updErr) { console.log(`  ✗ app status update: ${updErr.message}`); return; }
  console.log(`  ✓ status=approved, response recorded`);
}

(async () => {
  console.log(`Approving ${REFS.length} backfilled Lennar / Still Creek lots`);
  for (const ref of REFS) {
    try { await processOne(ref); }
    catch (e) { console.log(`${ref}: ERR ${e.message}`); }
  }
  console.log('\nDone.');
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
