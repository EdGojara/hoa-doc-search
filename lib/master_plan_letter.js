// Master plan approval letter — issued to a builder when their submitted
// master plan(s) are added to a community's approved catalog. Distinct from
// builder_letter.js (the per-lot construction decision letter) because:
//
//   • A per-lot letter approves ONE lot at ONE plan + elevation with a full
//     materials spec. The catalog reference is implicit (lot uses an
//     approved master plan).
//
//   • A master-plan letter approves N plans across M elevations as additions
//     to the community's catalog. No lot, no per-lot materials. The
//     "approved specifications" block is replaced by an approved-plans table
//     listing each plan + elevation + sqft + stories.
//
// Ed 2026-06-12 specifically directed: same letter shape as the per-lot
// decision letter, language adjusted to "master plan" context, NO review
// fee line on this letter (silent on cost — different conversation from
// per-lot fees).

const fs = require('fs');
const path = require('path');
const BRAND = require('./brand');

const LOGOS_DIR = path.join(__dirname, '..', 'public', 'logos');

// Same community logo map used by builder_letter.js. Kept independent here
// so this module is self-contained; if the alias map grows, factor into
// lib/community_logos.js.
const COMMUNITY_LOGOS = {
  'Lakes of Pine Forest':        'lakes_of_pine_forest_logo.png',
  'Canyon Gate at Cinco Ranch':  'canyon_gate_logo.png',
  'Canyon Gate':                 'canyon_gate_logo.png',
  'Waterview Estates':           'waterview_logo.jpg',
  'Waterview':                   'waterview_logo.jpg',
  'August Meadows':              'august_meadows_logo.png',
  'Still Creek Ranch':           'still_creek_ranch_logo.png',
};

const dataUriCache = {};
function loadLogoDataUri(filename) {
  if (!filename) return '';
  if (dataUriCache[filename] !== undefined) return dataUriCache[filename];
  try {
    const buf = fs.readFileSync(path.join(LOGOS_DIR, filename));
    const mime = filename.toLowerCase().endsWith('.jpg') || filename.toLowerCase().endsWith('.jpeg')
      ? 'image/jpeg' : 'image/png';
    dataUriCache[filename] = `data:${mime};base64,` + buf.toString('base64');
  } catch (_) {
    dataUriCache[filename] = '';
  }
  return dataUriCache[filename];
}

