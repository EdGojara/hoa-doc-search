// ============================================================================
// api/roster_import.js
// ----------------------------------------------------------------------------
// Template-driven roster import: the "clean once, verified forever" pattern
// Ed scoped 2026-06-02 5am.
//
// The flow:
//   1. Operator downloads a CSV template, pre-filled with current data for
//      the community (or empty for net-new community onboarding).
//   2. Operator cleans the data in Excel — fills missing city/zip,
//      corrects mailing addresses, fixes typos, etc.
//   3. Operator uploads cleaned CSV. Preview endpoint runs strict
//      validation, reports row-level errors, shows a diff summary.
//   4. Operator confirms; apply endpoint writes ONLY valid rows and
//      stamps data_verified_at + verified_by + verified_source on each.
//   5. Future Vantaca syncs surface proposed changes to verified rows
//      but do not auto-overwrite them (see Vantaca-diff integration,
//      Task #10).
//
// MVP scope (Phase 1): updates to existing properties (matched by
// vantaca_account_id). Net-new properties / contacts are flagged as
// errors with a "use Vantaca import or manual add" message. Phase 2
// will handle net-new rows for greenfield community onboarding.
//
// Column spec (canonical order, matches the CSV header):
//   vantaca_account_id (required for matching existing rows)
//   street_address     (required)
//   unit               (optional)
//   city               (required)
//   state              (required, 2-letter)
//   zip                (required, 5-digit or 5-digit+4)
//   lot_number         (optional)
//   property_type      (optional)
//   full_name          (required — primary owner name)
//   primary_email      (optional, format-checked)
//   primary_phone      (optional, format-checked)
//   mailing_address    (optional; if set must include a 5-digit ZIP)
// ============================================================================

const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB cap

// Canonical column header — order matters for download templates; case
// is forgiving on upload (we normalize headers to lowercase + underscore).
const TEMPLATE_COLUMNS = [
  'vantaca_account_id',
  'street_address',
  'unit',
  'city',
  'state',
  'zip',
  'lot_number',
  'property_type',
  'full_name',
  'primary_email',
  'primary_phone',
  'mailing_address',
];

const REQUIRED_FIELDS = ['street_address', 'city', 'state', 'zip', 'full_name'];

// ----------------------------------------------------------------------------
// Validators — pure functions, no DB
// ----------------------------------------------------------------------------
const RE_ZIP   = /^\d{5}(-\d{4})?$/;
const RE_STATE = /^[A-Z]{2}$/;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RE_PHONE = /^\+?[0-9\s().\-]{7,}$/; // permissive — full normalization happens server-side later

function validateRow(row, rowIndex) {
  const errors = [];
  // Required fields
  for (const f of REQUIRED_FIELDS) {
    if (!row[f] || !String(row[f]).trim()) {
      errors.push({ row: rowIndex, field: f, message: 'required field is empty' });
    }
  }
  // Format checks (only when value is present)
  if (row.zip && !RE_ZIP.test(String(row.zip).trim())) {
    errors.push({ row: rowIndex, field: 'zip', message: 'must be 5 digits or 5-digit+4 (e.g. 77407 or 77407-1234)' });
  }
  if (row.state && !RE_STATE.test(String(row.state).trim().toUpperCase())) {
    errors.push({ row: rowIndex, field: 'state', message: 'must be 2-letter state code (e.g. TX)' });
  }
  if (row.primary_email && !RE_EMAIL.test(String(row.primary_email).trim())) {
    errors.push({ row: rowIndex, field: 'primary_email', message: 'doesn\'t look like a valid email address' });
  }
  if (row.primary_phone && !RE_PHONE.test(String(row.primary_phone).trim())) {
    errors.push({ row: rowIndex, field: 'primary_phone', message: 'doesn\'t look like a valid phone number' });
  }
  // If mailing_address is set, it must include a 5-digit ZIP — this is
  // the rule that ends the street-only-mailings problem at the import
  // boundary. NULL mailing is OK (means "mailing = property").
  if (row.mailing_address && String(row.mailing_address).trim()) {
    if (!/\b\d{5}(-\d{4})?\b/.test(String(row.mailing_address))) {
      errors.push({ row: rowIndex, field: 'mailing_address', message: 'mailing_address must include a 5-digit ZIP, or leave blank to mean "mailing = property"' });
    }
  }
  return errors;
}

