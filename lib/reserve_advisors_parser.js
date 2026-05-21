// ============================================================================
// Reserve Advisors LLC v7.0 spreadsheet parser
// ----------------------------------------------------------------------------
// Reserve Advisors is one of the two national reserve-study firms. Their
// "Letter Spreadsheets" Excel template is well-structured: 4 sheets
// (Property Info, Use Instructions, Expenditures, Funding Plan). The
// component inventory + cost projections + funding plan are all here.
//
// This parser is intentionally PURE — no DB calls, no I/O. Caller passes a
// Buffer, gets back a structured JSON object. The /import/preview endpoint
// uses this; staff confirms in the preview UI; /import/commit then writes
// to reserve_components + reserve_study_metadata + reserve_funding_plan.
//
// Format compatibility: built against Reserve Advisors v7.0 (dated 2024).
// If a different version's columns shift, adjust COL_INDEX below.
// ============================================================================

const XLSX = require('xlsx');

// Expenditures sheet column indices (0-based). Reserve Advisors v7.0.
const COL_INDEX = {
  section_num:           0,
  partial_quantity_pct:  1,  // "30%" — fraction of component replaced each phase
  frequency_of_events:   2,
  length_of_phase:       3,
  events_per_phase:      4,
  next_full_replacement: 5,  // year e.g. 2030
  useful_life:           6,
  round_phase:           7,
  // 8 blank
  line_item:             9,  // "4.120"
  total_quantity:       10,
  per_phase_quantity:   11,
  units:                12,  // "Square Feet", "Linear Feet", etc.
  component_name:       13,  // "Concrete Parking Area, Partial"
  first_year_event:     14,
  ul_range:             15,  // "to 65"
  remaining_ul:         16,  // "6 to 30+" or "8"
  unit_cost:            17,
  pct_ownership:        18,
  per_phase_dollars:    19,
  total_2024_dollars:   20,
  thirty_yr_inflated:   21,
  pct_of_future:        22,
  // 23: RUL=0 / FY2024 column
  // 24+: year-by-year inflated cost columns (FY → +30 years)
  first_year_col:       23,  // RUL=0 / current FY
};

const SECTION_REGEX = /^[0-9]+\.?$/; // section number e.g. "1", "2", "3"
const LINE_ITEM_REGEX = /^[0-9]+\.[0-9]+$/; // component line e.g. "4.120"

// Smart category inference from section + component name.
// Schema allowed: pool, roof, paving, fence, mechanical, landscape, common_area,
// playground, signage, lighting, irrigation, mailroom, other.
function inferCategory(sectionTitle, componentName) {
  const sec = String(sectionTitle || '').toLowerCase();
  const name = String(componentName || '').toLowerCase();

  // Specific keyword wins regardless of section
  if (/\bfence\b|\bfences\b|\bfencing\b/.test(name)) return 'fence';
  if (/\broof\b|\broofs\b|metal roof/.test(name))    return 'roof';
  if (/playground|play structure/.test(name))         return 'playground';
  if (/irrigation/.test(name))                        return 'irrigation';
  if (/mailbox|mailroom|cluster box/.test(name))      return 'mailroom';
  if (/signage|\bsign\b|monument sign/.test(name))    return 'signage';
  if (/light pole|lighting|light fixture|fixtures/.test(name)) return 'lighting';
  if (/hvac|mechanical|equipment|pump|chiller|aerator|pump house/.test(name)) return 'mechanical';
  if (/parking|sidewalk|concrete|asphalt|paving|curb|driveway/.test(name))    return 'paving';
  if (/landscape|landscap|tree|shrub|pond/.test(name))                        return 'landscape';

  // Section-based default
  if (sec.includes('pool') || sec.includes('splash')) return 'pool';
  if (sec.includes('clubhouse') || sec.includes('pavilion') || sec.includes('amenity')) return 'common_area';
  if (sec.includes('property site') || sec.includes('common')) return 'common_area';

  return 'other';
}

function parsePercent(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().replace(/%/g, '');
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  // Reserve Advisors stores as "3.30%" string OR "30%" — always relative.
  // Round to 5 decimals to kill FP noise (2.7% → 0.027 not 0.027000000000000003).
  return Math.round((n / 100) * 100000) / 100000;
}

