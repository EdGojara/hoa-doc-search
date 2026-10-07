// ============================================================================
// lib/ap/date_check.js  (Ed 2026-10-07)
// ----------------------------------------------------------------------------
// Deterministic sanity check on the dates the invoice reader returned, run
// before a bill loads. Pure: no DB, no clock unless the caller omits receivedOn.
//
// Why: Fort Bend County M.U.D. No. 143 statement 29748370 (Waterview Estates)
// prints two-digit years (STATEMENT DATE 08/14/26, due 09/09/26). The only
// four-digit year on the PDF is a "10/2024" revision stamp in the rate insert's
// footer, and the model returned 2024 for every date. Nothing checked it, so the
// bill loaded as 2024 and posted at the GL cutover. Four sibling statements from
// the same email read 2026 correctly: model variance, so the net has to be code.
//
// A failed check HOLDS the bill for a person with the specific reason. It never
// corrects a date: the reader may be wrong, or the bill may really be old, and
// only a person looking at the PDF can tell which.
// ============================================================================

const MAX_DAYS_BEFORE_RECEIPT = 335;   // ~11 months: older than this is not a current bill
const MAX_DAYS_AFTER_RECEIPT = 60;     // a bill dated well after it arrived is misread
const SERVICE_GAP_DAYS = 92;           // a service period this far from the invoice, in another year

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

// 'YYYY-MM-DD' -> UTC ms, or null when not a real calendar date.
function parseIso(s) {
  if (s == null) return null;
  const m = ISO.exec(String(s).slice(0, 10));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(t);
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return t;
}
const days = (a, b) => Math.round((a - b) / 86400000);
const yearOf = (s) => Number(String(s).slice(0, 4));

// 784 days -> "2 years"; 120 days -> "4 months"; 70 days -> "70 days".
function span(d) {
  if (d >= 365) { const y = Math.round(d / 365); return `${y} year${y === 1 ? '' : 's'}`; }
  if (d >= 90) return `${Math.round(d / 30.44)} months`;
  return `${d} day${d === 1 ? '' : 's'}`;
}

// extracted: the reader's fields (invoice_date, due_date, service_period_start/end).
// receivedOn: when the bill arrived ('YYYY-MM-DD' or an ISO timestamp); today if omitted.
// Returns { ok, received_on, problems: [{ code, message }] }.
function checkInvoiceDates(extracted, receivedOn) {
  const e = extracted || {};
  const received = receivedOn ? String(receivedOn).slice(0, 10) : new Date().toISOString().slice(0, 10);
  const problems = [];
  const add = (code, message) => problems.push({ code, message });

  const inv = parseIso(e.invoice_date);
  const rec = parseIso(received);
  if (e.invoice_date && inv == null) add('invoice_date_invalid', `invoice date "${e.invoice_date}" is not a real date`);

  if (inv != null && rec != null) {
    const before = days(rec, inv);
    if (before > MAX_DAYS_BEFORE_RECEIPT) {
      add('invoice_date_too_old', `invoice date ${e.invoice_date} is ${span(before)} before the bill was received (${received}); the bill may print a two-digit year, or the year was read from a footer or form revision stamp`);
    } else if (-before > MAX_DAYS_AFTER_RECEIPT) {
      add('invoice_date_in_future', `invoice date ${e.invoice_date} is ${span(-before)} after the bill was received (${received})`);
    }
  }

  const due = parseIso(e.due_date);
  if (e.due_date && due == null) add('due_date_invalid', `due date "${e.due_date}" is not a real date`);
  if (inv != null && due != null && due < inv) {
    add('due_before_invoice', `due date ${e.due_date} is before the invoice date ${e.invoice_date}`);
  }

  // A December-January period billed in January, or December usage billed in
  // January, legitimately crosses a year. Flag only when no end of the period
  // shares the invoice's year AND the period is months away from the invoice.
  const ps = parseIso(e.service_period_start), pe = parseIso(e.service_period_end);
  if (inv != null && (ps != null || pe != null)) {
    const iy = yearOf(e.invoice_date);
    const years = [ps != null ? yearOf(e.service_period_start) : null, pe != null ? yearOf(e.service_period_end) : null].filter((y) => y != null);
    const near = pe != null ? pe : ps;
    if (!years.includes(iy) && Math.abs(days(inv, near)) > SERVICE_GAP_DAYS) {
      const period = [e.service_period_start, e.service_period_end].filter(Boolean).join('..');
      add('service_year_mismatch', `service period ${period} is in ${[...new Set(years)].join('/')} but the invoice is dated ${e.invoice_date}`);
    }
  }

  return { ok: problems.length === 0, received_on: received, problems };
}

// One line for a hold reason / exception note.
function dateCheckReason(result) {
  return `date check: ${result.problems.map((p) => p.message).join('; ')}. Held for review, nothing was changed: check the dates on the bill.`;
}

module.exports = { checkInvoiceDates, dateCheckReason, parseIso, MAX_DAYS_BEFORE_RECEIPT, MAX_DAYS_AFTER_RECEIPT };
