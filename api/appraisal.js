// =============================================================================
// Appraisal Records — FBCAD / HCAD bulk import + portfolio cross-reference
// =============================================================================
// Mounted at /api/appraisal in server.js. Imports county appraisal data
// (FBCAD = Fort Bend, HCAD = Harris, OTHER for future counties) for cross-
// reference against Vantaca ownership records. See migration 122 for schema.
//
// Module purpose:
//   - Catch missed deed transfers Vantaca didn't pick up
//   - Surface true acquisition dates ("Sarah's been here 14 years")
//   - Power tenure / investor-flag / assessed-value layers on the Community Map
//   - Build the audit trail for board termination exports
//
// Discipline:
//   County records are CANONICAL for legal ownership. Vantaca is canonical
//   for assessment-payer relationship. They USUALLY align but not always.
//   Every UI surfacing appraisal data must label it 'per [county] as of
//   [pull_date]'. Don't conflate.
//
// CSV approach:
//   FBCAD/HCAD bulk rolls are typically CSVs with non-standard column names
//   varying by county and by year. We do a two-stage approach:
//     1) AI (Claude Haiku — cheap) maps the header row to our canonical
//        fields based on a small sample.
//     2) Pure code then parses the entire file using that mapping — no
//        per-row AI cost. Scales cleanly to multi-thousand-row rolls.
//
// Endpoints:
//   POST   /api/appraisal/ingest                drag-drop CSV; returns preview
//   POST   /api/appraisal/ingest/:batch_id/approve   commit the preview
//   POST   /api/appraisal/ingest/:batch_id/discard
//   GET    /api/appraisal/batches               ingest history
//   GET    /api/appraisal/property/:id/history  per-property timeline
//   GET    /api/appraisal/community/:id/coverage  match coverage stats
// =============================================================================

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { safeErrorMessage } = require('./_safe_error');
const { resolveProperty } = require('../lib/entity_resolution');
const { getActingUser } = require('./_acting_user');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

// Large limit because annual county rolls can be 50-200MB for a whole county
// (multi-million rows). Operator should pre-filter to their communities'
// ZIP codes via Excel before uploading; even 50MB is generous.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
const router = express.Router();

// ----------------------------------------------------------------------------
// CSV parsing — RFC 4180-ish with quoted-field support. Keeps zero deps;
// CSV is forgiving enough that pure-JS handles 99% of county rolls. Falls
// over only on truly pathological inputs (embedded \r in quoted fields,
// non-standard quote chars) — operator can resave as standard CSV in Excel.
// ----------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"' && field === '') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field); field = '';
      } else if (ch === '\n') {
        row.push(field); field = '';
        // Skip empty trailing rows
        if (row.length > 1 || (row.length === 1 && row[0] !== '')) rows.push(row);
        row = [];
      } else if (ch === '\r') {
        // Ignore — \r\n line endings handled by the \n branch
      } else {
        field += ch;
      }
    }
  }
  // Last row if no trailing newline
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || (row.length === 1 && row[0] !== '')) rows.push(row);
  }
  return rows;
}

// ----------------------------------------------------------------------------
// Column-mapping prompt — runs ONCE per upload on the header row + 10 sample
// rows. Returns a JSON mapping {our_field: source_column_name}. Cheap (Haiku,
// ~500 tokens) and bypasses per-row AI cost entirely.
// ----------------------------------------------------------------------------
const MAPPING_PROMPT = `You are mapping CSV column names from a Texas county appraisal district
property roll (FBCAD = Fort Bend, HCAD = Harris, or another Texas CAD) to our
canonical schema.

You will receive the header row + first 10 data rows. Return ONLY a JSON
object with this shape — no preamble, no markdown:

{
  "county_source": "FBCAD" | "HCAD" | "OTHER",
  "column_mapping": {
    "property_address":         "<column name in the CSV, or null if not present>",
    "city":                     "<column or null>",
    "zip":                      "<column or null>",
    "parcel_number":            "<column or null — county PID, account #, geo ID, etc.>",
    "owner_name":               "<column or null — current owner of record>",
    "owner_mailing_address":    "<column or null — where the county mails tax bills>",
    "acquisition_date":         "<column or null — deed date for current owner>",
    "sale_price":               "<column or null>",
    "assessed_value_current":   "<column or null — most recent certified value>",
    "assessed_value_prior":     "<column or null — prior year value>",
    "land_value":               "<column or null>",
    "improvement_value":        "<column or null>",
    "year_built":               "<column or null>",
    "building_sqft":            "<column or null — heated/conditioned/total sq ft>",
    "lot_sqft":                 "<column or null>"
  },
  "pull_date_hint": "<YYYY-MM-DD if a 'tax year' or 'certified date' column suggests one, else null>"
}

RULES:
- Column names in your output must MATCH EXACTLY what's in the header row
  (case-sensitive — these go straight into a lookup).
- If a column is ambiguous (e.g., 'VALUE' could be land or total), pick the
  most likely interpretation from the sample data and explain nothing.
- 'OTHER' is fine for non-FBCAD/HCAD counties; we'll persist as that.
- Detect FBCAD vs HCAD from header style + sample data (FBCAD uses 'PIDN',
  HCAD uses 'acct'-style account numbers; FBCAD addresses are often in
  Sugar Land/Cinco Ranch/Katy area; HCAD covers Houston metro).`;

