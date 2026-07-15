// ============================================================================
// lib/builder_letter_validate.js  (Ed 2026-07-15)
// ----------------------------------------------------------------------------
// Ed: "WTF claude this is important it is going to client builders and the city
// we have to get this right"
//
// He is right, and the bar was wrong. A builder ARC approval letter is not an
// internal artifact — the builder hands it to a CITY PERMIT OFFICE. Until now
// the only thing standing between a defective application and that letter was
// whether the renderer threw, and it never throws: give it a null plan_name and
// it cheerfully prints a letter with a blank where the plan should be. Six
// approved applications were one click from doing exactly that.
//
// 14250 Emily Bend is the shape of the problem. DRB's own document has the plan
// name garbled on the page ("Soufwork" for "Southfork"), so extraction wrote
// plan_number="UNKNOWN" and plan_name="Soulfork/2380". The master-plan matcher
// is fine — it keys on plan_number + elevation, exactly as it should — but it
// had nothing to match on, so it correctly returned null, and NOTHING NOTICED.
// The letter would have gone to Needville citing no approved plan at all.
//
// So the control cannot be "extract better". Extraction reads what builders
// send, and builders send garbled documents. The control is: A LETTER CANNOT BE
// PRODUCED FROM AN APPLICATION THAT ISN'T SOUND. Refuse, say exactly what's
// wrong, and make a human fix it. That is the only thing that scales past Ed
// reading every letter — and Ed reading every letter is the thing the platform
// exists to end. (project_ed_not_in_loop_test, project_silent_failures.)
//
// This is the gold-standard-validator pattern CLAUDE.md names for catastrophic-
// output surfaces, applied to the builder ARC letter.
// ============================================================================

const UNKNOWN = (v) => {
  const s = String(v == null ? '' : v).trim();
  return !s || s.toUpperCase() === 'UNKNOWN' || s.toUpperCase() === 'N/A' || s === '-';
};
const same = (a, b) => String(a == null ? '' : a).trim().toUpperCase() === String(b == null ? '' : b).trim().toUpperCase();

/**
 * Is this application sound enough to print a letter a city will act on?
 *
 * @param {object} app          the builder_applications row
 * @param {object|null} plan    the linked master_plans row (null if unlinked)
 * @param {boolean} approvedAtCommunity  is `plan` approved at app.community_id (and not retired)
 * @returns {{ ok:boolean, errors:string[], warnings:string[] }}
 *   errors   — MUST block the letter
 *   warnings — worth a human's eye, don't block
 */
function validateApplicationForLetter(app, plan, approvedAtCommunity) {
  const errors = [];
  const warnings = [];
  if (!app) return { ok: false, errors: ['No application.'], warnings };

  // --- Identity of the house. A letter naming the wrong lot is worse than none.
  if (UNKNOWN(app.street_address)) errors.push('No street address on the application.');
  if (UNKNOWN(app.lot_number)) errors.push(`Lot number is ${JSON.stringify(app.lot_number)} — a permit letter has to name the lot.`);
  if (UNKNOWN(app.block_number)) warnings.push('No block number.');
  if (UNKNOWN(app.section_number)) warnings.push('No section number.');

  // --- What was actually approved.
  if (UNKNOWN(app.plan_number)) errors.push(`Plan number is ${JSON.stringify(app.plan_number)} — extraction couldn't read it off the packet. Set it from the submission.`);
  if (UNKNOWN(app.elevation)) errors.push(`Elevation is ${JSON.stringify(app.elevation)} — set it from the submission.`);
  if (UNKNOWN(app.plan_name)) errors.push('Plan name is blank — the letter would print an empty plan.');
  else if (/\//.test(String(app.plan_name))) {
    // "Soulfork/2380" — the number got jammed into the name, which is the
    // fingerprint of the extraction that also produced plan_number="UNKNOWN".
    warnings.push(`Plan name ${JSON.stringify(app.plan_name)} looks like it has the plan number jammed into it — confirm it reads as a name.`);
  }

  // --- The substance of the approval. "Approved as submitted" while specifying
  //     NOTHING is a materially weaker document at a permit office: the letter
  //     exists to say WHAT was approved, so a later color/material substitution
  //     can be held against it. application_data IS the materials record — and
  //     it's easy to clobber, because it's an untyped JSONB blob (I overwrote
  //     8118's with an internal note and the specs table silently vanished from
  //     the letter; the renderer just omits the section). Warn, don't block: a
  //     handful of legitimate older submissions predate the extractor.
  const md = app.application_data || {};
  const rows = md.materials && typeof md.materials === 'object' ? Object.values(md.materials).filter((r) => r && (r.type || r.color)) : [];
  const flats = ['brick_color', 'stone_type', 'siding_color', 'trim_color', 'garage_door_color', 'roof_color'].filter((k) => md[k]);
  if (!rows.length && !flats.length) {
    warnings.push('No materials on file — the letter will print "approved as submitted" with no Approved Specifications table, which approves nothing specific.');
  }

  // --- The link to the pre-approved plan. This is the whole basis of the
  //     approval: we are telling a city this house matches a plan the
  //     association already approved. If that link is missing or points
  //     somewhere else, the letter is asserting something we can't support.
  if (!app.master_plan_id) {
    errors.push('Not linked to an approved master plan — the letter would assert an approval with nothing behind it.');
  } else if (!plan) {
    errors.push('master_plan_id points at a master plan that no longer exists.');
  } else {
    if (!same(plan.plan_number, app.plan_number)) errors.push(`Linked plan MISMATCH: the application says plan ${app.plan_number}, the linked master plan is ${plan.plan_number} ${plan.plan_name}.`);
    if (!same(plan.elevation, app.elevation)) errors.push(`Linked elevation MISMATCH: the application says elevation ${app.elevation}, the linked master plan is elevation ${plan.elevation}.`);
    if (plan.status !== 'approved') errors.push(`The linked master plan's status is "${plan.status}", not approved.`);
    if (approvedAtCommunity === false) errors.push('The linked master plan is not approved at this community (or has been retired here).');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Loads the linked plan + community approval, then validates. */
async function validateApplicationForLetterById(supabase, applicationId) {
  const { data: app, error } = await supabase.from('builder_applications')
    .select('id, reference_number, street_address, lot_number, block_number, section_number, plan_number, plan_name, elevation, status, master_plan_id, community_id, application_data')
    .eq('id', applicationId).maybeSingle();
  if (error) throw error;
  if (!app) return { ok: false, errors: ['Application not found.'], warnings: [], app: null };

  let plan = null;
  let approvedAtCommunity = null;
  if (app.master_plan_id) {
    const { data: p, error: pe } = await supabase.from('master_plans')
      .select('id, plan_number, plan_name, elevation, status').eq('id', app.master_plan_id).maybeSingle();
    if (pe) throw pe;
    plan = p;
    if (p && app.community_id) {
      const { data: a, error: ae } = await supabase.from('master_plan_community_approvals')
        .select('community_id, retired_at').eq('master_plan_id', p.id).eq('community_id', app.community_id).maybeSingle();
      if (ae) throw ae;
      approvedAtCommunity = !!(a && !a.retired_at);
    }
  }
  const r = validateApplicationForLetter(app, plan, approvedAtCommunity);
  return { ...r, app, plan };
}

module.exports = { validateApplicationForLetter, validateApplicationForLetterById };
