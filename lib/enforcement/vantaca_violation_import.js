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
  // Return null for unknown — the caller MUST NOT silently default an
  // unrecognized stage to courtesy_1. Doing so resets a homeowner who is
  // mid-enforcement (e.g. Vantaca "Owner Response") back to a first notice.
  // Ed 2026-06-18: that silent first-notice is the exact regression the
  // reconciliation guard exists to prevent. Null flows to needs_review.
  if (raw == null) return null;
  const s = String(raw).toLowerCase().trim();
  if (!s) return null;

  // Resolved-state strings → terminal
  if (/(resolved|cured|closed|cleared|complied|fixed)/.test(s)) return 'cured';
  if (/(voided|void|withdrawn|cancelled|canceled)/.test(s)) return 'voided';
  // Certified / §209 — the certified letter AND its hearing process step.
  // "Pending Hearing" is NOT a fine; it's the §209 stage that carries the
  // statutory hearing right (Ed 2026-06-18). Must be tested BEFORE the fine
  // branch so a hearing-stage case folds up to certified_209, matching
  // _ssrsStageToCanonical and the SSRS-path behavior.
  if (/(certified|209|cert mail|cert\.|formal|hearing)/.test(s)) return 'certified_209';
  // Fine assessed (an actual monetary penalty, not the hearing step)
  if (/(fine|assessed|penalty)/.test(s)) return 'fine_assessed';
  // Second notice (check before the generic "notice" catch)
  if (/(2nd|second|2\s*nd|c2|courtesy 2)/.test(s)) return 'courtesy_2';
  // First courtesy
  if (/(1st|first|courtesy)/.test(s)) return 'courtesy_1';
  // Bare "notice"/"warn" with no ordinal → first courtesy is the safe read
  if (/(notice|warn)/.test(s)) return 'courtesy_1';
  // Unrecognized (e.g. "Owner Response") → null → needs_review, never a notice
  return null;
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

// ----------------------------------------------------------------------------
// Vantaca SSRS / Crystal Reports "Violation Report - Detail" export parser.
//
// This export uses generic field names like "textBox8" instead of human
// column labels. Layout observed (Lakes of Pine Forest May 2026):
//
//   col 0  textBox8             Report title (every row identical)
//   col 1  textBox7             Association name
//   col 2  StatusDataTextBox    Status section header ("Closed (Total Count = 93)")
//   col 3  textBox14            Label only: "Hearing Date"
//   col 4  textBox12            Label only: "Details"
//   col 5  textBox11            Label only: "Address"
//   col 6  textBox9             Label only: "Homeowner"
//   col 7  textBox4             Label only: "Account"
//   col 8  textBox3             Label only: "XN"
//   col 9  textBox10            DATA: street address
//   col 10 textBox6             DATA: homeowner name
//   col 11 textBox5             DATA: Vantaca account #
//   col 12 textBox15            DATA: hearing date (often blank)
//   col 13 textBox2             DATA: violation id (skip)
//   col 14 textBox1             DATA: violation type / category
//   col 15 textBox18            DATA: status string ("Closed - 05/06/2026 - Jennifer Flores")
//
// The status string carries both stage and date. We parse it for both.
// ----------------------------------------------------------------------------
const SSRS_COL = {
  status_group: 2,    // section header — used to disambiguate "Closed" rows
  street_address: 9,
  vantaca_account_id: 11,
  hearing_date: 12,
  category_label: 14,
  status_string: 15,
};