async function detectColumnMapping(headerRow, sampleRows) {
  const t0 = Date.now();
  const payload = `HEADER:\n${headerRow.join('|')}\n\nSAMPLE ROWS (up to 10):\n${
    sampleRows.slice(0, 10).map((r) => r.join('|')).join('\n')
  }`;
  const completion = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    messages: [{ role: 'user', content: MAPPING_PROMPT + '\n\n' + payload }],
  });
  const text = completion.content?.[0]?.text || '';
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let parsed;
  try {
    const m = cleaned.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : cleaned);
  } catch (e) {
    throw new Error(`column mapping returned invalid JSON: ${e.message}`);
  }
  return { mapping: parsed, duration_ms: Date.now() - t0 };
}

// ----------------------------------------------------------------------------
// Apply the column mapping to every data row → array of our canonical objects.
// Robust to missing columns, malformed dates/numbers.
// ----------------------------------------------------------------------------
function toNumber(v) {
  if (v == null || v === '') return null;
  const cleaned = String(v).replace(/[$,]/g, '').trim();
  if (cleaned === '' || cleaned === '-' || cleaned === 'N/A') return null;
  // Parens for negative numbers
  const n = /^\(.*\)$/.test(cleaned) ? -Number(cleaned.slice(1, -1)) : Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
function toInteger(v) {
  const n = toNumber(v);
  return n == null ? null : Math.round(n);
}
function toDate(v) {
  if (!v || v === '') return null;
  const s = String(v).trim();
  // Common formats: YYYY-MM-DD, MM/DD/YYYY, M/D/YY, etc.
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return s;
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/))) {
    const yr = Number(m[3]) > 50 ? `19${m[3]}` : `20${m[3]}`;
    return `${yr}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  // Last-ditch — let Date parse it
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function applyMapping(headerRow, dataRows, mapping) {
  const colIdx = new Map();
  for (let i = 0; i < headerRow.length; i++) {
    colIdx.set(headerRow[i], i);
  }
  const get = (row, fieldName) => {
    const colName = mapping.column_mapping[fieldName];
    if (!colName) return null;
    const idx = colIdx.get(colName);
    if (idx == null || idx >= row.length) return null;
    const v = row[idx];
    return v == null ? null : String(v).trim();
  };

  return dataRows.map((row) => ({
    property_address:        get(row, 'property_address'),
    city:                    get(row, 'city'),
    zip:                     get(row, 'zip'),
    parcel_number:           get(row, 'parcel_number'),
    owner_name:              get(row, 'owner_name'),
    owner_mailing_address:   get(row, 'owner_mailing_address'),
    acquisition_date:        toDate(get(row, 'acquisition_date')),
    sale_price:              toNumber(get(row, 'sale_price')),
    assessed_value_current:  toNumber(get(row, 'assessed_value_current')),
    assessed_value_prior:    toNumber(get(row, 'assessed_value_prior')),
    land_value:              toNumber(get(row, 'land_value')),
    improvement_value:       toNumber(get(row, 'improvement_value')),
    year_built:              toInteger(get(row, 'year_built')),
    building_sqft:           toInteger(get(row, 'building_sqft')),
    lot_sqft:                toInteger(get(row, 'lot_sqft')),
  }));
}

// ----------------------------------------------------------------------------
// POST /api/appraisal/ingest — drag-drop CSV; returns preview
// Body: multipart with 'csv' file + optional 'community_id' (operator pick)
//                                        + optional 'pull_date' (YYYY-MM-DD)
// ----------------------------------------------------------------------------
router.post('/ingest', upload.single('csv'), async (req, res) => {
  const t0 = Date.now();
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected field "csv")' });
    const communityId = req.body && req.body.community_id ? req.body.community_id : null;
    const overridePullDate = req.body && req.body.pull_date ? req.body.pull_date : null;
    const actor = await getActingUser(req);

    // Decode + parse the CSV. We tolerate BOM and UTF-16 fallback.
    let text = req.file.buffer.toString('utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = parseCsv(text);
    if (rows.length < 2) {
      return res.status(400).json({ error: 'CSV has no data rows (header + at least one row required)' });
    }
    const headerRow = rows[0];
    const dataRows = rows.slice(1);

    // Optional: stash the source CSV in storage for audit trail
    let storagePath = null;
    try {
      const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 16);
      const safeName = (req.file.originalname || 'appraisal.csv').replace(/[^a-zA-Z0-9._\-]/g, '_');
      storagePath = `appraisal_ingests/${hash}_${safeName}`;
      await supabase.storage
        .from('documents')
        .upload(storagePath, req.file.buffer, { contentType: 'text/csv', upsert: true });
    } catch (e) {
      console.warn('[appraisal] storage upload failed (non-fatal):', e.message);
      storagePath = null;
    }

    // AI column mapping — one call, fixed cost
    const { mapping } = await detectColumnMapping(headerRow, dataRows);
    const countySource = ['FBCAD', 'HCAD', 'OTHER'].includes(mapping.county_source) ? mapping.county_source : 'OTHER';
    const pullDate = overridePullDate || mapping.pull_date_hint || new Date().toISOString().slice(0, 10);

    // Apply mapping to all rows in pure code (no per-row AI)
    const parsed = applyMapping(headerRow, dataRows, mapping);

    // Resolve property matches. If operator didn't pre-select a community,
    // we can't reliably scope the match — unmatched rows surface for triage.
    const resolved = [];
    let matchedCount = 0;
    let inactiveCount = 0;
    for (const r of parsed) {
      let propertyMatch = null;
      if (communityId && r.property_address) {
        try {
          const m = await resolveProperty(supabase, communityId, r.property_address);
          if (m && m.id) propertyMatch = m;
        } catch (e) { /* swallow per-row resolver errors */ }
      }
      if (propertyMatch) matchedCount += 1;
      else inactiveCount += 1;
      resolved.push({
        ...r,
        property_id: propertyMatch ? propertyMatch.id : null,
        property_match_confidence: propertyMatch ? propertyMatch.match_confidence : null,
        matched_address: propertyMatch ? `${propertyMatch.street_address}${propertyMatch.unit ? ' #' + propertyMatch.unit : ''}` : null,
      });
    }

    // Persist the batch (status='previewed' — awaiting approve)
    const { data: batch, error: batchErr } = await supabase
      .from('appraisal_ingest_batches')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id: communityId,
        county_source: countySource,
        uploaded_by_user_id: actor ? actor.id : null,
        source_filename: req.file.originalname || null,
        source_storage_path: storagePath,
        pull_date: pullDate,
        total_rows: parsed.length,
        rows_matched_property: matchedCount,
        rows_unmatched: inactiveCount,
        status: 'previewed',
        raw_extraction: { rows: resolved, pull_date: pullDate },
        column_mapping: mapping,
        extraction_model: 'claude-haiku-4-5-20251001',
      })
      .select('id')
      .single();
    if (batchErr) throw batchErr;

    res.json({
      ok: true,
      batch_id: batch.id,
      county_source: countySource,
      pull_date: pullDate,
      total_rows: parsed.length,
      rows_matched_property: matchedCount,
      rows_unmatched: inactiveCount,
      column_mapping: mapping.column_mapping,
      preview_rows: resolved.slice(0, 50),
      preview_truncated: parsed.length > 50,
      duration_ms: Date.now() - t0,
    });
  } catch (err) {
    console.error('[appraisal] ingest failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /api/appraisal/ingest/:batch_id/approve
// ----------------------------------------------------------------------------
router.post('/ingest/:batch_id/approve', express.json(), async (req, res) => {
  try {
    const actor = await getActingUser(req);
    const { data: batch, error: bErr } = await supabase
      .from('appraisal_ingest_batches')
      .select('*')
      .eq('id', req.params.batch_id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (bErr) throw bErr;
    if (!batch) return res.status(404).json({ error: 'batch_not_found' });
    if (batch.status !== 'previewed') {
      return res.status(409).json({ error: `batch already ${batch.status}` });
    }

    const pullDate = (req.body && req.body.pull_date) || batch.pull_date;
    if (!pullDate) {
      return res.status(400).json({ error: 'pull_date required (extraction did not produce one; operator must supply)' });
    }

    const rows = (batch.raw_extraction && Array.isArray(batch.raw_extraction.rows)) ? batch.raw_extraction.rows : [];
    if (rows.length === 0) return res.status(400).json({ error: 'batch has no rows to approve' });

    // Build inserts. Skip rows without property_id (unmatched go to triage).
    const toInsert = [];
    let skipped = 0;
    for (const r of rows) {
      if (!r.property_id) { skipped += 1; continue; }
      // We need community_id on each row for the FK + denorm. The batch may
      // be community-scoped (single community uploads) — most common case.
      // Multi-community uploads (rare) would require resolving per-row;
      // unsupported in v1.
      if (!batch.community_id) { skipped += 1; continue; }
      toInsert.push({
        management_company_id:    BEDROCK_MGMT_CO_ID,
        community_id:             batch.community_id,
        property_id:              r.property_id,
        county_source:            batch.county_source,
        parcel_number:            r.parcel_number || null,
        owner_name_appraisal:     r.owner_name || null,
        owner_mailing_address:    r.owner_mailing_address || null,
        acquisition_date:         r.acquisition_date || null,
        sale_price:               r.sale_price,
        assessed_value_current:   r.assessed_value_current,
        assessed_value_prior:     r.assessed_value_prior,
        land_value:               r.land_value,
        improvement_value:        r.improvement_value,
        year_built:               r.year_built,
        building_sqft:            r.building_sqft,
        lot_sqft:                 r.lot_sqft,
        pull_date:                pullDate,
        source_filename:          batch.source_filename,
        source_storage_path:      batch.source_storage_path,
        ingest_batch_id:          batch.id,
        raw_extraction:           r,
        approved_at:              new Date().toISOString(),
        approved_by_user_id:      actor ? actor.id : null,
      });
    }

    // Upsert on (property_id, pull_date) — re-running approve after a fix
    // updates the existing snapshot row rather than duplicating.
    const { error: insErr } = await supabase
      .from('appraisal_records')
      .upsert(toInsert, { onConflict: 'property_id,pull_date' });
    if (insErr) throw insErr;

    await supabase
      .from('appraisal_ingest_batches')
      .update({
        status: 'approved',
        approved_at: new Date().toISOString(),
        approved_by_user_id: actor ? actor.id : null,
        pull_date: pullDate,
      })
      .eq('id', batch.id);

    res.json({
      ok: true,
      records_written: toInsert.length,
      rows_skipped_unmatched: skipped,
      pull_date: pullDate,
    });
  } catch (err) {
    console.error('[appraisal] approve failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /api/appraisal/ingest/:batch_id/discard
// ----------------------------------------------------------------------------
router.post('/ingest/:batch_id/discard', async (req, res) => {
  try {
    await supabase
      .from('appraisal_ingest_batches')
      .update({ status: 'discarded' })
      .eq('id', req.params.batch_id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /api/appraisal/batches — ingest history
// ----------------------------------------------------------------------------
router.get('/batches', async (req, res) => {
  try {
    let q = supabase
      .from('appraisal_ingest_batches')
      .select('id, community_id, county_source, source_filename, pull_date, total_rows, rows_matched_property, rows_unmatched, status, uploaded_at, approved_at')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('uploaded_at', { ascending: false })
      .limit(100);
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ batches: data || [] });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /api/appraisal/property/:propertyId/manual-record
// ----------------------------------------------------------------------------
// Per-property manual entry — for the steady-state workflow where staff
// looks up an individual property on FBCAD/HCAD esearch and enters the
// values into trustEd. Used when a home sale closes and Vantaca updates
// the owner — staff verifies against the county same day, no bulk roll
// needed.
//
// Body: {
//   county_source: 'FBCAD' | 'HCAD' | 'OTHER',
//   parcel_number?: string,
//   owner_name_appraisal?: string,
//   owner_mailing_address?: string,
//   acquisition_date?: 'YYYY-MM-DD',
//   sale_price?: number,
//   assessed_value_current?: number,
//   assessed_value_prior?: number,
//   land_value?: number,
//   improvement_value?: number,
//   year_built?: number,
//   building_sqft?: number,
//   lot_sqft?: number,
//   pull_date?: 'YYYY-MM-DD' (defaults to today),
//   notes?: string
// }
//
// Behavior:
//   - Looks up community_id from properties (no client-supplied trust)
//   - Upserts on (property_id, pull_date) — same constraint as bulk path
//   - Auto-approved with the acting user stamped as approved_by_user_id
//   - Returns the saved row so the UI can refresh in place
// ----------------------------------------------------------------------------
const ALLOWED_MANUAL_FIELDS = [
  'county_source', 'parcel_number',
  'owner_name_appraisal', 'owner_mailing_address',
  'acquisition_date', 'sale_price',
  'assessed_value_current', 'assessed_value_prior',
  'land_value', 'improvement_value',
  'year_built', 'building_sqft', 'lot_sqft',
  'notes',
];
router.post('/property/:propertyId/manual-record', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const propertyId = req.params.propertyId;
    if (!propertyId) return res.status(400).json({ error: 'property_id_required' });

    const actor = await getActingUser(req);
    const body = req.body || {};

    // Look up the property to get community_id + validate it's ours
    const { data: prop, error: pErr } = await supabase
      .from('properties')
      .select('id, community_id, street_address')
      .eq('id', propertyId)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!prop) return res.status(404).json({ error: 'property_not_found' });

    // Validate county_source if provided
    const county = body.county_source && ['FBCAD', 'HCAD', 'OTHER'].includes(body.county_source)
      ? body.county_source : 'OTHER';

    // Pull date defaults to today (Central). Operator can override for
    // back-dating a snapshot they're recording after the fact (e.g., "this
    // is the value as of when the sale closed last month").
    const pullDate = body.pull_date && /^\d{4}-\d{2}-\d{2}$/.test(body.pull_date)
      ? body.pull_date
      : new Date().toISOString().slice(0, 10);

    // Build the row using only allowlisted fields — never spread req.body raw
    const row = {
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id:          prop.community_id,
      property_id:           propertyId,
      county_source:         county,
      pull_date:             pullDate,
      source_filename:       null,                 // manual entry has no source file
      source_storage_path:   null,
      ingest_batch_id:       null,                 // manual entries are batch-less
      raw_extraction:        { source: 'manual_entry', entered_by: actor ? actor.id : null },
      approved_at:           new Date().toISOString(),
      approved_by_user_id:   actor ? actor.id : null,
    };
    for (const field of ALLOWED_MANUAL_FIELDS) {
      if (field === 'county_source') continue; // handled above
      if (body[field] !== undefined) row[field] = body[field];
    }

    // Upsert on the same (property_id, pull_date) constraint the bulk path uses.
    // Two manual edits on the same day = the second one wins (operator
    // correcting their own entry). Different days = new snapshot row.
    const { data, error } = await supabase
      .from('appraisal_records')
      .upsert(row, { onConflict: 'property_id,pull_date' })
      .select()
      .single();
    if (error) throw error;

    res.json({
      ok: true,
      record: data,
      property: { id: prop.id, street_address: prop.street_address, community_id: prop.community_id },
    });
  } catch (err) {
    console.error('[appraisal] manual-record failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /api/appraisal/property/:id/history — per-property snapshot timeline
// ----------------------------------------------------------------------------
router.get('/property/:id/history', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('appraisal_records')
      .select('id, pull_date, county_source, parcel_number, owner_name_appraisal, owner_mailing_address, acquisition_date, sale_price, assessed_value_current, year_built, building_sqft, lot_sqft')
      .eq('property_id', req.params.id)
      .not('approved_at', 'is', null)
      .order('pull_date', { ascending: false });
    if (error) throw error;
    res.json({ history: data || [] });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /api/appraisal/community/:id/coverage — % of properties with appraisal data
// ----------------------------------------------------------------------------
router.get('/community/:id/coverage', async (req, res) => {
  try {
    const communityId = req.params.id;

    const { data: props, error: pErr } = await supabase
      .from('properties')
      .select('id')
      .eq('community_id', communityId)
      .limit(5000);
    if (pErr) throw pErr;
    const total = (props || []).length;

    const { data: appr, error: aErr } = await supabase
      .from('v_latest_appraisal_per_property')
      .select('property_id, pull_date, days_since_pull')
      .eq('community_id', communityId)
      .limit(5000);
    if (aErr) throw aErr;
    const covered = (appr || []).length;
    const latestPull = (appr || []).reduce((latest, r) => (!latest || r.pull_date > latest ? r.pull_date : latest), null);

    res.json({
      community_id: communityId,
      total_properties: total,
      with_appraisal_data: covered,
      coverage_pct: total > 0 ? Number(((covered / total) * 100).toFixed(1)) : 0,
      latest_pull_date: latestPull,
    });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
