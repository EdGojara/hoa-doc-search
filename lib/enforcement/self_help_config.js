// ============================================================================
// lib/enforcement/self_help_config.js  (Ed 2026-10-06)
// ----------------------------------------------------------------------------
// Can this community send a 10-day self-help notice (force-mow / cleanup /
// tree)? Those letters assert the association's right to enter the lot and do
// the work at the owner's cost, so they cite a specific Declaration section and
// its recording (document number + county). Without that on the community
// profile the letter cannot be rendered, and it must not be.
//
// Scar (Quail Ridge, 520 Shady Dale, 2026-10-06): staff opened a "Lawn -
// 10-Day Certified Force Mow" case by manual entry. The case saved and the
// response said ok, but the letter draft (which runs after the response) hit the
// missing self-help config and returned an error that only reached the server
// log. Result: an open case showing a photo and "opened today", with no letter,
// nothing in Drafts, and no message to staff. Checking BEFORE the case is
// created turns that silent strand into a clear refusal.
//
// The ONE definition of what each remedy needs, so the pre-check and the
// letter renderer cannot disagree.
// ============================================================================

const SELF_HELP_REMEDY = { lawn_force_mow_10day: 'lawn', trash_cleanup_10day: 'cleanup', tree_hazard_10day: 'tree' };

const SELECT = 'name, legal_name, declaration_short_name, declaration_doc_number, declaration_county, force_mow_section_full, cleanup_section_full, force_mow_admin_fee_cents';

/** 'lawn' | 'cleanup' | 'tree' for a self-help category slug, else null. */
function remedyFor(slug) { return SELF_HELP_REMEDY[slug] || null; }

/** The authorizing-section field a remedy cites. Tree uses the lot-maintenance (force-mow) section. */
function sectionField(remedy) { return remedy === 'cleanup' ? 'cleanup_section_full' : 'force_mow_section_full'; }

/** Fields missing from a community row for this remedy ([] = ready). */
function missingFields(community, remedy) {
  const c = community || {};
  return [sectionField(remedy), 'declaration_doc_number', 'declaration_county'].filter((f) => !String(c[f] || '').trim());
}

const LABEL = {
  force_mow_section_full: 'the Declaration section authorizing lawn force-mow / lot maintenance',
  cleanup_section_full: 'the Declaration section authorizing trash/debris cleanup',
  declaration_doc_number: 'the Declaration recording number',
  declaration_county: 'the recording county',
};

/** Staff-facing explanation of what is missing, or null when ready. */
function explainMissing(communityName, categoryLabel, missing) {
  if (!missing.length) return null;
  return `${communityName || 'This community'} has no self-help authority on file, so a "${categoryLabel || '10-day self-help'}" notice can't be issued. `
    + `Missing on the Community Profile: ${missing.map((f) => LABEL[f] || f).join('; ')}. `
    + 'Confirm the governing documents give the association a right to enter and do the work, record it on the Community Profile, then file again. '
    + 'If they don\'t, file the regular (courtesy / §209) category for this issue instead.';
}

module.exports = { SELF_HELP_REMEDY, SELECT, remedyFor, sectionField, missingFields, explainMissing };