function _parseSsrsStatusString(s) {
  // A status cell carries either a single event or a HISTORY of events
  // separated by ';' (or newlines):
  //   "Closed - 05/06/2026 - Jennifer Flores"
  //   "First Notice - 02/23/2026 - X; Second Notice - 03/25/2026 - Y; Certified Letter Notice - 04/28/2026 - Z"
  //
  // The CURRENT status is the most RECENT event, and its date is when that
  // stage was entered — what the §209 cert clock counts from. The old code
  // anchored a non-greedy regex at the start and returned the FIRST event,
  // which understated escalated cases as first notices and dated the clock from
  // the wrong day (Ed 2026-06-18). We now split the history and pick the latest.
  if (!s) return { stageLabel: null, date: null, actor: null };
  const str = String(s).trim();
  const evRe = /^(.*?)\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(.+)$/;
  const events = str.split(/\s*;\s*|\n+/).map((p) => p.trim()).filter(Boolean).map((p) => {
    const m = p.match(evRe);
    return m
      ? { stageLabel: m[1].trim(), date: _parseDate(m[2].trim()), actor: m[3].trim() }
      : { stageLabel: p, date: null, actor: null };
  });
  if (events.length === 0) return { stageLabel: str, date: null, actor: null };
  if (events.length === 1) return events[0];
  // Current status = the event with the latest date. Picking by date (not by
  // ladder rank) is correct even when a case ends in closure: a history ending
  // "...; Closed - 05/01" is currently Closed, not Certified.
  const dated = events.filter((e) => e.date);
  if (dated.length) {
    return dated.reduce((best, e) => (e.date > best.date ? e : best));
  }
  return events[events.length - 1];
}

// Map Vantaca's status labels to trustEd's canonical violation stages.
// The trustEd stages are constrained by the violations_current_stage_check
// CHECK constraint: courtesy_1 / courtesy_2 / certified_209 / fine_assessed
// / cured / closed / voided (+ a few escalation tail stages).
// Texas §209 hearing process: the certified §209 notice triggers a hearing
// opportunity by statute. "Pending Hearing" and "Hearing Notice" in Vantaca
// are PROCESS STEPS within the certified_209 stage, not separate enforcement
// stages — they're properly modeled as certified_209 in trustEd.
// (Ed 2026-06-10: prior code emitted invented 'hearing_pending' /
// 'hearing_notice' values that crashed the CHECK constraint on insert.)
function _ssrsStageToCanonical(stageLabel) {
  if (!stageLabel) return null;
  const s = stageLabel.toLowerCase();
  if (s.includes('closed') || s.includes('cured'))            return 'cured';
  if (s.includes('first notice') || s === 'first')            return 'courtesy_1';
  if (s.includes('second notice') || s === 'second')          return 'courtesy_2';
  if (s.includes('certified letter') || s.includes('certified notice')) return 'certified_209';
  // Hearing-related labels are sub-states of the certified_209 stage in
  // Texas §209's enforcement procedure — they fold up to certified_209.
  if (s.includes('hearing'))                                  return 'certified_209';
  if (s.includes('fine assessed') || s.includes('fine'))      return 'fine_assessed';
  return null;
}

