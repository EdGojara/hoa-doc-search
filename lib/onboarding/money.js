// ============================================================================
// lib/onboarding/money.js  (Issue #15)
// ----------------------------------------------------------------------------
// Exact money handling for the onboarding engine. Everything is integer cents.
// A value that cannot be read exactly is an extraction defect, never a zero:
// parseCents throws on anything it does not fully understand, so a layout the
// adapter misreads fails loudly instead of quietly dropping an amount (the
// Quail Ridge package CSV dropped ".38"-style amounts that way).
// ============================================================================

// Accepts: 1,234.56  $1,234.56  (1,234.56)  -1,234.56  .38  -.38  ($.38)  0.00
// Dash-only ("-") is the report's explicit zero and is accepted as 0.
const MONEY_RE = /^\(?-?\$?\(?-?(?:\d{1,3}(?:,\d{3})+|\d+)?\.\d{2}\)?$/;

function parseCents(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '-' || s === '—') return 0;
  if (!MONEY_RE.test(s)) throw new Error(`unreadable amount: ${JSON.stringify(raw)}`);
  const negative = s.includes('(') || s.includes('-');
  const digits = s.replace(/[^\d.]/g, '');
  const [whole, frac] = digits.split('.');
  const cents = Number(whole || '0') * 100 + Number(frac);
  return negative ? -cents : cents;
}

// Non-throwing variant for "is this token an amount?" checks.
function isAmount(raw) {
  const s = String(raw == null ? '' : raw).trim();
  return s === '-' || MONEY_RE.test(s);
}

const fmt = (cents) => {
  const neg = cents < 0; const a = Math.abs(cents);
  const s = `${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`;
  return neg ? `(${s})` : s;
};

module.exports = { parseCents, isAmount, fmt };
