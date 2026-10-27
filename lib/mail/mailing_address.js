// ============================================================================
// lib/mail/mailing_address.js — the ONE resolver for a homeowner's current
// mailing address (Ed 2026-10-27, migration 549).
// ----------------------------------------------------------------------------
// Every module that puts a homeowner's address on mail (violation / DRV letters
// incl. certified §209, postcards, assessment statements, collections notices,
// homeowner statements) asks this module. One rule, one place:
//
//   1. the contact's mailing address. Staff edit it in Homeowner 360 through
//      set_contact_mailing_address(); an import can never overwrite a staff entry.
//      Since migration 549 the one-line contacts.mailing_address and the
//      structured mailing_* fields always agree (a trigger keeps them in step;
//      the one-line form carries the unit and country). When they agree, the
//      structured fields are used. On an older row where they disagree, the
//      one-line address wins: it is what imports and staff last wrote and what
//      violation letters have always printed.
//   2. else, only when the caller allows it, the property's own address, as a
//      WHOLE block, labelled source 'property_fallback' so the caller can show
//      or count it. Never a mix of mailing street and property city/ZIP.
//
// properties.street_address is the physical lot and is never written from here.
// The resolver is pure: it reads the row it is given (a contacts row, a
// v_current_property_owners row, or the legacy { mailing_address } owner shape).
// ============================================================================

// Columns of v_current_property_owners a caller must select for the resolver
// (append to an existing select list). Only columns that exist before migration
// 549, so a deploy ahead of the migration keeps working.
const OWNER_MAILING_COLUMNS = 'owner_mailing_address, owner_mailing_street, owner_mailing_city, owner_mailing_state, owner_mailing_zip';

const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const isUS = (c) => !clean(c) || /^(US|USA|U\.S\.A?\.?|UNITED STATES( OF AMERICA)?)$/i.test(clean(c));

// Lines from a raw address string. Flat "Street, City, ST ZIP" -> street line(s)
// + a single "City, ST ZIP" line; an already multi-line string is trusted as-is.
function addressLinesFromString(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return [];
  if (/\n/.test(s)) return s.split('\n').map((t) => t.trim()).filter(Boolean);
  const parts = s.split(',').map((t) => t.trim()).filter(Boolean);
  if (parts.length >= 3) return [...parts.slice(0, -2), parts.slice(-2).join(', ')];
  return parts;
}

// The block for structured fields. Same text as SQL mailing_address_compose().
function composeLines({ street, unit, city, state, zip, country }) {
  const line1 = [clean(street), clean(unit)].filter(Boolean).join(' ');
  if (!line1) return [];
  if (isUS(country)) {
    const stZip = [clean(state), clean(zip)].filter(Boolean).join(' ');
    const last = [clean(city), stZip].filter(Boolean).join(', ');
    return [line1, last].filter(Boolean);
  }
  const last = [clean(city), clean(state), clean(zip)].filter(Boolean).join(' ');
  return [line1, last, clean(country).toUpperCase()].filter(Boolean);
}
function composeText(a) {
  const lines = composeLines(a);
  if (!lines.length) return '';
  return isUS(a.country) ? lines.join(', ') : lines.join('\n');
}

// Same address, ignoring case, spacing and comma spacing.
const norm = (s) => String(s || '').toLowerCase().replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ').trim();
const sameAddress = (a, b) => norm(a) === norm(b);

