// ============================================================================
// lib/ap/vendor_email_guard.js  (Ed 2026-09-28)
// ----------------------------------------------------------------------------
// A Bedrock staff address never belongs on a vendor record. Ed: "celina email is
// not to be used for any vendor."
//
// Scar (Issue #3): a staffer's address sat as the contact_email on four vendor
// records. Every note she sent Emma was tagged as coming from that vendor, and a
// forwarded bill could create a new vendor "from" her. Invoice extraction reads
// whatever address is on the forwarded page, so it's stripped at every vendor
// write, not trusted.
//
// The only vendor allowed a @bedrocktx.com address is Bedrock itself (the
// management company billed as a payee, e.g. info@bedrocktx.com).
// ============================================================================

const STAFF_DOMAIN = /@bedrocktx\.com\s*$/i;
const BEDROCK_SELF = /^bedrock association management/i;

const isStaffEmail = (e) => STAFF_DOMAIN.test(String(e || '').trim());

// The email to store on a vendor: null when it's a staff address (unless the
// vendor IS Bedrock).
function vendorEmailOrNull(email, vendorName = '') {
  const e = String(email || '').trim();
  if (!e) return null;
  if (isStaffEmail(e) && !BEDROCK_SELF.test(String(vendorName || '').trim())) return null;
  return e;
}

// For an edit: which supplied email fields are refused. Returns [] when fine.
const EMAIL_FIELDS = ['email', 'contact_email', 'account_manager_email'];
function refusedStaffEmailFields(update = {}, vendorName = '') {
  return EMAIL_FIELDS.filter((k) => k in update && update[k] && vendorEmailOrNull(update[k], vendorName) === null);
}

// Does this vendor edit touch a staff address in ANY email field? (Cheap check
// before loading the vendor's name for the Bedrock-self exception.)
const touchesStaffEmail = (update = {}) => EMAIL_FIELDS.some((k) => k in update && isStaffEmail(update[k]));

module.exports = { isStaffEmail, vendorEmailOrNull, refusedStaffEmailFields, touchesStaffEmail, EMAIL_FIELDS };