function parseInt10(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().replace(/[, ]/g, '');
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

function parseDollars(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().replace(/[$, ]/g, '').replace(/[()]/g, ''); // strip ( ) for negatives — funding plan
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return n;
}

function parseDollarsCents(v) {
  const d = parseDollars(v);
  return d == null ? null : Math.round(d * 100);
}

function excelDateToISO(v) {
  if (v == null || v === '') return null;
  // Could be a string "10/18/24" or "10/18/2024" or Excel serial
  if (typeof v === 'number') {
    // Excel serial date (days since 1900-01-01, with the famous 1900 leap year bug)
    const date = new Date((v - 25569) * 86400 * 1000);
    if (isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let [, mm, dd, yy] = m;
    yy = yy.length === 2 ? (parseInt(yy, 10) < 50 ? '20' + yy : '19' + yy) : yy;
    return `${yy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`;
  }
  return null;
}

// ============================================================================
// Property Info sheet → study-level metadata
// ============================================================================
function parsePropertyInfo(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false });
  const get = (label) => {
    const row = rows.find(r => r && r[0] && String(r[0]).trim().toLowerCase() === label.toLowerCase());
    return row ? row[1] : null;
  };

  // Beginning Reserve Balance is shown as col B in row 23 ($720,165.00) in a non-labeled cell.
  // The pattern is "[null|'', '$720,165.00']" preceded by labeled rows. Find it via the first
  // row that has a dollar value with no label in col A.
  let beginningBalance = null;
  for (const r of rows) {
    if (!r) continue;
    const labelEmpty = r[0] == null || String(r[0]).trim() === '';
    if (labelEmpty && r[1] && /^\$[\d,]+(\.\d+)?$/.test(String(r[1]).trim())) {
      beginningBalance = parseDollarsCents(r[1]);
      break;
    }
  }

  return {
    format: 'reserve_advisors_v7',
    version: get('Version:'),
    association_name:        get('Association Name:'),
    city:                    get('City:'),
    state:                   get('State:'),
    reference_number:        get('Reference Number:'),
    length_years:            parseInt10(get('Length of Study (Years):')),
    units_count:             parseInt10(get('Number of Units:')),
    inspection_date:         excelDateToISO(get('Date of Inspection:')),
    fiscal_year:             parseInt10(get('Current Fiscal Year:')),
    fiscal_year_begin:       excelDateToISO(get('Fiscal Year Beginning:')),
    first_year_recommendation: parseInt10(get('First Year of Recommendation:')),
    beginning_balance_date:  excelDateToISO(get('Beginning Reserve Balance Date:')),
    beginning_balance_cents: beginningBalance,
    near_term_inflation:     parsePercent(get('Near Term Inflation:')),
    last_year_near_term:     parseInt10(get('Last Year of Near Term Inflation:')),
    remaining_inflation:     parsePercent(get('Remaining Study Inflation:')),
    interest_rate:           parsePercent(get('Interest:')),
    contributions_per_year:  parseInt10(get('Frequency of Contributions:')),
  };
}

