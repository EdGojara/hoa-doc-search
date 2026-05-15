// ============================================================================
// paper_form.js
// ----------------------------------------------------------------------------
// One-page printable Bedrock-branded "Board Nomination Request Form" — the
// fourth submission channel after online form, scanned upload, and staff
// manual entry. Mailed with the Call for Nominations letter, available as
// a standalone download, and printable at the on-site office.
//
// Filled out by hand → mailed/emailed/dropped off back → OCR pipeline
// (extract_from_scan.js) reads it → staff manual-entry modal pre-fills.
// One backend, four channels, equal effort.
//
// Layout philosophy: lines and boxes a person can fill in with a pen in
// 5 minutes. No marketing language. Community letterhead at the top,
// submission instructions clearly stated, signature + date at the bottom.
// ============================================================================

const fs = require('fs');
const path = require('path');

const LOGOS_DIR = path.join(__dirname, '..', '..', 'public', 'logos');

const COMMUNITY_LOGOS = {
  'Lakes of Pine Forest':        'lakes_of_pine_forest_logo.png',
  'Canyon Gate at Cinco Ranch':  'canyon_gate_logo.png',
  'Canyon Gate':                 'canyon_gate_logo.png',
  'Waterview Estates':           'waterview_logo.jpg',
  'Waterview':                   'waterview_logo.jpg',
};
const _dataUriCache = {};
function logoDataUri(filename) {
  if (!filename) return '';
  if (_dataUriCache[filename] !== undefined) return _dataUriCache[filename];
  try {
    const buf = fs.readFileSync(path.join(LOGOS_DIR, filename));
    const mime = filename.toLowerCase().endsWith('.jpg') || filename.toLowerCase().endsWith('.jpeg')
      ? 'image/jpeg' : 'image/png';
    _dataUriCache[filename] = `data:${mime};base64,` + buf.toString('base64');
  } catch (_) {
    _dataUriCache[filename] = '';
  }
  return _dataUriCache[filename];
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

// renderPaperFormHTML — pure HTML the puppeteer pipeline turns into a PDF.
// Inputs: cycle row + optional opts override for submission contact info.
async function renderPaperFormHTML(cycle, opts = {}) {
  const community = cycle.community_name || 'the Association';
  const legalName = cycle.association_legal_name || `${community} Homeowners Association, Inc.`;
  const closeDate = cycle.nominations_close_at;
  const onsite = cycle.onsite_drop_off || {};
  const showOnsite = !!onsite.enabled && (onsite.address || onsite.location_name);

  const mailAddr = opts.mail_address || '12808 West Airport Blvd, Ste 253, Sugar Land, TX 77478';
  const emailAddr = opts.email_address || 'info@bedrocktx.com';
  const phone = opts.phone || '(832) 588-2485';

  const logo = getCommunityLogo(community);

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { size: Letter; margin: 0.6in 0.75in 0.65in 0.75in; }
  body {
    font-family: Georgia, Cambria, "Times New Roman", serif;
    color: #1a1a1a;
    line-height: 1.5;
    font-size: 10.5pt;
    margin: 0;
  }

  /* Letterhead */
  .head { text-align: center; padding-bottom: 10px; border-bottom: 2px solid #1E2761; margin-bottom: 12px; }
  .head img { max-height: 64px; max-width: 180px; display: block; margin: 0 auto 4px; }
  .head .legal { font-size: 13pt; font-weight: 700; color: #1E2761; letter-spacing: 0.3px; }
  .head .sub { font-size: 10pt; color: #475569; margin-top: 2px; }

  .doc-title {
    text-align: center;
    font-family: Calibri, Arial, sans-serif;
    font-size: 14pt;
    letter-spacing: 2.5px;
    text-transform: uppercase;
    color: #1E2761;
    font-weight: 700;
    margin: 10px 0 8px;
  }

  .deadline {
    margin: 6px 0 14px;
    padding: 6px 12px;
    background: #1E2761;
    color: #fff;
    border-radius: 5px;
    font-size: 11pt;
    font-weight: 700;
    text-align: center;
  }
  .deadline .lbl { font-family: Calibri, Arial, sans-serif; font-size: 8pt; letter-spacing: 1.4px; text-transform: uppercase; color: #CADCFC; font-weight: 700; }

  /* Self/Other checkbox row */
  .self-row {
    display: flex; gap: 22px; align-items: center;
    margin: 4px 0 12px;
    padding: 8px 12px;
    background: #f8fafc;
    border-left: 3px solid #1E2761;
    border-radius: 0 5px 5px 0;
    font-size: 10pt;
  }
  .self-row .opt { display: inline-flex; align-items: center; gap: 6px; }
  .opt-box { font-family: Consolas, monospace; font-size: 12pt; color: #1E2761; }

  /* Fillable field rows */
  .fld { margin-bottom: 10px; }
  .fld label {
    display: block;
    font-family: Calibri, Arial, sans-serif;
    font-size: 8.5pt;
    letter-spacing: 0.7px;
    text-transform: uppercase;
    color: #475569;
    font-weight: 700;
    margin-bottom: 2px;
  }
  .fld .line {
    width: 100%;
    border-bottom: 1px solid #1a1a1a;
    height: 22px;
  }
  .fld-row { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }

  .bio-box {
    border: 1px solid #94A3B8;
    border-radius: 4px;
    padding: 6px 8px;
    height: 120px;
    background:
      repeating-linear-gradient(
        to bottom,
        transparent 0px,
        transparent 23px,
        #d0d7de 23px,
        #d0d7de 24px
      );
  }
  .bio-hint { font-size: 8.5pt; color: #94A3B8; font-style: italic; margin-top: 2px; }

  /* Photo paste area */
  .photo-area {
    display: grid;
    grid-template-columns: 1.4fr 1fr;
    gap: 14px;
    margin: 14px 0 10px;
  }
  .photo-instructions { font-size: 9.5pt; color: #334155; line-height: 1.55; }
  .photo-instructions strong { color: #1E2761; }
  .photo-box {
    border: 1.5px dashed #94A3B8;
    border-radius: 6px;
    height: 130px;
    display: flex; align-items: center; justify-content: center;
    text-align: center;
    color: #94A3B8;
    font-size: 9pt;
    font-style: italic;
  }

  /* Signature + date row */
  .sig-row {
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 18px;
    margin: 14px 0 6px;
  }
  .sig-line { border-bottom: 1px solid #1a1a1a; height: 28px; }
  .sig-label {
    font-family: Calibri, Arial, sans-serif;
    font-size: 8pt;
    letter-spacing: 0.7px;
    text-transform: uppercase;
    color: #475569;
    font-weight: 700;
    margin-top: 2px;
  }
  .form-must-sign {
    margin-top: 4px;
    padding: 6px 10px;
    background: #fefce8;
    border-left: 3px solid #ca8a04;
    border-radius: 0 5px 5px 0;
    font-size: 9.5pt;
    color: #78350f;
  }

  /* Submission instructions */
  .submit-box {
    margin-top: 10px;
    padding: 10px 14px;
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 5px;
    font-size: 9.5pt;
  }
  .submit-box .hdr {
    font-family: Calibri, Arial, sans-serif;
    font-size: 9pt;
    letter-spacing: 0.8px;
    text-transform: uppercase;
    color: #1E2761;
    font-weight: 700;
    margin-bottom: 4px;
  }
  .submit-box ul { margin: 4px 0 0 18px; padding: 0; }
  .submit-box li { margin: 2px 0; }

  .footer {
    margin-top: 10px;
    padding-top: 6px;
    border-top: 1px solid #e2e8f0;
    text-align: center;
    font-size: 8pt;
    color: #475569;
  }
</style></head><body>

<div class="head">
  ${logo
    ? `<img src="${logo}" alt="${escapeHtml(community)}">`
    : `<div style="font-size:18pt; font-weight:700; color:#1E2761;">${escapeHtml(community)}</div>`}
  <div class="legal">${escapeHtml(legalName)}</div>
  <div class="sub">Board of Directors</div>
</div>

<div class="doc-title">Board Nomination Request Form</div>

${closeDate ? `
<div class="deadline">
  <div class="lbl">Submission Deadline</div>
  ${escapeHtml(fmtDate(closeDate))}${cycle.nominations_close_time ? ` at ${escapeHtml(cycle.nominations_close_time)}` : ''}
</div>
` : ''}

<div class="self-row">
  <strong style="color:#1E2761;">I am submitting this nomination:</strong>
  <span class="opt"><span class="opt-box">[&nbsp;&nbsp;]</span> For myself</span>
  <span class="opt"><span class="opt-box">[&nbsp;&nbsp;]</span> On behalf of a neighbor</span>
</div>

<div class="fld">
  <label>Nominee&rsquo;s Full Name</label>
  <div class="line"></div>
</div>
<div class="fld">
  <label>Property Address (in ${escapeHtml(community)})</label>
  <div class="line"></div>
</div>
<div class="fld-row">
  <div class="fld">
    <label>Nominee Email</label>
    <div class="line"></div>
  </div>
  <div class="fld">
    <label>Nominee Phone</label>
    <div class="line"></div>
  </div>
</div>
<div class="fld-row">
  <div class="fld">
    <label>Years in ${escapeHtml(community)} <span style="color:#94A3B8; font-weight:400; text-transform:none; letter-spacing:0;">(optional)</span></label>
    <div class="line"></div>
  </div>
  <div class="fld">
    <label>If nominating a neighbor &mdash; your name</label>
    <div class="line"></div>
  </div>
</div>

<div class="fld">
  <label>Bio Statement <span style="color:#94A3B8; font-weight:400; text-transform:none; letter-spacing:0;">(background, qualifications, what you&rsquo;d bring to the Board)</span></label>
  <div class="bio-box"></div>
  <div class="bio-hint">This appears on the ballot exactly as written. If you need more space, attach a separate sheet.</div>
</div>

<div class="photo-area">
  <div class="photo-instructions">
    <strong>Photo (optional but encouraged).</strong> A head-and-shoulders photo helps your neighbors recognize you on the ballot. Include a photo with this form when you return it &mdash; printed, attached, or as a separate digital file if emailing.
  </div>
  <div class="photo-box">Submit photo<br>with this form</div>
</div>

<div class="sig-row">
  <div>
    <div class="sig-line"></div>
    <div class="sig-label">Signature of person submitting this form</div>
  </div>
  <div>
    <div class="sig-line"></div>
    <div class="sig-label">Date</div>
  </div>
</div>

<div class="form-must-sign">
  <strong>FORM MUST BE SIGNED TO BE VALID.</strong> Bedrock will confirm receipt of your nomination by email and phone within one business day.
</div>

<div class="submit-box">
  <div class="hdr">Return this completed form by one of the following methods</div>
  <ul>
    <li><strong>Email:</strong> ${escapeHtml(emailAddr)}</li>
    <li><strong>Mail:</strong> ${escapeHtml(community)} HOA, c/o Bedrock Association Management, ${escapeHtml(mailAddr)}</li>
    ${showOnsite ? `<li><strong>Drop-off:</strong> ${escapeHtml(onsite.location_name || 'On-site office')}${onsite.address ? ' &mdash; ' + escapeHtml(onsite.address) : ''}</li>` : ''}
  </ul>
</div>

<div class="footer">
  ${escapeHtml(legalName)} &nbsp;|&nbsp; c/o Bedrock Association Management, LLC &nbsp;|&nbsp; ${escapeHtml(mailAddr)} &nbsp;|&nbsp; ${escapeHtml(phone)} &nbsp;|&nbsp; bedrocktx.com
</div>

</body></html>`;
}

module.exports = { renderPaperFormHTML };
