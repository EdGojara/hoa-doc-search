// Builder ARC decision letter — renders the customer-facing PDF letterhead
// for new-construction approvals/denials. Companion to decision_letter.js
// (which handles resident modifications). Same visual letterhead, but the
// body captures the FULL material spec — plan + elevation + every approved
// material — so a builder can construct against the letter without ambiguity.
//
// The Rabbit Creek 2023 letter is the floor: plan number, elevation, brick
// color, stone callout, siding/trim/shutter/door colors, masonry %, fence
// material, conditions. The Still Meadow 2026 letter that said only
// "Approved: New Build" is exactly the failure mode this template prevents.
//
// Inputs are structured (no free-form body). The schema IS the spec — staff
// can't accidentally ship a thin letter because the template doesn't allow it.

const fs = require('fs');
const path = require('path');
const BRAND = require('./brand');
const { addressLinesFromString } = require('./mail/address_block');

const LOGOS_DIR = path.join(__dirname, '..', 'public', 'logos');

// Reused from decision_letter.js (kept here so this module is self-contained;
// if the alias map grows, factor into a shared lib/community_logos.js).
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

function getBedrockLogoDataUri() {
  // Minimal wordmark (Bedrock + Association Management) — used in the
  // signature block to attribute the managing agent without competing with
  // the community logo at the top of the letterhead.
  return loadLogoDataUri('bedrock_logo_minimal.png');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Format a lot/block/section line: "Lot 12, Block 3, Section 1"
function formatLotLine({ lot_number, block_number, section_number }) {
  const parts = [];
  if (lot_number)     parts.push(`Lot ${lot_number}`);
  if (block_number)   parts.push(`Block ${block_number}`);
  if (section_number) parts.push(`Section ${section_number}`);
  return parts.join(', ');
}

// Render the structured material spec block. Each row is "Label: Value".
// Rows with empty values are omitted (so a community that doesn't use shutters
// doesn't produce a "Shutter color: —" line).
function renderMaterialSpec(materials = {}) {
  const m = materials || {};
  const rows = [];

  const push = (label, value) => {
    if (value === null || value === undefined || value === '') return;
    rows.push({ label, value: String(value) });
  };

  // Masonry
  if (m.brick_color || m.brick_manufacturer) {
    const brick = [m.brick_color, m.brick_manufacturer && `(${m.brick_manufacturer})`]
      .filter(Boolean).join(' ');
    push('Brick', brick);
  }
  if (m.stone_type || m.stone_color) {
    const stone = [m.stone_color, m.stone_type && m.stone_type !== m.stone_color ? `(${m.stone_type})` : '']
      .filter(Boolean).join(' ');
    push('Stone', stone);
  }
  if (m.masonry_percentage_front != null || m.masonry_percentage_sides != null || m.masonry_percentage_rear != null) {
    const f = m.masonry_percentage_front;
    const s = m.masonry_percentage_sides;
    const r = m.masonry_percentage_rear;
    const parts = [];
    if (f != null) parts.push(`${f}% front`);
    if (s != null) parts.push(`${s}% sides`);
    if (r != null) parts.push(`${r}% rear`);
    push('Masonry coverage', parts.join(', '));
  }
  if (m.masonry_wrap_distance_sides != null) {
    push('Masonry wrap (sides)', `${m.masonry_wrap_distance_sides} ft`);
  }
  if (m.masonry_two_story_compliance === true) {
    push('Two-story masonry', 'compliant per Design Guidelines');
  }

  // Siding + paint
  if (m.siding_material || m.siding_color) {
    const siding = [m.siding_material, m.siding_color && `in ${m.siding_color}`]
      .filter(Boolean).join(' ');
    push('Siding', siding);
  }
  push('Trim color', m.trim_color);
  if (m.shutters_present) push('Shutter color', m.shutter_color || 'per submission');
  push('Front door color', m.front_door_color);
  if (m.garage_door_color || m.garage_door_style) {
    const garage = [m.garage_door_color, m.garage_door_style && `(${m.garage_door_style})`]
      .filter(Boolean).join(' ');
    push('Garage door', garage);
  }

  // Roof
  if (m.roof_material || m.roof_color) {
    const roof = [m.roof_color, m.roof_material && `(${m.roof_material.replace(/_/g, ' ')})`]
      .filter(Boolean).join(' ');
    push('Roof', roof);
  }

  // Site
  if (m.driveway_material) push('Driveway', m.driveway_material.replace(/_/g, ' '));
  if (m.fence_present) {
    const fence = [
      m.fence_material && m.fence_material.replace(/_/g, ' '),
      m.fence_height_feet != null && `${m.fence_height_feet} ft`,
      m.fence_orientation && m.fence_orientation.replace(/_/g, ' '),
    ].filter(Boolean).join(', ');
    push('Fence', fence || 'per submission');
  }

  return rows;
}

function renderSpecBlockHtml(rows) {
  if (!rows.length) return '';
  return `<div class="spec-block">
  <div class="spec-heading">Approved Specifications</div>
  <table class="spec-table">
    ${rows.map((r) => `
      <tr>
        <td class="spec-label">${escapeHtml(r.label)}</td>
        <td class="spec-value">${escapeHtml(r.value)}</td>
      </tr>`).join('')}
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

// Decision-specific opening paragraph. Each variant is short, plain English,
// names the property + plan, and sets the right tone (warm on approval,
// matter-of-fact on conditions, respectful on denial).
function renderOpeningParagraph({
  decision_type,
  builder_company_name,
  community,
  property_address,
  plan_number,
  elevation,
}) {
  const planRef = [plan_number && `Plan ${plan_number}`, elevation && `Elevation ${elevation}`]
    .filter(Boolean).join(', ');
  const planFragment = planRef ? ` (${planRef})` : '';

  if (decision_type === 'denied') {
    return `<p>After review against the ${escapeHtml(community)} Design Guidelines, the Architectural Control Committee is unable to approve the new home construction proposed by ${escapeHtml(builder_company_name)} at ${escapeHtml(property_address)}${planFragment}. The specific items requiring revision are listed below.</p>`;
  }

  if (decision_type === 'approved_with_conditions') {
    return `<p>The ${escapeHtml(community)} Architectural Control Committee has reviewed the new home construction submitted by ${escapeHtml(builder_company_name)} at ${escapeHtml(property_address)}${planFragment}. Approval is granted subject to the conditions listed below. The approved specifications follow.</p>`;
  }

  // Default: clean approval
  return `<p>The ${escapeHtml(community)} Architectural Control Committee has reviewed the new home construction submitted by ${escapeHtml(builder_company_name)} at ${escapeHtml(property_address)}${planFragment} and is pleased to approve it as submitted. The approved specifications follow.</p>`;
}

function renderDenialReasonsHtml(denial_reasons) {
  if (!denial_reasons) return '';
  // Accept either a single string or an array of reasons
  const items = Array.isArray(denial_reasons)
    ? denial_reasons.filter(Boolean)
    : String(denial_reasons).split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (!items.length) return '';
  return `<div class="denial-block">
  <div class="conditions-heading">Items Requiring Revision</div>
  <ol>${items.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ol>
  <p style="margin-top:10px;">Once these items are addressed, a revised submission may be made through the builder portal. We aim to turn revisions in two business days.</p>
</div>`;
}

function renderClosingParagraphs({ decision_type, community }) {
  if (decision_type === 'denied') {
    return `<p>If it would help to discuss the revisions before resubmitting, the management team is happy to set up a short call. Please reply to this letter or use the contact information below.</p>`;
  }

  // Approval (with or without conditions) — change-control + completion paragraphs
  return `<p>This approval is issued based on the specifications listed above. Any deviation from these specifications during construction, including substitutions of color, material, masonry coverage, fence type, or elevation, requires written re-approval prior to installation. Submitting a revised application through the builder portal is the cleanest path, and the management team can typically turn material substitution requests in 24 to 48 hours.</p>

<p>Upon completion of construction, please notify the management team so a final compliance walk may be scheduled. The final walk confirms that the home was built per the approved specifications and clears the property for the homeowner closing process.</p>

<p>Thank you for working with the ${escapeHtml(community)} Architectural Control Committee. Questions on this letter or future submissions may be directed to the contact information below or to <strong>builders@bedrocktx.com</strong>.</p>`;
}

/**
 * Render a builder ARC decision letter as HTML. Downstream pipeline converts
 * to PDF (puppeteer / Render PDF service), same path as decision_letter.js.
 *
 * @param {object} args
 * @param {string} args.community                 — e.g. "August Meadows"
 * @param {string} args.builder_company_name      — e.g. "DRB Group"
 * @param {string} args.builder_contact_name      — coordinator name on the submission
 * @param {string} [args.builder_mailing_address] — company mailing address (optional)
 * @param {string} args.property_address          — e.g. "502 Meadow Knoll Drive"
 * @param {string} [args.lot_number]
 * @param {string} [args.block_number]
 * @param {string} [args.section_number]
 * @param {string} args.plan_number               — e.g. "6512"
 * @param {string} [args.plan_name]               — e.g. "The Magnolia"
 * @param {string} args.elevation                 — e.g. "A"
 * @param {string} [args.elevation_orientation]   — e.g. "left" | "right" | "standard"
 * @param {object} args.materials                 — full material spec (see renderMaterialSpec)
 * @param {string} args.reference_number          — e.g. "AM-BLD-2026-0042"
 * @param {string} args.decision_type             — "approved" | "approved_with_conditions" | "denied"
 * @param {string|string[]} [args.conditions]     — required when approved_with_conditions
 * @param {string|string[]} [args.denial_reasons] — required when denied
 * @param {string} [args.date_str]                — defaults to today, US long format
 * @param {string} [args.signer_name]             — name on the signature line; defaults to BAM
 * @returns {string} HTML document
 */
// Strip bracketed placeholder leaks from names before they reach the page.
// The AI extraction sometimes returns values like "Karla [last name]" when
// page 1 of the submission has a partially-filled field, and staff entries
// occasionally use the same pattern as a TODO marker. Either way, a letter
// that goes to a real builder must NEVER show "[last name]" in the salutation.
//
// Rules:
//   - Remove any "[...]" segment regardless of contents.
//   - Collapse whitespace.
//   - If what's left is empty or under 2 chars (no real name there), return ''
//     so the caller can omit the line entirely.
//   - Otherwise return the cleaned string.
function sanitizeNameForLetter(raw) {
  if (!raw) return '';
  const stripped = String(raw).replace(/\s*\[[^\]]*\]\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (stripped.length < 2) return '';
  return stripped;
}

function renderBuilderLetterHTML(args) {
  const {
    community = '',
    builder_company_name = '',
    builder_contact_name: builder_contact_name_raw = '',
    builder_mailing_address = '',
    property_address = '',
    lot_number,
    block_number,
    section_number,
    plan_number = '',
    plan_name = '',
    elevation = '',
    elevation_orientation = '',
    materials = {},
    reference_number = '',
    decision_type = 'approved',
    conditions = null,
    denial_reasons = null,
    date_str = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    signer_name = BRAND.service.name,
    // Review/processing fee charged for this submission. Ed 2026-06-11:
    // surface the fee on the letter so the builder has confirmation of what
    // they were charged and their AP team can reconcile against the
    // Bedrock invoice. Pass either review_fee_cents (preferred — system of
    // record) or review_fee_dollars (override). Omit both to suppress the
    // fee line (e.g. for waiver or back-office cases).
    review_fee_cents = null,
    review_fee_dollars = null,
    review_fee_label = 'Review fee',
  } = args || {};

  // Defend the recipient block from "[last name]" / "[contact]" placeholder
  // leaks. The renderer renders nothing for the contact-name line if the
  // sanitizer can't recover a real name -- the letter falls through to the
  // company name as the recipient, which reads fine.
  const builder_contact_name = sanitizeNameForLetter(builder_contact_name_raw);

  const feeDollars = review_fee_dollars != null
    ? Number(review_fee_dollars)
    : (review_fee_cents != null ? Number(review_fee_cents) / 100 : null);
  const feeStr = feeDollars != null
    ? `$${feeDollars.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
    : null;

  const logoDataUri = getCommunityLogoDataUri(community);
  const bedrockLogoDataUri = getBedrockLogoDataUri();
  const lotLine = formatLotLine({ lot_number, block_number, section_number });
  const planLabel = plan_name
    ? `Plan ${escapeHtml(plan_number)} ${escapeHtml(plan_name)}, Elevation ${escapeHtml(elevation)}${elevation_orientation && elevation_orientation !== 'standard' ? ` (${escapeHtml(elevation_orientation)}-hand)` : ''}`
    : `Plan ${escapeHtml(plan_number)}, Elevation ${escapeHtml(elevation)}${elevation_orientation && elevation_orientation !== 'standard' ? ` (${escapeHtml(elevation_orientation)}-hand)` : ''}`;

  const specRows = renderMaterialSpec(materials);
  const specHtml = decision_type === 'denied' ? '' : renderSpecBlockHtml(specRows);
  const conditionsHtml = decision_type === 'approved_with_conditions' ? renderConditionsHtml(conditions) : '';
  const denialHtml = decision_type === 'denied' ? renderDenialReasonsHtml(denial_reasons) : '';
  const openingHtml = renderOpeningParagraph({
    decision_type, builder_company_name, community, property_address, plan_number, elevation,
  });
  const closingHtml = renderClosingParagraphs({ decision_type, community });

  const reLine = [
    property_address,
    lotLine,
    planLabel.replace(/<[^>]+>/g, ''),  // strip tags for plaintext fallback inside Re line
  ].filter(Boolean).join(' • ');

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

  .spec-block { margin: 14px 0; padding: 12px 14px;
    border: 1px solid #0B1D34; border-left: 4px solid #D4AF37; background: #FAFAF6; }
  .spec-heading {
    font-family: "Times New Roman", Georgia, serif;
    font-weight: bold; font-size: 11.5pt;
    color: #0B1D34; margin-bottom: 8px;
    border-bottom: 1px solid rgba(26,48,80,0.2); padding-bottom: 4px;
    letter-spacing: 0.02em;
  }
  .spec-table { border-collapse: collapse; width: 100%; }
  .spec-table td { padding: 3px 0; vertical-align: top; }
  .spec-table .spec-label {
    width: 38%; font-weight: 600; color: #0B1D34;
    padding-right: 10px;
  }
  .spec-table .spec-value { color: #111; }

  .conditions-block, .denial-block { margin: 14px 0; }
  .conditions-heading {
    font-weight: bold; color: #0B1D34; margin-bottom: 6px;
    letter-spacing: 0.02em;
  }
  .conditions-block ol, .denial-block ol { margin: 4px 0 0; padding-left: 22px; }
  .conditions-block li, .denial-block li { margin-bottom: 5px; }

  .closing { margin-top: 18px; }
  .signature { margin-top: 22px; }
  .signature .bedrock-mark { display: block; max-width: 140px; max-height: 36px; margin-bottom: 8px; }
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
    ? addressLinesFromString(builder_mailing_address).map((line) => `<div>${escapeHtml(line)}</div>`).join('')
    : ''}
</div>

<div class="re-line">Re: New construction at ${escapeHtml(reLine)}</div>
${reference_number ? `<div class="ref-line">Reference: ${escapeHtml(reference_number)}</div>` : ''}
${feeStr ? `<div class="ref-line">${escapeHtml(review_fee_label)}: ${feeStr} (per submission, charged to ${escapeHtml(builder_company_name)})</div>` : ''}

<div class="body-block">
  ${openingHtml}
  ${conditionsHtml}
  ${specHtml}
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
  This letter is issued by the ${escapeHtml(community)} Architectural Control Committee, acting under the authority granted by the recorded Declaration of Covenants, Conditions, and Restrictions for ${escapeHtml(community)}, and administered by ${BRAND.service.name}. Any deviation from the approved specifications during construction requires written re-approval prior to installation.
</div>

</body></html>`;
}

module.exports = { renderBuilderLetterHTML, renderMaterialSpec, sanitizeNameForLetter };
