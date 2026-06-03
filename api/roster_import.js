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
//   mailing_street     (optional; ALL 4 mailing fields blank = mailing = property)
//   mailing_city       (optional; required if any mailing field is set)
//   mailing_state      (optional; required if any mailing field is set, 2-letter)
//   mailing_zip        (optional; required if any mailing field is set, 5-digit)
//
// Mailing-address rules (migration 153 — structured fields):
//   - Leave ALL 4 mailing_* fields blank → "mailing = property address"
//     (the system uses property street/city/state/zip for the label)
//   - Fill ALL 4 → structured mailing label (clean, no parsing needed)
//   - Mixing some-filled / some-blank → validation error (operator must
//     either fill everything or clear everything; partial = ambiguous)
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
//
// Mailing fields (mig 153 — structured, replaces single mailing_address):
// - mailing_street / mailing_city / mailing_state / mailing_zip
// - ALL blank → mailing = property (the standard case for ~80% of rows)
// - ALL filled → off-property mailing (the "absentee owner" case)
// - PARTIAL → validation error
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
  'mailing_street',
  'mailing_city',
  'mailing_state',
  'mailing_zip',
];

const REQUIRED_FIELDS = ['street_address', 'city', 'state', 'zip', 'full_name'];

// Mailing-block field set — used by the all-or-nothing validation rule.
const MAILING_FIELDS = ['mailing_street', 'mailing_city', 'mailing_state', 'mailing_zip'];

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
  // Mailing block — structured fields (mig 153). All-or-nothing rule:
  // either all 4 fields are blank (mailing = property), or all 4 are
  // populated (off-property mailing). Partial fills are a validation
  // error because "what does the label printer do with a street but
  // no city?" The legacy single-string mailing_address column is
  // still read on upload for back-compat — if the operator uploads a
  // template with the OLD single column, we parse it best-effort into
  // structured fields below.
  if (row.mailing_address && !row.mailing_street && !row.mailing_city) {
    // Back-compat: operator uploaded a template that still has the
    // old single mailing_address column. Try to parse it now so
    // downstream logic only deals with structured fields.
    const m = String(row.mailing_address).trim();
    const parts = m.split(',').map(s => s.trim());
    if (parts.length >= 3) {
      const stateZip = parts[2].split(/\s+/).filter(Boolean);
      row.mailing_street = parts[0];
      row.mailing_city   = parts[1];
      row.mailing_state  = (stateZip[0] || '').toUpperCase();
      row.mailing_zip    = stateZip[1] || '';
    } else {
      errors.push({ row: rowIndex, field: 'mailing_address',
        message: 'legacy mailing_address column found but could not parse "STREET, CITY, STATE ZIP" shape — please split into mailing_street/mailing_city/mailing_state/mailing_zip columns' });
    }
  }
  const mailingFilled = MAILING_FIELDS.filter(f => row[f] && String(row[f]).trim()).length;
  if (mailingFilled > 0 && mailingFilled < MAILING_FIELDS.length) {
    const missing = MAILING_FIELDS.filter(f => !row[f] || !String(row[f]).trim());
    errors.push({ row: rowIndex, field: 'mailing_block',
      message: `mailing fields are partial — missing ${missing.join(', ')}. Either fill all four (street + city + state + zip) for off-property mailing, or leave all four blank to mean "mailing = property address"` });
  }
  if (mailingFilled === MAILING_FIELDS.length) {
    if (!RE_ZIP.test(String(row.mailing_zip).trim())) {
      errors.push({ row: rowIndex, field: 'mailing_zip', message: 'must be 5 digits or 5-digit+4 (e.g. 77407 or 77407-1234)' });
    }
    if (!RE_STATE.test(String(row.mailing_state).trim().toUpperCase())) {
      errors.push({ row: rowIndex, field: 'mailing_state', message: 'must be 2-letter state code (e.g. TX)' });
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
      // Structured mailing fields (owner_mailing_street/city/state/zip)
      // were added to the view in mig 153 alongside the new contacts
      // columns. If structured fields are NULL on a row (legacy contact
      // never went through Roster Import), we fall back to a best-effort
      // parse of the legacy owner_mailing_address string so the operator
      // sees SOMETHING to clean rather than a blank.
      const PAGE = 1000;
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('v_current_property_owners')
          .select('property_id, vantaca_account_id, street_address, unit, city, state, zip, lot_number, property_type, owner_name, owner_email, owner_phone, owner_mailing_address, owner_mailing_street, owner_mailing_city, owner_mailing_state, owner_mailing_zip')
          .eq('community_id', communityId)
          .range(from, from + PAGE - 1);
        if (error) return res.status(500).json({ error: error.message });
        if (!data || data.length === 0) break;
        for (const r of data) {
          // Resolve mailing block:
          //   1. Prefer structured columns when populated
          //   2. Else parse the legacy string (best-effort)
          //   3. Else leave blank (= "mailing = property address")
          let ms = r.owner_mailing_street || '';
          let mc = r.owner_mailing_city   || '';
          let mst = r.owner_mailing_state || '';
          let mz = r.owner_mailing_zip    || '';
          if (!ms && !mc && !mz && r.owner_mailing_address) {
            const parts = String(r.owner_mailing_address).split(',').map(s => s.trim());
            if (parts.length >= 3) {
              const sz = parts[2].split(/\s+/).filter(Boolean);
              ms = parts[0];
              mc = parts[1];
              mst = (sz[0] || '').toUpperCase();
              mz = sz[1] || '';
            }
          }
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
            mailing_street:     ms,
            mailing_city:       mc,
            mailing_state:      mst,
            mailing_zip:        mz,
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
        mailing_street:     '',
        mailing_city:       '',
        mailing_state:      '',
        mailing_zip:        '',
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

// ----------------------------------------------------------------------------
// POST /api/communities/:id/roster-import/apply
// multipart/form-data with file field 'file' + form field 'verified_by'
// Re-runs validation; refuses to write if ANY validation error present
// (atomic — all rows valid or nothing writes). Updates properties +
// contacts in place, stamps data_verified_at + verified_by +
// verified_source = 'template_import' on every written row.
// ----------------------------------------------------------------------------
router.post('/communities/:id/roster-import/apply', upload.single('file'), async (req, res) => {
  try {
    const communityId = req.params.id;
    if (!req.file) return res.status(400).json({ error: 'file_required' });
    const verifiedBy = (req.body?.verified_by || '').trim();
    if (!verifiedBy) return res.status(400).json({ error: 'verified_by required (operator identifier)' });

    const { data: comm } = await supabase.from('communities').select('id, name').eq('id', communityId).maybeSingle();
    if (!comm) return res.status(404).json({ error: 'community not found' });

    const rows = parseUploadedFile(req.file.buffer, req.file.originalname);
    if (rows.length === 0) return res.status(400).json({ error: 'no rows parsed from file' });

    // Re-validate every row — never trust the preview's pass
    const allErrors = [];
    for (let i = 0; i < rows.length; i++) {
      allErrors.push(...validateRow(rows[i], i + 2));
    }

    // Pull existing properties + their current owner contact for matching
    const PAGE = 1000;
    let existing = [];
    {
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('v_current_property_owners')
          .select('property_id, vantaca_account_id, owner_contact_id')
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

    // Resolve every row to a property_id + contact_id (or error). Phase 1
    // requires both — net-new rows error out so this commit is purely
    // an "update verified" operation.
    const resolvedRows = [];
    rows.forEach((r, idx) => {
      const rowNum = idx + 2;
      const vid = (r.vantaca_account_id || '').trim();
      if (!vid) {
        allErrors.push({ row: rowNum, field: 'vantaca_account_id', message: 'required' });
        return;
      }
      const match = byVantacaId.get(vid);
      if (!match) {
        allErrors.push({ row: rowNum, field: 'vantaca_account_id', message: `no existing property with vantaca_account_id="${vid}"` });
        return;
      }
      if (!match.owner_contact_id) {
        allErrors.push({ row: rowNum, field: 'full_name', message: 'no current owner contact linked to this property — manual fix required before template import can run' });
        return;
      }
      resolvedRows.push({ rowNum, row: r, property_id: match.property_id, contact_id: match.owner_contact_id });
    });

    if (allErrors.length > 0) {
      return res.status(409).json({
        error: 'validation_failed',
        message: `Refused to apply: ${allErrors.length} validation error${allErrors.length > 1 ? 's' : ''}. Fix the CSV and re-upload.`,
        errors: allErrors.slice(0, 200),
        errors_truncated: allErrors.length > 200
      });
    }

    // All rows pass — write them in chunks. Two passes: properties then
    // contacts. Each update stamps the verified columns. NULL out
    // mailing_address explicitly when the cell is blank (means "use
    // property address"), per the verification rule.
    const nowIso = new Date().toISOString();
    const propsToWrite = resolvedRows.map(({ property_id, row }) => ({
      id: property_id,
      patch: {
        street_address:    (row.street_address || '').trim() || null,
        unit:              (row.unit || '').trim() || null,
        city:              (row.city || '').trim() || null,
        state:             (row.state || '').trim().toUpperCase() || null,
        zip:               (row.zip || '').trim() || null,
        lot_number:        (row.lot_number || '').trim() || null,
        property_type:     (row.property_type || '').trim() || null,
        data_verified_at:  nowIso,
        verified_by:       verifiedBy,
        verified_source:   'template_import',
        updated_at:        nowIso
      }
    }));
    // Compose the legacy single-string mailing_address from structured
    // fields for back-compat (any consumer still reading the old column
    // keeps working).
    const composeMailing = (street, city, state, zip) => {
      if (!street && !city && !state && !zip) return null;
      const stateZip = [state, zip].filter(Boolean).join(' ').trim();
      return [street, city, stateZip].filter(Boolean).join(', ');
    };

    // Auto-populate mailing from property fields when the operator
    // left the mailing block blank — convention: blank in the upload
    // means "mailing = property address" (owner-occupied). We make
    // that explicit on apply by copying the property's street/city/
    // state/zip into the mailing columns. Now every row carries a
    // self-contained mailing block; downstream label printers don't
    // need conditional "if blank, fall back to property" logic. The
    // all-or-nothing validator already ran above, so partial fills
    // never reach this point.
    const contactsToWrite = resolvedRows.map(({ contact_id, row }) => {
      const operatorFilledMailing = MAILING_FIELDS.some(f => row[f] && String(row[f]).trim());
      const propertyStreetWithUnit = [
        (row.street_address || '').trim(),
        (row.unit || '').trim(),
      ].filter(Boolean).join(' ').trim();

      const mStreet = operatorFilledMailing
        ? ((row.mailing_street || '').trim() || null)
        : (propertyStreetWithUnit || null);
      const mCity = operatorFilledMailing
        ? ((row.mailing_city || '').trim() || null)
        : ((row.city || '').trim() || null);
      const mState = operatorFilledMailing
        ? ((row.mailing_state || '').trim().toUpperCase() || null)
        : ((row.state || '').trim().toUpperCase() || null);
      const mZip = operatorFilledMailing
        ? ((row.mailing_zip || '').trim() || null)
        : ((row.zip || '').trim() || null);

      return {
        id: contact_id,
        patch: {
          full_name:         (row.full_name || '').trim() || null,
          primary_email:     (row.primary_email || '').trim() || null,
          primary_phone:     (row.primary_phone || '').trim() || null,
          // Structured mailing fields (mig 153) — canonical going forward.
          mailing_street:    mStreet,
          mailing_city:      mCity,
          mailing_state:     mState,
          mailing_zip:       mZip,
          // Composed legacy field — kept in sync for back-compat readers.
          mailing_address:   composeMailing(mStreet, mCity, mState, mZip),
          data_verified_at:  nowIso,
          verified_by:       verifiedBy,
          verified_source:   'template_import',
          updated_at:        nowIso
        }
      };
    });

    let propertiesWritten = 0;
    let contactsWritten = 0;
    const writeErrors = [];

    // Serial updates — Supabase doesn't expose a transactional batch
    // through its JS client for per-row patches. Chunk loops with
    // explicit error capture so a single bad row doesn't kill the rest.
    for (const p of propsToWrite) {
      const { error } = await supabase.from('properties').update(p.patch).eq('id', p.id);
      if (error) writeErrors.push({ table: 'properties', id: p.id, message: error.message });
      else propertiesWritten++;
    }
    for (const c of contactsToWrite) {
      const { error } = await supabase.from('contacts').update(c.patch).eq('id', c.id);
      if (error) writeErrors.push({ table: 'contacts', id: c.id, message: error.message });
      else contactsWritten++;
    }

    console.log(`[roster-import/apply] community=${comm.name} verified_by=${verifiedBy} properties=${propertiesWritten} contacts=${contactsWritten} errors=${writeErrors.length}`);

    res.json({
      community: { id: comm.id, name: comm.name },
      verified_by: verifiedBy,
      verified_at: nowIso,
      properties_written: propertiesWritten,
      contacts_written: contactsWritten,
      write_errors: writeErrors,
      message: writeErrors.length === 0
        ? `Successfully verified ${propertiesWritten} properties and ${contactsWritten} contacts for ${comm.name}. These rows are now protected from future Vantaca-sync overwrites.`
        : `Wrote ${propertiesWritten + contactsWritten} rows but hit ${writeErrors.length} errors — review the write_errors array.`
    });
  } catch (err) {
    console.error('[roster-import/apply]', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// MAILING DELTA — "What's changed since I verified the roster?"
// ----------------------------------------------------------------------------
// Compares the canonical trustEd roster against a fresh Vantaca Mailing
// Addresses Export. Returns categorized deltas:
//   - transfers              property changed hands (new Vantaca account#)
//   - real_mailing_changes   matched account, mailing actually differs
//   - parse_bugs             trustEd has broken fields, Vantaca is clean
//   - real_name_diffs        name tokens meaningfully different
//   - format_only_noise      name tokens match, just style differs
//
// Preview is read-only. Apply requires per-row approval + verified_by.
// ----------------------------------------------------------------------------
const { parseVantacaMailingExport, computeMailingDelta } = require('../lib/contacts/mailing_delta');

router.post('/communities/:id/mailing-delta/preview', upload.single('file'), async (req, res) => {
  try {
    const communityId = req.params.id;
    if (!req.file) return res.status(400).json({ error: 'file_required' });

    const { data: comm } = await supabase.from('communities').select('id, name').eq('id', communityId).maybeSingle();
    if (!comm) return res.status(404).json({ error: 'community not found' });

    // Parse the Vantaca export
    const vantacaMap = parseVantacaMailingExport(req.file.buffer);
    if (vantacaMap.size === 0) {
      return res.status(400).json({ error: 'Vantaca export had no parseable rows — confirm the file has an Account column' });
    }

    // Pull the canonical trustEd roster for this community
    const PAGE = 1000;
    let trusted = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('v_current_property_owners')
        .select('vantaca_account_id, street_address, unit, city, state, zip, owner_name, owner_contact_id, owner_mailing_street, owner_mailing_city, owner_mailing_state, owner_mailing_zip')
        .eq('community_id', communityId)
        .range(from, from + PAGE - 1);
      if (error) return res.status(500).json({ error: error.message });
      if (!data || data.length === 0) break;
      // Normalize column names to what computeMailingDelta expects
      for (const r of data) {
        trusted.push({
          vantaca_account_id: r.vantaca_account_id,
          full_name: r.owner_name,
          street_address: r.street_address,
          unit: r.unit,
          city: r.city,
          state: r.state,
          zip: r.zip,
          mailing_street: r.owner_mailing_street,
          mailing_city:   r.owner_mailing_city,
          mailing_state:  r.owner_mailing_state,
          mailing_zip:    r.owner_mailing_zip,
          owner_contact_id: r.owner_contact_id,
        });
      }
      if (data.length < PAGE) break;
      from += PAGE;
      if (from > 100000) break;
    }

    const delta = computeMailingDelta(trusted, vantacaMap);
    res.json({
      community: { id: comm.id, name: comm.name },
      filename: req.file.originalname,
      ...delta,
    });
  } catch (err) {
    console.error('[mailing-delta/preview]', err);
    res.status(500).json({ error: err.message });
  }
});

// Apply approved deltas. Body shape:
//   {
//     verified_by: 'ed@bedrocktx.com',
//     mailing_updates: [
//       { contact_id, mailing_street, mailing_city, mailing_state, mailing_zip }
//     ],
//     name_updates: [
//       { contact_id, full_name }
//     ]
//   }
// Transfers are NOT applied by this endpoint — they require closing an
// ownership + creating a new contact + new ownership, which is non-trivial.
// MVP: surface them in the preview; operator handles via existing tools
// (manual contact creation + ownership transfer) until Phase 2.
router.post('/communities/:id/mailing-delta/apply', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const communityId = req.params.id;
    const verifiedBy = _norm(req.body && req.body.verified_by);
    if (!verifiedBy) return res.status(400).json({ error: 'verified_by required (operator identifier)' });

    const mailingUpdates = Array.isArray(req.body.mailing_updates) ? req.body.mailing_updates : [];
    const nameUpdates    = Array.isArray(req.body.name_updates)    ? req.body.name_updates    : [];

    if (mailingUpdates.length === 0 && nameUpdates.length === 0) {
      return res.status(400).json({ error: 'no updates provided — nothing to apply' });
    }

    const { data: comm } = await supabase.from('communities').select('id, name').eq('id', communityId).maybeSingle();
    if (!comm) return res.status(404).json({ error: 'community not found' });

    const nowIso = new Date().toISOString();
    const results = { mailing_updated: 0, name_updated: 0, errors: [] };

    // Compose the legacy single-field mailing_address from the structured
    // fields so back-compat readers stay in sync (matches the pattern in
    // the main Roster Import apply endpoint).
    const composeMailing = (s, c, st, z) => {
      if (!s && !c && !st && !z) return null;
      const sz = [st, z].filter(Boolean).join(' ').trim();
      return [s, c, sz].filter(Boolean).join(', ');
    };

    for (const u of mailingUpdates) {
      if (!u.contact_id) {
        results.errors.push({ kind: 'mailing', message: 'contact_id required', payload: u });
        continue;
      }
      const street = _norm(u.mailing_street) || null;
      const city   = _norm(u.mailing_city) || null;
      const state  = _upper(u.mailing_state) || null;
      const zip    = _norm(u.mailing_zip) || null;
      const patch = {
        mailing_street: street,
        mailing_city:   city,
        mailing_state:  state,
        mailing_zip:    zip,
        mailing_address: composeMailing(street, city, state, zip),
        data_verified_at: nowIso,
        verified_by: verifiedBy,
        verified_source: 'mailing_delta',
        updated_at: nowIso,
      };
      const { error } = await supabase.from('contacts').update(patch).eq('id', u.contact_id);
      if (error) results.errors.push({ kind: 'mailing', contact_id: u.contact_id, message: error.message });
      else results.mailing_updated++;
    }

    for (const u of nameUpdates) {
      if (!u.contact_id) {
        results.errors.push({ kind: 'name', message: 'contact_id required', payload: u });
        continue;
      }
      const fullName = _norm(u.full_name);
      if (!fullName) {
        results.errors.push({ kind: 'name', contact_id: u.contact_id, message: 'full_name cannot be empty' });
        continue;
      }
      const patch = {
        full_name: fullName,
        data_verified_at: nowIso,
        verified_by: verifiedBy,
        verified_source: 'mailing_delta',
        updated_at: nowIso,
      };
      const { error } = await supabase.from('contacts').update(patch).eq('id', u.contact_id);
      if (error) results.errors.push({ kind: 'name', contact_id: u.contact_id, message: error.message });
      else results.name_updated++;
    }

    console.log(`[mailing-delta/apply] community=${comm.name} verified_by=${verifiedBy} mailing=${results.mailing_updated} name=${results.name_updated} errors=${results.errors.length}`);
    res.json({ ok: true, ...results });
  } catch (err) {
    console.error('[mailing-delta/apply]', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/communities/:id/mailing-delta/claim-transfer
// ----------------------------------------------------------------------------
// One-click "claim" of an ownership transfer surfaced by the mailing-delta
// preview. The preview detects transfers as "same property address, NEW
// Vantaca account # in the export + OLD account # in trustEd" — this
// endpoint actually performs the spine update:
//
//   1. End the OLD ownership (sets end_date = now on the active
//      property_ownerships row pointing at the old contact)
//   2. Create or reuse a contact for the NEW owner. Reuse only when a
//      contact with the same name AND the new vantaca_account_id already
//      exists (defensive — fuzzy matching on name alone is risky here).
//   3. Create a new property_ownerships row linking the new contact to
//      the property with is_primary = true, start_date = now.
//   4. Update properties.vantaca_account_id to the new Vantaca account
//      so future syncs match correctly.
//   5. Stamp data_verified_at + verified_by + verified_source on the new
//      contact and the property. (verified_source = 'mailing_delta_transfer'
//      makes the source of truth auditable.)
//
// Idempotency: if the property already carries the new_account as its
// vantaca_account_id, we no-op with already_claimed = true so a double-
// click from the operator doesn't create a second new contact/ownership.
//
// SAFETY:
//   - All five writes happen in sequence; Supabase JS doesn't expose
//     transactions through PostgREST. If the new-ownership insert fails
//     after the old-ownership end, the operator gets a partial-fail
//     error and can recover via the existing Roster Import / inline
//     edit tools. Same pattern as the bedrock-vote in-person override.
//   - We do NOT delete the old contact or its history. Old contact +
//     old ownership row (now with end_date set) stay for audit.
// ----------------------------------------------------------------------------
router.post('/communities/:id/mailing-delta/claim-transfer', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const communityId = req.params.id;
    const {
      property_id,
      old_contact_id,
      new_account,
      new_owner_name,
      new_mailing,         // { street, city, state, zip }
      verified_by,
    } = req.body || {};

    if (!property_id)     return res.status(400).json({ error: 'property_id required' });
    if (!new_account)     return res.status(400).json({ error: 'new_account required' });
    if (!new_owner_name)  return res.status(400).json({ error: 'new_owner_name required' });
    if (!new_mailing || typeof new_mailing !== 'object') return res.status(400).json({ error: 'new_mailing object required' });
    if (!verified_by)     return res.status(400).json({ error: 'verified_by required (operator identifier)' });

    // 0) Scope check + property fetch
    const { data: property, error: propErr } = await supabase
      .from('properties')
      .select('id, community_id, vantaca_account_id, street_address, city, state, zip')
      .eq('id', property_id)
      .maybeSingle();
    if (propErr || !property) return res.status(404).json({ error: 'property not found' });
    if (property.community_id !== communityId) return res.status(403).json({ error: 'property does not belong to this community' });

    // Idempotency — if property already has the new account, this
    // transfer was already claimed (operator double-clicked).
    if (_norm(property.vantaca_account_id) === _norm(new_account)) {
      return res.json({ ok: true, already_claimed: true, message: 'Transfer was already claimed for this property.' });
    }

    const nowIso = new Date().toISOString();
    const street = _norm(new_mailing.street);
    const city   = _norm(new_mailing.city);
    const state  = _upper(new_mailing.state) || 'TX';
    const zip    = _norm(new_mailing.zip);
    const composedMailing = (street || city || zip)
      ? [street, city, [state, zip].filter(Boolean).join(' ').trim()].filter(Boolean).join(', ')
      : null;

    // 1) End old ownership(s). There may be only one active per property
    // under normal operation but defensive-update all active rows for
    // safety.
    if (old_contact_id) {
      const { error: endErr } = await supabase
        .from('property_ownerships')
        .update({ end_date: nowIso })
        .eq('property_id', property_id)
        .eq('contact_id', old_contact_id)
        .is('end_date', null);
      if (endErr) {
        return res.status(500).json({ error: 'failed to end old ownership: ' + endErr.message });
      }
    } else {
      // No specific old contact passed — end ALL active ownerships for
      // the property as a fallback. This protects against the panel
      // not having an old contact id (legacy data, broken view).
      await supabase
        .from('property_ownerships')
        .update({ end_date: nowIso })
        .eq('property_id', property_id)
        .is('end_date', null);
    }

    // 2) Create new contact. We don't try to reuse here — even if
    // someone named "Linden Spruce, Inc." exists elsewhere in the
    // book, that contact has its own vantaca_account_id and shouldn't
    // be re-linked. Cleaner to create a fresh contact and let the
    // operator merge later if it's actually the same entity.
    const { data: newContact, error: contactErr } = await supabase
      .from('contacts')
      .insert({
        full_name: _norm(new_owner_name),
        vantaca_account_id: _norm(new_account),
        mailing_street: street || null,
        mailing_city:   city || null,
        mailing_state:  state,
        mailing_zip:    zip || null,
        mailing_address: composedMailing,
        data_verified_at: nowIso,
        verified_by,
        verified_source: 'mailing_delta_transfer',
      })
      .select('id')
      .single();
    if (contactErr) return res.status(500).json({ error: 'failed to create new contact: ' + contactErr.message });

    // 3) Insert new ownership
    const { data: newOwnership, error: ownErr } = await supabase
      .from('property_ownerships')
      .insert({
        property_id,
        contact_id: newContact.id,
        start_date: nowIso,
        is_primary: true,
      })
      .select('id')
      .single();
    if (ownErr) {
      // New contact already exists but ownership insert failed. The
      // operator now has a stranded contact. Surface clearly.
      return res.status(500).json({
        error: 'New contact was created but ownership insert failed: ' + ownErr.message,
        partial_state: { new_contact_id: newContact.id },
      });
    }

    // 4) Update property's canonical account id + stamp verified
    const { error: propUpdErr } = await supabase
      .from('properties')
      .update({
        vantaca_account_id: _norm(new_account),
        data_verified_at:   nowIso,
        verified_by,
        verified_source:    'mailing_delta_transfer',
        updated_at:         nowIso,
      })
      .eq('id', property_id);
    if (propUpdErr) {
      // The transfer is now structurally correct (new ownership + new
      // contact) but the property's vantaca_account_id still points
      // at the old one. Idempotency won't catch a re-claim. Warn but
      // don't fail.
      console.warn('[mailing-delta/claim-transfer] property update failed:', propUpdErr.message);
    }

    console.log(`[mailing-delta/claim-transfer] community=${communityId} property=${property_id} old_contact=${old_contact_id || 'n/a'} new_contact=${newContact.id} new_account=${new_account} verified_by=${verified_by}`);

    res.json({
      ok: true,
      new_contact_id: newContact.id,
      new_ownership_id: newOwnership.id,
      property_id,
    });
  } catch (err) {
    console.error('[mailing-delta/claim-transfer]', err);
    res.status(500).json({ error: err.message });
  }
});

// Local helpers used only by the delta apply endpoint
function _norm(s)  { return String(s == null ? '' : s).trim(); }
function _upper(s) { return _norm(s).toUpperCase(); }

module.exports = { router };