// ----------------------------------------------------------------------------
// CSV parsing — XLSX library handles both .xlsx and .csv with one API
// ----------------------------------------------------------------------------
function parseUploadedFile(buffer, filename) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  // Normalize headers: lowercase, spaces → underscores. Operator can
  // ship "Street Address" or "street_address" or "STREET_ADDRESS"; we
  // unify before validation.
  return rows.map(r => {
    const out = {};
    for (const k of Object.keys(r)) {
      const norm = k.toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
      out[norm] = typeof r[k] === 'string' ? r[k].trim() : r[k];
    }
    return out;
  });
}

// ----------------------------------------------------------------------------
// GET /api/communities/:id/roster-template
// ?format=csv|xlsx (default csv) - file format
// ?include_current=true|false (default true) - pre-fill with existing data
// ----------------------------------------------------------------------------
router.get('/communities/:id/roster-template', async (req, res) => {
  try {
    const communityId = req.params.id;
    const format = (req.query.format || 'csv').toLowerCase();
    const includeCurrent = req.query.include_current !== 'false';

    // Look up community for filename + sanity check
    const { data: comm, error: commErr } = await supabase
      .from('communities').select('id, name').eq('id', communityId).maybeSingle();
    if (commErr || !comm) return res.status(404).json({ error: 'community not found' });

    let rows = [];
    if (includeCurrent) {
      // Pull current state from v_current_property_owners — paginated.
      const PAGE = 1000;
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('v_current_property_owners')
          .select('property_id, vantaca_account_id, street_address, unit, city, state, zip, lot_number, property_type, owner_name, owner_email, owner_phone, owner_mailing_address')
          .eq('community_id', communityId)
          .range(from, from + PAGE - 1);
        if (error) return res.status(500).json({ error: error.message });
        if (!data || data.length === 0) break;
        for (const r of data) {
          rows.push({
            vantaca_account_id: r.vantaca_account_id || '',
            street_address:     r.street_address || '',
            unit:               r.unit || '',
            city:               r.city || '',
            state:              r.state || 'TX',
            zip:                r.zip || '',
            lot_number:         r.lot_number || '',
            property_type:      r.property_type || '',
            full_name:          r.owner_name || '',
            primary_email:      r.owner_email || '',
            primary_phone:      r.owner_phone || '',
            mailing_address:    r.owner_mailing_address || '',
          });
        }
        if (data.length < PAGE) break;
        from += PAGE;
        if (from > 100000) break;
      }
    } else {
      // Empty template — one sample row to show the shape
      rows = [{
        vantaca_account_id: 'V-12345',
        street_address:     '123 Example Street',
        unit:               '',
        city:               'Houston',
        state:              'TX',
        zip:                '77001',
        lot_number:         '15',
        property_type:      'sfh',
        full_name:          'Jane & John Doe',
        primary_email:      'janedoe@example.com',
        primary_phone:      '281-555-0100',
        mailing_address:    '',
      }];
    }

    // Stable column order for the output file
    const orderedRows = rows.map(r => {
      const out = {};
      for (const c of TEMPLATE_COLUMNS) out[c] = r[c] != null ? r[c] : '';
      return out;
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(orderedRows, { header: TEMPLATE_COLUMNS });
    XLSX.utils.book_append_sheet(wb, ws, 'roster');

    const safeName = (comm.name || 'community').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const today = new Date().toISOString().slice(0, 10);

    if (format === 'xlsx') {
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}_roster_${today}.xlsx"`);
      return res.send(buf);
    }
    const csv = XLSX.utils.sheet_to_csv(ws);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_roster_${today}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[roster-template]', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/communities/:id/roster-import/preview
// multipart/form-data with file field 'file'
// Returns: { valid_count, error_count, errors: [...], diff_summary, sample_rows }
// Pure dry-run — no writes.
// ----------------------------------------------------------------------------
router.post('/communities/:id/roster-import/preview', upload.single('file'), async (req, res) => {
  try {
    const communityId = req.params.id;
    if (!req.file) return res.status(400).json({ error: 'file_required' });

    const { data: comm } = await supabase.from('communities').select('id, name').eq('id', communityId).maybeSingle();
    if (!comm) return res.status(404).json({ error: 'community not found' });

    const rows = parseUploadedFile(req.file.buffer, req.file.originalname);
    if (rows.length === 0) return res.status(400).json({ error: 'no rows parsed from file' });

    // Per-row validation (pure, no DB hits)
    const allErrors = [];
    for (let i = 0; i < rows.length; i++) {
      const errs = validateRow(rows[i], i + 2); // +2 to match human row numbers (1-indexed + header row)
      allErrors.push(...errs);
    }

    // FK resolution — fetch current properties for this community,
    // match by vantaca_account_id. Rows without a vantaca_account_id
    // OR with one that doesn't match an existing property are flagged
    // as "net-new" (which Phase 1 doesn't support yet).
    const PAGE = 1000;
    let existing = [];
    {
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('v_current_property_owners')
          .select('property_id, vantaca_account_id, street_address, unit, city, state, zip, owner_name, owner_email, owner_phone, owner_mailing_address, owner_contact_id')
          .eq('community_id', communityId)
          .range(from, from + PAGE - 1);
        if (error) return res.status(500).json({ error: error.message });
        if (!data || data.length === 0) break;
        existing = existing.concat(data);
        if (data.length < PAGE) break;
        from += PAGE;
        if (from > 100000) break;
      }
    }
    const byVantacaId = new Map();
    for (const e of existing) {
      if (e.vantaca_account_id) byVantacaId.set(String(e.vantaca_account_id), e);
    }

    let updateCount = 0;
    let netNewCount = 0;
    const netNewRowNums = [];
    const fieldChangeTotals = { city: 0, state: 0, zip: 0, mailing_address: 0, primary_email: 0, primary_phone: 0, street_address: 0 };

    rows.forEach((r, idx) => {
      const rowNum = idx + 2;
      const vid = (r.vantaca_account_id || '').trim();
      if (!vid) {
        allErrors.push({ row: rowNum, field: 'vantaca_account_id', message: 'vantaca_account_id required for matching to an existing property. Net-new properties not yet supported via template import — use Vantaca import or manual add.' });
        netNewCount++;
        netNewRowNums.push(rowNum);
        return;
      }
      const match = byVantacaId.get(vid);
      if (!match) {
        allErrors.push({ row: rowNum, field: 'vantaca_account_id', message: `no existing property with vantaca_account_id="${vid}" — net-new properties not yet supported.` });
        netNewCount++;
        netNewRowNums.push(rowNum);
        return;
      }
      updateCount++;
      // Tally per-field changes for the diff summary
      const propFields = ['city', 'state', 'zip', 'street_address'];
      const contactFields = ['mailing_address', 'primary_email', 'primary_phone'];
      for (const f of propFields) {
        const cur = (match[f] || '').toString().trim();
        const nxt = (r[f] || '').toString().trim();
        if (cur !== nxt && (cur || nxt)) fieldChangeTotals[f]++;
      }
      const ownerCur = (match.owner_email || '').toString().trim();
      const ownerNxt = (r.primary_email || '').toString().trim();
      if (ownerCur !== ownerNxt && (ownerCur || ownerNxt)) fieldChangeTotals.primary_email++;
      const phoneCur = (match.owner_phone || '').toString().trim();
      const phoneNxt = (r.primary_phone || '').toString().trim();
      if (phoneCur !== phoneNxt && (phoneCur || phoneNxt)) fieldChangeTotals.primary_phone++;
      const mailCur = (match.owner_mailing_address || '').toString().trim();
      const mailNxt = (r.mailing_address || '').toString().trim();
      if (mailCur !== mailNxt) fieldChangeTotals.mailing_address++;
    });

    res.json({
      community: { id: comm.id, name: comm.name },
      total_rows_parsed: rows.length,
      valid_count: rows.length - allErrors.filter(e => true).length, // any error makes the row invalid
      error_count: allErrors.length,
      update_count: updateCount,
      net_new_count: netNewCount,
      net_new_row_numbers: netNewRowNums.slice(0, 20),
      field_change_totals: fieldChangeTotals,
      errors: allErrors.slice(0, 200), // cap so we don't overflow the response
      errors_truncated: allErrors.length > 200,
      sample_rows: rows.slice(0, 5)
    });
  } catch (err) {
    console.error('[roster-import/preview]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
