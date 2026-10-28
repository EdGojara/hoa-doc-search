// ============================================================================
// lib/vault/documents.js  (Ed 2026-10-28)
// ----------------------------------------------------------------------------
// Pure helpers for Owner Vault documents (migration 550): the categories, the
// filed name (Entity_Document-Type_Date.ext, the house naming convention), and
// validation of the fields the owner types. No I/O here, so it is unit-tested
// directly (tests/test_vault_documents.js).
// ============================================================================
const crypto = require('crypto');

// Must match the CHECK on vault_documents.category (migration 550).
const CATEGORIES = {
  formation: 'Formation & ownership',
  tax: 'Tax returns & filings',
  irs_notice: 'IRS & state notices',
  bank: 'Bank & loans',
  insurance: 'Insurance',
  lease_property: 'Lease & office',
  contract: 'Contracts',
  government: 'City, county & state',
  correspondence: 'Letters & correspondence',
  payroll: 'Payroll & HR',
  legal: 'Legal',
  other: 'Other',
};

const MAX_BYTES = 30 * 1024 * 1024;

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// "Bedrock Association Management, LLC" -> "Bedrock_Association_Management".
// Legal suffixes are dropped; anything that is not a letter or digit becomes a
// word break.
function nameWords(s) {
  return String(s || '')
    .replace(/[,.]?\s*\b(L\.?L\.?C|Inc|Incorporated|Corp|Corporation|Co|Ltd|LLP|LP|PLLC|P\.?C)\b\.?/gi, ' ')
    .replace(/&/g, ' and ')
    .split(/[^A-Za-z0-9]+/).filter(Boolean);
}

function extOf(filename) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(filename || ''));
  return m ? '.' + m[1].toLowerCase() : '';
}

// Entity_Document-Type_Date.ext. Date wins over tax year; neither -> no suffix.
// The entity's words are not repeated when the title already starts with them.
function suggestFiledName({ entityName, title, documentDate, taxYear, originalFilename }) {
  const ent = nameWords(entityName);
  let doc = nameWords(title);
  if (ent.length && doc.slice(0, ent.length).join('_').toLowerCase() === ent.join('_').toLowerCase()) doc = doc.slice(ent.length);
  const parts = [...ent, ...doc];
  if (isIsoDate(documentDate)) parts.push(documentDate);
  else if (taxYear) parts.push(String(taxYear));
  const base = parts.join('_').slice(0, 150).replace(/_+$/, '') || 'Document';
  return base + extOf(originalFilename);
}

function isIsoDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

// A filed name the owner typed: keep it readable, strip path separators and
// control characters, keep the original extension if they left it off.
function cleanFiledName(name, originalFilename) {
  let n = String(name || '').replace(/[\u0000-\u001f\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
  if (!n) return '';
  const ext = extOf(originalFilename);
  if (ext && !n.toLowerCase().endsWith(ext)) n += ext;
  return n;
}

// Validates the editable fields. Returns { fields } or { error }. `partial`
// (PATCH) only validates what was sent; on create, title and category default.
function validateFields(b, { partial = false } = {}) {
  const out = {};
  const has = (k) => b[k] !== undefined;
  if (!partial || has('title')) {
    const t = String(b.title == null ? '' : b.title).trim().slice(0, 200);
    if (!t) return { error: 'title_required' };
    out.title = t;
  }
  if (!partial || has('category')) {
    const c = b.category == null || b.category === '' ? 'other' : String(b.category);
    if (!Object.prototype.hasOwnProperty.call(CATEGORIES, c)) return { error: 'invalid_category' };
    out.category = c;
  }
  if (has('document_date')) {
    if (b.document_date === '' || b.document_date == null) out.document_date = null;
    else if (!isIsoDate(b.document_date)) return { error: 'invalid_document_date' };
    else out.document_date = b.document_date;
  }
  if (has('tax_year')) {
    if (b.tax_year === '' || b.tax_year == null) out.tax_year = null;
    else {
      const y = Number(b.tax_year);
      if (!Number.isInteger(y) || y < 1990 || y > 2100) return { error: 'invalid_tax_year' };
      out.tax_year = y;
    }
  }
  if (has('notes')) out.notes = String(b.notes == null ? '' : b.notes).trim().slice(0, 4000) || null;
  return { fields: out };
}

module.exports = { CATEGORIES, MAX_BYTES, sha256Hex, nameWords, suggestFiledName, cleanFiledName, validateFields, isIsoDate };