// ============================================================================
// Expenditures sheet → component inventory + year-by-year cost forecast
// ============================================================================
function parseExpenditures(sheet, metadata) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false });

  // Find header rows. Header is in rows 7-8 (split header). Year columns
  // start at col 23 (FY2024 / "RUL = 0"). Build a year-by-col map.
  const yearByCol = {};
  if (rows[7]) {
    // Row 7 has year offsets ("1", "2", ... "30") starting at col 24
    for (let c = COL_INDEX.first_year_col; c < rows[7].length; c++) {
      const v = rows[7][c];
      if (c === COL_INDEX.first_year_col) {
        yearByCol[c] = metadata?.fiscal_year || 2024; // FY column
      } else if (v != null && v !== '') {
        const off = parseInt10(v);
        if (off != null && metadata?.fiscal_year) {
          yearByCol[c] = metadata.fiscal_year + off;
        }
      }
    }
  }
  // Also try row 8 in case the year offsets are there
  if (Object.keys(yearByCol).length < 5 && rows[8]) {
    for (let c = COL_INDEX.first_year_col; c < rows[8].length; c++) {
      const v = rows[8][c];
      if (yearByCol[c]) continue;
      // Some templates put the literal year like "2025"
      const n = parseInt10(v);
      if (n && n >= 2020 && n <= 2080) yearByCol[c] = n;
    }
  }

  const components = [];
  let currentSection = null;
  let currentSectionNum = null;

  for (let i = 9; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;

    const a = r[COL_INDEX.section_num];
    const j = r[COL_INDEX.line_item];
    const n = r[COL_INDEX.component_name];

    // Section header detection: col A is plain integer, col J is blank, col N is the title
    if (a != null && SECTION_REGEX.test(String(a).trim()) && (!j || j === '') && n) {
      currentSectionNum = String(a).trim();
      currentSection = String(n).trim();
      continue;
    }

    // Component row: col J has line-item number like "4.120"
    if (!(j && LINE_ITEM_REGEX.test(String(j).trim()) && n)) continue;

    const nextReplYear = parseInt10(r[COL_INDEX.next_full_replacement]);
    const usefulLife = parseInt10(r[COL_INDEX.useful_life]);
    const partialPct = parsePercent(r[COL_INDEX.partial_quantity_pct]);
    const isPartial = partialPct != null && partialPct < 1.0;

    // remaining_ul can be "8" or "6 to 30+" — take first number
    let remainingUL = null;
    const remStr = String(r[COL_INDEX.remaining_ul] || '').trim();
    const remMatch = remStr.match(/^(\d+)/);
    if (remMatch) remainingUL = parseInt10(remMatch[1]);

    // Cost: per-phase if partial, total if not
    const perPhaseDollars = parseDollars(r[COL_INDEX.per_phase_dollars]);
    const totalDollars = parseDollars(r[COL_INDEX.total_2024_dollars]);
    const currentCostDollars = isPartial ? perPhaseDollars : totalDollars;

    // Find inflated cost in the next-replacement year (or first non-empty year col)
    let futureCostDollars = null;
    let futureCostYear = null;
    for (const [col, year] of Object.entries(yearByCol)) {
      if (nextReplYear && year < nextReplYear) continue;
      const v = parseDollars(r[parseInt10(col)]);
      if (v && v > 0) {
        futureCostDollars = v;
        futureCostYear = year;
        break;
      }
    }

    // Pull the full year-by-year schedule (omitted from main payload to keep size sane;
    // included as a forecast array in case caller wants to render a chart)
    const forecast = [];
    for (const [col, year] of Object.entries(yearByCol)) {
      const v = parseDollars(r[parseInt10(col)]);
      if (v && v > 0) forecast.push({ year, inflated_dollars: v });
    }

    const sectionTitle = currentSection || '';
    const lineItem = String(j).trim();

    components.push({
      // Raw fields from spreadsheet
      section_num: currentSectionNum,
      section_title: sectionTitle,
      line_item: lineItem,
      component_name: String(n).trim(),
      units: r[COL_INDEX.units] || null,
      total_quantity: parseDollars(r[COL_INDEX.total_quantity]),
      per_phase_quantity: parseDollars(r[COL_INDEX.per_phase_quantity]),
      partial_quantity_pct: partialPct,
      is_partial: isPartial,
      events_per_phase: parseInt10(r[COL_INDEX.events_per_phase]),
      next_scheduled_replacement_year: nextReplYear,
      useful_life_years: usefulLife,
      remaining_useful_life_years: remainingUL,
      ul_range: remStr || null,
      unit_cost_dollars: parseDollars(r[COL_INDEX.unit_cost]),
      percentage_ownership: parsePercent(r[COL_INDEX.pct_ownership]),
      per_phase_dollars: perPhaseDollars,
      total_2024_dollars: totalDollars,
      thirty_year_inflated_dollars: parseDollars(r[COL_INDEX.thirty_yr_inflated]),
      pct_of_future: parsePercent(r[COL_INDEX.pct_of_future]),

      // Inferred + computed fields ready for reserve_components insert
      suggested_category: inferCategory(sectionTitle, n),
      current_cost_estimate_cents: currentCostDollars ? Math.round(currentCostDollars * 100) : null,
      future_cost_estimate_cents: futureCostDollars ? Math.round(futureCostDollars * 100) : null,
      future_cost_year: futureCostYear,
      installed_or_built_year: (nextReplYear && usefulLife) ? nextReplYear - usefulLife : null,
      inflation_factor: metadata?.near_term_inflation != null
        ? 1 + metadata.near_term_inflation
        : null,
      source_section: `Section ${currentSectionNum || '?'} — ${sectionTitle} · Line ${lineItem}`,

      // Full year-by-year forecast (for chart rendering)
      forecast,
    });
  }

  return components;
}

