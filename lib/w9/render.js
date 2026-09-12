// ============================================================================
// lib/w9/render.js  (Ed 2026-09-12)
// ----------------------------------------------------------------------------
// Fill the OFFICIAL IRS Form W-9 (Rev. 3-2024) rather than a home-made
// substitute, so the exact form and its perjury/certification language stay
// verbatim. We only fill the identifying fields (name, business name, tax
// classification, address, EIN); the form goes out UNSIGNED for the entity's
// authorized officer to sign and date Part II.
//
// Field map is from the template's AcroForm (templates/fw9.pdf):
//   f1_01 line1 Name · f1_02 line2 Business name
//   line 3a checkboxes c1_1[0..6]: 0 individual/sole-prop, 1 C corp, 2 S corp,
//     3 partnership, 4 trust/estate, 5 LLC (+ f1_03 letter), 6 Other (+ f1_04)
//   f1_05 exempt payee code · f1_06 FATCA code (line 4)
//   f1_07 line5 address · f1_08 line6 city/state/ZIP
//   f1_09 requester name/addr · f1_10 line7 account numbers
//   TIN: SSN f1_11/f1_12/f1_13 · EIN f1_14 (2 digits) + f1_15 (7 digits)
// ============================================================================
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const TEMPLATE = path.join(__dirname, '..', '..', 'templates', 'fw9.pdf');
const P = 'topmostSubform[0].Page1[0].';
const F = {
  name: P + 'f1_01[0]',
  business: P + 'f1_02[0]',
  llcLetter: P + 'Boxes3a-b_ReadOrder[0].f1_03[0]',
  otherText: P + 'Boxes3a-b_ReadOrder[0].f1_04[0]',
  exemptPayee: P + 'f1_05[0]',
  fatca: P + 'f1_06[0]',
  address: P + 'Address_ReadOrder[0].f1_07[0]',
  cityStateZip: P + 'Address_ReadOrder[0].f1_08[0]',
  requester: P + 'f1_09[0]',
  accounts: P + 'f1_10[0]',
  ssn1: P + 'f1_11[0]', ssn2: P + 'f1_12[0]', ssn3: P + 'f1_13[0]',
  ein1: P + 'f1_14[0]', ein2: P + 'f1_15[0]',
};
const CB = {
  individual: P + 'Boxes3a-b_ReadOrder[0].c1_1[0]',
  c_corp:     P + 'Boxes3a-b_ReadOrder[0].c1_1[1]',
  s_corp:     P + 'Boxes3a-b_ReadOrder[0].c1_1[2]',
  partnership:P + 'Boxes3a-b_ReadOrder[0].c1_1[3]',
  trust:      P + 'Boxes3a-b_ReadOrder[0].c1_1[4]',
  llc:        P + 'Boxes3a-b_ReadOrder[0].c1_1[5]',
  other:      P + 'Boxes3a-b_ReadOrder[0].c1_1[6]',
};

// Split a combined US address into (street line, "City, ST ZIP").
function splitAddress(addr) {
  const s = String(addr || '').trim();
  if (!s) return { street: '', cityStateZip: '' };
  // Match a trailing "City, ST 12345" (ZIP optional +4).
  const m = s.match(/^(.*?),?\s*([A-Za-z .'-]+),\s*([A-Z]{2})\s*(\d{5}(?:-\d{4})?)?\s*$/);
  if (m) return { street: m[1].replace(/,\s*$/, '').trim(), cityStateZip: `${m[2].trim()}, ${m[3]} ${m[4] || ''}`.trim() };
  return { street: s, cityStateZip: '' };
}

function einDigits(ein) { return String(ein || '').replace(/\D/g, ''); }

/**
 * @param {object} o
 * @param {string} o.name           Line 1 legal name (required)
 * @param {string} [o.businessName] Line 2 business/DBA
 * @param {string} o.classification one of: individual|c_corp|s_corp|partnership|trust|llc|other
 * @param {string} [o.llcLetter]    for classification 'llc': 'C'|'S'|'P'
 * @param {string} [o.otherText]    for classification 'other': the description
 * @param {string} [o.address]      combined address, OR pass street + cityStateZip
 * @param {string} [o.street] [o.cityStateZip]
 * @param {string} o.ein            EIN (any format)
 * @returns {Promise<Uint8Array>}
 */
async function renderW9(o = {}) {
  if (!o.name) throw new Error('name_required');
  const bytes = fs.readFileSync(TEMPLATE);
  const doc = await PDFDocument.load(bytes);
  const form = doc.getForm();
  const set = (key, val) => { if (val == null || val === '') return; try { form.getTextField(F[key]).setText(String(val)); } catch (e) { /* field absent */ } };
  const check = (fullName) => { try { form.getCheckBox(fullName).check(); } catch (e) {} };

  set('name', o.name);
  set('business', o.businessName);

  const cls = o.classification || 'other';
  if (CB[cls]) check(CB[cls]);
  if (cls === 'llc') set('llcLetter', (o.llcLetter || 'C').toUpperCase());
  if (cls === 'other') set('otherText', o.otherText || '');

  const addr = (o.street || o.cityStateZip) ? { street: o.street || '', cityStateZip: o.cityStateZip || '' } : splitAddress(o.address);
  set('address', addr.street);
  set('cityStateZip', addr.cityStateZip);

  const ein = einDigits(o.ein);
  if (ein.length === 9) { set('ein1', ein.slice(0, 2)); set('ein2', ein.slice(2)); }

  // Leave the form fillable (not flattened) so the signer can add signature +
  // date in Part II; appearances are updated so the values render everywhere.
  try { form.updateFieldAppearances(); } catch (e) {}
  return doc.save();
}

module.exports = { renderW9, splitAddress, einDigits };
