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
// SERVICE_TYPE was 'arc_builder_new_construction' until 2026-06-16. Migration
// 218 added a CHECK constraint on application_reference_counters.service_type
// limiting allowed values to: builder_arc, master_plan_submission, resident_acc,
// estoppel, other. The first INSERT for a never-seen-before (community, service,
// year) tuple hit the constraint and crashed at AM 8114 Graces Gamble Way.
// Switched to 'builder_arc'. Drift protection in next_application_counter reads
// MAX suffix from builder_applications.reference_number directly, so any prior
// counter rows under the old service_type become harmless orphans -- new INSERTs
// pick up at max_existing+1 with no duplicate-ref risk.
const SERVICE_TYPE = 'builder_arc';
const STORAGE_BUCKET = 'documents';
const ARCHIVE_BCC = process.env.ARCHIVE_BCC_EMAIL || 'Archive1Emails@bedrocktx.com';

// Shared master-plan-PDF extraction prompt. Used by /master-plans/bulk-extract
// and /master-plans/orphans/:id/extract so the orphan recovery flow can re-run
// AI extraction instead of forcing operator manual entry on PDFs the AI
// already understands.
const MASTER_PLAN_EXTRACT_PROMPT = `You are reviewing a builder's home plan PDF. Extract EVERY elevation shown in this PDF.

A single PDF often shows multiple elevations of the same base plan (e.g., Plan 6512 Elevation A, B, and C — usually one cover sheet listing all three then detail pages per elevation). Return ALL elevations as an array. If the PDF shows only one elevation, return a single-element array.

Each entry in the array:
- plan_number: The plan identifier (e.g., "6512"). Usually shared across elevations of the same plan.
- plan_name: The marketing/series name (e.g., "The Tuscany"). Usually shared.
- elevation: The elevation letter or code shown (REQUIRED — A, B, C, Standard, etc.). Must be unique within the array.
- square_footage: Heated/living-area square footage as an integer. May vary per elevation. null if not stated.
- stories: Number of stories (1, 1.5, 2, 2.5, 3). null if not stated.

Plus top-level fields about the PDF as a whole:
- ai_confidence: "high" | "medium" | "low" — your overall confidence in the extraction
- ai_notes: Any caveats

Look at: the title block (usually top-right or bottom of the cover sheet), the schedule of plans table (often a grid showing each elevation's footprint + sqft), square footage callouts, elevation header labels on per-elevation detail pages.

Return ONLY valid JSON, no preamble:
{
  "elevations": [
    {"plan_number":"6512","plan_name":"Tuscany","elevation":"A","square_footage":2150,"stories":2}
  ],
  "ai_confidence":"high",
  "ai_notes":"Schedule of plans on page 1 lists A, B, C."
}

If you can identify the plan number + at least one elevation, return what you can. If you cannot identify even the plan number, return {"elevations":[], "ai_confidence":"low", "ai_notes":"explain why"}.`;

// Trim a PDF to the first maxPages pages and return a new buffer. Used to
// keep master-plan PDF extractions under Claude's API limits (100 pages,
// 32 MB per document). The cover sheet + schedule of plans — which carry
// plan_number, plan_name, elevation, sqft — are virtually always in the
// first few pages; pages beyond that are construction drawings that don't
// help with metadata extraction. The original full PDF stays in storage
// for the operator-facing View PDF link.
async function trimPdfToFirstPages(pdfBuffer, maxPages) {
  try {
    const { PDFDocument } = require('pdf-lib');
    const src = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const total = src.getPageCount();
    if (total <= maxPages) return { buffer: pdfBuffer, total_pages: total, trimmed: false };
    const dst = await PDFDocument.create();
    const indices = Array.from({ length: maxPages }, (_, i) => i);
    const copied = await dst.copyPages(src, indices);
    copied.forEach((p) => dst.addPage(p));
    const trimmedBytes = await dst.save();
    return { buffer: Buffer.from(trimmedBytes), total_pages: total, trimmed: true };
  } catch (e) {
    // If pdf-lib can't parse, fall back to sending the original and let
    // Claude reject it — better than silently dropping the extraction.
    console.warn('[master-plan] pdf trim failed, sending original:', e.message);
    return { buffer: pdfBuffer, total_pages: null, trimmed: false };
  }
}

// Run AI extraction on a master-plan PDF buffer. Returns the parsed object
// or null if extraction couldn't produce structured JSON. Throws if the
// Anthropic SDK / API key isn't configured. PDFs > 10 pages are trimmed
// to the first 10 before sending to Claude (the cover sheet + schedule
// of plans live there; full construction drawings exceed Claude's API limits).
async function extractMasterPlanFromPdfBuffer(pdfBuffer) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const { buffer: claudeBuffer, total_pages, trimmed } = await trimPdfToFirstPages(pdfBuffer, 10);
  if (trimmed) {
    console.log(`[master-plan] trimmed PDF from ${total_pages} pages to 10 for Claude`);
  }

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: claudeBuffer.toString('base64') } },
        { type: 'text', text: MASTER_PLAN_EXTRACT_PROMPT + (trimmed ? `\n\nNote: this is the first 10 pages of a ${total_pages}-page construction set — the cover sheet and schedule of plans should be in this slice.` : '') },
      ],
    }],
  });
  const txt = (resp.content || []).map((c) => c.text || '').join('').trim();
  const jsonMatch = txt.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { extracted: null, raw: txt };
  try {
    return { extracted: JSON.parse(jsonMatch[0]), raw: txt };
  } catch (_) {
    return { extracted: null, raw: txt };
  }
}

// Infer the builder_company_id from a library_documents.title formatted as
// "${company.company_name} — ${filename}". Used by orphan auto-register to
// avoid forcing the operator to pick the builder when the title carries it.
async function inferBuilderFromTitle(title) {
  if (!title || typeof title !== 'string') return null;
  // Title format from bulk-extract: "${company_name} — ${filename}". The em-dash
  // is the separator. Take everything before " — " as the candidate name.
  const dashIdx = title.indexOf(' — ');
  if (dashIdx < 0) return null;
  const candidate = title.slice(0, dashIdx).trim();
  if (!candidate) return null;
  const { data } = await supabase
    .from('builder_companies')
    .select('id')
    .eq('management_company_id', BEDROCK_MGMT_CO_ID)
    .ilike('company_name', candidate)
    .maybeSingle();
  return data?.id || null;
}

// ============================================================================
// PLOT-PLAN EXTRACTION — for inbound builder submissions
// ----------------------------------------------------------------------------
// Builders attach a plot plan PDF to every submission. Lennar/DRB plot plans
// carry ~80% of the structured data Bedrock needs (lot, plat#, address,
// plan#, elevation, sqft, lot coverage %, fence LF, etc.) — extracting from
// the PDF eliminates duplicate operator typing.
// ============================================================================

const PLOT_PLAN_EXTRACT_PROMPT = `You are extracting structured data from a builder's PLOT PLAN PDF for an HOA architectural review.

Plot plans (also called site plans, plot drawings, or improvement surveys) show a specific home's footprint on a specific lot. They have a title block with property + plan + builder identification and usually a table of improvement quantities.

Extract the following fields. Return null for any field you cannot find — do NOT invent or estimate.

PROPERTY IDENTIFICATION:
- lot_number: lot designation (e.g., "8", "12A")
- block_number: block designation (e.g., "1")
- section_number: section/phase (e.g., "1")
- plat_number: recorded plat number (e.g., "20190044")
- county: county name (e.g., "Fort Bend County")
- subdivision_name: recorded subdivision name (e.g., "Still Creek Ranch")
- street_address: full street address (e.g., "7419 Tye Creek Lane")

PLAN IDENTIFICATION:
- plan_number: builder's plan number (e.g., "6480")
- plan_name: plan trade/series name if shown
- elevation: elevation code (e.g., "A")
- elevation_orientation: "left" | "right" | "standard" if mirrored
- stories: numeric (1, 1.5, 2, 2.5, 3)
- square_footage: heated/conditioned area in sqft

LOT METRICS:
- lot_area_sqft: total lot size
- lot_coverage_pct: % of lot covered by structure (number, e.g., 43.26)
- fence_linear_ft: total fence length
- total_sod_sqyd: total sod area
- total_paving_sqft: total impervious paving

BUILDER IDENTIFICATION:
- builder_company_name: builder shown on title block (e.g., "Lennar Homes", "DRB Group")
- builder_internal_job_no: builder's internal job/lot reference
- surveyor_firm: licensed surveyor firm
- surveyor_license_no: TBPLS or equivalent license #
- plot_issue_date: issue date stamped on the plot (YYYY-MM-DD)
- flood_zone: FEMA flood zone (e.g., "X")

OTHER:
- options_notes: any notes like "NO OPTIONS" or option list
- ai_confidence: "high" | "medium" | "low"
- ai_notes: caveats — anything unusual or ambiguous

Return ONLY valid JSON, no preamble. Example:
{
  "lot_number": "8", "block_number": "1", "section_number": "1",
  "plat_number": "20190044", "county": "Fort Bend County",
  "subdivision_name": "Still Creek Ranch", "street_address": "7419 Tye Creek Lane",
  "plan_number": "6480", "plan_name": null, "elevation": "A", "elevation_orientation": "left",
  "stories": 2, "square_footage": 2271,
  "lot_area_sqft": 6600, "lot_coverage_pct": 43.26,
  "fence_linear_ft": 233.1, "total_sod_sqyd": 441, "total_paving_sqft": 1002,
  "builder_company_name": "Lennar Homes", "builder_internal_job_no": "LH204078",
  "surveyor_firm": "Allpoints Land Survey, Inc.", "surveyor_license_no": "10122600",
  "plot_issue_date": "2020-03-11", "flood_zone": "X",
  "options_notes": "NO OPTIONS",
  "ai_confidence": "high", "ai_notes": null
}`;

const COLOR_SHEET_EXTRACT_PROMPT = `You are extracting buyer color/material selections from a builder's SELECTIONS SHEET PDF for an HOA architectural review.

These sheets vary widely by builder — sometimes a structured table, sometimes a narrative list. Extract what's there, return null for what's not.

Fields:
- brick_color, brick_manufacturer
- stone_color, stone_type
- siding_color, siding_material
- stucco_color
- trim_color
- shutter_color (if present)
- front_door_color
- garage_door_color, garage_door_style
- roof_color, roof_material
- fence_material, fence_height_feet
- driveway_material
- ai_confidence: "high" | "medium" | "low"
- ai_notes: caveats

Return ONLY valid JSON.`;

async function extractFromPdfBuffer(pdfBuffer, prompt, maxPagesToSend) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { buffer: claudeBuffer, total_pages, trimmed } = await trimPdfToFirstPages(pdfBuffer, maxPagesToSend);
  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: claudeBuffer.toString('base64') } },
        { type: 'text', text: prompt + (trimmed ? `\n\nNote: this is the first ${maxPagesToSend} pages of a ${total_pages}-page document — the title block + tables should be in this slice.` : '') },
      ],
    }],
  });
  const txt = (resp.content || []).map((c) => c.text || '').join('').trim();
  const jsonMatch = txt.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { extracted: null, raw: txt };
  try {
    return { extracted: JSON.parse(jsonMatch[0]), raw: txt };
  } catch (_) {
    return { extracted: null, raw: txt };
  }
}

const extractPlotPlanFromPdfBuffer  = (buf) => extractFromPdfBuffer(buf, PLOT_PLAN_EXTRACT_PROMPT, 5);
const extractColorSheetFromPdfBuffer = (buf) => extractFromPdfBuffer(buf, COLOR_SHEET_EXTRACT_PROMPT, 5);

// ============================================================================
// FULL-SUBMISSION FORM EXTRACTION — for DRB-style "Plan Submission" packets
// ----------------------------------------------------------------------------
// Karla / DRB Group send Bedrock a single multi-page PDF that begins with a
// structured "PLAN SUBMISSION" form (date, builder + contact info, address,
// plan/elevation, materials table, masonry + repetition compliance, lot
// type) followed by 60+ pages of architectural drawings. Page 1 carries
// everything we need to create the application row; the rest is reference.
//
// Ed 2026-06-16: built so staff can upload these PDFs on behalf of builders
// and have them land in the same review queue + approval flow as portal
// submissions. Closes the gap where DRB couldn't use the online portal yet
// but needed approvals to keep building.
// ============================================================================
const SUBMISSION_FORM_EXTRACT_PROMPT = `You are extracting structured data from page 1 of a builder's ARC PLAN SUBMISSION packet for an HOA architectural review.

The form has these sections: builder + contact info, property address, plan/elevation, visible sides, attachments confirmation, a materials table (10 rows × Type/Color/Other), masonry + repetition compliance, and a free-text "Other Information" line.

Extract the following fields. Return null for any field you cannot find — do NOT invent.

SUBMISSION METADATA:
- date_submitted: date on the form (YYYY-MM-DD)
- is_new_plan_approval_request: true | false | null

BUILDER + CONTACT:
- builder_company_name: e.g., "DRB Group Texas LLC"
- contact_person: name of the purchasing coordinator / point of contact
- contact_phone
- contact_email
- contact_fax

PROPERTY:
- street_address: street address only (e.g., "14219 Sloan Street")
- section_number, block_number, lot_number

PLAN:
- plan_name: e.g., "Palm"
- plan_number: e.g., "1970"  (when the form shows "Palm/1970", plan_name="Palm" and plan_number="1970")
- elevation: e.g., "O"
- square_footage_heated: heated/cooled square footage as integer
- lot_type: "interior" | "corner" | "cul_de_sac" | "backs_to_common_area" | "backs_to_thoroughfare" | "flag_lot" | null
  (parse from the "Other Information" line — e.g., "Interior Lot" → "interior")

VISIBLE SIDES (checkboxes):
- visible_sides_front: true | false
- visible_sides_left: true | false
- visible_sides_back: true | false
- visible_sides_right: true | false

ATTACHMENTS CONFIRMATION (checkboxes):
- site_plan_attached: true | false
- floor_plan_attached: true | false

COMPLIANCE:
- met_repetition_requirement: true | false | null
- repetition_exceptions: free-text if "No"
- met_front_masonry_minimum: true | false | null
- front_masonry_exceptions: free-text if "No"

MATERIALS TABLE — each row: {type, color, other}. Return null for absent rows. Keys are EXACTLY these snake_case identifiers:
- shingles: {type, color, other}
- brick: {type, color, other}
- rock: {type, color, other}                       (or "stone" / "stonework")
- siding: {type, color, other}                     (or "cementious fiber board" / "hardie")
- mortar: {type, color, other}
- stucco_paint: {type, color, other}
- chimney: {type, color, other}                    (often "NA")
- windows: {type, color, other}
- trim_paint: {type, color, other}
- garage_door: {type, color, other}

QUALITY:
- ai_confidence: "high" | "medium" | "low"
- ai_notes: caveats — anything illegible, ambiguous, or surprising

Return ONLY valid JSON, no preamble. Empty material rows = null (not {}). Example:
{
  "date_submitted": "2026-06-15",
  "is_new_plan_approval_request": true,
  "builder_company_name": "DRB Group Texas LLC",
  "contact_person": "Karla Rutan",
  "contact_phone": "713-243-3556",
  "contact_email": "drbghoustonpurchasing@drbgroup.com",
  "contact_fax": null,
  "street_address": "14219 Sloan Street",
  "section_number": "1", "block_number": "2", "lot_number": "22",
  "plan_name": "Palm", "plan_number": "1970", "elevation": "O",
  "square_footage_heated": 1968,
  "lot_type": "interior",
  "visible_sides_front": true, "visible_sides_left": true, "visible_sides_back": true, "visible_sides_right": true,
  "site_plan_attached": true, "floor_plan_attached": true,
  "met_repetition_requirement": true, "repetition_exceptions": null,
  "met_front_masonry_minimum": true, "front_masonry_exceptions": null,
  "shingles":     { "type": "3 Tab",                "color": "Weathered Wood",    "other": null },
  "brick":        { "type": "Red River",            "color": "Winter Lake",       "other": null },
  "rock":         { "type": "Legends Arch Stone",   "color": "Blanco Fieldstone", "other": null },
  "siding":       { "type": "SW",                   "color": "Mega Greige",       "other": "cementious fiber board" },
  "mortar":       { "type": "ACME Masonry",         "color": "White",             "other": null },
  "stucco_paint": { "type": "SW",                   "color": "Mega Greige",       "other": null },
  "chimney":      null,
  "windows":      { "type": "Builders First Source","color": "White",             "other": null },
  "trim_paint":   { "type": "SW",                   "color": "Gossamer Veil",     "other": null },
  "garage_door":  { "type": "SW",                   "color": "Gossamer Veil",     "other": null },
  "ai_confidence": "high",
  "ai_notes": null
}`;

