// ============================================================================
// vantaca_violation_import.js — parse a Vantaca violations export
// ----------------------------------------------------------------------------
// Vantaca exports violation history as CSV/XLSX with columns that vary by
// report. The parser uses fuzzy column detection (mirrors the property
// import in lib/contacts/vantaca_import.js) so the same uploader works
// across different report formats.
//
// Returns:
//   { rows: NormalizedRow[], mapping: { field: header }, headers, errors }
//
// NormalizedRow:
//   {
//     vantaca_account_id, street_address (raw),
//     category_label, opened_at, stage, resolved_at, resolved_via,
//     notes, fine_amount, _source_row
//   }
//
// The downstream resolver maps:
//   - vantaca_account_id  → properties.id via vantaca_account_id lookup
//   - category_label      → enforcement_categories.id via fuzzy match
//   - stage string        → 'courtesy_1' / 'courtesy_2' / 'certified_209' / etc.
// ============================================================================

const xlsx = require('xlsx');

const FIELD_PATTERNS = [
  { field: 'vantaca_account_id', patterns: ['account #', 'account number', 'account id', 'acct #', 'vantaca id', 'account'] },
  { field: 'street_address',     patterns: ['property address', 'street address', 'site address', 'address', 'property', 'mailaddress1'] },
  { field: 'house_number',       patterns: ['mail street no', 'street no', 'street number', 'house number', 'house #', 'streetno', 'mailstreetno'] },
  { field: 'category_label',     patterns: ['violation type', 'violation category', 'category', 'compliance issue', 'issue', 'rule violated', 'violation'] },
  { field: 'opened_at',          patterns: ['violation date', 'opened date', 'date opened', 'date observed', 'inspection date', 'issued date', 'date'] },
  { field: 'stage',              patterns: ['stage', 'letter type', 'notice type', 'status', 'compliance stage', 'level'] },
  { field: 'resolved_at',        patterns: ['resolved date', 'cured date', 'closed date', 'cleared date', 'date resolved'] },
  { field: 'resolved_via',       patterns: ['resolution', 'how resolved', 'cured by', 'closed by', 'outcome'] },
  { field: 'fine_amount',        patterns: ['fine amount', 'fine', 'assessment', 'penalty', 'amount'] },
  { field: 'notes',              patterns: ['notes', 'description', 'comments', 'remarks', 'detail'] },
];

function _norm(h) {
  return String(h || '').toLowerCase().trim().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ');
}

