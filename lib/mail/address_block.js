// ============================================================================
// lib/mail/address_block.js — ONE postal address formatter for every mailed
// artifact (violation letters, postcards, builder/ARC letters, etc.).
// ----------------------------------------------------------------------------
// The whole point: the final line is "City, ST ZIP" on ONE line, USPS-standard,
// so the block folds into a #10 window envelope. The recurring bug this kills:
// renderers that split a stored address on EVERY comma (e.g. /,(?=\s)/ or
// /\s*,\s*/), which tears "Richmond, TX 77407" onto two lines.
//
// Every letter renderer must import from here — do NOT hand-roll an address
// split in a renderer again (that's how this bug spread across ~4 files).
// ============================================================================

// Lines from a raw address string. Flat "Street, City, ST ZIP" → street line(s)
// + a single "City, ST ZIP" line (the state+zip token has no comma, so the last
// two comma-separated tokens are city + "ST ZIP"). An already-multi-line string
// is trusted as-is.
function addressLinesFromString(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return [];
  if (/\n/.test(s)) return s.split('\n').map((t) => t.trim()).filter(Boolean);
  const parts = s.split(',').map((t) => t.trim()).filter(Boolean);
  if (parts.length >= 3) return [...parts.slice(0, -2), parts.slice(-2).join(', ')];
  return parts; // 1–2 tokens — leave as-is
}

// Homeowner recipient block: prefer the explicit mailing address; else build a
// clean block from the property's street + city/state/zip fields.
//   owner: { mailing_address }   property: { street_address, unit, city, state, zip }
function formatMailingLines(owner, property) {
  const raw = (owner && owner.mailing_address) ? String(owner.mailing_address).trim() : '';
  if (raw) return addressLinesFromString(raw);
  const p = property || {};
  const streetLine = `${p.street_address || ''}${p.unit ? ' #' + p.unit : ''}`.trim();
  const cityStateZip = `${p.city || ''}, ${p.state || 'TX'} ${p.zip || ''}`
    .replace(/^,\s*/, '').replace(/\s+/g, ' ').trim();
  return [streetLine, cityStateZip].filter(Boolean);
}

module.exports = { formatMailingLines, addressLinesFromString };
