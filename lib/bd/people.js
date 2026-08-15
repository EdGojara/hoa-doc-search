// =============================================================================
// lib/bd/people.js — Business Development card roster (single source of truth)
// =============================================================================
//
// WHY THIS IS A FILE AND NOT A TABLE
// ----------------------------------
// This is the Bedrock staff roster for outward-facing digital business cards.
// It is a handful of rows, it changes when someone is hired or a phone number
// changes (a few times a year), and it carries zero homeowner or community
// data. A migration + admin CRUD screen would be more machinery than the fact
// deserves, and it would put a DB round-trip in front of a page whose entire
// job is to load instantly on a stranger's phone at a conference.
//
// It is still a SINGLE source of truth: every surface that renders a card
// (api/bd.js, public/card.html, the BD tab in index.html) reads from HERE.
// Do not re-type a phone number anywhere else. If this grows past ~20 people
// or non-engineers need to edit it, promote it to a table then — the shape
// below is already table-ready.
//
// RECORD OWNERSHIP: `workpaper` (Bedrock staff contact info, Bedrock IP).
// Not an association record; nothing here exports on HOA termination.
//
// =============================================================================

// -----------------------------------------------------------------------------
// Roster. `slug` is the public URL segment (/c/<slug>) — treat it as permanent
// once a card has been shown to anyone; changing it breaks every QR already
// scanned into someone's phone and every card already handed out.
// -----------------------------------------------------------------------------
const PEOPLE = Object.freeze([
  Object.freeze({
    slug: 'ed',
    active: true,
    first: 'Ed',
    last: 'Gojara',
    // Suffix shown after the name (vCard N: suffix field + display name).
    // Deliberately empty. Ed holds a CPA but Bedrock does not perform CPA work
    // for these clients, so putting the credential on a card handed to HOA
    // boards implies a service relationship that does not exist. Leave it off.
    credentials: '',
    title: 'President',
    org: 'Bedrock Association Management, LLC',
    // Trade name without the ", LLC" — this is what goes in the vCard ORG.
    // See the comma note in buildVCard: escaping is spec-correct but its
    // failure mode is a literal backslash sitting in a prospect's phone, and
    // the legal suffix buys nothing in a contact list.
    orgShort: 'Bedrock Association Management',
    // Second-line affiliation — the technology arm. Shown on the card as a
    // secondary role; goes into the vCard NOTE so it survives into the phone.
    orgSecondary: 'Bedrock Intelligence',
    titleSecondary: 'Founder',
    email: 'egojara@bedrocktx.com',
    // Store raw digits; formatting for display and E.164 for tel: links are
    // both derived (see format helpers below). One fact, one place.
    // Three distinct lines, and the labels are NOT interchangeable — a prospect
    // calling the wrong one is exactly the small failure that reads as sloppy.
    phoneCell: '8325416149',
    phoneDirect: '3464401422',
    phoneOffice: '8325882485',
    // Street and suite are separate because vCard ADR has a distinct
    // "extended address" field for the suite. Jamming them together with a
    // comma is both structurally wrong and needless escaping.
    street: '12808 W Airport Blvd',
    suite: 'Ste 253',
    city: 'Sugar Land',
    state: 'TX',
    zip: '77478',
    country: 'USA',
    websites: Object.freeze([
      Object.freeze({ label: 'bedrocktx.com', url: 'https://bedrocktx.com' }),
      Object.freeze({ label: 'bedrocktxai.com', url: 'https://bedrocktxai.com' }),
    ]),
    // One line, plain English, no jargon. This is what a board member reads
    // three weeks after the conference when they're deciding who to call.
    blurb:
      'Houston-area HOA management, run on our own software. Full-service '
      + 'management and back-office support for self-managed associations.',
    // Short form for the vCard NOTE. Kept comma-free and em-dash-free: this is
    // customer-facing copy that lands in a stranger's contact list.
    blurbShort:
      'Houston-area HOA management run on our own software. Full-service '
      + 'management and back-office support for self-managed associations.',
  }),
]);

// -----------------------------------------------------------------------------
// Lookup
// -----------------------------------------------------------------------------
function listPeople({ includeInactive = false } = {}) {
  return PEOPLE.filter((p) => includeInactive || p.active !== false);
}

function getPerson(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const key = slug.trim().toLowerCase();
  return PEOPLE.find((p) => p.slug === key && p.active !== false) || null;
}

