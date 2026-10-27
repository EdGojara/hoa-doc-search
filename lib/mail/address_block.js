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
// WHICH address a homeowner gets is decided in lib/mail/mailing_address.js
// (migration 549); this file only lays it out.
// ============================================================================
const { mailingAddressOf, addressLinesFromString } = require('./mailing_address');

// Homeowner recipient block: the current mailing address from the one resolver
// (structured contact address, else the contact's one-line address, else the
// property's own address as a whole block).
//   owner: contacts row, v_current_property_owners row, or { mailing_address }
//   property: { street_address, unit, city, state, zip }
function formatMailingLines(owner, property) {
  return mailingAddressOf(owner, property).lines;
}

module.exports = { formatMailingLines, addressLinesFromString };
