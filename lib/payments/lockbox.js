// ============================================================================
// lib/payments/lockbox.js  (Ed 2026-11-20)
// ----------------------------------------------------------------------------
// BANK LOCKBOX REMITTANCE + COUPON SCANLINE, per association. One place, so
// the printed statement, the portal and the annual billing batch agree.
//
// THE SCANLINE (industry-standard HOA OCR line; the same layout NewFirst reads
// from Vantaca's coupons, and the one the Pacific Premier/Columbia and
// CIT/Mutual of Omaha specs document):
//   MMMM AAAAAA UUUUUUUUUUUUUUUU NNNNNNNNNNNN $$$$$$ C      (50 chars)
//   1-4   management company code, zero-filled left (bank assigned; 0000 at NewFirst)
//   6-11  association code, zero-filled left
//   13-28 homeowner account number, zero-filled left (16)
//   30-41 last name, letters only, zero-filled right (12)
//   43-48 amount due in cents, zero-filled left (6)
//   50    check digit
// Verified against 21 real Vantaca/NewFirst coupons (Waterview, 2025 + 2026):
// the check digit is Luhn mod-10 over every digit on the line, letters skipped,
// 21 of 21 match. Print: OCR-A 12pt, 10 cpi, black non-magnetic ink, inside a
// 0.25-0.5 in band from the bottom edge with a 0.25 in clear border.
//
// STATUS per association (what is verified, and from what record):
//   remittance_verified: the bank's lockbox mailing address is confirmed as the
//     association's CURRENT arrangement (bank record + recent lockbox deposits).
//   scanline_verified:   the bank has accepted coupons with this exact line
//     (management + association code). Until then statements print, but the
//     batch is NOT cleared for mailing: the bank must read-test a proof first
//     (NewFirst tests sample coupons before a new print source goes live).
// Nothing here is assumed from another association: an association with no
// verified entry gets no lockbox, and checks go c/o Bedrock's office.
// ============================================================================

const NEWFIRST_LOCKBOX = {
  bank: 'NewFirst National Bank',
  // NewFirst Lockbox/HOA Services (lockbox@newfirst.com, 832-344-2067),
  // 2023-10-12: "The mailing address for the assessments is ... PO Box 1992,
  // Richmond, TX 77406-0050". Vantaca's 2026-11-20 Waterview statement prints it.
  lines: ['c/o Bedrock Association Management LLC', 'PO Box 1992', 'Richmond, TX 77406-0050'],
  mgmt_code: '0000',
};

// Keyed by communities.name (stable, and what staff read). association_code
// is the Vantaca association number the lockbox routes on; it is also the
// prefix of every Vantaca account number in that association.
const LOCKBOXES = {
  'Waterview Estates': {
    ...NEWFIRST_LOCKBOX, association_code: '101',
    remittance_verified: true, scanline_verified: true,
    evidence: 'Vantaca statement 2026-11-20 (acct 10110474) and 20 Waterview coupons 2025-11; lockbox deposits to NewFirst operating x5961 through 2026-09-25',
  },
  'Lakes of Pine Forest': {
    ...NEWFIRST_LOCKBOX, association_code: '201',
    remittance_verified: true, scanline_verified: false,
    evidence: 'Lockbox deposits to NewFirst operating x2449 through 2026-09-16; association code 201 = Vantaca account prefix (no LOPF coupon on file to confirm the printed code)',
  },
  'Still Creek Ranch': {
    ...NEWFIRST_LOCKBOX, association_code: '102',
    remittance_verified: true, scanline_verified: false,
    evidence: 'Lockbox deposits to NewFirst operating x1777 through 2026-07-15; NewFirst association ID SCR (2020); association code 102 = Vantaca account prefix (no SCR coupon on file to confirm the printed code)',
  },
  // Canyon Gate moved to NewFirst (operating x5313). The NewFirst lockbox was
  // requested 2026-04-28; NewFirst's confirmation (2026-04-30) is an encrypted
  // message not readable here, and no lockbox deposit has reached x5313.
  // PROPOSED ONLY (bank-validation samples): lockboxFor() ignores it, so no
  // production statement uses it until NewFirst confirms and this is verified.
  'Canyon Gate at Cinco Ranch': {
    ...NEWFIRST_LOCKBOX, association_code: '105',
    remittance_verified: false, scanline_verified: false, proposed: true,
    evidence: 'Proposed: NewFirst operating x5313; association code 105 = Vantaca account prefix; NewFirst lockbox address and Canyon Gate lockbox ID not yet confirmed by NewFirst',
  },
  // Quail Ridge banks at First Citizens; its lockbox address is not on file.
};

function lockboxFor(communityName) {
  const lb = LOCKBOXES[String(communityName || '').trim()];
  return lb && lb.remittance_verified ? lb : null;
}

// ---- scanline ---------------------------------------------------------------
const SUFFIX = /^(?:JR|SR|II|III|IV|V)$/i;
// Last name of the first owner, as Vantaca prints it: "Brenda Moreno & Anastacio
// Moreno Jr." -> MORENO; "Gary & Linda Litton" -> LITTON; "Richard Dunlap II"
// -> DUNLAPII. Letters only, upper case, 12 max.
function scanName(ownerName) {
  const raw = String(ownerName || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const segs = raw.split(/\s*(?:&|\band\b|,|\/)\s*/i).filter(Boolean);
  let words = (segs[0] || '').split(' ').filter(Boolean);
  if (words.length < 2) {
    // "Gary & Linda Litton": the shared last name is at the end of the line.
    const all = raw.split(' ').filter((w) => !/^(?:&|and)$/i.test(w));
    const tail = all.filter((w) => !SUFFIX.test(w.replace(/\W/g, '')));
    words = tail.length ? [tail[0], tail[tail.length - 1]] : all;
  }
  const last = words.slice(1).join('');
  return last.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 12);
}

function luhn(digits) {
  let sum = 0;
  const d = String(digits).split('').map(Number).reverse();
  for (let i = 0; i < d.length; i++) { let x = d[i]; if (i % 2 === 0) { x *= 2; if (x > 9) x -= 9; } sum += x; }
  return (10 - (sum % 10)) % 10;
}

// The 50-character line, or null when the association has no verified lockbox
// or the account/amount cannot be encoded (never a guessed line).
function buildScanline(lockbox, { accountNumber, ownerName, amountCents }) {
  if (!lockbox) return null;
  const acct = String(accountNumber || '').replace(/\D/g, '');
  if (!acct || acct.length > 16 || /^0/.test(acct)) return null;      // unit id cannot start with 0
  const cents = Math.max(0, Math.round(Number(amountCents) || 0));
  if (cents > 999999) return null;                                     // 6-digit field: $9,999.99 max
  const name = scanName(ownerName).padEnd(12, '0');
  const body = [
    String(lockbox.mgmt_code).padStart(4, '0').slice(-4),
    String(lockbox.association_code).padStart(6, '0').slice(-6),
    acct.padStart(16, '0'),
    name,
    String(cents).padStart(6, '0'),
  ].join(' ');
  return `${body} ${luhn(body.replace(/\D/g, ''))}`;
}

module.exports = { LOCKBOXES, lockboxFor, buildScanline, scanName, luhn };
