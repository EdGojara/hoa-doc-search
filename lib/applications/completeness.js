// ============================================================================
// lib/applications/completeness.js — service-type-specific completeness rules
// ----------------------------------------------------------------------------
// Ed 2026-06-09 — Fast synchronous "did the homeowner give us everything we
// need?" check. Runs at submission time and is surfaced to the HOMEOWNER —
// distinct from the deeper multi-persona assessment which stays internal.
//
// DESIGN:
//   - Rules are per service_type (paint / fence / roof / addition / etc.)
//   - Each rule is a simple structural check (form field present? min number
//     of photos? contractor info if applicable?)
//   - Result returns: { passed, issues[], message }
//     - issues[] is structured for staff dashboards
//     - message is human-friendly for the homeowner email
//
// PHASE 2 enhancement (later): wire an LLM call to ALSO check photo quality
// (in-focus? shows project area? not just owner's living room?). Phase 1
// stays rule-based to be fast + cheap + deterministic.
// ============================================================================

// Each rule = { id, check(application_data, attachments) → { ok, ask } }
// ask = human-readable string of what's missing.
const RULES_BY_SERVICE = {
  paint: [
    { id: 'photos', check: (_a, atts) => atts.length >= 2
      ? { ok: true }
      : { ok: false, ask: 'At least 2 photos of the area to be painted' } },
    { id: 'color', check: (a) => (a.color_name || a.color_code || a.color_description)
      ? { ok: true }
      : { ok: false, ask: 'Paint color name or code (e.g., SW 7008 Alabaster, or color sample photo)' } },
    { id: 'area', check: (a) => (a.areas_to_paint || a.body_or_trim || a.description)
      ? { ok: true }
      : { ok: false, ask: 'Which surfaces will be painted (body, trim, door, fence, etc.)' } },
  ],
  fence: [
    { id: 'photos', check: (_a, atts) => atts.length >= 2
      ? { ok: true }
      : { ok: false, ask: 'Photos showing where the fence will be installed' } },
    { id: 'material', check: (a) => (a.material || a.fence_material)
      ? { ok: true }
      : { ok: false, ask: 'Fence material (cedar, wrought iron, vinyl, etc.)' } },
    { id: 'height', check: (a) => (a.height || a.fence_height)
      ? { ok: true }
      : { ok: false, ask: 'Fence height (most communities cap at 6 feet)' } },
    { id: 'location', check: (a) => (a.location_description || a.description)
      ? { ok: true }
      : { ok: false, ask: 'Where on the property the fence will go (rear yard, side yard, etc.)' } },
  ],
  roof: [
    { id: 'photos', check: (_a, atts) => atts.length >= 2
      ? { ok: true }
      : { ok: false, ask: 'Photos of the current roof + a sample of the proposed material if available' } },
    { id: 'material', check: (a) => (a.material || a.roof_material || a.shingle_brand)
      ? { ok: true }
      : { ok: false, ask: 'Roof material (architectural shingle, tile, metal, etc.) — brand/model if known' } },
    { id: 'color', check: (a) => (a.color_name || a.color || a.shingle_color)
      ? { ok: true }
      : { ok: false, ask: 'Roof color' } },
    { id: 'contractor', check: (a) => (a.contractor_name || a.contractor_company)
      ? { ok: true }
      : { ok: false, ask: 'Contractor name (for insurance/license verification)' } },
  ],
  addition: [
    { id: 'photos', check: (_a, atts) => atts.length >= 3
      ? { ok: true }
      : { ok: false, ask: 'At least 3 photos showing the area + property context' } },
    { id: 'description', check: (a) => (a.description || a.project_description)
      ? { ok: true }
      : { ok: false, ask: 'Description of the addition (room type, square footage, story)' } },
    { id: 'drawings', check: (_a, atts) => atts.some(a => /plan|drawing|sketch|elevation/i.test(a.name || '') || a.kind === 'plan')
      ? { ok: true }
      : { ok: false, ask: 'Floor plan or elevation drawing (PDF, photo of sketch is OK for initial review)' } },
    { id: 'contractor', check: (a) => (a.contractor_name || a.contractor_company)
      ? { ok: true }
      : { ok: false, ask: 'Contractor name (insurance/license required at construction)' } },
  ],
  landscape: [
    { id: 'photos', check: (_a, atts) => atts.length >= 2
      ? { ok: true }
      : { ok: false, ask: 'Photos of the area before changes' } },
    { id: 'description', check: (a) => (a.description || a.project_description)
      ? { ok: true }
      : { ok: false, ask: 'Description of what is being changed (plants, hardscape, trees, etc.)' } },
  ],
  solar: [
    { id: 'photos', check: (_a, atts) => atts.length >= 2
      ? { ok: true }
      : { ok: false, ask: 'Photos of the roof area where panels will be installed' } },
    { id: 'panel_count', check: (a) => (a.panel_count || a.system_size_kw || a.description)
      ? { ok: true }
      : { ok: false, ask: 'Number of panels OR system size in kW' } },
    { id: 'installer', check: (a) => (a.contractor_name || a.installer_company)
      ? { ok: true }
      : { ok: false, ask: 'Installer/contractor company (required by TX Property Code §202.010)' } },
  ],
  pool: [
    { id: 'photos', check: (_a, atts) => atts.length >= 2
      ? { ok: true }
      : { ok: false, ask: 'Photos of the proposed pool location' } },
    { id: 'description', check: (a) => (a.pool_type || a.description)
      ? { ok: true }
      : { ok: false, ask: 'Pool type and approximate size' } },
    { id: 'fencing_note', check: (a) => (a.fencing_plan || a.description)
      ? { ok: true }
      : { ok: false, ask: 'Pool fencing/safety plan (required by code)' } },
    { id: 'contractor', check: (a) => (a.contractor_name || a.contractor_company)
      ? { ok: true }
      : { ok: false, ask: 'Pool contractor company' } },
  ],
};

