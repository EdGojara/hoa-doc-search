// ============================================================================
// lib/payments/remit_address.js  (Ed 2026-11-20)
// ----------------------------------------------------------------------------
// WHERE A HOMEOWNER MAILS AN ASSESSMENT CHECK. One answer for the printed
// assessment statement and the homeowner portal's "mail a check" line, so the
// two can never disagree again (the portal had the old office hard-coded).
//
//   1. The association's own pay-to instructions (communities.letter_pay_to_name
//      / letter_pay_to_address: a lockbox or PO Box), exactly as entered.
//   2. Otherwise, the association c/o Bedrock at Bedrock's office
//      (lib/brand.js BRAND.service, the single source of the office address).
// ============================================================================
const BRAND = require('../brand');

function remitTo(comm = {}, assocName = null, { mgmtName = BRAND.service.name } = {}) {
  const name = (comm && comm.letter_pay_to_name) || assocName || (comm && (comm.hoa_legal_name || comm.legal_name || comm.name)) || 'Your association';
  const own = comm && String(comm.letter_pay_to_address || '').trim();
  const block = own || [name, `c/o ${mgmtName}`, BRAND.service.address, BRAND.service.addressCityStateZip].join('\n');
  return { name, block, association_specific: !!own };
}

module.exports = { remitTo };
