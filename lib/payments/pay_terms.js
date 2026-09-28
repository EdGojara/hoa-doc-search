// ============================================================================
// lib/payments/pay_terms.js  (Ed 2026-09-27)
// ----------------------------------------------------------------------------
// Trusted Pay Payment Terms and Conditions: the ONE source for the terms text,
// its version, and the hash every acceptance records.
//
// The wording lives in templates/trusted-pay-terms.html (draft for legal review
// before live-money launch). This module fills its {{placeholders}} and hashes
// the RENDERED page, so any change to wording or contact details yields a new
// hash; bump TERMS_VERSION whenever the wording changes. A homeowner accepts a
// specific (version, sha256), and checkout refuses an acceptance for any other.
// ============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TERMS_VERSION = '2026-09-27.2';
const EFFECTIVE_DATE = 'September 27, 2026';
const TEMPLATE = path.join(__dirname, '..', '..', 'templates', 'trusted-pay-terms.html');
const TERMS_PATH = '/pay/terms';

// Support contact shown in the terms (configurable; defaults are Bedrock's
// published office details). A phone number appears only when PAY_SUPPORT_PHONE
// is set to something that is actually a phone number; otherwise the terms name
// the email alone (never prose standing in for a number). Changing any of these
// changes the rendered hash.
function supportPhone(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  if (!/^[0-9+().\-\s]+$/.test(v) || v.replace(/\D/g, '').length < 10) {
    console.warn('[pay_terms] PAY_SUPPORT_PHONE is not a phone number; omitting phone from the terms');
    return null;
  }
  return v;
}
function supportConfig(env = process.env) {
  const email = String(env.PAY_SUPPORT_EMAIL || '').trim() || 'info@bedrocktx.com';
  const address = String(env.PAY_SUPPORT_ADDRESS || '').trim() || '12808 W Airport Blvd Ste 253, Sugar Land, TX 77478';
  const phone = supportPhone(env.PAY_SUPPORT_PHONE);
  return {
    SUPPORT_REACH: phone ? `${email} or ${phone}` : email,
    SUPPORT_LINE: ['Bedrock Association Management', address, email, phone].filter(Boolean).join(' · '),
    phone,
  };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let cache = null;
function getTerms() {
  const raw = fs.readFileSync(TEMPLATE, 'utf8').replace(/\r\n/g, '\n');
  const { SUPPORT_REACH, SUPPORT_LINE } = supportConfig();
  const vars = { TERMS_VERSION, EFFECTIVE_DATE, SUPPORT_REACH, SUPPORT_LINE };
  const key = raw + JSON.stringify(vars);
  if (cache && cache.key === key) return cache.terms;
  const html = raw.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? escapeHtml(vars[k]) : m));
  if (/\{\{[A-Z_]+\}\}/.test(html)) throw new Error('trusted pay terms template has an unfilled placeholder');
  const terms = { version: TERMS_VERSION, effective_date: EFFECTIVE_DATE, sha256: crypto.createHash('sha256').update(html, 'utf8').digest('hex'), html, path: TERMS_PATH };
  cache = { key, terms };
  return terms;
}

module.exports = { getTerms, supportConfig, TERMS_VERSION, TERMS_PATH };
