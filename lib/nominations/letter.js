// Call for Nominations letter — "no substitute" Bedrock-branded version.
// Community-specific knobs ride along on the cycle row so each community's
// letter feels like itself without forking the template:
//   onsite_drop_off  → optional drop-off block
//   proxy_teaser     → optional "proxy/ballot to follow" line
//   expectations_blurb → optional sidebar copy ("what serving entails")
//   bio_prompt_style → 'simple' | 'structured' (affects landing-page form, not the letter itself)
// Contact is ALWAYS info@bedrocktx.com (role address — survives staff turnover).

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const LOGOS_DIR = path.join(__dirname, '..', '..', 'public', 'logos');

const COMMUNITY_LOGOS = {
  'Lakes of Pine Forest':        'lakes_of_pine_forest_logo.png',
  'Canyon Gate at Cinco Ranch':  'canyon_gate_logo.png',
  'Canyon Gate':                 'canyon_gate_logo.png',
  'Waterview Estates':           'waterview_logo.jpg',
  'Waterview':                   'waterview_logo.jpg',
};
const dataUriCache = {};
function logoDataUri(filename) {
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
function getCommunityLogo(community) {
  if (!community) return '';
  if (COMMUNITY_LOGOS[community]) return logoDataUri(COMMUNITY_LOGOS[community]);
  for (const [name, file] of Object.entries(COMMUNITY_LOGOS)) {
    if (community.toLowerCase().includes(name.toLowerCase())) return logoDataUri(file);
  }
  return '';
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(String(d).length === 10 ? `${d}T12:00:00` : d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
function fmtDateShort(d) {
  if (!d) return '';
  const dt = new Date(String(d).length === 10 ? `${d}T12:00:00` : d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Default expectations blurb — three-year term is the Bedrock default; the
// `expectations_blurb` knob on the cycle row lets any community override the
// whole paragraph (e.g., a two-year term, community-specific framing, or
// language tailored to that community's governing documents). Meeting
// cadence is intentionally omitted — some boards meet monthly, some
// quarterly, some only as needed.
const DEFAULT_EXPECTATIONS = `Board members serve a three-year term. The role is volunteer. The board approves the annual budget, oversees the management agent, and represents the homeowners. Meeting cadence varies by community — some boards meet monthly, some quarterly, some only as needed. If you would like to serve, please submit your nomination.`;

// Spell numbers 0-10 as words for grammar inside the letter body ("two (2)
// members", "three (3) year term"). Anything 11+ falls back to digits.
const NUM_WORDS = ['zero','one','two','three','four','five','six','seven','eight','nine','ten'];
function numberToWord(n) {
  const x = Number(n);
  if (Number.isInteger(x) && x >= 0 && x <= 10) return NUM_WORDS[x];
  return String(n);
}

async function renderCallForNominationsHTML(cycle, opts = {}) {
  const {
    community_name,
    annual_meeting_date,
    annual_meeting_time,
    annual_meeting_location,
    nominations_open_at,
    nominations_close_at,
    nominations_close_time,
    seats_open,
    term_years,
    current_board,
    description,
    public_slug,
    id,
    bio_prompt_style,
    onsite_drop_off,
    proxy_teaser,
    expectations_blurb,
    accept_electronic,
    accept_physical_mail,
    floor_nominations_policy,
    include_floor_nominations_notice,
    floor_nominations_note,
  } = cycle;

  // Default both true for legacy rows that pre-date migration 038.
  const acceptElectronic = accept_electronic !== false;
  const acceptPhysical   = accept_physical_mail !== false;

  const logo = getCommunityLogo(community_name);
  const base = opts.base_url || 'https://app.bedrocktxai.com';
  const slug = public_slug || id;
  const publicUrl = `${base}/nominate/${slug}`;

  let qrDataUri = '';
  try {
    qrDataUri = await QRCode.toDataURL(publicUrl, { width: 360, margin: 1, color: { dark: '#1E2761', light: '#FFFFFF' } });
  } catch (_) { qrDataUri = ''; }

  const boardArr = Array.isArray(current_board) ? current_board : [];
  const seats = Number(seats_open) || 1;
  // "one (1) member" / "two (2) members" — word form for the count, digit
  // in parens. Avoids the "2 (2) members" stutter Ed flagged.
  const seatPhrase = seats === 1
    ? 'one (1) member'
    : `${numberToWord(seats)} (${seats}) members`;
  // Term phrase, e.g. "three (3) year term". Defaults to 3 if not set.
  const termN = Number(term_years) || 3;
  const termPhrase = `${numberToWord(termN)} (${termN}) year term`;

  const onsite = onsite_drop_off || { enabled: false };
  const showOnsite = !!onsite.enabled && (onsite.address || onsite.location_name);

  // The follow-up mailing line — replaces the prior "proxy and absentee
  // ballot" wording. The Call for Nominations doesn't touch voting; the
  // Annual Meeting Notice (mailed after nominations close) handles that.
  const followupLine = (proxy_teaser !== false)
    ? `An Annual Meeting Notice — with meeting details and voting instructions — will be mailed after the nomination deadline. Please keep a look out for this additional mailing.`
    : '';

  // Floor-nominations notice. Three rendering paths:
  //  1. Custom `floor_nominations_note` set → use it verbatim (paper trail
  //     for boards that elected to deviate from their governing documents).
  //  2. Policy = 'not_allowed' → red-highlighted callout (§209.0058 disclosure).
  //  3. Policy = 'allowed'     → neutral note encouraging early submission.
  let floorNoticeHtml = '';
  if (include_floor_nominations_notice) {
    if (floor_nominations_note && floor_nominations_note.trim()) {
      floorNoticeHtml = `<div class="floor-notice floor-notice-custom">${escapeHtml(floor_nominations_note.trim())}</div>`;
    } else if (floor_nominations_policy === 'not_allowed') {
      floorNoticeHtml = `<div class="floor-notice floor-notice-strict"><strong>Please note:</strong> Nominations will <strong>not</strong> be accepted from the floor during the Annual Meeting. To have your name placed on the ballot, your nomination must be received by the deadline above.</div>`;
    } else if (floor_nominations_policy === 'allowed') {
      floorNoticeHtml = `<div class="floor-notice floor-notice-open">Nominations may also be made from the floor at the Annual Meeting; however, submitting before the deadline ensures your name appears on the mailed ballot and absentee/proxy materials.</div>`;
    }
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { size: Letter; margin: 0.65in 0.85in 0.8in 0.85in; }
  body {
    font-family: Georgia, Cambria, "Times New Roman", serif;
    color: #1a1a1a;
    line-height: 1.5;
    font-size: 11pt;
    margin: 0;
  }

  /* Letterhead */
  .head { text-align: center; padding-bottom: 14px; border-bottom: 2px solid #1E2761; margin-bottom: 16px; }
  .head img { max-height: 90px; max-width: 220px; display: block; margin: 0 auto 6px; }
  .head .community { font-size: 17pt; font-weight: 700; color: #1E2761; letter-spacing: 0.2px; }
  .head .sub { font-size: 9pt; color: #475569; margin-top: 2px; }

  .return-block { font-size: 10pt; color: #475569; text-align: right; margin-bottom: 8px; line-height: 1.35; }
  .return-block .b { color: #1E2761; font-weight: 700; }

  .doc-title {
    text-align: center;
    font-family: Calibri, Arial, sans-serif;
    font-size: 13pt;
    letter-spacing: 3px;
    text-transform: uppercase;
    color: #1E2761;
    font-weight: 700;
    margin: 14px 0 10px;
  }

  .salutation { margin-top: 14px; }
  p { margin: 0 0 10px; }

  /* Hero */
  .hero {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;
    margin: 12px 0 14px;
  }
  .hero-card {
    background: #f8fafc; border: 1px solid #e2e8f0; border-left: 3px solid #1E2761;
    border-radius: 0 6px 6px 0; padding: 8px 10px;
  }
  .hero-card .lbl { font-family: Calibri, Arial, sans-serif; font-size: 8.5pt; color: #475569; letter-spacing: 1px; text-transform: uppercase; font-weight: 700; }
  .hero-card .val { font-size: 11.5pt; font-weight: 700; color: #1E2761; margin-top: 2px; }

  /* Current board */
  .board-section { margin: 14px 0; }
  .board-h { font-family: Calibri, Arial, sans-serif; font-size: 10pt; font-weight: 700; color: #1E2761; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 5px; }
  table.board { width: 100%; border-collapse: collapse; font-size: 10.5pt; }
  table.board th { text-align: left; font-family: Calibri, Arial, sans-serif; font-size: 8.5pt; color: #475569; letter-spacing: 0.5px; text-transform: uppercase; border-bottom: 1.5px solid #1E2761; padding: 4px 6px; }
  table.board td { padding: 4px 6px; border-bottom: 1px solid #e2e8f0; }

  /* What's expected — italics sidebar callout */
  .expectations {
    margin: 14px 0;
    padding: 10px 14px;
    border-left: 3px solid #CADCFC;
    background: #fafbfc;
    font-style: italic;
    font-size: 10.5pt;
    color: #334155;
    line-height: 1.5;
  }

  /* Submit box — the centerpiece */
  .submit {
    margin: 16px 0 14px;
    border: 2px solid #1E2761;
    border-radius: 10px;
    padding: 14px 16px;
    display: grid;
    grid-template-columns: 175px 1fr;
    gap: 18px;
    align-items: center;
    background: #fff;
  }
  .submit .qr { text-align: center; }
  .submit .qr img { width: 165px; height: 165px; display: block; }
  .submit .qr .scan { font-family: Calibri, Arial, sans-serif; font-size: 8.5pt; color: #475569; letter-spacing: 1px; text-transform: uppercase; font-weight: 700; margin-top: 4px; }
  .submit .copy .h { font-family: Calibri, Arial, sans-serif; font-size: 14pt; font-weight: 700; color: #1E2761; margin-bottom: 4px; letter-spacing: 0.3px; }
  .submit .copy .u { font-family: Consolas, "Courier New", monospace; font-size: 10.5pt; color: #1E2761; font-weight: 700; word-break: break-all; padding: 4px 8px; background: #f8fafc; border-radius: 4px; display: inline-block; margin: 4px 0 6px; }
  .submit .copy p { margin: 4px 0; font-size: 10.5pt; }

  /* Other ways */
  .other-ways { margin: 8px 0 12px; padding: 10px 14px; background: #f8fafc; border-radius: 6px; font-size: 10.5pt; }
  .other-ways .h { font-family: Calibri, Arial, sans-serif; font-size: 9pt; font-weight: 700; color: #1E2761; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 5px; }
  .other-ways ul { margin: 0; padding-left: 18px; }
  .other-ways li { margin: 2px 0; }
  .other-ways .b { font-weight: 700; color: #1E2761; }

  .deadline {
    margin: 14px 0;
    padding: 8px 14px;
    background: #1E2761;
    color: #fff;
    border-radius: 6px;
    font-size: 11.5pt;
    font-weight: 700;
    text-align: center;
    letter-spacing: 0.3px;
  }
  .deadline .lbl { font-family: Calibri, Arial, sans-serif; font-size: 8.5pt; letter-spacing: 1.5px; text-transform: uppercase; color: #CADCFC; font-weight: 700; }

  /* Floor-nominations notice — strict (red) for "not allowed", neutral
     (gray) for "allowed" or custom override wording. */
  .floor-notice {
    margin: 12px 0;
    padding: 10px 14px;
    border-radius: 6px;
    font-size: 11pt;
    line-height: 1.5;
  }
  .floor-notice-strict {
    background: #fef2f2;
    border-left: 3px solid #b91c1c;
    color: #7f1d1d;
  }
  .floor-notice-strict strong { color: #b91c1c; }
  .floor-notice-open {
    background: #f8fafc;
    border-left: 3px solid #1E2761;
    color: #1f2937;
  }
  .floor-notice-custom {
    background: #fffbeb;
    border-left: 3px solid #b45309;
    color: #78350f;
  }

  .closing { margin-top: 14px; }
  .signature { margin-top: 12px; }
  .signature .line1 { font-weight: 700; color: #1E2761; }
  .footer-contact { margin-top: 4px; font-size: 10pt; color: #475569; }
</style></head><body>

<div class="return-block">
  <div class="b">${escapeHtml(community_name)} Homeowners Association</div>
  <div>c/o Bedrock Association Management, Inc.</div>
  <div>12808 West Airport Blvd. #253, Sugar Land, TX 77498</div>
  <div>(832) 588-2485 &nbsp;·&nbsp; info@bedrocktx.com</div>
</div>

<div class="head">
  ${logo
    ? `<img src="${logo}" alt="${escapeHtml(community_name)}">`
    : `<div style="font-size:20pt; font-weight:700; color:#1E2761;">${escapeHtml(community_name)}</div>`}
  <div class="community">${escapeHtml(community_name)} Homeowners Association</div>
  <div class="sub">${escapeHtml(fmtDateShort(new Date()))}</div>
</div>

<div class="doc-title">Call for Nominations — Board of Directors</div>

<div class="salutation">Dear ${escapeHtml(community_name)} Homeowner,</div>

<p>The annual meeting of the ${escapeHtml(community_name)} Homeowners Association will be held on <strong>${escapeHtml(fmtDate(annual_meeting_date))}</strong>${annual_meeting_time ? ` at <strong>${escapeHtml(annual_meeting_time)}</strong>` : ''}${annual_meeting_location ? `, at <strong>${escapeHtml(annual_meeting_location)}</strong>` : ''}. The purpose of this meeting is to elect ${seatPhrase} of the Board of Directors to serve a ${termPhrase} and to discuss the affairs of the Association.</p>

<div class="hero">
  <div class="hero-card">
    <div class="lbl">Annual Meeting</div>
    <div class="val">${escapeHtml(fmtDateShort(annual_meeting_date))}</div>
  </div>
  <div class="hero-card">
    <div class="lbl">${seats === 1 ? 'Seat Open' : 'Seats Open'}</div>
    <div class="val">${seats}</div>
  </div>
  <div class="hero-card">
    <div class="lbl">Nominations Open</div>
    <div class="val">${escapeHtml(fmtDateShort(nominations_open_at))}</div>
  </div>
  <div class="hero-card">
    <div class="lbl">Nominations Close</div>
    <div class="val">${escapeHtml(fmtDateShort(nominations_close_at))}</div>
  </div>
</div>

<p>Please accept this letter as the official call for nominations. ${description ? escapeHtml(description) : "Any homeowner is welcome to run for the Board or nominate a candidate — your community's governing documents set the specific eligibility rules, and we'll confirm them before the ballot is finalized."} You may nominate yourself or a neighbor.</p>

${boardArr.length ? `
<div class="board-section">
  <div class="board-h">Current Board of Directors</div>
  <table class="board">
    <thead><tr><th>Name</th><th>Position</th><th>Term Ends</th></tr></thead>
    <tbody>
      ${boardArr.map((b) => `
        <tr>
          <td>${escapeHtml(b.name || '')}</td>
          <td>${escapeHtml(b.position || '')}</td>
          <td>${escapeHtml(b.term_end || '')}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>
</div>
` : ''}

${acceptElectronic ? `
<div class="submit">
  <div class="qr">
    ${qrDataUri ? `<img src="${qrDataUri}" alt="QR code">` : `<div style="width:165px; height:165px; border:1px dashed #94A3B8;"></div>`}
    <div class="scan">Scan with your phone</div>
  </div>
  <div class="copy">
    <div class="h">Submit your nomination online</div>
    <div class="u">${escapeHtml(publicUrl)}</div>
    <p>Use your phone or a computer. You'll provide the nominee's name and address, a brief bio, and an electronic signature. Take a moment with the bio — that's what your neighbors will read on the ballot.</p>
  </div>
</div>
` : ''}

${(acceptElectronic || acceptPhysical || showOnsite) ? `
<div class="other-ways">
  <div class="h">${acceptElectronic ? 'Other ways to submit' : 'How to submit'}</div>
  <ul>
    ${acceptElectronic ? `<li><span class="b">Email:</span> info@bedrocktx.com (include nominee name, address, a brief bio, and a photo if available)</li>` : ''}
    ${acceptPhysical ? `<li><span class="b">Mail:</span> ${escapeHtml(community_name)} HOA, c/o Bedrock Association Management, 12808 West Airport Blvd. #253, Sugar Land, TX 77498</li>` : ''}
    ${showOnsite ? `<li><span class="b">Drop off:</span> ${escapeHtml(onsite.location_name || 'On-site office')}${onsite.address ? ` &mdash; ${escapeHtml(onsite.address)}` : ''}</li>` : ''}
  </ul>
</div>
` : ''}

<div class="deadline">
  <div class="lbl">Nominations Close</div>
  ${escapeHtml(fmtDate(nominations_close_at))}${nominations_close_time ? ` at ${escapeHtml(nominations_close_time)}` : ''}
</div>

${floorNoticeHtml}

${followupLine ? `<p>${escapeHtml(followupLine)}</p>` : ''}

<p>If you have questions about the role or the nomination process, please email <strong>info@bedrocktx.com</strong> or call <strong>(832) 588-2485</strong>. Thank you for your continued participation in the ${escapeHtml(community_name)} community.</p>

<div class="closing">Sincerely,</div>

<div class="signature">
  <div class="line1">Bedrock Association Management</div>
  <div>On behalf of the ${escapeHtml(community_name)} Board of Directors</div>
  <div class="footer-contact">(832) 588-2485 &nbsp;|&nbsp; info@bedrocktx.com &nbsp;|&nbsp; bedrocktx.com</div>
</div>

</body></html>`;
}

module.exports = { renderCallForNominationsHTML };