function _parseVantacaSsrsExport(aoa, headers) {
  const rows = [];
  // Dedupe key — the SSRS export sometimes emits the same row 2-3× in
  // sequence (observed in Lakes of Pine Forest May 2026 rows 156-157).
  // Track (account|address|category|date|stage) to drop the dupes.
  const seen = new Set();

  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r];
    if (!row || row.length === 0) continue;

    const streetAddress = _clean(row[SSRS_COL.street_address]);
    const acctId        = _clean(row[SSRS_COL.vantaca_account_id]);
    const categoryLabel = _clean(row[SSRS_COL.category_label]);
    const statusStr     = _clean(row[SSRS_COL.status_string]);

    if (!streetAddress && !acctId) continue;        // need a property
    if (!categoryLabel) continue;                    // need a violation type

    const { stageLabel, date } = _parseSsrsStatusString(statusStr);
    const stage = _ssrsStageToCanonical(stageLabel);

    if (!date) continue;                             // unusable without an event date
    const isClosed = stage === 'cured';

    // _parseDate returns 'YYYY-MM-DD' string, not a Date.
    const key = `${acctId || ''}|${streetAddress || ''}|${categoryLabel}|${date}|${stage || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    rows.push({
      vantaca_account_id: acctId,
      street_address: streetAddress,
      category_label: categoryLabel,
      opened_at: date,
      stage: isClosed ? null : stage, // closed rows track the cure date, not an open stage
      resolved_at: isClosed ? date : null,
      resolved_via: isClosed ? 'cured' : null,
      fine_amount: null,
      notes: stageLabel || null,
      _source_row: r + 1,
    });
  }

  // Return the canonical {field: {header, columnIndex}} shape so the
  // frontend Column-mapping panel renders correctly. The _source marker
  // surfaces in the UI as "auto-detected from SSRS export" so staff sees
  // how the system understood the file.
  const safeHeader = (i) => (headers[i] != null ? headers[i] : `column ${i + 1}`);
  return {
    rows,
    mapping: {
      street_address:     { header: safeHeader(SSRS_COL.street_address),     columnIndex: SSRS_COL.street_address },
      vantaca_account_id: { header: safeHeader(SSRS_COL.vantaca_account_id), columnIndex: SSRS_COL.vantaca_account_id },
      category_label:     { header: safeHeader(SSRS_COL.category_label),     columnIndex: SSRS_COL.category_label },
      opened_at:          { header: safeHeader(SSRS_COL.status_string),      columnIndex: SSRS_COL.status_string },
      _source: 'vantaca_ssrs_export',
    },
    headers,
    errors: rows.length === 0
      ? ['SSRS export shape detected but no rows parsed — verify the file is the Violation Report Detail and not a different report.']
      : [],
  };
}

/**
 * Parse a Vantaca violations file (CSV / XLSX).
 *
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {object} [opts]
 * @param {object} [opts.manualMapping] — operator override for auto-detect.
 *   Keys are field names ('street_address', 'vantaca_account_id',
 *   'category_label', 'opened_at', etc.), values are column INDEXES into
 *   the header row. Lets the staff resolve "couldn't detect a property
 *   identifier" errors in the UI without escalating to Ed — pick the
 *   right column from a dropdown, retry.
 */
function parseVantacaViolations(buffer, filename, opts = {}) {
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

  // Ed 2026-06-10: detect the Vantaca SSRS / Crystal Reports "Violation
  // Report - Detail" export. That export ships with generic field names
  // ("textBox8", "textBox7", "StatusDataTextBox", "textBox1" ...) instead
  // of human column labels, so the standard header-pattern matcher never
  // finds Account / Address / Violation Type and the file rejects.
  // When we see this shape, switch to a positional mapping based on the
  // known SSRS layout and parse the status string for stage + date.
  const looksLikeSsrsExport = (
    headers.length >= 14 &&
    headers.some((h) => /^textBox\d+$/i.test(String(h).trim())) &&
    headers.some((h) => /StatusDataTextBox/i.test(String(h).trim()))
  );
  // Manual override path — if the operator provided explicit column
  // indexes (via the self-diagnose UI), skip SSRS detection and
  // auto-detect entirely. This is how staff resolves a "couldn't detect
  // columns" error without paging Ed.
  if (opts && opts.manualMapping && Object.keys(opts.manualMapping).length > 0) {
    const overrideMapping = {};
    for (const [field, colIdx] of Object.entries(opts.manualMapping)) {
      const i = Number(colIdx);
      if (Number.isInteger(i) && i >= 0 && i < headers.length) {
        overrideMapping[field] = { header: headers[i], columnIndex: i };
      }
    }
    return _parseWithMapping(aoa, headers, overrideMapping, { source: 'manual_override' });
  }

  if (looksLikeSsrsExport) {
    return _parseVantacaSsrsExport(aoa, headers);
  }

  const mapping = detectColumnMapping(headers);
  return _parseWithMapping(aoa, headers, mapping, { source: 'auto_detect' });
}

// ----------------------------------------------------------------------------
// Shared row-extraction logic — used by both auto-detect and manual-override
// paths. Validates the mapping has the required fields, then iterates rows
// and emits the canonical row shape. Single source of truth so the manual
// override and auto-detect paths can never silently diverge.
// ----------------------------------------------------------------------------
function _parseWithMapping(aoa, headers, mapping, mappingMeta) {
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

  return {
    rows,
    mapping: { ...mapping, ...(mappingMeta || {}) },
    headers,
    errors: [],
  };
}

// ============================================================================
// PDF extraction path — Vantaca's standard violation history report exports
// as PDF, not CSV. We send the PDF binary to Claude and ask for the same
// NormalizedRow shape the CSV path produces, so the downstream resolver +
// preview UI works without changes.
//
// Per CLAUDE.md: never use pdf-parse on Vantaca PDFs (form-field overlay
// scar). Always send the binary to the model.
//
// Large-PDF handling: the model's per-request PDF limit is 100 pages / 32MB.
// Bedrock's actual violation history reports run 100-150+ pages. We split
// the source PDF into 40-page chunks via pdf-lib, process them in parallel,
// then merge + dedup by (property, category, opened_at). Wall-clock cost
// for a 4-chunk PDF: ~12-15 seconds parallel vs. ~50-60 seconds sequential.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const { PDFDocument } = require('pdf-lib');

const _anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Ed 2026-06-10: dropped from 40 → 6. The 40-page chunk fit Claude's PDF
// input cap but routinely overflowed the 16k OUTPUT cap: a single
// status-grouped Vantaca page can carry 15-25 rows × ~150 tokens each, and
// 12 pages × 20 rows × 150 = ~36k tokens of JSON output. Hit the truncate
// in real use (Lakes of Pine Forest May 2026, 157 rows, 12 pages — failed).
// 6 pages = ~90-150 rows per chunk = ~13-22k output tokens, comfortably
// under the new 32k max_tokens ceiling below. Tradeoff: 2-3 parallel
// model calls per typical Vantaca monthly export, well within rate limits.
const PDF_CHUNK_PAGES = 6;

/**
 * Split a PDF buffer into N-page chunks for parallel processing.
 * Returns [{ buffer, startPage, endPage, totalPages }] — one entry per chunk.
 * For PDFs under PDF_CHUNK_PAGES, returns a single passthrough chunk.
 */
async function _splitPdfIntoChunks(buffer, pagesPerChunk = PDF_CHUNK_PAGES) {
  const original = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const totalPages = original.getPageCount();
  if (totalPages <= pagesPerChunk) {
    return [{ buffer, startPage: 1, endPage: totalPages, totalPages }];
  }
  const chunks = [];
  for (let start = 0; start < totalPages; start += pagesPerChunk) {
    const end = Math.min(start + pagesPerChunk, totalPages);
    const chunkDoc = await PDFDocument.create();
    const indices = [];
    for (let i = start; i < end; i++) indices.push(i);
    const copiedPages = await chunkDoc.copyPages(original, indices);
    copiedPages.forEach((page) => chunkDoc.addPage(page));
    const chunkBytes = await chunkDoc.save();
    chunks.push({
      buffer: Buffer.from(chunkBytes),
      startPage: start + 1,
      endPage: end,
      totalPages,
    });
  }
  return chunks;
}

const PDF_EXTRACTION_PROMPT = `You are extracting violation history rows from a Vantaca property management
violation report PDF. The report typically contains a table or per-property
list with columns: property address, owner, violation date, violation
type/category, status/stage, resolution date, resolution method, fine
amount, notes.