// -----------------------------------------------------------------------------
// Derived formatting — the only place raw digits become display/link strings.
// -----------------------------------------------------------------------------
function formatPhone(raw) {
  if (!raw) return '';
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === '1') {
    return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  }
  return raw;
}

function telHref(raw) {
  if (!raw) return '';
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === '1') return `+${d}`;
  return `+${d}`;
}

function fullName(p) {
  return [p.first, p.last].filter(Boolean).join(' ');
}

// One-line postal address for display and for the maps deep link.
function streetCityLine(p) {
  const street = [p.street, p.suite].filter(Boolean).join(', ');
  return `${street}, ${p.city}, ${p.state} ${p.zip}`;
}

function displayName(p) {
  const base = fullName(p);
  return p.credentials ? `${base}, ${p.credentials}` : base;
}

// -----------------------------------------------------------------------------
// vCard 3.0 serialization
// -----------------------------------------------------------------------------
// Version 3.0 (not 4.0) deliberately: 3.0 is what iOS Contacts, Android, and
// Outlook all import without complaint. 4.0 is newer and better specified and
// is exactly the kind of "more correct" choice that silently fails to import
// on somebody's five-year-old Android in a hotel ballroom.
//
// Two variants:
//   full — everything, served as the .vcf download.
//   scan — what gets encoded INTO a QR code. Deliberately trimmed to name,
//          company, title, phones and email.
//
// The trimming is not cosmetic. QR density is set by payload length, and scan
// reliability is set by how many screen pixels each module gets. Measured on
// the rendered images: at 233 characters the code is version 11 / 69 modules
// and reads under blur, glare, 40 degrees of rotation and a capture as small
// as 300px wide. Adding the postal address and both URLs pushed it to version
// 15 / 85 modules, and the smaller surfaces started failing.
//
// So the address, the second website and the NOTE stay out. The website is
// printed as text on every card surface anyway, which means encoding it spends
// scan margin on information the prospect is already looking at. Everything
// dropped here is still in the full .vcf.
//
// If you add a field to the scan variant, re-run tests/test_bd_card.js — it
// fails the build if the payload grows past what the QR can carry at that size.
// -----------------------------------------------------------------------------

// vCard escaping per RFC 2426 §4: backslash, comma, semicolon, newline.
function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function buildVCard(p, { scan = false } = {}) {
  // The scan variant is byte-for-byte the payload that was measured and
  // verified against the rendered images. Keep it explicit and separate rather
  // than as a pile of conditionals inside the full builder, so it cannot drift
  // when someone adds a field to the full card.
  if (scan) {
    const l = ['BEGIN:VCARD', 'VERSION:3.0'];
    l.push(`N:${esc(p.last)};${esc(p.first)};;;${esc(p.credentials || '')}`);
    l.push(`FN:${esc(fullName(p))}`);
    if (p.orgShort || p.org) l.push(`ORG:${esc(p.orgShort || p.org)}`);
    if (p.title) l.push(`TITLE:${esc(p.title)}`);
    if (p.phoneCell) l.push(`TEL;TYPE=CELL:${telHref(p.phoneCell)}`);
    if (p.phoneDirect) l.push(`TEL;TYPE=WORK:${telHref(p.phoneDirect)}`);
    if (p.phoneOffice) l.push(`TEL;TYPE=WORK:${telHref(p.phoneOffice)}`);
    if (p.email) l.push(`EMAIL:${esc(p.email)}`);
    l.push('END:VCARD');
    return `${l.join('\r\n')}\r\n`;
  }

  const lines = [];
  lines.push('BEGIN:VCARD');
  lines.push('VERSION:3.0');
  // N: Family;Given;Additional;Prefix;Suffix — credentials go in the SUFFIX
  // field, which is where they structurally belong. Every mainstream importer
  // reads N, so "CPA" survives without needing a comma anywhere.
  lines.push(`N:${esc(p.last)};${esc(p.first)};;;${esc(p.credentials || '')}`);
  // FN deliberately WITHOUT the ", CPA" comma. RFC 2426 requires escaping a
  // comma in a text value, and compliant importers unescape it — but the
  // failure mode when one doesn't is a literal backslash sitting in the middle
  // of a prospect's contact list, on the single most visible field there is.
  // The credential is already carried in N above and shown on the card page.
  lines.push(`FN:${esc(fullName(p))}`);
  if (p.orgShort || p.org) lines.push(`ORG:${esc(p.orgShort || p.org)}`);
  if (p.title) lines.push(`TITLE:${esc(p.title)}`);
  // Order matters: most phones surface the first TEL as the default call
  // target, and the cell is the one he wants a prospect to reach him on.
  if (p.phoneCell) {
    lines.push(`TEL;TYPE=CELL,VOICE:${telHref(p.phoneCell)}`);
  }
  if (p.phoneDirect) {
    lines.push(`TEL;TYPE=WORK,VOICE:${telHref(p.phoneDirect)}`);
  }
  if (p.phoneOffice) {
    lines.push(`TEL;TYPE=WORK,VOICE:${telHref(p.phoneOffice)}`);
  }
  if (p.email) lines.push(`EMAIL;TYPE=INTERNET,WORK:${esc(p.email)}`);
  if (p.street) {
    // ADR: PO;Extended;Street;Locality;Region;PostalCode;Country
    // Suite goes in Extended, not appended to Street with a comma.
    lines.push(
      `ADR;TYPE=WORK:;${esc(p.suite || '')};${esc(p.street)};${esc(p.city)};`
      + `${esc(p.state)};${esc(p.zip)};${esc(p.country || 'USA')}`,
    );
  }
  (p.websites || []).forEach((w) => lines.push(`URL:${esc(w.url)}`));

  // NOTE is the one field where free-text escaping is unavoidable. Keep it
  // comma-light and em-dash-free; a period reads the same and travels safer.
  const note = [];
  if (p.titleSecondary && p.orgSecondary) {
    note.push(`${p.titleSecondary} of ${p.orgSecondary}.`);
  }
  if (p.blurbShort || p.blurb) note.push(p.blurbShort || p.blurb);
  if (note.length) lines.push(`NOTE:${esc(note.join(' '))}`);

  lines.push('END:VCARD');
  // CRLF is required by the spec; some Android importers reject bare LF.
  return `${lines.join('\r\n')}\r\n`;
}

