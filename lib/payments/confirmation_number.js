// ============================================================================
// lib/payments/confirmation_number.js  (Ed 2026-11-27)
// ----------------------------------------------------------------------------
// The Bedrock confirmation number a homeowner sees for an online payment:
// 'BP-7K3M-9QXA'. Crockford base32 (no I, L, O or U, so it reads aloud and
// types cleanly over the phone). 8 random characters = 32^8, about 1.1e12.
//
// It is ours, never Stripe's: a homeowner quoting it to staff finds the payment
// (GET /api/payments/by-confirmation/:number), and nothing about the processor
// leaks onto a receipt. Set once when the payment group is created and stored on
// every row of the group (migration 585, unique on the assessment row).
// The SQL twin for backfills is payment_new_confirmation_number() (mig 585).
// ============================================================================
const crypto = require('crypto');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const FORMAT = /^BP-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

function newConfirmationNumber(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[bytes[i] % 32];
  return `BP-${s.slice(0, 4)}-${s.slice(4)}`;
}

// A number typed by staff or a homeowner: case-insensitive, O->0, I/L->1,
// spaces and missing dashes tolerated. Returns the canonical form or null.
function normalizeConfirmationNumber(input) {
  const raw = String(input || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  const body = raw.startsWith('BP') ? raw.slice(2) : raw;
  if (body.length !== 8) return null;
  const n = `BP-${body.slice(0, 4)}-${body.slice(4)}`;
  return FORMAT.test(n) ? n : null;
}

const isConfirmationNumber = (s) => FORMAT.test(String(s || ''));

module.exports = { newConfirmationNumber, normalizeConfirmationNumber, isConfirmationNumber, CONFIRMATION_FORMAT: FORMAT };