// "Street[, more], City, ST ZIP" or "Street, City ST ZIP" -> parts; null otherwise.
// Same rule as the migration 549 trigger.
function parseUSLine(text) {
  const s = String(text || '').trim();
  if (!s || /\n/.test(s)) return null;
  const parts = s.split(',').map((t) => t.trim()).filter(Boolean);
  const n = parts.length;
  let m;
  if (n >= 3 && (m = /^([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/.exec(parts[n - 1]))) {
    return { street: parts.slice(0, n - 2).join(', '), city: parts[n - 2], state: m[1].toUpperCase(), zip: m[2] };
  }
  if (n >= 2 && (m = /^(.+?)\s+([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/.exec(parts[n - 1]))) {
    return { street: parts.slice(0, n - 1).join(', '), city: m[1], state: m[2].toUpperCase(), zip: m[3] };
  }
  return null;
}

// Pull the mailing fields from whichever row shape we were handed.
function fieldsOf(row) {
  const r = row || {};
  const pick = (k) => (r[`owner_mailing_${k}`] !== undefined ? r[`owner_mailing_${k}`] : r[`mailing_${k}`]);
  return {
    street: pick('street'), unit: pick('unit'), city: pick('city'), state: pick('state'), zip: pick('zip'), country: pick('country'),
    text: r.owner_mailing_address !== undefined ? r.owner_mailing_address : r.mailing_address,
    source: r.owner_mailing_source !== undefined ? r.owner_mailing_source : r.mailing_address_source,
  };
}

/**
 * The current mailing address for one recipient.
 * @param {object} row       contacts row, v_current_property_owners row, or { mailing_address }
 * @param {object} [property] { street_address, unit, city, state, zip } for the fallback
 * @param {object} [opts]    { allowPropertyFallback = true }
 * @returns {{ source: 'contact'|'contact_text'|'property_fallback'|'none', staff_entered: boolean,
 *             street, unit, city, state, zip, country, lines: string[], text: string, complete: boolean }}
 */
function mailingAddressOf(row, property, { allowPropertyFallback = true } = {}) {
  const f = fieldsOf(row);
  // A legacy caller may hand a pre-resolved object as owner.mailing_address.
  if (f.text && typeof f.text === 'object') {
    const o = f.text;
    return mailingAddressOf({ mailing_street: o.street || o.line1 || o.address, mailing_unit: o.unit, mailing_city: o.city, mailing_state: o.state, mailing_zip: o.zip, mailing_country: o.country }, property, { allowPropertyFallback });
  }
  const staff = f.source === 'staff';
  const text = f.text == null ? '' : String(f.text).trim();
  const structured = clean(f.street)
    ? { street: clean(f.street), unit: clean(f.unit) || null, city: clean(f.city) || null, state: clean(f.state) || null, zip: clean(f.zip) || null, country: isUS(f.country) ? 'US' : clean(f.country).toUpperCase() }
    : null;
  if (structured && (!text || sameAddress(text, composeText(structured)))) {
    const a = structured;
    return { source: 'contact', staff_entered: staff, ...a, lines: composeLines(a), text: composeText(a), complete: !!(a.city && (a.country !== 'US' || (a.state && a.zip))) };
  }
  if (text) {
    const lines = addressLinesFromString(text);
    const p = parseUSLine(text);
    return { source: 'contact_text', staff_entered: staff, street: p ? p.street : (lines[0] || null), unit: null,
      city: p ? p.city : null, state: p ? p.state : null, zip: p ? p.zip : null, country: p ? 'US' : null,
      lines, text, complete: !!p || /\n/.test(text) };
  }
  const p = property || {};
  if (allowPropertyFallback && clean(p.street_address)) {
    const a = { street: clean(p.street_address), unit: clean(p.unit) ? `#${clean(p.unit).replace(/^#/, '')}` : null, city: clean(p.city) || null, state: clean(p.state) || 'TX', zip: clean(p.zip) || null, country: 'US' };
    const lines = composeLines(a);
    return { source: 'property_fallback', staff_entered: false, ...a, lines, text: composeText(a), complete: !!(a.city && a.zip) };
  }
  return { source: 'none', staff_entered: false, street: null, unit: null, city: null, state: null, zip: null, country: null, lines: [], text: '', complete: false };
}

// Statement-style addressee { name, street, cityline } (assessment statements,
// collections notices). The whole block comes from one source.
function addresseeOf(row, property, name) {
  const m = mailingAddressOf(row, property);
  return { name: name || 'Property Owner', street: m.lines.slice(0, -1).join('\n') || m.lines[0] || '', cityline: m.lines.length > 1 ? m.lines[m.lines.length - 1] : '', source: m.source };
}

module.exports = { mailingAddressOf, addresseeOf, addressLinesFromString, composeLines, composeText, parseUSLine, OWNER_MAILING_COLUMNS };
