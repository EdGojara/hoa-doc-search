// ============================================================================
// lib/community/fastlane_coverage.js  (Ed 2026-09-10)
// ----------------------------------------------------------------------------
// One source of truth for "does Claire have the operational facts she answers
// fast (trash, hours, amenity hours, contact, assessment, meeting dates) for
// this community?" Used by BOTH the CLI audit (scripts/audit_fastlane_facts.js)
// and the Community Profile page's live "Claire readiness" panel, so the two
// never disagree.
//
// Runs against the built context block (what Claire actually sees) plus the
// community profile (for applicability: no pool -> pool hours is N/A, not a gap;
// not on-site and no office hours -> hours is N/A).
// ============================================================================

// A stable, ordered list so the UI and CLI show the same rows.
const FACTS = [
  { key: 'trash',      label: 'Trash / recycling day' },
  { key: 'hours',      label: 'Office / on-site hours' },
  { key: 'amenityHrs', label: 'Pool / amenity hours' },
  { key: 'phone',      label: 'Management phone' },
  { key: 'email',      label: 'Management email' },
  { key: 'assessment', label: 'Assessment amount' },
  { key: 'meeting',    label: 'Meeting date' },
];

// Detectors run against the built context block (what Claire sees).
const DET = {
  trash:      (b) => /TRASH & RECYCLING|\btrash\b|recycl/i.test(b),
  hours:      (b) => /(office|onsite|business)\s*hours?[^\n]*(\d|am|pm)/i.test(b),
  amenityHrs: (b) => /(pool|clubhouse|gate|gym|tennis|splash)[^\n]*(\d\s?(am|pm)|\bhours?\b|open|close)/i.test(b),
  phone:      (b) => /\(\d{3}\)\s?\d{3}[-.\s]?\d{4}|\b\d{3}[-.]\d{3}[-.]\d{4}\b/.test(b),
  email:      (b) => /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(b),
  assessment: (b) => /assessment[^\n]*(\$?\s?\d{2,}|annual|monthly|quarterly|semi)/i.test(b),
  meeting:    (b) => /(annual|board)[^\n]*meeting|meeting[^\n]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4}|\d{1,2}\/\d)/i.test(b),
};

// Applicability: which facts even apply to this community?
// - amenityHrs applies only with a pool or a listed amenity.
// - hours applies only if there is an on-site office (onsite === yes) OR office
//   hours are set; otherwise there is no "office" to give hours for.
// Everything else (trash, phone, email, assessment, meeting) applies to every HOA.
function applicability(profile) {
  const p = profile || {};
  const hasPool = p.has_pool === true;
  const amenities = Array.isArray(p.amenities) ? p.amenities : [];
  const onsite = String(p.onsite || '').toLowerCase() === 'yes';
  const hasMgmtHours = !!(p.office_hours || p.onsite_hours);
  return {
    trash: true,
    hours: onsite || hasMgmtHours,
    amenityHrs: hasPool || amenities.length > 0,
    phone: true,
    email: true,
    assessment: true,
    meeting: true,
  };
}

/**
 * Per-fact status for a community.
 * @param {string} block   the built context block (buildCommunityContextBlock)
 * @param {object} profile the community's profile JSONB (for applicability)
 * @returns {{key,label,status}[]}  status ∈ 'yes' | 'gap' | 'na'
 */
function computeCoverage(block, profile) {
  const app = applicability(profile);
  const b = String(block || '');
  const p = profile || {};
  return FACTS.map(({ key, label }) => {
    if (!app[key]) return { key, label, status: 'na' };
    let present = DET[key](b);
    // The Annual/board meeting fact is entered as a free-text profile field
    // (meeting_schedule). Treat a filled field as covered even if its wording
    // doesn't trip the text detector — the field is authoritative. (Ed 2026-09-10)
    if (key === 'meeting' && String(p.meeting_schedule || '').trim()) present = true;
    return { key, label, status: present ? 'yes' : 'gap' };
  });
}

module.exports = { FACTS, DET, applicability, computeCoverage };
