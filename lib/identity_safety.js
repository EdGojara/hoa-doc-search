// ============================================================================
// lib/identity_safety.js  (Issue #15) — hard boundary around legacy identity writes
// ----------------------------------------------------------------------------
// The onboarding audit found production paths that infer identity and
// relationships the source never established: global name-based contact reuse,
// mailing addresses used as property addresses, owner-occupancy guessed from
// mailing addresses, one account's emails / phones fanned onto one contact,
// thread participants written onto a homeowner, destructive residency
// replacement, invented start dates. Until the new community-data model
// (lib/onboarding/community/) replaces them, those paths FAIL CLOSED here with a
// clear message instead of silently writing. Read paths and previews are not
// touched. Re-enabling a path is a code change reviewed on #15, not a setting.
// ============================================================================
const PAUSED = Object.freeze({
  vantaca_contacts_apply: {
    what: 'Applying a Vantaca contacts import',
    why: 'it reuses contacts by name across communities, maps mailing columns into property addresses, dates ownerships and residencies with the import date, and replaces open residencies with guessed ones',
    still_works: 'uploading and previewing the import (the diff); editing a contact or property by hand',
  },
  infer_residency: {
    what: 'Inferring owner-occupied / renter from mailing addresses',
    why: 'a mailing address does not establish who lives in a home; occupancy now comes only from lease or owner-statement evidence',
    still_works: 'adding a renter or a residency by hand with what you actually know',
  },
  contact_methods_import_apply: {
    what: 'Applying a bulk email / phone import',
    why: 'it sends every email and phone on an account to one contact (co-owners, spouses and tenants on the account collapse onto one person) and does not check the name on the file',
    still_works: 'previewing the import; adding an email or phone to a contact by hand',
  },
  roster_import_apply: {
    what: 'Applying a roster import',
    why: 'it writes one contact per account (a person with several homes is overwritten row by row), copies the property address into a blank mailing address, and overwrites names, emails and mailing addresses in place',
    still_works: 'previewing the roster; editing a contact by hand',
  },
  mailing_delta_apply: {
    what: 'Applying mailing-address changes from a roster',
    why: 'it overwrites the mailing address of the account\'s one primary contact and infers transfers from mailing addresses',
    still_works: 'previewing the changes; editing a mailing address by hand',
  },
  clean_redundant_mailings: {
    what: 'Clearing "redundant" mailing addresses',
    why: 'it erases mailing addresses by a fuzzy comparison with the property street',
    still_works: 'editing a mailing address by hand',
  },
});

function pausedBody(key) {
  const p = PAUSED[key];
  if (!p) throw new Error(`unknown paused path ${key}`);
  return { error: `${p.what} is paused while the community-data onboarding model is built (Issue #15): ${p.why}. Still available: ${p.still_works}.`, code: 'PAUSED_IDENTITY_SAFETY', paused: key };
}
// Express helper: answer 423 and write nothing.
function refusePaused(res, key) {
  console.warn('[identity-safety] refused paused path', { path: key });
  return res.status(423).json(pausedBody(key));
}

// May an inbound message's sender details be written onto a contact automatically?
// Only when the contact was identified by the sender's EXACT email already on file
// (so the person is known by a durable identifier, not by a name).
function mayEnrichFromMessage(res) {
  return !!(res && res.contact_id && res.contact_basis === 'email');
}

module.exports = { PAUSED, pausedBody, refusePaused, mayEnrichFromMessage };
