// ============================================================================
// lib/welcome/sections.js — the canonical list of welcome-packet sections.
// ----------------------------------------------------------------------------
// One list. The assembler builds from it, the renderer prints from it, the
// readiness panel reports against it, and welcome_packets.sections_included /
// sections_missing store its keys. Adding a section here is the only edit
// needed for it to appear in all four places.
//
// ORDER IS THE MESSAGE. Value-first (Ed 2026-08-24): a world-class welcome
// leads with what the association GIVES a new owner — their team, their
// community, the AI assistant, the portal — and defers what it ASKS of them —
// assessments, architectural rules, what gets enforced — to a clearly marked
// "A few things worth knowing" run at the end.
//
// This list is the ONE source of section order. The renderer iterates it to
// order the printed blocks and to place the "A few things worth knowing"
// divider at the first `part:'knowing'` section, so render order and readiness
// order cannot drift apart. `part` values in render order: welcome, team,
// community, knowing.
//
// Each entry carries `fix` — where an operator goes to supply the data when a
// section comes back empty. A readiness check that says "missing" without
// saying "and here is where you fill it in" just relocates the problem.
// ============================================================================

const SECTIONS = Object.freeze([
  {
    key: 'welcome',
    title: 'Welcome',
    part: 'welcome',
    // Always prints: the community name, the lot, and the owner. The one
    // section that cannot be missing, because it is the address block.
    required: true,
    fix: null,
  },
  {
    key: 'manager',
    title: 'Your team',
    part: 'team',
    required: true,
    fix: 'Community Profile — set the on-site contact and hours (/admin/communities).',
  },
  {
    key: 'claire',
    title: 'Just ask Claire',
    part: 'team',
    // The differentiator, and free to print (text, not the embodied video).
    // Only prints where Claire is actually live for the community, so it is a
    // promise we keep, never a marketing line for a tile that is off.
    required: false,
    fix: 'Portal Admin — enable the Claire tile for this community.',
  },
  {
    key: 'amenities',
    title: 'Amenities',
    part: 'community',
    required: false,
    fix: 'Amenities Admin — add the pool, clubhouse, parks (/admin/amenities).',
  },
  {
    key: 'contacts',
    title: 'Numbers worth keeping',
    part: 'community',
    required: false,
    fix: 'Community Contacts — add utilities, emergency, TV/internet (/admin/community-contacts).',
  },
  {
    key: 'portal',
    title: 'Get started online',
    part: 'community',
    required: false,
    fix: 'Portal Admin — turn the portal on for this community, then invite the owner.',
  },
  {
    key: 'assessments',
    title: 'Your assessments',
    part: 'knowing',
    required: false,
    fix: 'Community Profile — assessment_annual and assessment_frequency.',
  },
  {
    key: 'arc',
    title: 'Before you change anything outside',
    part: 'knowing',
    required: false,
    fix: 'Nothing to set. This prints whenever architectural review is active.',
  },
  {
    key: 'trash',
    title: 'Trash and recycling',
    part: 'knowing',
    required: false,
    fix: 'Community Contacts — set the trash schedule (/admin/community-contacts).',
  },
  {
    key: 'compliance',
    title: 'What gets noticed here',
    part: 'knowing',
    required: false,
    fix: 'Needs at least one violation opened in the last 12 months for this community.',
  },
  {
    key: 'documents',
    title: 'Your governing documents',
    part: 'knowing',
    required: false,
    fix: 'Document Library — upload the Declaration, Bylaws, and Rules for this community.',
  },
]);

const SECTION_BY_KEY = Object.freeze(Object.fromEntries(SECTIONS.map((s) => [s.key, s])));
const SECTION_KEYS = Object.freeze(SECTIONS.map((s) => s.key));

module.exports = { SECTIONS, SECTION_BY_KEY, SECTION_KEYS };