const extractSubmissionFormFromPdfBuffer = (buf) => extractFromPdfBuffer(buf, SUBMISSION_FORM_EXTRACT_PROMPT, 2);

// Resolve community_id from extracted subdivision_name + plat_number. ILIKE
// match on name with plat as tiebreaker if the subdivision name is ambiguous.
async function resolveCommunityFromExtraction(extracted) {
  const subdivision = extracted?.subdivision_name;
  if (!subdivision) return null;
  // Strip common suffixes ("Homeowners Association", "HOA") for cleaner match
  const cleaned = String(subdivision)
    .replace(/\s+(homeowners?\s+associations?|hoa|inc\.?|llc\.?)\b.*/i, '')
    .trim();
  if (!cleaned) return null;
  const { data } = await supabase
    .from('communities')
    .select('id, name, slug')
    .eq('management_company_id', BEDROCK_MGMT_CO_ID)
    .ilike('name', `%${cleaned}%`)
    .limit(2);
  if (!data || data.length === 0) return null;
  if (data.length === 1) return data[0];
  // Ambiguous — could add plat-based tiebreaker here when we track it on communities
  return data[0];  // best-effort: first match
}

// Resolve builder_company_id from extracted builder_company_name. Loose
// match — "Lennar Homes" → "Lennar"; "DRB Group" → "DRB Group".
async function resolveBuilderFromExtraction(extracted) {
  const name = extracted?.builder_company_name;
  if (!name) return null;
  // Try exact match first
  let { data } = await supabase
    .from('builder_companies')
    .select('id, company_name')
    .eq('management_company_id', BEDROCK_MGMT_CO_ID)
    .ilike('company_name', name)
    .maybeSingle();
  if (data) return data;
  // Loose: try first word (e.g., "Lennar Homes" → "Lennar%")
  const firstWord = name.split(/\s+/)[0];
  if (firstWord && firstWord.length >= 3) {
    const res = await supabase
      .from('builder_companies')
      .select('id, company_name')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .ilike('company_name', `${firstWord}%`)
      .limit(2);
    if (res.data && res.data.length === 1) return res.data[0];
  }
  return null;
}

// Resolve master_plan_id from builder_company_id + plan_number + elevation.
// Used to flip fast_track=TRUE when a submission matches a pre-approved plan.
async function resolveMasterPlanForExtraction(builderId, planNumber, elevation, communityId) {
  if (!builderId || !planNumber || !elevation) return null;
  const { data: plans } = await supabase
    .from('master_plans')
    .select('id, plan_number, plan_name, elevation, status')
    .eq('builder_company_id', builderId)
    .ilike('plan_number', String(planNumber).trim())
    .ilike('elevation', String(elevation).trim())
    .eq('status', 'approved')
    .limit(2);
  if (!plans || plans.length === 0) return null;
  const plan = plans[0];
  // Verify community pre-approval if we have a community
  if (communityId) {
    const { data: appr } = await supabase
      .from('master_plan_community_approvals')
      .select('community_id, retired_at')
      .eq('master_plan_id', plan.id)
      .eq('community_id', communityId)
      .maybeSingle();
    const fastTrack = !!(appr && !appr.retired_at);
    return { ...plan, fast_track: fastTrack };
  }
  return { ...plan, fast_track: false };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 12 },
});

// Bulk upload variant — used by /master-plans/bulk-extract for builder
// plan inventory uploads (DRB has 19 plans across Classic + Premier tiers).
// Same per-file 25MB cap; up to 30 files per call for headroom.
const uploadBulk = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 30 },
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

  // Atomic counter via migration 225 generalized RPC — eliminates the
  // read-then-write race that crashed DRB Group's submission, drift-
  // protected across all four tables that share
  // application_reference_counters (builder_applications,
  // community_applications, amenity_rentals, master_plan_submissions).
  // The audit after the DRB incident found 3 other public-facing
  // endpoints with the same bug; all four now converge on this RPC.
  const { data: nextCounter, error } = await supabase
    .rpc('next_application_counter', {
      p_community_id: community.id,
      p_service_type: SERVICE_TYPE,
      p_year:         year,
      p_prefix:       prefix,
      p_infix:        '-BLD-',
    });
  if (error) throw new Error(`reference number allocation failed: ${error.message}`);
  if (typeof nextCounter !== 'number' || nextCounter < 1) {
    throw new Error(`reference number allocation returned invalid value: ${nextCounter}`);
  }

  return `${prefix}-BLD-${year}-${String(nextCounter).padStart(4, '0')}`;
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