// Public shape for the browser — never ship the raw object, so adding an
// internal-only field to PEOPLE later can't accidentally leak to a stranger's
// phone. Explicit allowlist, same discipline as PATCH allowedFields.
function publicPerson(p, { baseUrl = '' } = {}) {
  return {
    slug: p.slug,
    first: p.first,
    last: p.last,
    name: fullName(p),
    displayName: displayName(p),
    credentials: p.credentials || null,
    title: p.title || null,
    org: p.org || null,
    // Trade name for display surfaces. The legal "…, LLC" belongs on a
    // contract, not across the front of a card.
    orgShort: p.orgShort || p.org || null,
    titleSecondary: p.titleSecondary || null,
    orgSecondary: p.orgSecondary || null,
    email: p.email || null,
    phoneCell: p.phoneCell ? formatPhone(p.phoneCell) : null,
    phoneCellHref: p.phoneCell ? telHref(p.phoneCell) : null,
    phoneDirect: p.phoneDirect ? formatPhone(p.phoneDirect) : null,
    phoneDirectHref: p.phoneDirect ? telHref(p.phoneDirect) : null,
    phoneOffice: p.phoneOffice ? formatPhone(p.phoneOffice) : null,
    phoneOfficeHref: p.phoneOffice ? telHref(p.phoneOffice) : null,
    addressLine1: p.street
      ? [p.street, p.suite].filter(Boolean).join(', ')
      : null,
    addressLine2: p.city ? `${p.city}, ${p.state} ${p.zip}` : null,
    addressInline: p.street ? streetCityLine(p) : null,
    mapsUrl: p.street
      ? `https://maps.google.com/?q=${encodeURIComponent(streetCityLine(p))}`
      : null,
    websites: (p.websites || []).map((w) => ({ label: w.label, url: w.url })),
    blurb: p.blurb || null,
    cardUrl: `${baseUrl}/card/${p.slug}`,
    vcfUrl: `${baseUrl}/api/bd/${p.slug}/card.vcf`,
    qrUrl: `${baseUrl}/api/bd/${p.slug}/qr.svg`,
    qrVcardUrl: `${baseUrl}/api/bd/${p.slug}/qr.svg?mode=vcard`,
  };
}

module.exports = {
  PEOPLE,
  listPeople,
  getPerson,
  getPersonBySlug: getPerson,
  buildVCard,
  publicPerson,
  formatPhone,
  telHref,
  fullName,
  displayName,
};