// Generic fallback rules for service types not listed above
const GENERIC_RULES = [
  { id: 'photos', check: (_a, atts) => atts.length >= 1
    ? { ok: true }
    : { ok: false, ask: 'At least one photo of the project area' } },
  { id: 'description', check: (a) => (a.description || a.project_description)
    ? { ok: true }
    : { ok: false, ask: 'A description of the project' } },
];

/**
 * Check a submission for completeness.
 *
 * @param {object} args
 * @param {string} args.service_type        - 'paint', 'fence', etc.
 * @param {object} args.application_data    - the JSONB application_data
 * @param {Array}  args.attachments         - array of { id, name, kind?, ... } describing uploaded files
 * @returns {{ passed: boolean, issues: Array<{rule_id, ask}>, message: string }}
 */
function checkCompleteness({ service_type, application_data, attachments }) {
  const data = application_data || {};
  const atts = attachments || [];
  const rules = RULES_BY_SERVICE[String(service_type || '').toLowerCase()] || GENERIC_RULES;

  const issues = [];
  for (const r of rules) {
    let result;
    try { result = r.check(data, atts); }
    catch (e) { result = { ok: false, ask: `Internal check failed for ${r.id}` }; }
    if (!result.ok) {
      issues.push({ rule_id: r.id, ask: result.ask });
    }
  }

  const passed = issues.length === 0;
  let message;
  if (passed) {
    message = "Application looks complete. We've forwarded it to the team for review — you'll hear back with a decision soon.";
  } else if (issues.length === 1) {
    message = `Almost there. To complete your application, please add: ${issues[0].ask}.`;
  } else {
    const bullets = issues.map(i => `• ${i.ask}`).join('\n');
    message = `We need a little more to review your application:\n\n${bullets}\n\nReply to this email with the additions and we'll resume the review.`;
  }

  return { passed, issues, message };
}

module.exports = { checkCompleteness, RULES_BY_SERVICE };