function getCommunityLogoDataUri(community) {
  if (!community) return '';
  if (COMMUNITY_LOGOS[community]) return loadLogoDataUri(COMMUNITY_LOGOS[community]);
  for (const [name, file] of Object.entries(COMMUNITY_LOGOS)) {
    if (community.toLowerCase().includes(name.toLowerCase())) return loadLogoDataUri(file);
  }
  return '';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Render the structured approved-plans block. Each row is one plan +
// elevation + orientation + sqft + stories. Rows are sorted by plan
// number then elevation for predictable presentation.
function renderApprovedPlansBlockHtml(plans) {
  if (!plans || !plans.length) return '';

  const sorted = [...plans].sort((a, b) => {
    const ap = String(a.plan_number || '');
    const bp = String(b.plan_number || '');
    if (ap !== bp) return ap.localeCompare(bp);
    return String(a.elevation || '').localeCompare(String(b.elevation || ''));
  });

  const rows = sorted.map((p) => {
    const planLabel = p.plan_name
      ? `${escapeHtml(p.plan_number)} ${escapeHtml(p.plan_name)}`
      : escapeHtml(p.plan_number);
    const elevLabel = p.elevation_orientation && p.elevation_orientation !== 'standard'
      ? `${escapeHtml(p.elevation)} (${escapeHtml(p.elevation_orientation)}-hand)`
      : escapeHtml(p.elevation);
    const sqftLabel = p.square_footage ? `${Number(p.square_footage).toLocaleString()} sq ft` : '';
    const storiesLabel = p.stories ? `${p.stories} story` : '';
    const details = [sqftLabel, storiesLabel].filter(Boolean).join(', ');

    return `<tr>
      <td class="plan-col">${planLabel}</td>
      <td class="elev-col">${elevLabel}</td>
      <td class="details-col">${details}</td>
    </tr>`;
  }).join('');

  return `<div class="plans-block">
    <div class="plans-heading">Approved Master Plans</div>
    <table class="plans-table">
      <thead>
        <tr><th>Plan</th><th>Elevation</th><th>Details</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderConditionsHtml(conditions) {
  if (!conditions) return '';
  const items = Array.isArray(conditions)
    ? conditions.filter(Boolean)
    : String(conditions).split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (!items.length) return '';
  return `<div class="conditions-block">
    <div class="conditions-heading">Conditions of Approval</div>
    <ol>${items.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ol>
  </div>`;
}

function renderDenialReasonsHtml(reasons) {
  if (!reasons) return '';
  const items = Array.isArray(reasons)
    ? reasons.filter(Boolean)
    : String(reasons).split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (!items.length) return '';
  return `<div class="denial-block">
    <div class="conditions-heading">Items Requiring Revision</div>
    <ol>${items.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ol>
    <p style="margin-top:10px;">Once these items are addressed, a revised master plan submission may be made through the builder portal. We aim to turn revisions in two business days.</p>
  </div>`;
}

function renderOpeningParagraph({
  decision_type,
  builder_company_name,
  community,
  submission_title,
  plan_count,
}) {
  if (decision_type === 'denied') {
    return `<p>After review against the ${escapeHtml(community)} Design Guidelines, the Architectural Control Committee is unable to add the master plans submitted by ${escapeHtml(builder_company_name)} under "${escapeHtml(submission_title)}" to the community's approved catalog. The specific items requiring revision are listed below.</p>`;
  }
  if (decision_type === 'approved_with_conditions') {
    return `<p>The ${escapeHtml(community)} Architectural Control Committee has reviewed the master plans submitted by ${escapeHtml(builder_company_name)} under "${escapeHtml(submission_title)}". Approval to add these plans to the community's approved catalog is granted subject to the conditions listed below. The full list of approved plans follows.</p>`;
  }
  // Default — clean approval
  return `<p>The ${escapeHtml(community)} Architectural Control Committee has reviewed the master plans submitted by ${escapeHtml(builder_company_name)} under "${escapeHtml(submission_title)}" and is pleased to add them to the community's approved catalog. The full list of approved plans follows.</p>`;
}

function renderClosingParagraphs({ decision_type, community }) {
  if (decision_type === 'denied') {
    return `<p>If it would help to discuss the revisions before resubmitting, the management team is happy to set up a short call. Please reply to this letter or use the contact information below.</p>`;
  }

  return `<p>Going forward, lot submissions referencing any of the approved plans listed above will be eligible for fast-track review under the standard 24 to 48 hour SLA, provided the per-lot materials and site conditions conform to the approved master plan specifications and the ${escapeHtml(community)} Design Guidelines.</p>

<p>Any modification to an approved master plan after this approval, including changes to floor plan, elevation handedness, structural design, material categories, or masonry coverage minimums, requires a separate master plan amendment submission and is not covered by this letter or by per-lot material substitution requests. The cleanest path is a fresh master plan submission through the builder portal.</p>

<p>Thank you for working with the ${escapeHtml(community)} Architectural Control Committee. Questions on this letter or future submissions may be directed to the contact information below or to <strong>builders@bedrocktx.com</strong>.</p>`;
}

/**
 * Render a master plan approval letter as HTML.
 *
 * @param {object} args
 * @param {string} args.community                — e.g. "Still Creek Ranch"
 * @param {string} args.builder_company_name     — e.g. "Lennar"
 * @param {string} [args.builder_contact_name]   — coordinator name on the submission
 * @param {string} [args.builder_mailing_address] — builder address
 * @param {string} args.submission_title         — internal-facing title for the batch
 * @param {string} args.reference_number         — e.g. "SCR-MPS-2026-0001"
 * @param {Array}  args.approved_plans           — array of {plan_number, plan_name, elevation, elevation_orientation, square_footage, stories}
 * @param {string} args.decision_type            — 'approved' | 'approved_with_conditions' | 'denied'
 * @param {string|string[]} [args.conditions]
 * @param {string|string[]} [args.denial_reasons]
 * @param {string} [args.date_str]
 * @param {string} [args.signer_name]
 * @returns {string} HTML document
 */
function renderMasterPlanLetterHTML(args) {
  const {
    community = '',
    builder_company_name = '',
    builder_contact_name = '',
    builder_mailing_address = '',
    submission_title = '',
    reference_number = '',
    approved_plans = [],
    decision_type = 'approved',
    conditions = null,
    denial_reasons = null,
    date_str = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    signer_name = BRAND.service.name,
  } = args || {};

  const logoDataUri = getCommunityLogoDataUri(community);
  const plansHtml = decision_type === 'denied' ? '' : renderApprovedPlansBlockHtml(approved_plans);
  const conditionsHtml = decision_type === 'approved_with_conditions' ? renderConditionsHtml(conditions) : '';
  const denialHtml = decision_type === 'denied' ? renderDenialReasonsHtml(denial_reasons) : '';
  const openingHtml = renderOpeningParagraph({
    decision_type, builder_company_name, community, submission_title,
    plan_count: approved_plans.length,
  });
  const closingHtml = renderClosingParagraphs({ decision_type, community });

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { size: Letter; margin: 0.85in 0.95in 1in 0.95in; }
  body {
    font-family: "Times New Roman", Cambria, Georgia, serif;
    color: #111;
    line-height: 1.45;
    font-size: 11.5pt;
    margin: 0;
  }
  .logo-wrap { text-align: center; margin-bottom: 18px; }
  .logo-wrap img { max-height: 110px; max-width: 220px; }
  .from-block { font-size: 11pt; }
  .from-block .name { font-weight: bold; }
  .date-block { margin-top: 18px; }
  .recipient-block { margin-top: 18px; }
  .re-line { margin-top: 14px; font-style: italic; color: #333; }
  .ref-line { margin-top: 4px; font-size: 10.5pt; color: #555; }
  .body-block { margin-top: 14px; }
  .body-block p { margin: 0 0 12px; }

  .plans-block {
    margin: 14px 0; padding: 12px 14px;
    border: 1px solid #0B1D34; border-left: 4px solid #D4AF37; background: #FAFAF6;
  }
  .plans-heading {
    font-family: "Times New Roman", Georgia, serif;
    font-weight: bold; font-size: 11.5pt;
    color: #0B1D34; margin-bottom: 8px;
    border-bottom: 1px solid rgba(26,48,80,0.2); padding-bottom: 4px;
    letter-spacing: 0.02em;
  }
  .plans-table { border-collapse: collapse; width: 100%; font-size: 11pt; }
  .plans-table th {
    text-align: left; padding: 4px 8px 4px 0;
    color: #0B1D34; font-size: 10pt; font-weight: 600;
    border-bottom: 1px solid rgba(26,48,80,0.15);
  }
  .plans-table td { padding: 4px 8px 4px 0; vertical-align: top; }
  .plans-table .plan-col { width: 38%; font-weight: 600; color: #0B1D34; }
  .plans-table .elev-col { width: 28%; }
  .plans-table .details-col { width: 34%; color: #444; }

  .conditions-block, .denial-block { margin: 14px 0; }
  .conditions-heading {
    font-weight: bold; color: #0B1D34; margin-bottom: 6px;
    letter-spacing: 0.02em;
  }
  .conditions-block ol, .denial-block ol { margin: 4px 0 0; padding-left: 22px; }
  .conditions-block li, .denial-block li { margin-bottom: 5px; }

  .closing { margin-top: 18px; }
  .signature { margin-top: 22px; }
  .signature .line1 { font-weight: bold; }
  .footer-contact { margin-top: 6px; font-size: 11pt; color: #111; }
  .authority {
    margin-top: 24px; padding-top: 10px;
    border-top: 1px solid rgba(0,0,0,0.12);
    font-size: 9.5pt; font-style: italic; color: #555; line-height: 1.35;
  }
</style></head><body>

<div class="logo-wrap">
  ${logoDataUri
    ? `<img src="${logoDataUri}" alt="${escapeHtml(community)}">`
    : `<div style="font-size:18pt; font-weight:bold;">${escapeHtml(community)}</div>`}
</div>

<div class="from-block">
  <div class="name">${escapeHtml(community)} Architectural Control Committee</div>
  <div>c/o ${BRAND.service.name}</div>
  <div>${BRAND.service.address}</div>
  <div>${BRAND.service.addressCityStateZip}</div>
</div>

<div class="date-block">${escapeHtml(date_str)}</div>

<div class="recipient-block">
  ${builder_contact_name ? `<div>${escapeHtml(builder_contact_name)}</div>` : ''}
  ${builder_company_name ? `<div>${escapeHtml(builder_company_name)}</div>` : ''}
  ${builder_mailing_address
    ? escapeHtml(builder_mailing_address).split(/\s*,\s*/).map((line) => `<div>${line}</div>`).join('')
    : ''}
</div>

<div class="re-line">Re: Master plan submission, ${escapeHtml(submission_title)}</div>
${reference_number ? `<div class="ref-line">Reference: ${escapeHtml(reference_number)}</div>` : ''}

<div class="body-block">
  ${openingHtml}
  ${conditionsHtml}
  ${plansHtml}
  ${denialHtml}
  ${closingHtml}
</div>

<div class="closing">${decision_type === 'denied' ? 'Respectfully,' : 'Sincerely,'}</div>

<div class="signature">
  <div class="line1">${escapeHtml(signer_name)}</div>
  <div>On behalf of the ${escapeHtml(community)} Architectural Control Committee</div>
  <div class="footer-contact">
    ${BRAND.service.phone} &nbsp;|&nbsp; builders@bedrocktx.com &nbsp;|&nbsp; ${BRAND.service.website}
  </div>
</div>

<div class="authority">
  This letter is issued by the ${escapeHtml(community)} Architectural Control Committee, acting under the authority granted by the recorded Declaration of Covenants, Conditions, and Restrictions for ${escapeHtml(community)}, and administered by ${BRAND.service.name}. Any modification to an approved master plan after this approval requires a separate master plan amendment submission.
</div>

</body></html>`;
}

module.exports = { renderMasterPlanLetterHTML, renderApprovedPlansBlockHtml };