Extract EVERY violation row visible. Return ONLY a JSON object — no
preamble, no markdown fences:

{
  "rows": [
    {
      "vantaca_account_id": "string or null — Vantaca account # if shown",
      "street_address": "string — physical property address (e.g. '15711 Crooked Arrow Dr')",
      "owner_name": "string or null — owner name as written",
      "category_label": "string — violation type/category as written ('Trash bins', 'Grass too long', 'Holiday lights', etc.)",
      "opened_at": "YYYY-MM-DD — violation/observation/letter date",
      "stage": "string — the stage/notice type as written ('1st Notice', 'Courtesy', '2nd Notice', 'Certified', 'Hearing', '209 Letter', etc.)",
      "resolved_at": "YYYY-MM-DD or null — if the row shows resolution",
      "resolved_via": "string or null — how resolved (cured/withdrawn/fine/etc.)",
      "fine_amount": <number or null — dollars as a plain number, no $ or commas>,
      "notes": "string or null — any free-text note"
    }
  ]
}

EXTRACTION RULES:
- Extract ALL rows visible, even ones marked resolved/closed/voided.
- A status cell may list a HISTORY of events, e.g. "First Notice - 02/23/2026 - X;
  Second Notice - 03/25/2026 - Y; Certified Letter Notice - 04/28/2026 - Z". When
  it does, the CURRENT status is the MOST RECENT (last) event. Set "stage" to that
  last event's status ("Certified Letter Notice" here) and "opened_at" to THAT
  event's date (2026-04-28), NOT the first event's. Do not return the first notice
  for a case that has already escalated.