// ----------------------------------------------------------------------------
// GET /api/builder-applications/active-communities
// Lists communities in the Bedrock portfolio where builder_arc_active=TRUE.
// Returns the EXACT set of communities the builder-ARC pipeline operates
// on — used by admin upload modals to pre-check pre-approval boxes.
//
// Avoids relying on the generic /api/communities listing which doesn't
// always return builder_arc_active and was filtered with a permissive
// !== false check (let through communities where the column was null/
// undefined). Result: previously Canyon Gate + Eaglewood (force-mow
// configured but no new construction) appeared in the modal alongside
// August Meadows + Still Creek Ranch. This endpoint returns the
// authoritative set.
//
// MUST be defined BEFORE any /:id route (Express order shadow scar).
// ----------------------------------------------------------------------------
router.get('/active-communities', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('communities')
      .select('id, name, slug, builder_arc_fee_cents, builder_arc_sla_business_days, builder_arc_fast_track_business_days, builder_arc_design_guidelines_url, builder_arc_reference_prefix')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('builder_arc_active', true)
      .order('name');
    if (error) throw error;
    res.json({ ok: true, communities: data || [] });
  } catch (err) {
    console.error('[active-communities]', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /api/builder-applications/builder-companies
// Lists active builder_companies for Bedrock. Populates the builder
// dropdown in admin upload modals. MUST be defined BEFORE any /:id route
// or Express matches "builder-companies" as a UUID and errors. (Scar
// 2026-05-29: was defined later in the file, got route-shadowed.)
// ----------------------------------------------------------------------------
router.get('/builder-companies', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('builder_companies')
      .select('id, company_name, primary_email_domain, primary_contact_name, primary_contact_email, status, active_community_ids')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('status', 'active')
      .order('company_name');
    if (error) throw error;
    // Normalize active_community_ids to always be a real JS array so the
    // frontend can .includes() / .indexOf() without type-checking.
    const builders = (data || []).map((b) => ({
      ...b,
      active_community_ids: Array.isArray(b.active_community_ids) ? b.active_community_ids : [],
    }));
    res.json({ ok: true, builder_companies: builders });
  } catch (err) {
    console.error('[builder_companies]', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

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

    // Reference number (atomic per community/year via Postgres function;
    // see migration 224). Retry loop is defense-in-depth — should never
    // fire now that the counter increment is atomic + drift-protected,
    // but guards against any future divergence so the BUILDER never
    // sees a raw "duplicate key value violates unique constraint" error.
    let referenceNumber = null;
    let app = null;
    let aErr = null;
    for (let attempt = 0; attempt < 3 && !app; attempt++) {
      referenceNumber = await nextBuilderReferenceNumber(community);
      const tryInsertRow = {
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

      const insertResult = await supabase
        .from('builder_applications')
        .insert(tryInsertRow)
        .select('*')
        .single();
      app = insertResult.data;
      aErr = insertResult.error;
      if (aErr) {
        // Postgres unique-constraint violation = 23505. Retry with a fresh
        // reference number (drift may have grown between counter alloc and
        // insert). Anything else = throw.
        if (aErr.code === '23505' && /reference_number/.test(String(aErr.message || ''))) {
          console.warn('[builder_applications] reference_number collision on attempt', attempt + 1, '— retrying with fresh counter:', referenceNumber, aErr.message);
          app = null;
          continue;
        }
        throw aErr;
      }
    }
    if (!app) {
      // 3 collisions in a row = something is structurally wrong (counter
      // function broken, drift corruption, etc.). Surface a friendly error
      // to the builder + a loud one to the logs so we investigate.
      console.error('[builder_applications] reference number allocation failed after 3 retries; counter may be corrupted for community', community.id);
      throw new Error('Submission temporarily unavailable. Please refresh the page and try again — if it keeps happening, email builders@bedrocktx.com.');
    }

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
// DELETE /api/builder-applications/:id — admin-only hard delete
// Removes the submission + cascade-deletes its assessments, responses, and
// attachments via the schema's ON DELETE CASCADE FKs (migration 080).
//
// Storage cleanup: PDFs stored under builder_application_attachments
// .storage_path and builder_application_responses.letter_pdf_path become
// orphans in the Supabase storage bucket — logged for later sweep but
// NOT auto-deleted (admin destructive op should be reversible at storage
// layer in case the delete was wrong).
//
// Used to clean up test submissions, or admin-corrective delete of a
// submission that landed against the wrong property / wrong builder.
// ============================================================================
// Reusable UUID-shape guard. Lets non-UUID single-segment paths
// (/master-plans, /builder-companies, etc.) fall through to subsequent
// routes instead of erroring with "invalid input syntax for type uuid".
// Hit this scar twice already — guarding the /:id handlers permanently.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.delete('/:id', async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) return next();
  try {
    const { requireAdmin } = require('./users');
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'id required' });

    // Fetch first so we can log what we're deleting + return useful confirmation
    const { data: app, error: gErr } = await supabase
      .from('builder_applications')
      .select('id, reference_number, street_address, lot_number, plan_number, elevation, status')
      .eq('id', id)
      .maybeSingle();
    if (gErr) {
      console.error('[builder_applications.delete] lookup failed:', gErr.message);
      return res.status(500).json({ error: safeErrorMessage(gErr) });
    }
    if (!app) return res.status(404).json({ error: 'submission not found' });

    // Collect orphan storage paths (audit trail; manual sweep later if needed)
    const [attsRes, respsRes] = await Promise.all([
      supabase.from('builder_application_attachments').select('storage_path').eq('application_id', id),
      supabase.from('builder_application_responses').select('letter_pdf_path').eq('application_id', id),
    ]);
    const orphans = [];
    (attsRes.data || []).forEach((a) => { if (a.storage_path) orphans.push(a.storage_path); });
    (respsRes.data || []).forEach((r) => { if (r.letter_pdf_path) orphans.push(r.letter_pdf_path); });

    // The cascade FKs handle the children. Single DELETE on parent.
    const { error: dErr } = await supabase
      .from('builder_applications')
      .delete()
      .eq('id', id);
    if (dErr) {
      console.error('[builder_applications.delete] delete failed:', dErr.message);
      return res.status(500).json({ error: safeErrorMessage(dErr) });
    }

    console.log('[builder_applications.delete] admin',
      ctx.user && ctx.user.email,
      'deleted', app.reference_number || id,
      '· orphaned storage paths:', orphans.length);

    res.json({
      ok: true,
      deleted: {
        id: app.id,
        reference_number: app.reference_number,
        address: app.street_address,
        lot: app.lot_number,
        plan: `${app.plan_number} / ${app.elevation}`,
        status_at_delete: app.status,
      },
      orphaned_storage_paths: orphans,
    });
  } catch (err) {
    console.error('[builder_applications.delete]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /api/builder-applications/:id
// Returns full detail: application + community + builder_company + master_plan
//          + attachments + assessments + responses (latest first)
// ============================================================================
router.get('/:id', async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) return next();
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

    // Ed 2026-06-16: stamp a short-lived signed URL on each attachment so
    // the detail panel can embed the submission packet PDF inline. Before
    // this, the panel rendered only the filename text and Ed had no way
    // to see what the builder actually submitted without downloading.
    const attsWithUrls = await Promise.all((attResp.data || []).map(async (a) => {
      if (!a.storage_path) return a;
      try {
        const { data: sd } = await supabase.storage
          .from(a.storage_bucket || 'documents')
          .createSignedUrl(a.storage_path, 60 * 60);  // 1 hour
        return { ...a, signed_url: sd?.signedUrl || null };
      } catch (_) {
        return a;
      }
    }));

    res.json({
      application: appResp.data,
      assessments: assessResp.data || [],
      responses: respResp.data || [],
      attachments: attsWithUrls,
    });
  } catch (err) {
    console.error('[builder_applications] detail failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// GET /api/builder-applications/:id/recommendation
// ----------------------------------------------------------------------------
// Ed 2026-06-16: "Shouldn't the AI decide?" Per CLAUDE.md catastrophic-
// output discipline, the AI doesn't decide autonomously — operator
// confirms. But the system can encode the rule-based judgment Ed would
// apply mentally on every submission and surface a strong recommendation
// so the operator clicks once instead of evaluating from scratch.
//
// Rule set, in priority order:
//   1. Master-plan fast-track match + compliance flags clear → APPROVE
//   2. Master-plan fast-track match + at least one compliance flag failed
//      → APPROVE_WITH_CONDITIONS (conditions list pre-populated from flags)
//   3. No master-plan match + materials present → APPROVE_WITH_CONDITIONS
//      (catch the next submission of this plan, build precedent)
//   4. Missing materials or address → REQUEST_MORE_INFO
//   5. Explicit non-conformity in extracted form (e.g., masonry minimum
//      explicitly marked No with no acceptable exception) → DENY
//
// Returns: {
//   recommended_action, confidence, reasoning,
//   conditions: [], denial_reasons: [],
//   signals: { ... }   // for transparency
// }
// ============================================================================
function computeBuilderRecommendation(app) {
  const data = (app && app.application_data) || {};
  const compliance = data.compliance || {};
  const materials = data.materials || {};
  const flatHasMaterials = !!(data.brick_color || data.stone_color || data.siding_color || data.trim_color || data.roof_color);
  const nestedHasMaterials = !!(materials.brick || materials.rock || materials.siding || materials.trim_paint || materials.shingles);
  const anyMaterials = flatHasMaterials || nestedHasMaterials;
  const fastTrack = !!app.fast_track;
  const masterMatched = !!app.master_plan_id;
  const masonryOk = compliance.met_front_masonry_minimum;       // true | false | null
  const repetitionOk = compliance.met_repetition_requirement;
  const masonryNote = (compliance.front_masonry_exceptions || '').trim();
  const repetitionNote = (compliance.repetition_exceptions || '').trim();

  const planRef = `Plan ${app.plan_number || '—'} / ${app.elevation || '—'}`;
  const signals = {
    fast_track: fastTrack,
    master_plan_matched: masterMatched,
    masonry_minimum_met: masonryOk,
    repetition_rule_met: repetitionOk,
    materials_captured: anyMaterials,
  };

  // 4. No materials → can't safely recommend; ask for more info
  if (!anyMaterials && !app.street_address) {
    return {
      recommended_action: 'request_more_info',
      confidence: 'low',
      reasoning: 'Extraction came back missing both the materials table and the property address. Need the form re-sent or the operator to fill in by hand before a decision is safe.',
      conditions: [],
      denial_reasons: [],
      signals,
    };
  }

  // 5. Explicit non-conformity with no acceptable exception → DENY
  // (only fire when the form literally says "No" and the operator hasn't
  //  noted an acceptable exception)
  if (masonryOk === false && masonryNote.length === 0 && repetitionOk === false && repetitionNote.length === 0) {
    return {
      recommended_action: 'deny',
      confidence: 'high',
      reasoning: `${planRef} flags BOTH masonry-minimum failure AND repetition-rule failure with no exceptions noted. Denial is the procedurally clean response — builder can resubmit with corrected plans or a board variance request.`,
      conditions: [],
      denial_reasons: [
        'Front masonry coverage below the community minimum with no acceptable exception noted.',
        'Elevation repetition rule not met with no acceptable exception noted.',
      ],
      signals,
    };
  }

  // 1. Fast-track + everything clean → APPROVE
  if (fastTrack && (masonryOk !== false) && (repetitionOk !== false) && anyMaterials) {
    return {
      recommended_action: 'approve',
      confidence: 'high',
      reasoning: `${planRef} matches an approved master plan in the library, masonry and repetition compliance both check out per the submitted form, and materials are populated. Clean approval — no conditions, ready for the standard decision letter.`,
      conditions: [],
      denial_reasons: [],
      signals,
    };
  }

  // 2. Fast-track + at least one compliance flag failed → CONDITIONS
  if (fastTrack && (masonryOk === false || repetitionOk === false)) {
    const conditions = [];
    if (masonryOk === false) {
      conditions.push(masonryNote
        ? `Front masonry below community minimum (builder noted: "${masonryNote}"). Confirm the noted exception meets community standards before construction begins.`
        : 'Front masonry below community minimum. Confirm corrected coverage before construction begins, or submit a board variance request.');
    }
    if (repetitionOk === false) {
      conditions.push(repetitionNote
        ? `Elevation repetition rule not met (builder noted: "${repetitionNote}"). Confirm the noted exception meets community standards.`
        : 'Elevation repetition rule not met. Confirm spacing meets the community minimum before construction.');
    }
    return {
      recommended_action: 'approve_with_conditions',
      confidence: 'high',
      reasoning: `${planRef} matches an approved master plan, but the submission form flags ${conditions.length} compliance item${conditions.length === 1 ? '' : 's'}. Approve subject to the condition${conditions.length === 1 ? '' : 's'} below.`,
      conditions,
      denial_reasons: [],
      signals,
    };
  }

  // 3. No master plan match → review materials, build precedent
  if (!fastTrack) {
    return {
      recommended_action: 'approve_with_conditions',
      confidence: 'medium',
      reasoning: `${planRef} doesn't match any approved master plan in the library yet. Recommend approving on the condition that materials match the community palette — this submission then becomes precedent and future ${planRef} submissions will fast-track.`,
      conditions: [
        'Confirm materials (brick, stone, siding, trim, garage door, roof) match the community approved palette. Operator: spot-check the inline PDF preview against the palette guide before issuing the letter.',
      ],
      denial_reasons: [],
      signals,
    };
  }

  // Safety net — should be unreachable, but never silently drop
  return {
    recommended_action: 'request_more_info',
    confidence: 'low',
    reasoning: 'Recommendation rules did not match cleanly. Operator review needed.',
    conditions: [],
    denial_reasons: [],
    signals,
  };
}

router.get('/:id/recommendation', async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) return next();
  try {
    const { data: app, error } = await supabase
      .from('builder_applications')
      .select('id, fast_track, master_plan_id, plan_number, elevation, street_address, application_data')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!app) return res.status(404).json({ error: 'application not found' });
    const recommendation = computeBuilderRecommendation(app);
    res.json({ application_id: app.id, recommendation });
  } catch (err) {
    console.error('[builder_applications] recommendation failed:', err.message);
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
        // Surface the community's ARC review fee on the letter (Ed 2026-06-11)
        // so the builder has confirmation of the charge for AP reconciliation
        // against the Bedrock invoice.
        review_fee_cents: app.community?.builder_arc_fee_cents ?? null,
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
// Build the email envelope (to, subject, html, text, pdf buffer + filename) for
// a given builder_application + response. Shared by both POST /:id/send (Resend
// auto-send) and GET /:id/eml-export (download as .eml for Outlook review).
// Single source of truth so the email Ed previews in Outlook is byte-identical
// to what Resend would have sent.
async function buildBuilderEmailEnvelope(applicationId, responseId, opts = {}) {
  const { forceRegenerate = false } = opts;
  const { data: app, error: aErr } = await supabase
    .from('builder_applications')
    .select(`
      *,
      community:communities(id, name, slug, builder_arc_fee_cents),
      builder_company:builder_companies(id, company_name, primary_contact_email, primary_contact_name, mailing_address)
    `)
    .eq('id', applicationId)
    .single();
  if (aErr) throw new Error(aErr.message);
  if (!app) throw new Error('application not found');

  let response;
  if (responseId) {
    const { data } = await supabase
      .from('builder_application_responses')
      .select('*')
      .eq('id', responseId)
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
  if (!response) { const e = new Error('no response found for this application'); e.statusCode = 404; throw e; }
  if (!response.letter_pdf_path && !forceRegenerate) { const e = new Error('no letter PDF on record (request_more_info responses do not generate a letter)'); e.statusCode = 400; throw e; }
  if (response.response_type === 'request_more_info' && forceRegenerate) {
    const e = new Error('request_more_info responses do not generate a letter'); e.statusCode = 400; throw e;
  }

  // forceRegenerate (set by /eml-export) renders the PDF fresh from the
  // current database state -- so contact-info edits (e.g. fixing Karla's
  // last name) flow into the next preview without requiring staff to click
  // "Render letter" again. Cached path is kept for already-sent letters and
  // for /:id/send (the record of what went out should be stable).
  let pdfBuffer;
  if (forceRegenerate && !response.email_sent_at) {
    const conditionsList = (response.conditions || '').split('\n').filter(Boolean);
    const denialReasonsList = (response.denial_reasons || '').split('\n').filter(Boolean);
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
      decision_type: response.response_type,
      conditions: conditionsList.length ? conditionsList : (response.conditions || null),
      denial_reasons: denialReasonsList.length ? denialReasonsList : (response.denial_reasons || null),
      signer_name: response.decided_by,
      review_fee_cents: app.community?.builder_arc_fee_cents ?? null,
    };
    pdfBuffer = await renderBuilderLetterPdfBuffer(letterArgs);
    // Replace the cached storage copy too so the builder portal's download
    // link reflects the same fresh content.
    try {
      const fresh = await uploadLetterPdf({
        pdfBuffer,
        communitySlug: app.community.slug,
        referenceNumber: app.reference_number,
      });
      await supabase
        .from('builder_application_responses')
        .update({
          letter_pdf_path: fresh.path,
          letter_signed_url: fresh.signed_url,
          letter_signed_url_expires_at: fresh.signed_url_expires_at,
        })
        .eq('id', response.id);
      response.letter_pdf_path = fresh.path;
    } catch (e) {
      console.warn('[builder_applications.buildBuilderEmailEnvelope] storage refresh skipped:', e.message);
    }
  } else {
    const { data: dl, error: dlErr } = await supabase.storage.from(STORAGE_BUCKET).download(response.letter_pdf_path);
    if (dlErr) throw new Error(`failed to read letter PDF: ${dlErr.message}`);
    pdfBuffer = Buffer.from(await dl.arrayBuffer());
  }

  const toEmail = app.builder_company.primary_contact_email || app.submitter_email || '';
  const { sanitizeNameForLetter } = require('../lib/builder_letter');
  const greetingName = sanitizeNameForLetter(app.builder_company.primary_contact_name)
                     || sanitizeNameForLetter(app.submitter_name)
                     || 'Team';
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
      <p>Questions or revised submissions: reply to this email, write to <a href="mailto:builders@bedrocktx.com">builders@bedrocktx.com</a>, or use the portal at <a href="https://builders.bedrocktxai.com">builders.bedrocktxai.com</a>.</p>
      <p style="color:#555; font-size:11px; margin-top:24px;">
        Sent on behalf of the ${app.community.name} Architectural Control Committee by Bedrock Association Management.
      </p>
    `;
  const subject = response.email_subject || emailSubjectFor(app, response.response_type);
  const filename = `${app.reference_number}.pdf`;

  return { app, response, toEmail, subject, html, text: plaintextFromHtml(html), pdfBuffer, filename };
}

// Compose an RFC 5322 .eml file with the letter PDF attached. The X-Unsent: 1
// header tells Outlook to open this as a NEW message in compose mode (Ed sees
// the editable draft) rather than as a received-mail viewer. Works on Outlook
// desktop on Windows — staff machine default.
function buildEmlFile({ from, to, subject, html, pdfBuffer, pdfFilename }) {
  const boundary = '----=_BedrockARC_' + Math.random().toString(36).slice(2, 14);
  const rfc2822Date = new Date().toUTCString();
  // Base64-wrap to 76 chars per RFC 2045
  const b64 = pdfBuffer.toString('base64').replace(/(.{76})/g, '$1\r\n');
  const safeSubject = subject.replace(/[\r\n]+/g, ' ');
  const parts = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${safeSubject}`,
    `Date: ${rfc2822Date}`,
    `MIME-Version: 1.0`,
    `X-Unsent: 1`,           // <-- Outlook opens in compose mode
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `This is a multi-part message in MIME format.`,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    html,
    ``,
    `--${boundary}`,
    `Content-Type: application/pdf; name="${pdfFilename}"`,
    `Content-Disposition: attachment; filename="${pdfFilename}"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    b64,
    `--${boundary}--`,
    ``,
  ];
  return parts.join('\r\n');
}

// ============================================================================
// GET /api/builder-applications/:id/eml-export
// Downloads the staged email as a .eml file. Double-clicking the file in
// Windows opens it in Outlook as an editable draft (X-Unsent:1 header). Staff
// can review the recipient + body + attached PDF, tweak if needed, then click
// Send from Outlook. Nothing leaves Bedrock until staff hits send.
// Ed 2026-06-16: "export to email with outlook so we can look at before sending."
// ============================================================================
router.get('/:id/eml-export', async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) return next();
  try {
    // forceRegenerate so the EML always reflects current contact info /
    // material spec / community name. Cached PDF skipped for unsent letters.
    const env = await buildBuilderEmailEnvelope(req.params.id, req.query.response_id || null, { forceRegenerate: true });
    const eml = buildEmlFile({
      from: '"Bedrock ARC" <builders@bedrocktx.com>',
      to: env.toEmail,
      subject: env.subject,
      html: env.html,
      pdfBuffer: env.pdfBuffer,
      pdfFilename: env.filename,
    });
    const filenameSafe = (env.app.reference_number || 'arc-letter').replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'message/rfc822');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameSafe}.eml"`);
    res.send(eml);
  } catch (err) {
    console.error('[builder_applications.eml-export]', err);
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || 'eml export failed' });
  }
});

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
    // Build the envelope through the shared helper so the email body, subject,
    // attachment, and sanitized greeting are byte-identical to what
    // /eml-export produces. One source of truth -- if Ed reviews a draft in
    // Outlook, Send-to-builder sends the same thing.
    let env;
    try {
      env = await buildBuilderEmailEnvelope(req.params.id, req.body.response_id || null);
    } catch (e) {
      return res.status(e.statusCode || 500).json({ error: e.message });
    }
    const app = env.app;
    const response = env.response;
    if (response.email_sent_at) return res.status(400).json({ error: 'already sent', email_sent_at: response.email_sent_at });

    const toEmail = req.body.to || env.toEmail;
    const bcc = [ARCHIVE_BCC];

    const send = await sendEmail({
      to: toEmail,
      subject: env.subject,
      html: env.html,
      text: env.text,
      attachments: [{
        filename: env.filename,
        content: env.pdfBuffer.toString('base64'),
      }],
      replyTo: 'builders@bedrocktx.com',
      tags: [
        { name: 'module', value: 'arc_builder' },
        { name: 'community', value: env.app.community.slug || 'unknown' },
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
// POST /api/builder-applications/master-plans
// Admin-only direct upload — register a master plan WITHOUT going through
// the submission → approve → promote flow. Used when a builder hands over
// their plan inventory in bulk (e.g., DRB at August Meadows: 5+ plans to
// register before they file any individual lot submissions).
//
// Multipart form:
//   plan_pdf            file       PDF of the plan set (required)
//   builder_company_id  UUID       (required)
//   plan_number         text       e.g., "6512" (required)
//   elevation           text       e.g., "A" (required)
//   plan_name           text       e.g., "The Tuscany"
//   elevation_orientation text     "left" | "right" | "standard"
//   square_footage     int
//   stories            numeric
//   default_materials  JSON string brick_color, paint_palette, etc.
//   notes              text
//   status             text       defaults to "approved" (admin uploads are
//                                  treated as already approved by Bedrock review)
//   community_ids      JSON array Pre-approve for these community IDs
//                                  (creates master_plan_community_approvals rows)
//
// Flow:
//   1. Upload PDF to storage bucket 'documents' under builders/<builder_id>/
//      master-plans/<filename>
//   2. Insert library_documents row (category=master_plan_pdf) so the OCR
//      pipeline indexes it for askEd retrieval
//   3. Insert master_plans row linking to the library_documents row
//   4. For each provided community_id, insert master_plan_community_approvals
//   5. Return the new plan + community approvals
//
// Idempotency: master_plans has UNIQUE (builder_company_id, plan_number,
// elevation, elevation_orientation) so re-uploading the same plan returns
// a 409 conflict rather than creating duplicates.
// ============================================================================
const fs_ = require('fs');
const crypto_ = require('crypto');

router.post('/master-plans', upload.single('plan_pdf'), async (req, res) => {
  try {
    const body = req.body || {};
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'plan_pdf file is required' });
    if (file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'plan_pdf must be a PDF file' });
    }
    if (!body.builder_company_id) return res.status(400).json({ error: 'builder_company_id is required' });
    if (!body.plan_number) return res.status(400).json({ error: 'plan_number is required' });
    if (!body.elevation) return res.status(400).json({ error: 'elevation is required (e.g., "A")' });

    // Parse the optional structured fields
    let defaultMaterials = {};
    if (body.default_materials) {
      try {
        defaultMaterials = typeof body.default_materials === 'string'
          ? JSON.parse(body.default_materials)
          : body.default_materials;
      } catch (e) {
        return res.status(400).json({ error: 'default_materials must be valid JSON' });
      }
    }
    let communityIds = [];
    if (body.community_ids) {
      try {
        communityIds = typeof body.community_ids === 'string'
          ? JSON.parse(body.community_ids)
          : body.community_ids;
        if (!Array.isArray(communityIds)) communityIds = [];
      } catch (e) {
        return res.status(400).json({ error: 'community_ids must be a JSON array of UUIDs' });
      }
    }

    // Verify builder_company exists + belongs to Bedrock
    const { data: company } = await supabase
      .from('builder_companies')
      .select('id, company_name')
      .eq('id', body.builder_company_id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (!company) return res.status(404).json({ error: 'builder_company not found' });

    // ---- 1) Upload PDF to storage --------------------------------------
    const safePlanNumber = String(body.plan_number).replace(/[^a-zA-Z0-9._-]/g, '_');
    const safeElevation = String(body.elevation).replace(/[^a-zA-Z0-9._-]/g, '_');
    const stamp = Date.now();
    const storagePath = `builders/${company.id}/master-plans/${safePlanNumber}_${safeElevation}_${stamp}.pdf`;
    const fileHash = crypto_.createHash('sha256').update(file.buffer).digest('hex');

    const { error: upErr } = await supabase.storage
      .from('documents')
      .upload(storagePath, file.buffer, { contentType: 'application/pdf', upsert: false });
    if (upErr) {
      console.error('[master-plans POST] storage upload failed:', upErr.message);
      return res.status(500).json({ error: 'storage upload failed: ' + upErr.message });
    }

    // ---- 2) Insert library_documents row ------------------------------
    // Pick the first community in the pre-approval list as community_id
    // hint (so the doc shows under that community's matrix). If none
    // selected, leave NULL — the doc is still searchable globally.
    const docTitle = (body.plan_name && body.plan_name.trim())
      ? `${company.company_name} ${body.plan_number} (${body.elevation}) — ${body.plan_name}`
      : `${company.company_name} ${body.plan_number} (${body.elevation})`;
    const fileNameOriginal = file.originalname || `${safePlanNumber}_${safeElevation}.pdf`;
    const fileNameNormalized = `${company.company_name.replace(/\s+/g, '-')}-${safePlanNumber}-${safeElevation}-master-plan.pdf`;

    const { data: libDoc, error: libErr } = await supabase
      .from('library_documents')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id: communityIds[0] || null,
        category: 'master_plan_pdf',
        title: docTitle,
        file_path: storagePath,
        file_name_original: fileNameOriginal,
        file_name_normalized: fileNameNormalized,
        file_hash: fileHash,
        status: 'current',
        index_status: 'pending',
        uploaded_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (libErr) {
      console.error('[master-plans POST] library_documents insert failed:', libErr.message);
      // Roll back storage so we don't leave an orphan
      try { await supabase.storage.from('documents').remove([storagePath]); } catch (_) {}
      return res.status(500).json({ error: 'library_documents insert failed: ' + libErr.message });
    }

    // ---- 3) Insert master_plans row -----------------------------------
    const { data: plan, error: planErr } = await supabase
      .from('master_plans')
      .insert({
        builder_company_id: company.id,
        plan_number: String(body.plan_number).trim(),
        plan_name: (body.plan_name || '').trim() || null,
        elevation: String(body.elevation).trim(),
        elevation_orientation: body.elevation_orientation || null,
        square_footage: body.square_footage ? parseInt(body.square_footage, 10) : null,
        stories: body.stories ? parseFloat(body.stories) : null,
        default_materials: defaultMaterials,
        status: body.status || 'approved',
        notes: body.notes || null,
        library_document_id: libDoc.id,
      })
      .select('*')
      .single();
    if (planErr) {
      console.error('[master-plans POST] master_plans insert failed:', planErr.message);
      // Roll back library_documents + storage
      try {
        await supabase.from('library_documents').delete().eq('id', libDoc.id);
        await supabase.storage.from('documents').remove([storagePath]);
      } catch (_) {}
      // Surface the duplicate case clearly
      if (planErr.code === '23505') {
        return res.status(409).json({
          error: 'A master plan with this builder/plan_number/elevation/orientation already exists.',
          builder: company.company_name,
          plan_number: body.plan_number,
          elevation: body.elevation,
        });
      }
      return res.status(500).json({ error: 'master_plans insert failed: ' + planErr.message });
    }

    // ---- 4) Pre-approve for selected communities ---------------------
    const approvalRows = [];
    for (const cid of communityIds) {
      if (!cid) continue;
      const { data: appr, error: apprErr } = await supabase
        .from('master_plan_community_approvals')
        .insert({
          master_plan_id: plan.id,
          community_id: cid,
          approved_by: 'direct_admin_upload',
        })
        .select()
        .single();
      if (apprErr) {
        console.warn('[master-plans POST] community approval insert failed for', cid, apprErr.message);
      } else {
        approvalRows.push(appr);
      }
    }

    res.json({
      ok: true,
      master_plan: plan,
      community_approvals: approvalRows,
      library_document_id: libDoc.id,
      pdf_storage_path: storagePath,
    });
  } catch (err) {
    console.error('[master-plans POST]', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/builder-applications/master-plans/bulk-extract
// Admin-only bulk PDF upload. For each PDF:
//   1. Upload to documents storage under builders/<bid>/master-plans/
//   2. Insert library_documents row (category=master_plan_pdf, index_status=
//      'pending' so the OCR/reindex pipeline picks it up for askEd retrieval)
//   3. Send the PDF binary to Claude PDF-direct extraction asking for
//      plan_number, plan_name, elevation, square_footage, stories
//   4. Return the extracted fields + library_document_id per file
//
// Does NOT create master_plans rows. The operator reviews the extracted
// metadata in a grid, edits anything wrong, then submits to bulk-commit.
// Two-step flow because AI extraction is ~95% accurate; 5% drift on a
// master plan registration matters (wrong plan number → DRB submissions
// don't fast-track and staff has to re-tag manually).
//
// Multipart form:
//   plan_pdfs[]         multiple PDFs (up to 30 per call)
//   builder_company_id  UUID (required) — applies to all PDFs in this batch
//
// Returns: { extracted: [{ filename, library_document_id, file_path,
//             plan_number, plan_name, elevation, square_footage, stories,
//             ai_confidence, ai_notes, error?: string }, ...] }
// ============================================================================
router.post('/master-plans/bulk-extract', uploadBulk.array('plan_pdfs', 30), async (req, res) => {
  try {
    const { requireAdmin } = require('./users');
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;

    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: 'plan_pdfs files required' });

    const builderId = req.body?.builder_company_id;
    if (!builderId) return res.status(400).json({ error: 'builder_company_id is required' });

    const { data: company } = await supabase
      .from('builder_companies')
      .select('id, company_name')
      .eq('id', builderId)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (!company) return res.status(404).json({ error: 'builder_company not found' });

    // Anthropic SDK for the PDF-direct extraction
    let Anthropic, anthropic;
    try {
      Anthropic = require('@anthropic-ai/sdk');
      anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    } catch (e) {
      return res.status(500).json({ error: 'Anthropic SDK unavailable: ' + e.message });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured — extraction unavailable' });
    }

    const EXTRACT_PROMPT = `You are reviewing a builder's home plan PDF. Extract EVERY elevation shown in this PDF.

A single PDF often shows multiple elevations of the same base plan (e.g., Plan 6512 Elevation A, B, and C — usually one cover sheet listing all three then detail pages per elevation). Return ALL elevations as an array. If the PDF shows only one elevation, return a single-element array.

Each entry in the array:
- plan_number: The plan identifier (e.g., "6512"). Usually shared across elevations of the same plan.
- plan_name: The marketing/series name (e.g., "The Tuscany"). Usually shared.
- elevation: The elevation letter or code shown (REQUIRED — A, B, C, Standard, etc.). Must be unique within the array.
- square_footage: Heated/living-area square footage as an integer. May vary per elevation. null if not stated.
- stories: Number of stories (1, 1.5, 2, 2.5, 3). null if not stated.

Plus top-level fields about the PDF as a whole:
- ai_confidence: "high" | "medium" | "low" — your overall confidence in the extraction
- ai_notes: Any caveats — "schedule of plans table shows three elevations" or "couldn't find sqft on cover sheet, may be on detail pages" or "this looks like a site plan not a home plan"

Look at: the title block (usually top-right or bottom of the cover sheet), the schedule of plans table (often a grid showing each elevation's footprint + sqft), square footage callouts, elevation header labels on per-elevation detail pages.

Return ONLY valid JSON, no preamble:
{
  "elevations": [
    {"plan_number":"6512","plan_name":"Tuscany","elevation":"A","square_footage":2150,"stories":2},
    {"plan_number":"6512","plan_name":"Tuscany","elevation":"B","square_footage":2150,"stories":2}
  ],
  "ai_confidence":"high",
  "ai_notes":"Schedule of plans on page 1 lists A, B, C."
}

If you can identify the plan number + at least one elevation, return what you can. If you cannot identify even the plan number, return {"elevations":[], "ai_confidence":"low", "ai_notes":"explain why"}.`;

    const out = [];
    for (const file of files) {
      const filename = file.originalname || 'unknown.pdf';
      if (file.mimetype !== 'application/pdf') {
        out.push({ filename, error: `not a PDF (got ${file.mimetype})` });
        continue;
      }
      try {
        // 1. Hash first — if this PDF is already in library_documents (same
        //    SHA-256), reuse that row instead of uploading a duplicate. Lets
        //    the operator re-run an upload safely after a partial-failure
        //    without hitting the ux_docs_file_hash unique constraint.
        const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const fileHash = require('crypto').createHash('sha256').update(file.buffer).digest('hex');
        const fileNameNormalized = `${company.company_name.replace(/\s+/g, '-')}-${safeName}`;

        let libDocId = null;
        let storagePath = null;
        let reusedExisting = false;

        const { data: existing, error: existErr } = await supabase
          .from('library_documents')
          .select('id, file_path')
          .eq('file_hash', fileHash)
          .maybeSingle();
        if (existErr && existErr.code !== 'PGRST116') {
          out.push({ filename, error: 'hash lookup: ' + existErr.message });
          continue;
        }

        if (existing) {
          libDocId = existing.id;
          storagePath = existing.file_path;
          reusedExisting = true;
        } else {
          // New file — upload to storage + insert library_documents row.
          const stamp = Date.now() + '-' + Math.floor(Math.random() * 10000);
          storagePath = `builders/${company.id}/master-plans/${stamp}_${safeName}`;

          const { error: upErr } = await supabase.storage.from(STORAGE_BUCKET)
            .upload(storagePath, file.buffer, { contentType: 'application/pdf', upsert: false });
          if (upErr) { out.push({ filename, error: 'storage upload: ' + upErr.message }); continue; }

          const { data: libDoc, error: libErr } = await supabase
            .from('library_documents')
            .insert({
              management_company_id: BEDROCK_MGMT_CO_ID,
              community_id: null,  // populated at bulk-commit time when operator picks pre-approval communities
              category: 'master_plan_pdf',
              title: `${company.company_name} — ${filename.replace(/\.pdf$/i, '')}`,
              file_path: storagePath,
              file_name_original: filename,
              file_name_normalized: fileNameNormalized,
              file_hash: fileHash,
              status: 'current',
              index_status: 'pending',
              uploaded_at: new Date().toISOString(),
            })
            .select('id')
            .single();
          if (libErr) {
            try { await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]); } catch (_) {}
            out.push({ filename, error: 'library_documents insert: ' + libErr.message });
            continue;
          }
          libDocId = libDoc.id;
        }

        // Synthetic libDoc handle for the rest of the loop (existing code reads libDoc.id)
        const libDoc = { id: libDocId };

        // 3. Claude PDF-direct extract
        let extracted = null;
        let aiRaw = null;
        try {
          // Use the shared helper which trims oversized PDFs to the first
          // 10 pages before sending to Claude (page-count + size limits).
          const result = await extractMasterPlanFromPdfBuffer(file.buffer);
          extracted = result.extracted;
          aiRaw = result.raw;
        } catch (aiErr) {
          console.warn('[bulk-extract] AI extraction failed for', filename, '·', aiErr.message);
          extracted = null;
        }

        // The new prompt asks for an "elevations" array so a single PDF
        // can produce multiple registration rows (one per elevation). For
        // each entry, we share the library_document_id but stamp a unique
        // elevation + per-row sqft/stories. Falls back to a single empty
        // row when extraction returns nothing usable so the operator can
        // still see + edit the filename in the grid.
        const elevations = Array.isArray(extracted?.elevations) ? extracted.elevations : [];
        if (elevations.length > 0) {
          elevations.forEach((elev, idx) => {
            out.push({
              filename,
              library_document_id: libDoc.id,
              file_path: storagePath,
              plan_number: elev?.plan_number || null,
              plan_name: elev?.plan_name || null,
              elevation: elev?.elevation || null,
              square_footage: elev?.square_footage ?? null,
              stories: elev?.stories ?? null,
              ai_confidence: extracted?.ai_confidence || null,
              ai_notes: idx === 0 ? (extracted?.ai_notes || null) : null,
              elevation_index: idx + 1,
              elevation_count: elevations.length,
              raw_extracted: idx === 0 ? aiRaw : null,
            });
          });
        } else {
          // Extraction returned nothing — single placeholder row so the
          // operator can still type in the metadata manually.
          out.push({
            filename,
            library_document_id: libDoc.id,
            file_path: storagePath,
            plan_number: null,
            plan_name: null,
            elevation: null,
            square_footage: null,
            stories: null,
            ai_confidence: extracted?.ai_confidence || 'low',
            ai_notes: extracted?.ai_notes || 'AI returned no elevations — review PDF manually',
            elevation_index: 1,
            elevation_count: 1,
            raw_extracted: aiRaw,
          });
        }
      } catch (perFileErr) {
        console.error('[bulk-extract] per-file failure for', filename, '·', perFileErr.message);
        out.push({ filename, error: perFileErr.message });
      }
    }

    // Per-PDF success count — distinct from total elevations because one
    // PDF can produce multiple rows now. Counts unique filenames that
    // produced at least one error-free row.
    const successfulFilenames = new Set(out.filter((r) => !r.error).map((r) => r.filename));

    res.json({
      ok: true,
      builder_company: { id: company.id, name: company.company_name },
      extracted: out,
      total_files: files.length,
      total_files_ok: successfulFilenames.size,
      total_extracted_rows: out.filter((r) => !r.error).length,
    });
  } catch (err) {
    console.error('[bulk-extract]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/builder-applications/master-plans/bulk-commit
// Admin-only. Companion to /bulk-extract — takes the reviewed grid of rows
// and creates master_plans + master_plan_community_approvals records.
// Each row carries a library_document_id from the prior extract step.
//
// Body: {
//   builder_company_id,
//   community_ids: [uuid, ...],   // pre-approve at these communities
//   rows: [{
//     library_document_id, plan_number, plan_name?, elevation,
//     elevation_orientation?, square_footage?, stories?, notes?
//   }, ...]
// }
//
// Returns: { ok, registered: [{plan_number, elevation, master_plan_id}],
//            failed: [{filename or row, error}] }
// ============================================================================
router.post('/master-plans/bulk-commit', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const { requireAdmin } = require('./users');
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;

    const body = req.body || {};
    const builderId = body.builder_company_id;
    if (!builderId) return res.status(400).json({ error: 'builder_company_id required' });
    const communityIds = Array.isArray(body.community_ids) ? body.community_ids.filter(Boolean) : [];
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (rows.length === 0) return res.status(400).json({ error: 'rows array required' });

    const { data: company } = await supabase
      .from('builder_companies')
      .select('id, company_name')
      .eq('id', builderId)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (!company) return res.status(404).json({ error: 'builder_company not found' });

    const registered = [];
    const failed = [];

    for (const row of rows) {
      try {
        // Required-field validation
        if (!row.library_document_id) { failed.push({ row, error: 'library_document_id missing' }); continue; }
        if (!row.plan_number) { failed.push({ row, error: 'plan_number required' }); continue; }
        if (!row.elevation) { failed.push({ row, error: 'elevation required' }); continue; }

        // Community pre-approval lives ONLY in master_plan_community_approvals
        // below. Do not mutate library_documents.community_id — a master plan
        // can be approved at multiple communities, and storing one of them on
        // the PDF row was a single-source-of-truth violation.

        const { data: plan, error: planErr } = await supabase
          .from('master_plans')
          .insert({
            builder_company_id: company.id,
            plan_number: String(row.plan_number).trim(),
            plan_name: (row.plan_name || '').trim() || null,
            elevation: String(row.elevation).trim(),
            elevation_orientation: row.elevation_orientation || null,
            square_footage: row.square_footage ? parseInt(row.square_footage, 10) : null,
            stories: row.stories ? parseFloat(row.stories) : null,
            default_materials: row.default_materials || {},
            status: 'approved',
            notes: row.notes || null,
            library_document_id: row.library_document_id,
          })
          .select('id, plan_number, elevation')
          .single();
        if (planErr) {
          if (planErr.code === '23505') {
            failed.push({ row, error: `duplicate master plan: ${row.plan_number} / ${row.elevation}` });
          } else {
            failed.push({ row, error: planErr.message });
          }
          continue;
        }

        // Pre-approve at selected communities
        for (const cid of communityIds) {
          try {
            await supabase.from('master_plan_community_approvals').insert({
              master_plan_id: plan.id,
              community_id: cid,
              approved_by: 'bulk_admin_upload',
            });
          } catch (_) {}
        }

        registered.push({ master_plan_id: plan.id, plan_number: plan.plan_number, elevation: plan.elevation });
      } catch (perRowErr) {
        failed.push({ row, error: perRowErr.message });
      }
    }

    res.json({
      ok: true,
      builder_company: { id: company.id, name: company.company_name },
      community_ids: communityIds,
      registered_count: registered.length,
      failed_count: failed.length,
      registered,
      failed,
    });
  } catch (err) {
    console.error('[bulk-commit]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// GET /api/builder-applications/master-plans/orphans
// ----------------------------------------------------------------------------
// Returns library_documents rows with category='master_plan_pdf' that have
// NO master_plans row linking back. These are PDFs that landed via the bulk
// extract step but never got registered as plans — either the operator
// closed the modal between steps, the commit failed for some rows, or the
// hash-collision bug rejected them before today's fix.
//
// Placed BEFORE the dynamic /master-plans/:id routes to avoid Express
// matching "orphans" as a UUID and 500-ing.
// ============================================================================
router.get('/master-plans/orphans', async (req, res) => {
  try {
    // All master_plan PDFs
    const { data: docs, error: docsErr } = await supabase
      .from('library_documents')
      .select('id, title, file_name_original, file_path, uploaded_at')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('category', 'master_plan_pdf')
      .order('uploaded_at', { ascending: false });
    if (docsErr) throw docsErr;

    if (!docs || docs.length === 0) {
      return res.json({ ok: true, orphans: [], total: 0 });
    }

    // Which of those are already linked from master_plans?
    const docIds = docs.map((d) => d.id);
    const { data: linked, error: linkedErr } = await supabase
      .from('master_plans')
      .select('library_document_id')
      .in('library_document_id', docIds);
    if (linkedErr) throw linkedErr;
    const linkedSet = new Set((linked || []).map((r) => r.library_document_id));

    const orphans = docs.filter((d) => !linkedSet.has(d.id));
    res.json({ ok: true, orphans, total: orphans.length });
  } catch (err) {
    console.error('[builder_applications] orphans list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// GET /api/builder-applications/master-plans/orphans/:library_document_id/pdf
// ----------------------------------------------------------------------------
// Redirects to a short-lived signed URL for the orphan PDF. Same pattern as
// the registered-plan PDF endpoint but scoped to library_documents directly.
// ============================================================================
router.get('/master-plans/orphans/:library_document_id/pdf', async (req, res) => {
  try {
    const { data: doc, error: docErr } = await supabase
      .from('library_documents')
      .select('id, category, file_path')
      .eq('id', req.params.library_document_id)
      .maybeSingle();
    if (docErr) throw docErr;
    if (!doc) return res.status(404).json({ error: 'library_document_not_found' });
    if (doc.category !== 'master_plan_pdf') {
      return res.status(400).json({ error: 'not a master plan PDF' });
    }
    if (!doc.file_path) return res.status(404).json({ error: 'pdf_missing' });
    const { data: signed, error: signErr } = await supabase
      .storage.from(STORAGE_BUCKET).createSignedUrl(doc.file_path, 60 * 10);
    if (signErr) throw signErr;
    res.redirect(signed.signedUrl);
  } catch (err) {
    console.error('[builder_applications] orphan pdf failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/builder-applications/master-plans/orphans/:library_document_id/extract
// ----------------------------------------------------------------------------
// Runs AI extraction on an orphan PDF and returns the structured fields the
// frontend needs to pre-populate the registration form. Also infers the
// builder_company_id from the library_documents.title prefix + suggests
// community_ids from that builder's active_community_ids.
//
// No DB writes. The frontend uses this to fill in the form, operator
// verifies, then either calls /register or /auto-register to commit.
// ============================================================================
router.post('/master-plans/orphans/:library_document_id/extract', async (req, res) => {
  try {
    const { requireAdmin } = require('./users');
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;

    const libId = req.params.library_document_id;
    const { data: doc, error: docErr } = await supabase
      .from('library_documents')
      .select('id, title, file_path, category')
      .eq('id', libId)
      .maybeSingle();
    if (docErr) throw docErr;
    if (!doc) return res.status(404).json({ error: 'library_document_not_found' });
    if (doc.category !== 'master_plan_pdf') return res.status(400).json({ error: 'not a master plan PDF' });
    if (!doc.file_path) return res.status(404).json({ error: 'pdf_missing' });

    // Download the PDF bytes from storage so we can hand it to Claude
    const { data: blob, error: dlErr } = await supabase.storage.from(STORAGE_BUCKET).download(doc.file_path);
    if (dlErr) throw dlErr;
    const arrayBuf = await blob.arrayBuffer();
    const pdfBuffer = Buffer.from(arrayBuf);

    // AI extract
    let extracted = null;
    let raw = null;
    try {
      const result = await extractMasterPlanFromPdfBuffer(pdfBuffer);
      extracted = result.extracted;
      raw = result.raw;
    } catch (aiErr) {
      console.warn('[orphan-extract] AI failed for', doc.id, '·', aiErr.message);
    }

    // Infer builder from title
    const inferredBuilderId = await inferBuilderFromTitle(doc.title);

    // Suggest community pre-approvals from the inferred builder's active_community_ids
    let suggestedCommunityIds = [];
    if (inferredBuilderId) {
      const { data: builder } = await supabase
        .from('builder_companies')
        .select('active_community_ids')
        .eq('id', inferredBuilderId)
        .maybeSingle();
      if (Array.isArray(builder?.active_community_ids)) {
        suggestedCommunityIds = builder.active_community_ids;
      }
    }

    res.json({
      ok: true,
      library_document_id: libId,
      elevations: Array.isArray(extracted?.elevations) ? extracted.elevations : [],
      ai_confidence: extracted?.ai_confidence || 'low',
      ai_notes: extracted?.ai_notes || null,
      inferred_builder_company_id: inferredBuilderId,
      suggested_community_ids: suggestedCommunityIds,
      raw_extracted: raw,
    });
  } catch (err) {
    console.error('[builder_applications] orphan extract failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/builder-applications/master-plans/orphans/:library_document_id/auto-register
// ----------------------------------------------------------------------------
// Runs extract + creates master_plans rows + community approvals in one call.
// Fans out into one master_plans row per elevation when the PDF shows
// multiple. Handles duplicate-key collisions gracefully (existing plan with
// same builder+plan#+elevation = skip + report).
//
// Body (all optional — server infers when missing):
//   { builder_company_id?, community_ids?: [uuid, ...] }
// Returns: { ok, registered: [{ plan_number, elevation, master_plan_id }],
//            skipped: [{ reason, plan_number, elevation }],
//            ai_confidence, ai_notes }
// ============================================================================
router.post('/master-plans/orphans/:library_document_id/auto-register',
  express.json({ limit: '8kb' }),
  async (req, res) => {
    try {
      const { requireAdmin } = require('./users');
      const ctx = await requireAdmin(req, res);
      if (!ctx) return;

      const libId = req.params.library_document_id;
      const { data: doc, error: docErr } = await supabase
        .from('library_documents')
        .select('id, title, file_path, category')
        .eq('id', libId)
        .maybeSingle();
      if (docErr) throw docErr;
      if (!doc) return res.status(404).json({ error: 'library_document_not_found' });
      if (doc.category !== 'master_plan_pdf') return res.status(400).json({ error: 'not a master plan PDF' });
      if (!doc.file_path) return res.status(404).json({ error: 'pdf_missing' });

      // Already linked? Don't re-register.
      const { data: existing } = await supabase.from('master_plans')
        .select('id').eq('library_document_id', libId).limit(1);
      if (existing && existing.length > 0) {
        return res.status(409).json({ error: 'orphan already linked to a master plan — refresh the page' });
      }

      // 1. Builder — from body, else infer from title
      let builderId = req.body?.builder_company_id || null;
      if (!builderId) builderId = await inferBuilderFromTitle(doc.title);
      if (!builderId) {
        return res.status(400).json({ error: 'builder_unknown — title did not match any builder + none provided' });
      }
      const { data: builder } = await supabase
        .from('builder_companies').select('id, company_name, active_community_ids')
        .eq('id', builderId).eq('management_company_id', BEDROCK_MGMT_CO_ID).maybeSingle();
      if (!builder) return res.status(404).json({ error: 'builder_company_not_found' });

      // 2. Community pre-approvals — from body, else from builder's active list
      let communityIds = Array.isArray(req.body?.community_ids) ? req.body.community_ids.filter(Boolean) : null;
      if (!communityIds || communityIds.length === 0) {
        communityIds = Array.isArray(builder.active_community_ids) ? builder.active_community_ids : [];
      }

      // 3. AI extract
      const { data: blob, error: dlErr } = await supabase.storage.from(STORAGE_BUCKET).download(doc.file_path);
      if (dlErr) throw dlErr;
      const pdfBuffer = Buffer.from(await blob.arrayBuffer());
      const { extracted } = await extractMasterPlanFromPdfBuffer(pdfBuffer);
      const elevations = Array.isArray(extracted?.elevations) ? extracted.elevations : [];
      if (elevations.length === 0) {
        return res.status(422).json({
          error: 'ai_extract_empty — could not identify plan_number + elevation. Fill in manually.',
          ai_confidence: extracted?.ai_confidence || 'low',
          ai_notes: extracted?.ai_notes || null,
        });
      }

      // 4. Create one master_plans row per elevation
      const registered = [];
      const skipped = [];
      for (const elev of elevations) {
        if (!elev?.plan_number || !elev?.elevation) {
          skipped.push({ reason: 'missing plan_number or elevation', plan_number: elev?.plan_number || null, elevation: elev?.elevation || null });
          continue;
        }
        const { data: plan, error: planErr } = await supabase
          .from('master_plans')
          .insert({
            builder_company_id: builder.id,
            plan_number: String(elev.plan_number).trim(),
            plan_name: elev.plan_name ? String(elev.plan_name).trim() : null,
            elevation: String(elev.elevation).trim(),
            square_footage: elev.square_footage ? parseInt(elev.square_footage, 10) : null,
            stories: elev.stories ? parseFloat(elev.stories) : null,
            status: 'approved',
            library_document_id: libId,
          })
          .select('id, plan_number, elevation')
          .single();
        if (planErr) {
          if (planErr.code === '23505') {
            skipped.push({ reason: 'duplicate', plan_number: elev.plan_number, elevation: elev.elevation });
          } else {
            skipped.push({ reason: planErr.message, plan_number: elev.plan_number, elevation: elev.elevation });
          }
          continue;
        }
        // Approve at each community
        for (const cid of communityIds) {
          try {
            await supabase.from('master_plan_community_approvals').insert({
              master_plan_id: plan.id,
              community_id: cid,
              approved_by: 'orphan_auto_register',
            });
          } catch (_) {}
        }
        registered.push({ master_plan_id: plan.id, plan_number: plan.plan_number, elevation: plan.elevation });
      }

      res.json({
        ok: true,
        builder_company: { id: builder.id, name: builder.company_name },
        community_ids: communityIds,
        registered,
        skipped,
        ai_confidence: extracted?.ai_confidence || null,
        ai_notes: extracted?.ai_notes || null,
      });
    } catch (err) {
      console.error('[builder_applications] orphan auto-register failed:', err.message);
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

// ============================================================================
// POST /api/builder-applications/master-plans/orphans/:library_document_id/register
// ----------------------------------------------------------------------------
// Body: { builder_company_id, plan_number, plan_name?, elevation,
//         square_footage?, stories?, community_ids: [uuid, ...] }
// Promotes an orphan library_documents row into a master_plans row + community
// approvals. Same shape as a single bulk-commit row, scoped to one PDF.
// ============================================================================
router.post('/master-plans/orphans/:library_document_id/register',
  express.json({ limit: '64kb' }),
  async (req, res) => {
    try {
      const { requireAdmin } = require('./users');
      const ctx = await requireAdmin(req, res);
      if (!ctx) return;

      const libId = req.params.library_document_id;
      const body = req.body || {};
      if (!body.builder_company_id) return res.status(400).json({ error: 'builder_company_id required' });
      if (!body.plan_number) return res.status(400).json({ error: 'plan_number required' });
      if (!body.elevation) return res.status(400).json({ error: 'elevation required' });

      // Confirm the orphan actually exists + is a master plan PDF
      const { data: doc, error: docErr } = await supabase
        .from('library_documents')
        .select('id, category, management_company_id')
        .eq('id', libId)
        .maybeSingle();
      if (docErr) throw docErr;
      if (!doc) return res.status(404).json({ error: 'library_document_not_found' });
      if (doc.category !== 'master_plan_pdf') {
        return res.status(400).json({ error: 'library_document is not a master plan PDF' });
      }

      // Confirm builder belongs to Bedrock
      const { data: company } = await supabase
        .from('builder_companies')
        .select('id, company_name')
        .eq('id', body.builder_company_id)
        .eq('management_company_id', BEDROCK_MGMT_CO_ID)
        .maybeSingle();
      if (!company) return res.status(404).json({ error: 'builder_company_not_found' });

      // Insert master_plans row
      const { data: plan, error: planErr } = await supabase
        .from('master_plans')
        .insert({
          builder_company_id: company.id,
          plan_number: String(body.plan_number).trim(),
          plan_name: (body.plan_name || '').trim() || null,
          elevation: String(body.elevation).trim(),
          square_footage: body.square_footage ? parseInt(body.square_footage, 10) : null,
          stories: body.stories ? parseFloat(body.stories) : null,
          status: 'approved',
          library_document_id: libId,
        })
        .select('id, plan_number, elevation')
        .single();
      if (planErr) {
        if (planErr.code === '23505') {
          return res.status(409).json({ error: `duplicate master plan: ${body.plan_number} / ${body.elevation}` });
        }
        throw planErr;
      }

      // Pre-approve at the requested communities
      const communityIds = Array.isArray(body.community_ids) ? body.community_ids.filter(Boolean) : [];
      const approvals = [];
      for (const cid of communityIds) {
        try {
          await supabase.from('master_plan_community_approvals').insert({
            master_plan_id: plan.id,
            community_id: cid,
            approved_by: 'orphan_recovery',
          });
          approvals.push(cid);
        } catch (_) {}
      }

      res.json({ ok: true, master_plan: plan, approved_at: approvals });
    } catch (err) {
      console.error('[builder_applications] orphan register failed:', err.message);
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

// ============================================================================
// DELETE /api/builder-applications/master-plans/orphans/:library_document_id
// ----------------------------------------------------------------------------
// Hard-deletes an orphan master_plan PDF. Refuses to delete if the library
// document is linked from a master_plans row (use the master_plans retire
// endpoint instead). Removes the storage object best-effort.
// ============================================================================
router.delete('/master-plans/orphans/:library_document_id', async (req, res) => {
  try {
    const { requireAdmin } = require('./users');
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;

    const libId = req.params.library_document_id;

    // Refuse to delete if linked
    const { data: linked, error: linkedErr } = await supabase
      .from('master_plans')
      .select('id')
      .eq('library_document_id', libId)
      .limit(1);
    if (linkedErr) throw linkedErr;
    if (linked && linked.length > 0) {
      return res.status(409).json({
        error: 'library_document is linked from a master plan — retire the plan instead of deleting the PDF',
      });
    }

    // Get storage info before delete
    const { data: doc, error: docErr } = await supabase
      .from('library_documents')
      .select('id, category, file_path')
      .eq('id', libId)
      .maybeSingle();
    if (docErr) throw docErr;
    if (!doc) return res.status(404).json({ error: 'library_document_not_found' });
    if (doc.category !== 'master_plan_pdf') {
      return res.status(400).json({ error: 'not a master plan PDF — refusing to delete' });
    }

    // Delete row first (so even if storage delete fails, no dangling DB ref)
    const { error: delErr } = await supabase
      .from('library_documents')
      .delete()
      .eq('id', libId);
    if (delErr) throw delErr;

    // Best-effort storage cleanup
    if (doc.file_path) {
      try { await supabase.storage.from(STORAGE_BUCKET).remove([doc.file_path]); } catch (_) {}
    }

    res.json({ ok: true, deleted: libId });
  } catch (err) {
    console.error('[builder_applications] orphan delete failed:', err.message);
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
    // Stage 1: master_plans rows (flat — no nested embeds, which can silently
    // fail PostgREST relationship resolution when multiple FKs are present)
    let q = supabase.from('master_plans').select('*').order('plan_number');
    if (req.query.builder_company_id) q = q.eq('builder_company_id', req.query.builder_company_id);
    if (req.query.status) q = q.eq('status', req.query.status);
    const { data: planRows, error: planErr } = await q;
    if (planErr) throw planErr;
    const plans = planRows || [];
    console.log(`[master-plans] base query returned ${plans.length} rows`);

    if (plans.length === 0) {
      return res.json({ master_plans: [], total: 0 });
    }

    // Stage 2: hydrate builder + library_document + community approvals via
    // separate flat queries. Small N, small joins — way more debuggable than
    // a nested PostgREST embed.
    const builderIds = [...new Set(plans.map((p) => p.builder_company_id).filter(Boolean))];
    const libDocIds  = [...new Set(plans.map((p) => p.library_document_id).filter(Boolean))];
    const planIds    = plans.map((p) => p.id);

    const [buildersRes, libDocsRes, approvalsRes] = await Promise.all([
      builderIds.length
        ? supabase.from('builder_companies').select('id, company_name').in('id', builderIds)
        : Promise.resolve({ data: [] }),
      libDocIds.length
        ? supabase.from('library_documents').select('id, title, file_path').in('id', libDocIds)
        : Promise.resolve({ data: [] }),
      supabase.from('master_plan_community_approvals')
        .select('master_plan_id, community_id, approved_at, approved_by, retired_at')
        .in('master_plan_id', planIds),
    ]);

    if (buildersRes.error) throw buildersRes.error;
    if (libDocsRes.error)  throw libDocsRes.error;
    if (approvalsRes.error) throw approvalsRes.error;

    const buildersById = Object.fromEntries((buildersRes.data || []).map((b) => [b.id, b]));
    const libDocsById  = Object.fromEntries((libDocsRes.data || []).map((d) => [d.id, d]));

    // Group approvals by master_plan_id + look up community names
    const allCommunityIds = [...new Set((approvalsRes.data || []).map((a) => a.community_id).filter(Boolean))];
    let communitiesById = {};
    if (allCommunityIds.length) {
      const { data: comms, error: commsErr } = await supabase
        .from('communities').select('id, name').in('id', allCommunityIds);
      if (commsErr) throw commsErr;
      communitiesById = Object.fromEntries((comms || []).map((c) => [c.id, c]));
    }
    const approvalsByPlan = {};
    for (const a of (approvalsRes.data || [])) {
      (approvalsByPlan[a.master_plan_id] ||= []).push({
        ...a,
        community: communitiesById[a.community_id] || null,
      });
    }

    let hydrated = plans.map((p) => ({
      ...p,
      builder_company: buildersById[p.builder_company_id] || null,
      library_document: libDocsById[p.library_document_id] || null,
      community_approvals: approvalsByPlan[p.id] || [],
    }));

    if (req.query.community_id) {
      hydrated = hydrated.filter((p) => p.community_approvals
        .some((a) => a.community_id === req.query.community_id && !a.retired_at));
    }

    console.log(`[master-plans] returning ${hydrated.length} hydrated rows`);
    res.json({ master_plans: hydrated, total: hydrated.length });
  } catch (err) {
    console.error('[builder_applications] master plans list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/builder-applications/master-plans/fix-pre-approvals
// ----------------------------------------------------------------------------
// Admin-only sweep that finds master_plans rows with NO active community
// pre-approval and adds the approvals from their builder's active_community_ids.
// Used to clean up plans that were registered before migration 137 applied
// (or before the builder's active_community_ids was seeded). Idempotent —
// safe to run repeatedly; rows that already have approvals are skipped.
//
// Body: { builder_company_id? }  // scope to one builder, optional
// Returns: { ok, fixed: [{ master_plan_id, plan_number, elevation, added_community_ids }],
//            skipped_no_builder_communities: [...],
//            total_plans_checked, total_plans_fixed }
// ============================================================================
router.post('/master-plans/fix-pre-approvals', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const { requireAdmin } = require('./users');
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;

    const body = req.body || {};

    // Fetch all master_plans (optionally scoped to a builder)
    let q = supabase
      .from('master_plans')
      .select('id, builder_company_id, plan_number, elevation, status')
      .neq('status', 'retired');
    if (body.builder_company_id) q = q.eq('builder_company_id', body.builder_company_id);
    const { data: plans, error: planErr } = await q;
    if (planErr) throw planErr;
    if (!plans || plans.length === 0) {
      return res.json({ ok: true, fixed: [], total_plans_checked: 0, total_plans_fixed: 0 });
    }

    // Fetch all approvals for those plans (in one query)
    const planIds = plans.map((p) => p.id);
    const { data: approvals, error: apprErr } = await supabase
      .from('master_plan_community_approvals')
      .select('master_plan_id, community_id, retired_at')
      .in('master_plan_id', planIds);
    if (apprErr) throw apprErr;
    const activeApprovalsByPlan = {};
    for (const a of (approvals || [])) {
      if (a.retired_at) continue;
      (activeApprovalsByPlan[a.master_plan_id] ||= new Set()).add(a.community_id);
    }

    // Fetch builder active_community_ids for all relevant builders
    const builderIds = [...new Set(plans.map((p) => p.builder_company_id).filter(Boolean))];
    const buildersById = {};
    if (builderIds.length) {
      const { data: builders, error: bErr } = await supabase
        .from('builder_companies')
        .select('id, active_community_ids')
        .in('id', builderIds);
      if (bErr) throw bErr;
      for (const b of (builders || [])) {
        buildersById[b.id] = Array.isArray(b.active_community_ids) ? b.active_community_ids : [];
      }
    }

    const fixed = [];
    const skipped = [];
    for (const p of plans) {
      const existingActive = activeApprovalsByPlan[p.id] || new Set();
      const targetCommunities = buildersById[p.builder_company_id] || [];
      if (targetCommunities.length === 0) {
        if (existingActive.size === 0) {
          skipped.push({ master_plan_id: p.id, plan_number: p.plan_number, elevation: p.elevation, reason: 'builder has no active_community_ids' });
        }
        continue;
      }
      const toAdd = targetCommunities.filter((cid) => !existingActive.has(cid));
      if (toAdd.length === 0) continue;  // already covered
      for (const cid of toAdd) {
        try {
          await supabase.from('master_plan_community_approvals').insert({
            master_plan_id: p.id,
            community_id: cid,
            approved_by: 'fix_pre_approvals_sweep',
          });
        } catch (_) {}
      }
      fixed.push({
        master_plan_id: p.id,
        plan_number: p.plan_number,
        elevation: p.elevation,
        added_community_ids: toAdd,
      });
    }

    res.json({
      ok: true,
      fixed,
      skipped_no_builder_communities: skipped,
      total_plans_checked: plans.length,
      total_plans_fixed: fixed.length,
    });
  } catch (err) {
    console.error('[builder_applications] fix pre-approvals failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/builder-applications/plot-plan-extract
// ----------------------------------------------------------------------------
// AI-extract structured fields from a single plot plan PDF. Returns the
// extraction plus auto-resolved community_id, builder_company_id, and
// master_plan_id (with fast_track flag) when matches are found. Read-only —
// no DB writes. Operator reviews + commits via /auto-create-from-extraction.
//
// Multipart form: plot_plan_pdf (required)
// ============================================================================
router.post('/plot-plan-extract', upload.single('plot_plan_pdf'), async (req, res) => {
  try {
    const { requireAdmin } = require('./users');
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;

    const file = req.file;
    if (!file) return res.status(400).json({ error: 'plot_plan_pdf required' });
    if (file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'plot_plan_pdf must be a PDF' });

    const { extracted, raw } = await extractPlotPlanFromPdfBuffer(file.buffer);
    if (!extracted) {
      return res.status(422).json({
        error: 'AI returned no structured data — file may be a scan/image or unrecognized format',
        raw_extracted: raw,
      });
    }

    // Auto-resolve community + builder + master plan
    const community = await resolveCommunityFromExtraction(extracted);
    const builder = await resolveBuilderFromExtraction(extracted);
    const masterPlan = await resolveMasterPlanForExtraction(
      builder?.id, extracted.plan_number, extracted.elevation, community?.id,
    );

    res.json({
      ok: true,
      filename: file.originalname,
      extracted,
      resolved: {
        community: community ? { id: community.id, name: community.name, slug: community.slug } : null,
        builder: builder ? { id: builder.id, company_name: builder.company_name } : null,
        master_plan: masterPlan,
        fast_track: !!masterPlan?.fast_track,
      },
      raw_extracted: raw,
    });
  } catch (err) {
    console.error('[builder_applications] plot-plan-extract failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/builder-applications/color-sheet-extract
// ----------------------------------------------------------------------------
// AI-extract buyer color/material selections from a selections sheet PDF.
// Used alongside plot-plan-extract to assemble a full submission draft.
//
// Multipart form: color_sheet_pdf (required)
// ============================================================================
router.post('/color-sheet-extract', upload.single('color_sheet_pdf'), async (req, res) => {
  try {
    const { requireAdmin } = require('./users');
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;

    const file = req.file;
    if (!file) return res.status(400).json({ error: 'color_sheet_pdf required' });
    if (file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'color_sheet_pdf must be a PDF' });

    const { extracted, raw } = await extractColorSheetFromPdfBuffer(file.buffer);
    if (!extracted) {
      return res.status(422).json({
        error: 'AI returned no structured data — file may be a scan/image or unrecognized format',
        raw_extracted: raw,
      });
    }

    res.json({
      ok: true,
      filename: file.originalname,
      extracted,
      raw_extracted: raw,
    });
  } catch (err) {
    console.error('[builder_applications] color-sheet-extract failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/builder-applications/upload-on-behalf
// ----------------------------------------------------------------------------
// Staff-side single-shot intake. Karla / DRB / any other builder emails a
// multi-page ARC submission packet to Bedrock. Staff uploads it via the
// review queue and the system:
//   1. Stores the PDF in Supabase storage.
//   2. Extracts page-1 form data via Claude (builder, contact, address,
//      lot/block/section, plan/elevation, materials table, masonry +
//      repetition compliance, lot type).
//   3. Resolves or auto-creates the builder_companies row from the
//      extracted builder name + submitter email.
//   4. Generates an atomic reference_number (migration 225 RPC).
//   5. Inserts a builder_applications row in status='received',
//      source='manual_entry'. The full materials map lands in
//      application_data JSONB along with masonry/repetition flags.
//   6. Tries the master_plans auto-match for fast-track.
//   7. Returns { application_id, reference_number, extracted, fast_track }.
//
// Multipart form:
//   submission_pdf  (required PDF, up to 25MB)
//   community_id    (required UUID)
//
// On extraction failure the endpoint returns 422 with the raw Claude
// response so staff sees what was misread (per CLAUDE.md self-diagnosing
// UI rule).
//
// Ed 2026-06-16: built for the DRB / August Meadows interim email-then-
// approve workflow agreed with Paul Grover at Ventana. Replaces the
// previous "Karla emails 14 PDFs to Ed, Ed eyeballs each one" loop.
// ============================================================================
router.post('/upload-on-behalf', upload.single('submission_pdf'), async (req, res) => {
  try {
    // Staff workflow — admin OR staff role can use. Was previously gated to
    // admin-only by mistake, which blocked Karla / Laurie / anyone non-Ed
    // from running the very workflow this endpoint exists for.
    const { requireStaff } = require('./users');
    const ctx = await requireStaff(req, res);
    if (!ctx) return;

    const file = req.file;
    if (!file) return res.status(400).json({ error: 'submission_pdf required' });
    if (file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'submission_pdf must be a PDF' });
    const communityId = req.body && req.body.community_id;
    if (!communityId) return res.status(400).json({ error: 'community_id required' });

    // 1. Verify community exists + pull the slug for storage path.
    const { data: community, error: cErr } = await supabase
      .from('communities')
      .select('id, name, slug, builder_arc_reference_prefix')
      .eq('id', communityId)
      .maybeSingle();
    if (cErr || !community) return res.status(404).json({ error: 'community not found' });

    // 2. Extract page-1 form data BEFORE storage upload — if Claude
    //    returns nothing usable we want to bail before littering storage.
    let extracted = null, raw = null;
    try {
      const result = await extractSubmissionFormFromPdfBuffer(file.buffer);
      extracted = result.extracted;
      raw = result.raw;
    } catch (extractErr) {
      console.error('[builder_applications.upload-on-behalf] extraction threw:', extractErr.message);
      return res.status(500).json({
        error: 'AI extraction failed: ' + extractErr.message,
        raw_extracted: null,
      });
    }
    if (!extracted) {
      return res.status(422).json({
        error: 'AI returned no structured data — page 1 may be a scanned image, not a form. Operator can still create the application manually via the existing auto-create modal.',
        raw_extracted: raw,
      });
    }

    // 3. Resolve / auto-create builder_companies row from extracted name.
    // Uses the three-tier dedup ladder (exact -> normalized name -> email
    // domain) so "DRB Group, Inc." matches an existing "DRB Group" instead
    // of silently creating a duplicate row. Ed 2026-06-16 "match if close."
    let builderCompanyId = null;
    let builderMatch = null;  // returned to UI so staff sees what happened
    let matchedCompany = null;  // when matched, the full row from builder_companies
    if (extracted.builder_company_name) {
      const { resolveBuilderCompany } = require('../lib/builder_applications/resolve_builder_company');
      const resolved = await resolveBuilderCompany(supabase, {
        company_name:  extracted.builder_company_name,
        contact_email: extracted.contact_email,
        mgmt_co_id:    BEDROCK_MGMT_CO_ID,
      });
      if (!resolved.ok) {
        return res.status(500).json({ error: 'builder resolution failed: ' + resolved.error, extracted });
      }

      if (resolved.id) {
        builderCompanyId = resolved.id;
        matchedCompany = resolved.matched_company || null;
        builderMatch = {
          match_type:     resolved.match_type,        // 'exact' | 'normalized' | 'domain'
          matched_name:   resolved.matched_name,
          extracted_name: extracted.builder_company_name.trim(),
          matched_domain: resolved.matched_domain || null,
          notes: resolved.match_type === 'normalized'
            ? `Matched by close name (extracted "${extracted.builder_company_name.trim()}" → existing "${resolved.matched_name}")`
            : resolved.match_type === 'domain'
            ? `Matched by email domain @${resolved.matched_domain} → existing "${resolved.matched_name}"`
            : null,
        };
      } else if (resolved.match_type === 'ambiguous') {
        // Multiple plausible matches. Don't pick silently — staff resolves.
        builderMatch = {
          match_type: 'ambiguous',
          extracted_name: extracted.builder_company_name.trim(),
          candidates: resolved.candidates || [],
        };
        // For v1 we'll still let the application land WITHOUT a builder_company_id;
        // staff can pick the right one from the candidates list on the detail panel.
        // This is the safer failure mode than auto-picking the wrong DRB.
      } else {
        // match_type === 'created' — new builder
        const { data: newBc, error: bErr } = await supabase
          .from('builder_companies')
          .insert({
            management_company_id: BEDROCK_MGMT_CO_ID,
            company_name: extracted.builder_company_name.trim(),
            primary_contact_email: extracted.contact_email || null,
            primary_contact_name:  extracted.contact_person || null,
            primary_contact_phone: extracted.contact_phone || null,
            primary_email_domain: (extracted.contact_email || '').split('@')[1] || null,
            notes: 'Auto-created from upload-on-behalf intake (Ed 2026-06-16). Edit details in admin if needed.',
          })
          .select('id')
          .single();
        if (bErr) {
          console.error('[builder_applications.upload-on-behalf] builder company auto-create failed:', bErr.message);
          return res.status(500).json({ error: 'builder company create failed: ' + bErr.message, extracted });
        }
        builderCompanyId = newBc.id;
        builderMatch = {
          match_type: 'created',
          extracted_name: extracted.builder_company_name.trim(),
          new_builder_id: newBc.id,
        };
      }
    }

    // 4. Atomic reference_number via migration 225 RPC. Retry loop is
    //    belt-and-suspenders — RPC is atomic so a collision shouldn't
    //    occur, but if it does we re-allocate and retry up to 3×.
    let referenceNumber = null;
    let app = null;
    let aErr = null;
    for (let attempt = 0; attempt < 3 && !app; attempt++) {
      referenceNumber = await nextBuilderReferenceNumber(community);

      // Compose application_data JSONB. Both shapes:
      //   - Flat fields (brick_color, siding_material, etc.) that the
      //     existing detail-panel renderer reads — so materials display
      //     immediately without renderer changes.
      //   - Nested .materials map preserving the richer DRB form shape
      //     ({type, color, other} per row) for downstream callers that
      //     want the full structure (AI recommend, letter renderer, etc.).
      const mat = (k) => extracted[k] || null;
      const applicationData = {
        // Flat fields read by renderMaterialsRows in builder-arc-review.html
        brick_color:        mat('brick')?.color  || null,
        stone_color:        mat('rock')?.color   || null,
        stone_type:         mat('rock')?.type    || null,
        siding_material:    mat('siding')?.type  || mat('siding')?.other || null,
        siding_color:       mat('siding')?.color || null,
        trim_color:         mat('trim_paint')?.color || null,
        garage_door_color:  mat('garage_door')?.color || null,
        roof_color:         mat('shingles')?.color || null,
        roof_material:      mat('shingles')?.type  || null,
        // Nested original — preserved for richer DRB-specific access
        materials: {
          shingles:     mat('shingles'),
          brick:        mat('brick'),
          rock:         mat('rock'),
          siding:       mat('siding'),
          mortar:       mat('mortar'),
          stucco_paint: mat('stucco_paint'),
          chimney:      mat('chimney'),
          windows:      mat('windows'),
          trim_paint:   mat('trim_paint'),
          garage_door:  mat('garage_door'),
        },
        compliance: {
          met_repetition_requirement:   extracted.met_repetition_requirement,
          repetition_exceptions:        extracted.repetition_exceptions,
          met_front_masonry_minimum:    extracted.met_front_masonry_minimum,
          front_masonry_exceptions:     extracted.front_masonry_exceptions,
        },
        visible_sides: {
          front: !!extracted.visible_sides_front,
          left:  !!extracted.visible_sides_left,
          back:  !!extracted.visible_sides_back,
          right: !!extracted.visible_sides_right,
        },
        attachments: {
          site_plan_attached:  !!extracted.site_plan_attached,
          floor_plan_attached: !!extracted.floor_plan_attached,
        },
        is_new_plan_approval_request: extracted.is_new_plan_approval_request,
        date_submitted_on_form: extracted.date_submitted,
        contact_fax: extracted.contact_fax || null,
        ai_extraction_pending: false,
        ai_confidence: extracted.ai_confidence || null,
        ai_notes:      extracted.ai_notes || null,
      };

      // Prefer the matched builder's on-file contact info over the AI's
      // partial page-1 extraction when the emails confirm the same person.
      // Ed 2026-06-16: "you have Karla's full name, why did you use the
      // partial one." DRB Group already had Karla Rutan + krutan@drbgroup.com
      // on file; the upload extracted "Karla [last name]" from a handwritten
      // form. With this check, the application stores "Karla Rutan" and the
      // letter renders correctly. If the extracted email is DIFFERENT (a new
      // person at the same builder), fall back to the AI extraction.
      const { sanitizeNameForLetter: _sanitize } = require('../lib/builder_letter');
      const extractedEmail = (extracted.contact_email || '').toLowerCase().trim();
      const matchedEmail = (matchedCompany?.primary_contact_email || '').toLowerCase().trim();
      const useMatchedContact = !!matchedCompany
        && matchedEmail
        && extractedEmail
        && matchedEmail === extractedEmail;
      const authoritativeName  = useMatchedContact && _sanitize(matchedCompany.primary_contact_name)
                              || _sanitize(extracted.contact_person)
                              || null;
      const authoritativePhone = useMatchedContact && matchedCompany.primary_contact_phone
                              || extracted.contact_phone
                              || null;

      const tryInsertRow = {
        community_id: community.id,
        builder_company_id: builderCompanyId,
        reference_number: referenceNumber,
        submitter_email: (extracted.contact_email || 'unknown@unspecified').toLowerCase().trim(),
        submitter_name:  authoritativeName,
        submitter_phone: authoritativePhone,
        source: 'manual_entry',
        lot_number:     extracted.lot_number     ? String(extracted.lot_number).trim() : 'UNKNOWN',
        block_number:   extracted.block_number   ? String(extracted.block_number).trim() : null,
        section_number: extracted.section_number ? String(extracted.section_number).trim() : null,
        street_address: extracted.street_address ? String(extracted.street_address).trim() : '(address unspecified)',
        lot_type:       extracted.lot_type || null,
        plan_number:    extracted.plan_number ? String(extracted.plan_number).trim() : 'UNKNOWN',
        plan_name:      extracted.plan_name || null,
        elevation:      extracted.elevation ? String(extracted.elevation).trim() : 'UNKNOWN',
        square_footage: extracted.square_footage_heated ? parseInt(extracted.square_footage_heated, 10) : null,
        application_data: applicationData,
        status: 'received',
      };

      const insertResult = await supabase
        .from('builder_applications')
        .insert(tryInsertRow)
        .select('*')
        .single();
      app = insertResult.data;
      aErr = insertResult.error;
      if (aErr) {
        if (aErr.code === '23505' && /reference_number/.test(String(aErr.message || ''))) {
          console.warn('[builder_applications.upload-on-behalf] reference_number collision on attempt', attempt + 1, '— retrying:', referenceNumber, aErr.message);
          app = null;
          continue;
        }
        throw aErr;
      }
    }
    if (!app) {
      console.error('[builder_applications.upload-on-behalf] reference number allocation failed after 3 retries');
      return res.status(500).json({
        error: 'Submission upload could not complete — reference number allocation kept colliding. Refresh and try once more; if it keeps happening, email support@bedrocktx.com.',
        extracted,
      });
    }

    // 5. Now that the row exists, upload the PDF to storage under the
    //    reference number so it's reachable via the existing attachments
    //    UI. Storage failure is non-fatal — the application row stays
    //    and staff can re-upload via /:id/attachments.
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const safeName = (file.originalname || 'submission.pdf').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      const path = `builders/${community.slug || community.id}/${new Date().getFullYear()}/${app.reference_number}/submission/${stamp}_${safeName}`;
      const { error: upErr } = await supabase.storage.from(STORAGE_BUCKET)
        .upload(path, file.buffer, { contentType: 'application/pdf', upsert: false });
      if (!upErr) {
        await supabase.from('builder_application_attachments').insert({
          application_id: app.id,
          kind: 'submission_packet',
          original_filename: file.originalname || 'submission.pdf',
          storage_bucket: STORAGE_BUCKET,
          storage_path: path,
          mime_type: 'application/pdf',
          size_bytes: file.size,
          uploaded_by: ctx.user?.email || 'staff_upload_on_behalf',
        });
      } else {
        console.warn('[builder_applications.upload-on-behalf] storage upload failed (non-fatal):', upErr.message);
      }
    } catch (storErr) {
      console.warn('[builder_applications.upload-on-behalf] storage block threw (non-fatal):', storErr.message);
    }

    // 6. Try master plan auto-match for fast-track.
    let matchedMasterPlanId = null;
    try {
      matchedMasterPlanId = await tryMatchMasterPlan({
        communityId: community.id,
        builderCompanyId,
        planNumber: app.plan_number,
        elevation:  app.elevation,
      });
      if (matchedMasterPlanId) {
        await supabase.from('builder_applications').update({
          master_plan_id: matchedMasterPlanId,
          fast_track: true,
          fast_track_reason: 'Matched approved master plan for this community',
        }).eq('id', app.id);
      }
    } catch (_) { /* non-fatal */ }

    res.json({
      ok: true,
      application_id: app.id,
      reference_number: app.reference_number,
      status: app.status,
      fast_track: !!matchedMasterPlanId,
      extracted,
      ai_confidence: extracted.ai_confidence || null,
      builder_match: builderMatch,   // exact | normalized | domain | created | ambiguous
    });
  } catch (err) {
    console.error('[builder_applications.upload-on-behalf]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/builder-applications/auto-create-from-extraction
// ----------------------------------------------------------------------------
// Commits an operator-reviewed extraction into a real builder_applications
// row with status='received'. The body shape mirrors what plot-plan-extract
// returns, plus a materials object from color-sheet-extract. Operator may
// override any field before commit (community_id, builder_company_id,
// master_plan_id, any extracted field).
//
// Also stores both source PDFs as builder_application_attachments so the
// reviewer can View PDF when they open the submission.
//
// Body (JSON, application/json):
// {
//   community_id, builder_company_id, master_plan_id?,
//   property: { lot_number, block_number, section_number, street_address, lot_type, plat_number },
//   plan: { plan_number, plan_name, elevation, elevation_orientation, square_footage, stories },
//   metrics: { lot_area_sqft, lot_coverage_pct, fence_linear_ft, total_sod_sqyd, total_paving_sqft },
//   materials: { brick_color, brick_manufacturer, stone_color, ... },
//   submitter: { email, name, phone },
//   target_construction_start_date, estimated_completion_date,
//   fast_track: bool,
//   plot_plan_storage_path?, color_sheet_storage_path?  (set by separate upload helper)
// }
// ============================================================================
router.post('/auto-create-from-extraction', express.json({ limit: '512kb' }), async (req, res) => {
  try {
    const { requireAdmin } = require('./users');
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;

    const body = req.body || {};
    const property = body.property || {};
    const plan = body.plan || {};

    // Required fields
    if (!body.community_id) return res.status(400).json({ error: 'community_id required' });
    if (!body.builder_company_id) return res.status(400).json({ error: 'builder_company_id required' });
    if (!property.lot_number) return res.status(400).json({ error: 'property.lot_number required' });
    if (!property.street_address) return res.status(400).json({ error: 'property.street_address required' });
    if (!plan.plan_number) return res.status(400).json({ error: 'plan.plan_number required' });
    if (!plan.elevation) return res.status(400).json({ error: 'plan.elevation required' });

    // Generate reference number — atomic RPC (migration 225). This used to
    // be a hand-rolled read-then-write referencing a column called
    // `next_number` that doesn't even exist on the schema (the real column
    // is `counter`), so this path was silently failing forever and falling
    // through the catch block. Both bugs fixed by converging on the shared
    // generator. Caught during the post-DRB audit.
    let referenceNumber = null;
    try {
      const { data: comm } = await supabase.from('communities')
        .select('builder_arc_reference_prefix, slug').eq('id', body.community_id).maybeSingle();
      const prefix = comm?.builder_arc_reference_prefix || (comm?.slug || 'BLD').slice(0, 3).toUpperCase();
      const year = new Date().getFullYear();
      const { data: counter, error: refErr } = await supabase.rpc('next_application_counter', {
        p_community_id: body.community_id,
        p_service_type: SERVICE_TYPE,
        p_year:         year,
        p_prefix:       prefix,
        p_infix:        '-BLD-',
      });
      if (refErr) throw refErr;
      if (typeof counter !== 'number' || counter < 1) throw new Error('invalid counter value');
      referenceNumber = `${prefix}-BLD-${year}-${String(counter).padStart(4, '0')}`;
    } catch (refErr) {
      console.warn('[auto-create] reference number generation failed, proceeding without:', refErr.message);
    }

    // Compose application_data JSONB from extracted materials + metrics
    const applicationData = {
      ...(body.materials || {}),
      lot_area_sqft: body.metrics?.lot_area_sqft ?? null,
      lot_coverage_pct: body.metrics?.lot_coverage_pct ?? null,
      fence_linear_ft: body.metrics?.fence_linear_ft ?? null,
      total_sod_sqyd: body.metrics?.total_sod_sqyd ?? null,
      total_paving_sqft: body.metrics?.total_paving_sqft ?? null,
      plat_number: property.plat_number ?? null,
      options_notes: body.options_notes ?? null,
      surveyor_firm: body.surveyor?.firm ?? null,
      surveyor_license_no: body.surveyor?.license_no ?? null,
      plot_issue_date: body.surveyor?.plot_issue_date ?? null,
      flood_zone: body.flood_zone ?? null,
      builder_internal_job_no: body.builder_internal_job_no ?? null,
    };

    const insertRow = {
      community_id: body.community_id,
      builder_company_id: body.builder_company_id,
      master_plan_id: body.master_plan_id || null,
      reference_number: referenceNumber,
      submitter_email: body.submitter?.email || 'unknown@unspecified',
      submitter_name: body.submitter?.name || null,
      submitter_phone: body.submitter?.phone || null,
      source: 'email',
      lot_number: String(property.lot_number).trim(),
      block_number: property.block_number ? String(property.block_number).trim() : null,
      section_number: property.section_number ? String(property.section_number).trim() : null,
      street_address: String(property.street_address).trim(),
      lot_type: property.lot_type || null,
      plan_number: String(plan.plan_number).trim(),
      plan_name: plan.plan_name || null,
      elevation: String(plan.elevation).trim(),
      elevation_orientation: plan.elevation_orientation || null,
      square_footage: plan.square_footage ? parseInt(plan.square_footage, 10) : null,
      stories: plan.stories ? parseFloat(plan.stories) : null,
      application_data: applicationData,
      status: 'received',
      fast_track: !!body.fast_track,
      fast_track_reason: body.fast_track ? 'master_plan_match' : null,
      target_construction_start_date: body.target_construction_start_date || null,
      estimated_completion_date: body.estimated_completion_date || null,
      builder_acknowledgments: body.acknowledgments || {},
    };

    const { data: app, error: insErr } = await supabase
      .from('builder_applications')
      .insert(insertRow)
      .select('id, reference_number, status, fast_track')
      .single();
    if (insErr) throw insErr;

    // Attach the source PDFs (when caller uploaded them via storage first)
    const attachmentsToCreate = [];
    if (body.plot_plan_storage_path) {
      attachmentsToCreate.push({
        application_id: app.id,
        kind: 'site_plan',
        storage_bucket: STORAGE_BUCKET,
        storage_path: body.plot_plan_storage_path,
        original_filename: body.plot_plan_filename || 'plot_plan.pdf',
        mime_type: 'application/pdf',
        uploaded_by: ctx.user?.email || 'operator',
      });
    }
    if (body.color_sheet_storage_path) {
      attachmentsToCreate.push({
        application_id: app.id,
        kind: 'color_board',
        storage_bucket: STORAGE_BUCKET,
        storage_path: body.color_sheet_storage_path,
        original_filename: body.color_sheet_filename || 'selections.pdf',
        mime_type: 'application/pdf',
        uploaded_by: ctx.user?.email || 'operator',
      });
    }
    if (attachmentsToCreate.length > 0) {
      try {
        await supabase.from('builder_application_attachments').insert(attachmentsToCreate);
      } catch (attErr) {
        console.warn('[auto-create] attachment insert failed (non-fatal):', attErr.message);
      }
    }

    res.json({
      ok: true,
      application: {
        id: app.id,
        reference_number: app.reference_number,
        status: app.status,
        fast_track: app.fast_track,
      },
    });
  } catch (err) {
    console.error('[builder_applications] auto-create-from-extraction failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/builder-applications/upload-source-pdf
// ----------------------------------------------------------------------------
// Helper used by the auto-create UI: uploads a PDF to storage so its path
// can be passed to /auto-create-from-extraction. Returns the storage path.
//
// Multipart form: pdf (required), kind ("plot_plan" | "color_sheet" | "other")
// ============================================================================
router.post('/upload-source-pdf', upload.single('pdf'), async (req, res) => {
  try {
    const { requireAdmin } = require('./users');
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;

    const file = req.file;
    if (!file) return res.status(400).json({ error: 'pdf required' });
    if (file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'pdf must be PDF' });

    const kind = (req.body?.kind || 'other').toLowerCase();
    const safeName = (file.originalname || 'doc.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
    const stamp = Date.now() + '-' + Math.floor(Math.random() * 10000);
    const storagePath = `builder-submissions/${kind}/${stamp}_${safeName}`;
    const { error: upErr } = await supabase.storage.from(STORAGE_BUCKET)
      .upload(storagePath, file.buffer, { contentType: 'application/pdf', upsert: false });
    if (upErr) throw upErr;

    res.json({
      ok: true,
      storage_path: storagePath,
      storage_bucket: STORAGE_BUCKET,
      filename: file.originalname,
      kind,
    });
  } catch (err) {
    console.error('[builder_applications] upload-source-pdf failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// DELETE /api/builder-applications/master-plans/:id
// ----------------------------------------------------------------------------
// Admin-only hard delete of a master plan row. Used to clean up duplicate
// registrations from earlier broken upload runs. Cascades:
//   - master_plan_community_approvals rows go via ON DELETE CASCADE
//   - builder_applications.master_plan_id goes to NULL via ON DELETE SET NULL
//   - if the library_document is no longer referenced by any other plan,
//     it (and its storage object) get cleaned up too
//
// Refuses if any builder_applications row still references this plan — that's
// real submission history; the operator should use the retire endpoint
// instead so the audit trail survives. Duplicates from staging uploads have
// no submission references, so they delete cleanly.
// ============================================================================
router.delete('/master-plans/:id', async (req, res) => {
  try {
    const { requireAdmin } = require('./users');
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;

    const planId = req.params.id;

    // Fetch the plan first so we know what to clean up
    const { data: plan, error: planErr } = await supabase
      .from('master_plans')
      .select('id, plan_number, elevation, library_document_id')
      .eq('id', planId)
      .maybeSingle();
    if (planErr) throw planErr;
    if (!plan) return res.status(404).json({ error: 'plan_not_found' });

    // Refuse if a real submission references this plan
    const { data: apps, error: appsErr } = await supabase
      .from('builder_applications')
      .select('id, reference_number')
      .eq('master_plan_id', planId)
      .limit(3);
    if (appsErr) throw appsErr;
    if (apps && apps.length > 0) {
      return res.status(409).json({
        error: `plan is referenced by ${apps.length}+ submission(s) — retire it instead of deleting so the audit trail survives`,
        sample_references: apps.map((a) => a.reference_number).filter(Boolean),
      });
    }

    // Delete the master_plans row (cascades to master_plan_community_approvals)
    const { error: delErr } = await supabase
      .from('master_plans')
      .delete()
      .eq('id', planId);
    if (delErr) throw delErr;

    // If the PDF isn't referenced by any other plan, clean it up too
    let pdfCleanedUp = false;
    if (plan.library_document_id) {
      const { data: stillLinked, error: linkErr } = await supabase
        .from('master_plans')
        .select('id')
        .eq('library_document_id', plan.library_document_id)
        .limit(1);
      if (linkErr) throw linkErr;
      if (!stillLinked || stillLinked.length === 0) {
        // Last reference — delete the library_document + storage object
        const { data: doc } = await supabase
          .from('library_documents')
          .select('id, file_path')
          .eq('id', plan.library_document_id)
          .maybeSingle();
        if (doc) {
          await supabase.from('library_documents').delete().eq('id', doc.id);
          if (doc.file_path) {
            try { await supabase.storage.from(STORAGE_BUCKET).remove([doc.file_path]); } catch (_) {}
          }
          pdfCleanedUp = true;
        }
      }
    }

    res.json({
      ok: true,
      deleted: { id: plan.id, plan_number: plan.plan_number, elevation: plan.elevation },
      pdf_cleaned_up: pdfCleanedUp,
    });
  } catch (err) {
    console.error('[builder_applications] master plan delete failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// GET /api/builder-applications/master-plans/:id/pdf
// Redirects to a short-lived signed URL for the underlying plan PDF.
// Used by the master plan library "View" link.
// ============================================================================
router.get('/master-plans/:id/pdf', async (req, res) => {
  try {
    const { data: plan, error: planErr } = await supabase
      .from('master_plans')
      .select('id, library_document_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (planErr) throw planErr;
    if (!plan) return res.status(404).json({ error: 'plan_not_found' });
    if (!plan.library_document_id) return res.status(404).json({ error: 'plan_pdf_missing' });

    const { data: doc, error: docErr } = await supabase
      .from('library_documents')
      .select('file_path')
      .eq('id', plan.library_document_id)
      .maybeSingle();
    if (docErr) throw docErr;
    if (!doc?.file_path) return res.status(404).json({ error: 'plan_pdf_missing' });

    const { data: signed, error: signErr } = await supabase
      .storage.from(STORAGE_BUCKET).createSignedUrl(doc.file_path, 60 * 10);  // 10 min
    if (signErr) throw signErr;
    res.redirect(signed.signedUrl);
  } catch (err) {
    console.error('[builder_applications] master plan pdf failed:', err.message);
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
// ----------------------------------------------------------------------------
// GET /api/builder-applications/public/master-plans?community=X&builder=Y
// Public read endpoint — returns master plans approved for the named
// (community, builder) combo. No sensitive data (just plan number, name,
// sq ft, stories) so this is safe to expose without admin auth. Powers
// the plan dropdown on builder portal pages so Karla et al. don't have
// to type plan numbers from memory.
// ----------------------------------------------------------------------------
router.get('/public/master-plans', async (req, res) => {
  try {
    const communityName = (req.query.community || '').trim();
    const builderName = (req.query.builder || '').trim();
    if (!communityName || !builderName) {
      return res.status(400).json({ error: 'community and builder query params required' });
    }
    const { data: comm } = await supabase
      .from('communities').select('id, name')
      .ilike('name', communityName + '%')
      .maybeSingle();
    if (!comm) return res.json({ master_plans: [], total: 0, debug: 'community not found' });

    const { data: bc } = await supabase
      .from('builder_companies').select('id, company_name')
      .ilike('company_name', builderName + '%')
      .maybeSingle();
    if (!bc) return res.json({ master_plans: [], total: 0, debug: 'builder not found' });

    const { data: plans } = await supabase
      .from('master_plans')
      .select('id, plan_number, plan_name, elevation, square_footage, stories, default_materials, status')
      .eq('builder_company_id', bc.id)
      .eq('status', 'approved')
      .order('plan_number');

    if (!plans || plans.length === 0) return res.json({ master_plans: [], total: 0 });

    // Filter: include a plan unless it's been EXPLICITLY RETIRED at this
    // community. Plans without any approval rows still show (matches the
    // admin Plan Library behavior — if a plan is in the builder's library
    // it's assumed available everywhere they build). Plans explicitly
    // retired at this community via master_plan_community_approvals are
    // excluded.
    const planIds = plans.map((p) => p.id);
    const { data: retiredHere } = await supabase
      .from('master_plan_community_approvals')
      .select('master_plan_id')
      .in('master_plan_id', planIds)
      .eq('community_id', comm.id)
      .not('retired_at', 'is', null);

    const retiredSet = new Set((retiredHere || []).map((a) => a.master_plan_id));
    const filtered = plans.filter((p) => !retiredSet.has(p.id));

    res.json({
      master_plans: filtered,
      total: filtered.length,
      community: comm.name,
      builder: bc.company_name
    });
  } catch (err) {
    console.error('[public/master-plans]', err);
    res.status(500).json({ error: err.message });
  }
});

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

// ============================================================================
// GET /api/builder-applications/portal/my-submissions
// Builder-facing dashboard endpoint. Authenticates via the same portal-user
// magic-link cookie homeowners use. Returns ALL submissions the authenticated
// user's linked builder_companies have submitted, grouped:
//   - pending: status IN (received, under_review, info_requested) — top of UI
//   - decided: status IN (approved, *_with_conditions, denied, withdrawn)
//
// Access scope (CLAUDE.md Done Checklist #2): the only submissions returned
// are those whose builder_company_id is in the active portal_user_builders
// link set for THIS portal user. Never trust client-provided builder_company_id.
//
// Letter PDFs: re-sign storage paths on every request rather than trusting
// the cached letter_signed_url (which may have expired). Single source of
// truth = letter_pdf_path.
// ============================================================================
// ============================================================================
// GET /api/builder-applications/manager/builders
// Returns the list of builders a manager can preview. Powers the picker page
// at /portal-staff-enter-builder.html. Mirrors the homeowner-side
// /api/portal/manager/properties endpoint shape.
//
// Scope rules:
//   - Portfolio-wide scope (NULL row in portal_manager_builder_scope) →
//     return all builders under the management company.
//   - Specific scope → return only those builder_company_ids.
//
// Each row includes a submission count + last activity timestamp so the
// picker can show "DRB Group · 14 submissions · last 6/16" at a glance.
// ============================================================================
router.get('/manager/builders', async (req, res) => {
  try {
    const { resolvePortalUser } = require('./portal');
    const { portalUserId } = resolvePortalUser(req);
    if (!portalUserId) return res.status(401).json({ error: 'not_signed_in' });

    const { data: portalUser } = await supabase
      .from('portal_users')
      .select('id, email, role, status')
      .eq('id', portalUserId)
      .maybeSingle();
    if (!portalUser || portalUser.role !== 'manager' || portalUser.status !== 'active') {
      return res.status(403).json({ error: 'not_manager' });
    }

    const { data: scopeRows } = await supabase
      .from('portal_manager_builder_scope')
      .select('builder_company_id')
      .eq('portal_user_id', portalUserId)
      .is('revoked_at', null);
    const scope = scopeRows || [];
    const portfolioWide = scope.some((s) => s.builder_company_id === null);
    const scopedIds = scope.map((s) => s.builder_company_id).filter(Boolean);

    let bq = supabase
      .from('builder_companies')
      .select('id, company_name, primary_contact_name, primary_contact_email, status')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('company_name');
    if (!portfolioWide) {
      if (scopedIds.length === 0) return res.json({ builders: [], portfolio_wide: false });
      bq = bq.in('id', scopedIds);
    }
    const { data: builders, error: bErr } = await bq;
    if (bErr) return res.status(500).json({ error: bErr.message });

    // Submission counts + last activity per builder. One query per builder
    // would be O(N) round-trips; instead pull all in one IN-list and group.
    const ids = (builders || []).map((b) => b.id);
    let countsByBuilder = new Map();
    if (ids.length) {
      const { data: apps } = await supabase
        .from('builder_applications')
        .select('builder_company_id, submitted_at')
        .in('builder_company_id', ids);
      for (const a of (apps || [])) {
        const cur = countsByBuilder.get(a.builder_company_id) || { count: 0, last_at: null };
        cur.count++;
        if (!cur.last_at || (a.submitted_at && a.submitted_at > cur.last_at)) {
          cur.last_at = a.submitted_at;
        }
        countsByBuilder.set(a.builder_company_id, cur);
      }
    }

    res.json({
      builders: (builders || []).map((b) => {
        const stats = countsByBuilder.get(b.id) || { count: 0, last_at: null };
        return {
          id: b.id,
          company_name: b.company_name,
          primary_contact_name: b.primary_contact_name,
          primary_contact_email: b.primary_contact_email,
          status: b.status,
          submission_count: stats.count,
          last_submission_at: stats.last_at,
        };
      }),
      portfolio_wide: portfolioWide,
      staff_email: portalUser.email,
    });
  } catch (err) {
    console.error('[builder_applications.manager/builders]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/portal/my-submissions', async (req, res) => {
  try {
    const { resolvePortalUser } = require('./portal');
    const { portalUserId } = resolvePortalUser(req);
    if (!portalUserId) return res.status(401).json({ error: 'not_signed_in' });

    // Resolve role + manager-mode context. Bedrock staff sign in as
    // role='manager' via /api/portal/staff-enter; they can preview ANY
    // builder via ?as_builder_id within their portal_manager_builder_scope.
    const { data: portalUser } = await supabase
      .from('portal_users')
      .select('id, email, role, status')
      .eq('id', portalUserId)
      .maybeSingle();
    const isManager = portalUser && portalUser.role === 'manager' && portalUser.status === 'active';
    const asBuilderId = (req.query.as_builder_id || '').toString().trim() || null;

    let builderIds = [];
    let builderCompanies = [];
    let managerView = false;

    if (isManager && asBuilderId) {
      // Manager mode: verify scope (portfolio-wide OR specific builder),
      // log the view, scope query to ONE builder. Mirrors the homeowner-side
      // portal_manager_view_log audit pattern from migration 201.
      const { data: scopeRows } = await supabase
        .from('portal_manager_builder_scope')
        .select('builder_company_id')
        .eq('portal_user_id', portalUserId)
        .is('revoked_at', null);
      const scope = scopeRows || [];
      const portfolioWide = scope.some((s) => s.builder_company_id === null);
      const inScope = portfolioWide || scope.some((s) => s.builder_company_id === asBuilderId);
      if (!inScope) {
        return res.status(403).json({ error: 'builder_not_in_manager_scope', builder_id: asBuilderId });
      }
      const { data: bc } = await supabase
        .from('builder_companies')
        .select('id, company_name')
        .eq('id', asBuilderId)
        .maybeSingle();
      if (!bc) return res.status(404).json({ error: 'builder_not_found', builder_id: asBuilderId });
      builderIds = [bc.id];
      builderCompanies = [{ id: bc.id, name: bc.company_name }];
      managerView = true;
      // Best-effort audit log; don't fail the request if the table isn't
      // populated yet (migration 227 timing safety).
      try {
        await supabase.from('portal_manager_builder_view_log').insert({
          portal_user_id: portalUserId,
          staff_email: portalUser.email,
          viewed_builder_id: bc.id,
          ip_address: req.ip,
          user_agent: req.headers['user-agent'] || null,
        });
      } catch (logErr) {
        console.warn('[builder_applications] manager builder view log skipped:', logErr.message);
      }
    } else if (isManager && !asBuilderId) {
      // Manager landed on the dashboard without picking a builder. Tell the
      // UI to send them to the picker page.
      return res.json({
        builder_companies: [],
        pending: [],
        decided: [],
        empty_reason: 'manager_picker_required',
        manager_view: true,
        staff_email: portalUser.email,
      });
    } else {
      // Regular builder portal user -- look up which builder companies they
      // can act on via the link table (existing behavior, unchanged).
      const { data: links, error: linkErr } = await supabase
        .from('portal_user_builders')
        .select('builder_company_id, builder_companies(id, company_name)')
        .eq('portal_user_id', portalUserId)
        .is('revoked_at', null);
      if (linkErr) {
        console.error('[builder_applications] portal link lookup failed:', linkErr.message);
        return res.status(500).json({ error: safeErrorMessage(linkErr) });
      }
      builderIds = (links || []).map((l) => l.builder_company_id).filter(Boolean);
      if (builderIds.length === 0) {
        return res.json({
          builder_companies: [],
          pending: [],
          decided: [],
          empty_reason: 'no_builder_access',
        });
      }
      builderCompanies = (links || [])
        .filter((l) => l.builder_companies)
        .map((l) => ({ id: l.builder_companies.id, name: l.builder_companies.company_name }));
    }

    // Fetch submissions for those builders, scoped to Bedrock-managed
    // communities. Hard cap at 500 to avoid runaway responses if a builder
    // racks up years of history. Most recent first within each bucket.
    const { data: apps, error: appsErr } = await supabase
      .from('builder_applications')
      .select(`
        id, reference_number, status, fast_track,
        street_address, lot_number, block_number, section_number,
        plan_number, plan_name, elevation, square_footage, stories,
        submitter_name, submitter_email,
        submitted_at, decided_at, decided_by,
        builder_company_id, builder_companies(id, company_name),
        community_id, communities(id, name, slug),
        master_plan_id, master_plans!master_plan_id(id, plan_number, plan_name),
        builder_application_responses(
          id, response_type, message_to_builder, conditions, denial_reasons,
          decided_at, decided_by, letter_pdf_path, email_sent_at
        )
      `)
      .in('builder_company_id', builderIds)
      .order('submitted_at', { ascending: false })
      .limit(500);
    if (appsErr) {
      console.error('[builder_applications] portal submissions fetch failed:', appsErr.message);
      return res.status(500).json({ error: safeErrorMessage(appsErr) });
    }

    const PENDING_STATUSES = new Set(['received', 'under_review', 'info_requested']);

    // Parallelize letter PDF signing for decided rows — sequential awaits
    // at 500-row scale would push response time past 30 sec. Promise.all
    // means total time = single slowest sign call, not the sum.
    const signedUrls = await Promise.all((apps || []).map(async (a) => {
      const latestResp = (a.builder_application_responses || [])
        .sort((x, y) => new Date(y.decided_at || 0) - new Date(x.decided_at || 0))[0] || null;
      if (!latestResp || !latestResp.letter_pdf_path) return { id: a.id, latestResp, url: null };
      try {
        const { data: signed, error: signErr } = await supabase.storage
          .from('documents')
          .createSignedUrl(latestResp.letter_pdf_path, 60 * 60); // 1h
        if (signErr) {
          console.warn('[builder_applications] letter sign failed for', a.id, signErr.message);
          return { id: a.id, latestResp, url: null };
        }
        return { id: a.id, latestResp, url: signed && signed.signedUrl };
      } catch (e) {
        console.warn('[builder_applications] letter sign exception for', a.id, e.message);
        return { id: a.id, latestResp, url: null };
      }
    }));
    const signedById = new Map(signedUrls.map((s) => [s.id, s]));

    const pending = [];
    const decided = [];

    for (const a of (apps || [])) {
      const signedEntry = signedById.get(a.id) || { latestResp: null, url: null };
      const latestResponse = signedEntry.latestResp;
      const letterUrl = signedEntry.url;

      const row = {
        id: a.id,
        reference_number: a.reference_number,
        status: a.status,
        fast_track: !!a.fast_track,
        community: a.communities ? { id: a.communities.id, name: a.communities.name, slug: a.communities.slug } : null,
        builder: a.builder_companies ? { id: a.builder_companies.id, name: a.builder_companies.company_name } : null,
        street_address: a.street_address,
        lot_number: a.lot_number,
        block_number: a.block_number,
        section_number: a.section_number,
        plan_number: a.plan_number,
        plan_name: a.plan_name,
        elevation: a.elevation,
        square_footage: a.square_footage,
        stories: a.stories,
        submitter_name: a.submitter_name,
        submitter_email: a.submitter_email,
        submitted_at: a.submitted_at,
        decided_at: a.decided_at,
        decided_by: a.decided_by,
        days_in_review: a.submitted_at && !a.decided_at
          ? Math.floor((Date.now() - new Date(a.submitted_at).getTime()) / 86400000)
          : null,
        response: latestResponse ? {
          response_type: latestResponse.response_type,
          message_to_builder: latestResponse.message_to_builder,
          conditions: latestResponse.conditions,
          denial_reasons: latestResponse.denial_reasons,
          decided_at: latestResponse.decided_at,
          decided_by: latestResponse.decided_by,
          letter_url: letterUrl,
          email_sent_at: latestResponse.email_sent_at,
        } : null,
      };
      if (PENDING_STATUSES.has(a.status)) pending.push(row); else decided.push(row);
    }

    res.json({
      builder_companies: builderCompanies,
      pending,
      decided,
      counts: {
        pending: pending.length,
        decided: decided.length,
        total: pending.length + decided.length,
      },
      manager_view: managerView,
      staff_email: managerView ? (portalUser && portalUser.email) : null,
    });
  } catch (err) {
    console.error('[builder_applications] portal dashboard failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