// ============================================================================
// Funding Plan sheet → year-by-year reserve fund projection
// ============================================================================
function parseFundingPlan(sheet, metadata) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false });

  // The funding plan has TWO horizontal blocks: years 1-16 (rows 5-15) and
  // years 17-30 (rows 22-30+). Each block has the year row at the top and
  // the data rows below it.
  const yearsBlocks = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    // Year header row: starts with "FY" or has multiple 4-digit years
    const numericYears = r.filter(v => {
      const n = parseInt10(v);
      return n && n >= 2020 && n <= 2080;
    });
    const hasFY = r.some(v => String(v || '').trim().match(/^FY\d{4}$/));
    if (numericYears.length >= 5 || hasFY) {
      // Build colIdx → year map for this block
      const yearByCol = {};
      r.forEach((v, c) => {
        if (v == null) return;
        const s = String(v).trim();
        const fyMatch = s.match(/^FY(\d{4})$/);
        if (fyMatch) yearByCol[c] = parseInt10(fyMatch[1]);
        else {
          const n = parseInt10(v);
          if (n && n >= 2020 && n <= 2080) yearByCol[c] = n;
        }
      });
      if (Object.keys(yearByCol).length >= 3) {
        yearsBlocks.push({ headerRow: i, yearByCol });
      }
    }
  }

  // For each block, extract the per-row metrics by looking at the label column
  // The labels live in col 1 or 2 ("Reserves at Beginning of Year", "Recommended
  // Reserve Contributions ", etc.) within the next ~12 rows after the header.
  const rowLabels = {
    'reserves at beginning of year':                'beginning_balance',
    'recommended reserve contributions':            'recommended_contribution',
    'additional reserve contributions':             'additional_contribution',
    'additional assessment':                        'additional_assessment',
    'total recommended reserve contributions':      'total_contribution',
    'anticipated interest rate':                    'interest_rate',
    'estimated interest earned, during year':       'interest_earned',
    'anticipated expenditures, by year':            'anticipated_expenditures',
    'anticipated reserves at year end':             'ending_balance',
  };

  const byYear = {};
  for (const block of yearsBlocks) {
    for (let i = block.headerRow + 1; i < Math.min(block.headerRow + 14, rows.length); i++) {
      const r = rows[i];
      if (!r) continue;
      // Find the label — it's in cols 1, 2, or 3
      let labelKey = null;
      for (let c = 1; c <= 3; c++) {
        const lbl = String(r[c] || '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (rowLabels[lbl]) { labelKey = rowLabels[lbl]; break; }
      }
      if (!labelKey) continue;

      for (const [colStr, year] of Object.entries(block.yearByCol)) {
        const col = parseInt10(colStr);
        if (!byYear[year]) byYear[year] = { year };
        if (labelKey === 'interest_rate') {
          byYear[year][labelKey] = parsePercent(r[col]);
        } else {
          byYear[year][labelKey + '_cents'] = parseDollarsCents(r[col]);
        }
      }
    }
  }

  // Sort years ascending, return array
  return Object.values(byYear).sort((a, b) => a.year - b.year);
}

// ============================================================================
// Top-level: parse the full workbook
// ============================================================================
function parseReserveAdvisorsWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellNF: false });

  if (!wb.SheetNames.includes('Property Info') || !wb.SheetNames.includes('Expenditures')) {
    return {
      ok: false,
      error: 'unrecognized_format',
      message: 'Expected Reserve Advisors v7.0 spreadsheet (Property Info + Expenditures + Funding Plan sheets). Got: ' + wb.SheetNames.join(', '),
    };
  }

  const metadata = parsePropertyInfo(wb.Sheets['Property Info']);
  const components = parseExpenditures(wb.Sheets['Expenditures'], metadata);
  const fundingPlan = wb.SheetNames.includes('Funding Plan')
    ? parseFundingPlan(wb.Sheets['Funding Plan'], metadata)
    : [];

  return {
    ok: true,
    metadata,
    components,
    funding_plan: fundingPlan,
    stats: {
      component_count: components.length,
      funding_plan_years: fundingPlan.length,
      sections: [...new Set(components.map(c => c.section_title))],
    },
  };
}

module.exports = {
  parseReserveAdvisorsWorkbook,
  inferCategory,
  COL_INDEX,
};