function _clean(v) {
  if (v == null) return null;
  // xlsx might return Date objects; coerce to ISO string
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim().replace(/\s+/g, ' ').replace(/^["']|["']$/g, '');
  return s || null;
}

// Map a free-text Vantaca stage to our canonical stage slug.
// Vantaca uses things like: "1st Notice", "Courtesy", "Certified", "Hearing", etc.
function _normalizeStage(raw) {
  if (raw == null) return 'courtesy_1';   // default if unknown
  const s = String(raw).toLowerCase().trim();
  if (!s) return 'courtesy_1';

  // Resolved-state strings → 'cured'
  if (/(resolved|cured|closed|cleared|complied|fixed)/.test(s)) return 'cured';
  if (/(voided|withdrawn|cancelled|canceled)/.test(s)) return 'voided';
  // Fine / hearing
  if (/(fine|assessed|penalty|hearing)/.test(s)) return 'fine_assessed';
  // Certified / §209
  if (/(certified|209|cert mail|cert\.|formal)/.test(s)) return 'certified_209';
  // Second notice
  if (/(2nd|second|2\s*nd|c2|courtesy 2)/.test(s)) return 'courtesy_2';
  // Default first courtesy
  if (/(1st|first|courtesy|notice|warn)/.test(s)) return 'courtesy_1';
  return 'courtesy_1';
}

function _normalizeResolvedVia(raw) {
  if (raw == null) return null;
  const s = String(raw).toLowerCase().trim();
  if (!s) return null;
  if (/(cured|complied|fixed|resolved|cleared)/.test(s)) return 'cured';
  if (/(fine|assessment|penalty)/.test(s)) return 'fine';
  if (/(withdrawn|dismissed)/.test(s)) return 'withdrawn';
  if (/(void|cancelled|canceled)/.test(s)) return 'voided';
  return null;
}

function _parseDate(raw) {
  if (raw == null) return null;
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  const s = String(raw).trim();
  if (!s) return null;
  // Try ISO first
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Try MM/DD/YYYY or M/D/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let yr = parseInt(m[3], 10);
    if (yr < 100) yr += 2000;
    return `${yr}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function detectColumnMapping(headers) {
  const normalized = headers.map((h, i) => ({ raw: h, norm: _norm(h), idx: i }));
  const mapping = {};
  const claimed = new Set();
  for (const { field, patterns } of FIELD_PATTERNS) {
    // Pass 1: exact
    for (const pat of patterns) {
      const m = normalized.find((h) => !claimed.has(h.idx) && h.norm === pat);
      if (m) { mapping[field] = { header: m.raw, columnIndex: m.idx }; claimed.add(m.idx); break; }
    }
    if (mapping[field]) continue;
    // Pass 2: substring
    for (const pat of patterns) {
      const m = normalized.find((h) => !claimed.has(h.idx) && h.norm.includes(pat));
      if (m) { mapping[field] = { header: m.raw, columnIndex: m.idx }; claimed.add(m.idx); break; }
    }
  }
  return mapping;
}

function parseVantacaViolations(buffer, filename) {
  let workbook;
  try {
    workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true });
  } catch (e) {
    return { rows: [], mapping: {}, headers: [], errors: ['Could not parse file: ' + e.message] };
  }
  if (!workbook.SheetNames.length) {
    return { rows: [], mapping: {}, headers: [], errors: ['File has no sheets.'] };
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const aoa = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: null, blankrows: false });
  if (aoa.length < 2) {
    return { rows: [], mapping: {}, headers: [], errors: ['File has no data rows.'] };
  }
  const headers = aoa[0].map((h) => (h == null ? '' : String(h)));
  const mapping = detectColumnMapping(headers);

  if (!mapping.street_address && !mapping.vantaca_account_id) {
    return {
      rows: [], mapping, headers,
      errors: ['Could not detect a property identifier column (need at least Account # or Street Address).'],
    };
  }
  if (!mapping.category_label) {
    return {
      rows: [], mapping, headers,
      errors: ['Could not detect a violation category column (need "Violation Type" or similar).'],
    };
  }
  if (!mapping.opened_at) {
    return {
      rows: [], mapping, headers,
      errors: ['Could not detect a violation date column (need "Violation Date" or "Date Opened").'],
    };
  }

  const rows = [];
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r];
    const getField = (f) => mapping[f] ? _clean(row[mapping[f].columnIndex]) : null;

    const acctId = getField('vantaca_account_id');
    let streetAddress = getField('street_address');
    const houseNum = getField('house_number');
    if (houseNum && streetAddress && !/^\d/.test(streetAddress)) {
      streetAddress = `${houseNum} ${streetAddress}`;
    }
    const opened = _parseDate(getField('opened_at'));
    const resolved = _parseDate(getField('resolved_at'));
    if (!opened) continue;  // row without a date is unusable
    if (!acctId && !streetAddress) continue;  // need a property identifier

    const stage = _normalizeStage(getField('stage'));
    const resolvedVia = _normalizeResolvedVia(getField('resolved_via')) || (resolved ? 'cured' : null);
    const fineRaw = getField('fine_amount');
    let fineAmt = null;
    if (fineRaw) {
      const m = String(fineRaw).match(/-?\$?\s*([\d,]+(?:\.\d{1,2})?)/);
      if (m) fineAmt = Number(m[1].replace(/,/g, ''));
    }

    rows.push({
      vantaca_account_id: acctId,
      street_address: streetAddress,
      category_label: getField('category_label'),
      opened_at: opened,
      stage,
      resolved_at: resolved,
      resolved_via: resolvedVia,
      fine_amount: fineAmt,
      notes: getField('notes'),
      _source_row: r + 1,
    });
  }

  return { rows, mapping, headers, errors: [] };
}

module.exports = { parseVantacaViolations, detectColumnMapping };