- Money: numbers only, no $ or commas. Parens for negative.
- Dates: YYYY-MM-DD. Vantaca shows MM/DD/YYYY usually — convert.
- Unit numbers stay separate from street address ('#2A' isn't part of street).
- If a property has multiple violation rows, return one JSON row per violation.
- Use null for any field not shown on that row.
- If the report shows owner_mailing_address or owner_name, include owner_name.

Return ONLY the JSON object.`;

/**
 * Extract violation rows from a single PDF chunk (≤ PDF_CHUNK_PAGES).
 * Internal helper for parseVantacaViolationsPdf which handles chunking.
 */
async function _extractChunkViaModel(chunkBuffer, chunkLabel) {
  const pdfBase64 = chunkBuffer.toString('base64');
  // Per Anthropic SDK: requests where max_tokens × generation time could
  // exceed 10 minutes REQUIRE streaming. Even though typical PDF extraction
  // returns in 15-30 seconds, the SDK rejects non-streamed create() calls
  // with 16k+ max_tokens preemptively. messages.stream(...) + finalMessage()
  // gives us streaming on the wire with the same return shape we used before.
  let completion;
  try {
    const stream = _anthropic.messages.stream({
      model: 'claude-sonnet-4-5',
      max_tokens: 32000,  // Ed 2026-06-10: bumped back to 32k after a 12-page
                          // chunk overflowed 16k. Combined with chunking down
                          // to 6 pages, output stays under 24k in practice but
                          // the headroom prevents truncation on dense pages.
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: PDF_EXTRACTION_PROMPT },
        ],
      }],
    });
    completion = await stream.finalMessage();
  } catch (err) {
    return { rows: [], error: `extraction failed for ${chunkLabel}: ${err.message}` };
  }

  const text = (completion.content?.[0]?.text || '').trim();
  console.log(`[vantaca_violation_import_pdf] ${chunkLabel}: model returned ${text.length} chars (stop=${completion.stop_reason})`);
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  let parsed;
  try {
    const m = cleaned.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : cleaned);
  } catch (err) {
    const truncatedHint = completion.stop_reason === 'max_tokens'
      ? ' (output truncated — chunk had more rows than max_tokens could express). Try splitting the export into smaller PDFs or reducing PDF_CHUNK_PAGES.'
      : '';
    return {
      rows: [],
      error: `JSON parse failed for ${chunkLabel}${truncatedHint}: ${err.message}`,
      raw_sample: text.slice(0, 600),
    };
  }

  const rawRows = Array.isArray(parsed.rows) ? parsed.rows : [];
  const rows = rawRows.map((r) => {
    const stage = _normalizeStage(r.stage);
    const resolvedVia = _normalizeResolvedVia(r.resolved_via) || (r.resolved_at ? 'cured' : null);
    const fineAmt = r.fine_amount != null ? Number(r.fine_amount) : null;
    return {
      vantaca_account_id: r.vantaca_account_id ? String(r.vantaca_account_id).trim() : null,
      street_address: r.street_address ? String(r.street_address).trim() : null,
      category_label: r.category_label ? String(r.category_label).trim() : null,
      opened_at: r.opened_at && /^\d{4}-\d{2}-\d{2}$/.test(r.opened_at) ? r.opened_at : null,
      stage,
      resolved_at: r.resolved_at && /^\d{4}-\d{2}-\d{2}$/.test(r.resolved_at) ? r.resolved_at : null,
      resolved_via: resolvedVia,
      fine_amount: Number.isFinite(fineAmt) ? fineAmt : null,
      notes: r.notes ? String(r.notes).trim() : null,
      owner_name: r.owner_name ? String(r.owner_name).trim() : null,
    };
  }).filter((r) => r.opened_at && (r.vantaca_account_id || r.street_address));

  return { rows, error: null, row_count_raw: rawRows.length };
}

/**
 * Extract violation rows from a Vantaca PDF report using Claude.
 * Produces the same NormalizedRow shape as parseVantacaViolations (CSV path)
 * so the downstream resolver + preview UI works identically.
 *
 * Handles large PDFs (138+ pages) by splitting into 40-page chunks and
 * processing them in parallel. Dedup by (property+category+opened_at)
 * across chunks in case a row appears on a chunk-boundary page.
 *
 * @param {Buffer} buffer  — PDF file buffer
 * @param {string} filename
 * @returns {Promise<{ rows, mapping, headers, errors, raw_extracted, duration_ms }>}
 */
// ----------------------------------------------------------------------------
// extractVantacaSummaryTotals — read the printed SUMMARY counts off page 1-2.
//
// SCAR EXCEPTION (documented on purpose): CLAUDE.md says never use pdf-parse on
// Vantaca PDFs — that rule is about the DETAIL ROWS, whose values are Adobe
// form-field overlays pdf-parse can't see (it returns underscores). The SUMMARY
// section at the top is ordinary rendered report text, and pdf-parse reads it
// perfectly (verified against Waterview 5/31: 118/54/34/34/2/901/1/6). We use it
// ONLY for the per-status totals, never for row values. Those totals are the
// AUTHORITATIVE count the coverage cross-check compares against — so a parser
// that under-extracts detail rows ("34 certified in the report, we only parsed
// 11") is caught instead of silently undercounting.
//
// Returns null on any failure (non-fatal — the cross-check just falls back to
// the parsed-row counts).
// ----------------------------------------------------------------------------
const VANTACA_SUMMARY_LABELS = [
  // Order matters: match longer/more-specific labels first so "Certified Letter
  // Notice" isn't shadowed by a bare "Notice" match.
  { label: 'Certified Letter Notice', stage: 'certified_209' },
  { label: 'Pending Hearing',         stage: 'certified_209' },  // §209 hearing step folds up
  { label: 'Second Notice',           stage: 'courtesy_2' },
  { label: 'First Notice',            stage: 'courtesy_1' },
  { label: 'Owner Response',          stage: 'owner_response' }, // open, no trustEd stage → review
  { label: 'Resolved',                stage: 'cured' },
  { label: 'Closed',                  stage: 'cured' },
  { label: 'Void',                    stage: 'voided' },
];

// Pure text→totals parser (exported for testing). Takes the raw extracted PDF
// text, returns canonical per-stage + per-label totals, or null if no summary
// labels are found.
function _parseSummaryText(text) {
  if (!text) return null;
  // The per-property detail tables begin at "(Total Count =". Everything before
  // that is the summary; clipping avoids matching a status label that also
  // appears as a detail-row status string.
  const cut = text.indexOf('(Total Count =');
  const summaryText = cut > 0 ? text.slice(0, cut) : text.slice(0, 6000);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const byLabel = {};
  const byStage = {};
  let found = 0;
  for (const { label, stage } of VANTACA_SUMMARY_LABELS) {
    const m = summaryText.match(new RegExp(esc(label) + '\\s*(\\d+)'));
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isNaN(n)) continue;
    byLabel[label] = n;
    byStage[stage] = (byStage[stage] || 0) + n;
    found += 1;
  }
  if (found === 0) return null;
  return { by_label: byLabel, by_stage: byStage };
}

async function extractVantacaSummaryTotals(buffer) {
  try {
    const pdfParse = require('pdf-parse');
    const parsed = await pdfParse(buffer);
    return _parseSummaryText(parsed.text || '');
  } catch (err) {
    return null;
  }
}

async function parseVantacaViolationsPdf(buffer, filename) {
  const t0 = Date.now();
  if (!_anthropic) {
    return {
      rows: [], mapping: { source: 'pdf_extraction' }, headers: [],
      errors: ['ANTHROPIC_API_KEY not configured in Render environment.'],
      raw_extracted: null,
      duration_ms: Date.now() - t0,
    };
  }

  // Split the PDF if it exceeds the per-request page cap
  let chunks;
  try {
    chunks = await _splitPdfIntoChunks(buffer);
  } catch (err) {
    return {
      rows: [], mapping: { source: 'pdf_extraction' }, headers: [],
      errors: [`Failed to read PDF (possibly corrupted or encrypted): ${err.message}`],
      raw_extracted: null,
      duration_ms: Date.now() - t0,
    };
  }
  const totalPages = chunks[0]?.totalPages || 0;
  console.log(`[vantaca_violation_import_pdf] ${filename}: ${totalPages} pages → ${chunks.length} chunk(s)`);

  // Process chunks in PARALLEL (faster but burns more concurrent API quota).
  // For typical Anthropic API tiers (Tier 2+) 4-6 concurrent requests is
  // well within limits. Fall back to sequential if rate-limited.
  const chunkResults = await Promise.all(
    chunks.map((chunk, idx) =>
      _extractChunkViaModel(chunk.buffer, `chunk ${idx + 1}/${chunks.length} (pages ${chunk.startPage}-${chunk.endPage})`)
    )
  );

  // Merge + dedup. Same property + category + opened_at = same violation
  // (could happen if a row spans a chunk boundary or appears on consecutive
  // pages of the original report).
  const seen = new Set();
  const allRows = [];
  const chunkErrors = [];
  for (let i = 0; i < chunkResults.length; i++) {
    const cr = chunkResults[i];
    if (cr.error) {
      chunkErrors.push(cr.error);
      continue;
    }
    for (const r of (cr.rows || [])) {
      const key = `${r.vantaca_account_id || r.street_address || ''}::${r.category_label || ''}::${r.opened_at || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allRows.push({ ...r, _source_row: allRows.length + 1 });
    }
  }

  return {
    rows: allRows,
    mapping: {
      source: 'pdf_extraction',
      model: 'claude-sonnet-4-5',
      chunks: chunks.length,
      total_pages: totalPages,
    },
    headers: [],
    errors: allRows.length === 0
      ? (chunkErrors.length > 0 ? chunkErrors : ['No usable violation rows extracted from PDF.'])
      : chunkErrors, // partial-success: keep the rows even if some chunks failed
    raw_extracted: {
      chunk_count: chunks.length,
      total_pages: totalPages,
      rows_per_chunk: chunkResults.map((cr) => (cr.rows ? cr.rows.length : 0)),
      chunk_errors: chunkErrors,
    },
    duration_ms: Date.now() - t0,
  };
}

module.exports = {
  parseVantacaViolations,
  parseVantacaViolationsPdf,
  detectColumnMapping,
  // Exported for the reconciliation regression test — the exact label→stage
  // mapping is a correctness surface (silent first-notice bug), so it gets
  // asserted against the real Vantaca report labels.
  _normalizeStage,
  _ssrsStageToCanonical,
  extractVantacaSummaryTotals,
  _parseSummaryText,
  _parseSsrsStatusString,
};
