// Call for Nominations letter — Bedrock-branded letterhead PDF that the
// community mails to every homeowner ahead of the annual meeting. Same
// letterhead pattern as decision_letter.js (community logo centered, Sugar
// Land return address, signed by Bedrock on behalf of the community).
//
// Embeds a QR code pointing at /nominate/:slug so homeowners can submit
// directly from their phone. Public_slug is appended into the letter copy.

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
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

async function renderCallForNominationsHTML(cycle, opts = {}) {
  const {
    community_name,
    annual_meeting_date,
    annual_meeting_time,
    annual_meeting_location,
    nominations_open_at,
    nominations_close_at,
    seats_open,
    current_board,
    description,
    public_slug,
    id,
  } = cycle;

  const logo = getCommunityLogo(community_name);
  const base = opts.base_url || 'https://trusted.bedrocktx.com';
  const slug = public_slug || id;
  const publicUrl = `${base}/nominate/${slug}`;

  // QR code as data URI
  let qrDataUri = '';
  try {
    qrDataUri = await QRCode.toDataURL(publicUrl, { width: 220, margin: 1, color: { dark: '#1E2761', light: '#FFFFFF' } });
  } catch (_) { qrDataUri = ''; }

  const boardArr = Array.isArray(current_board) ? current_board : [];
  const boardHtml = boardArr.length
    ? `<table class="board-table">
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
       </table>`
    : '';

  const seats = Number(seats_open) || 1;
  const seatPhrase = seats === 1 ? 'one (1) seat is' : `${seats} seats are`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { size: Letter; margin: 0.85in 0.95in 0.95in 0.95in; }
  body {
    font-family: "Times New Roman", Cambria, Georgia, serif;
    color: #111;
    line-height: 1.45;
    font-size: 11.5pt;
    margin: 0;
  }
  .logo-wrap { text-align: center; margin-bottom: 14px; }
  .logo-wrap img { max-height: 110px; max-width: 220px; }
  .from-block { font-size: 11pt; }
  .from-block .name { font-weight: bold; }
  .date-block { margin-top: 18px; }
  .recipient-block { margin-top: 16px; }
  .subject { margin-top: 18px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px; color: #1E2761; font-size: 12pt; text-align: center; padding-bottom: 6px; border-bottom: 2px solid #1E2761; }
  .salutation { margin-top: 18px; }
  .body-block { margin-top: 12px; }
  .body-block p { margin: 0 0 11px; }
  .meeting-box { margin: 12px 0; padding: 12px 16px; background: #f8fafc; border-left: 3px solid #1E2761; border-radius: 0 6px 6px 0; }
  .meeting-box .lbl { font-size: 9.5pt; color: #475569; letter-spacing: 0.5px; text-transform: uppercase; font-weight: 700; }
  .meeting-box .val { font-size: 12pt; color: #1E2761; font-weight: 700; }
  .meeting-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; margin-top: 6px; }
  .board-table { width: 100%; border-collapse: collapse; margin: 10px 0 14px; font-size: 11pt; }
  .board-table th { text-align: left; font-size: 9.5pt; letter-spacing: 0.5px; text-transform: uppercase; color: #475569; border-bottom: 1.5px solid #1E2761; padding: 4px 6px; }
  .board-table td { padding: 4px 6px; border-bottom: 1px solid #e2e8f0; }
  .submit-box { margin: 14px 0; padding: 14px; border: 1.5px solid #1E2761; border-radius: 8px; display: grid; grid-template-columns: auto 1fr; gap: 16px; align-items: center; }
  .submit-box .qr img { width: 130px; height: 130px; display: block; }
  .submit-box .copy .h { font-size: 12pt; font-weight: 700; color: #1E2761; margin-bottom: 4px; }
  .submit-box .copy .u { font-family: Consolas, Menlo, monospace; font-size: 10.5pt; color: #1E2761; word-break: break-all; }
  .submit-box .copy p { margin: 6px 0 0; font-size: 10.5pt; color: #334155; }
  .closing { margin-top: 16px; }
  .signature { margin-top: 14px; }
  .signature .line1 { font-weight: bold; }
  .footer-contact { margin-top: 6px; font-size: 11pt; color: #111; }
</style></head><body>

<div class="logo-wrap">
  ${logo
    ? `<img src="${logo}" alt="${escapeHtml(community_name)}">`
    : `<div style="font-size:18pt; font-weight:bold;">${escapeHtml(community_name)}</div>`}
</div>

<div class="from-block">
  <div class="name">${escapeHtml(community_name)} Homeowners Association</div>
  <div>c/o Bedrock Association Management, Inc.</div>
  <div>12808 West Airport Blvd. #253</div>
  <div>Sugar Land, TX 77498</div>
</div>

<div class="date-block">${escapeHtml(fmtDate(new Date()))}</div>

<div class="recipient-block">
  <div>Dear ${escapeHtml(community_name)} Homeowner,</div>
</div>

<div class="subject">Call for Nominations — Board of Directors</div>

<div class="body-block">
  <p>The annual meeting of the ${escapeHtml(community_name)} Homeowners Association is scheduled for <strong>${escapeHtml(fmtDate(annual_meeting_date))}</strong>${annual_meeting_time ? ` at <strong>${escapeHtml(annual_meeting_time)}</strong>` : ''}${annual_meeting_location ? `, at <strong>${escapeHtml(annual_meeting_location)}</strong>` : ''}. At that meeting the homeowners will elect members of the Board of Directors.</p>

  <p>This year ${seatPhrase} open for election. ${description ? escapeHtml(description) : 'Any homeowner in good standing is eligible to serve.'} The Board is responsible for setting policy, approving the annual budget, overseeing the management agent, and representing the interests of all homeowners in the community.</p>

  <div class="meeting-box">
    <div class="meeting-grid">
      <div>
        <div class="lbl">Annual Meeting</div>
        <div class="val">${escapeHtml(fmtDate(annual_meeting_date))}</div>
      </div>
      <div>
        <div class="lbl">${seats === 1 ? 'Seat Open' : 'Seats Open'}</div>
        <div class="val">${seats}</div>
      </div>
      <div>
        <div class="lbl">Nominations Open</div>
        <div class="val">${escapeHtml(fmtDate(nominations_open_at))}</div>
      </div>
      <div>
        <div class="lbl">Nominations Close</div>
        <div class="val">${escapeHtml(fmtDate(nominations_close_at))}</div>
      </div>
    </div>
  </div>

  ${boardArr.length ? `<p><strong>Current Board of Directors:</strong></p>${boardHtml}` : ''}

  <p><strong>How to submit a nomination.</strong> You may nominate yourself or a neighbor. Each nominee should be a homeowner in good standing. The form takes less than two minutes — scan the QR code below or visit the link with any web browser.</p>

  <div class="submit-box">
    <div class="qr">
      ${qrDataUri ? `<img src="${qrDataUri}" alt="QR code">` : `<div style="width:130px; height:130px; border:1px dashed #94A3B8;"></div>`}
    </div>
    <div class="copy">
      <div class="h">Submit your nomination online</div>
      <div class="u">${escapeHtml(publicUrl)}</div>
      <p>Provide the nominee's name and address, a short bio statement, and an electronic signature. Nominations close <strong>${escapeHtml(fmtDate(nominations_close_at))}</strong>.</p>
    </div>
  </div>

  <p>If you have questions or would prefer to submit by mail, please contact Bedrock Association Management at the address above or call <strong>(832) 588-2485</strong>.</p>

  <p>Thank you for your continued participation in the ${escapeHtml(community_name)} community.</p>
</div>

<div class="closing">Sincerely,</div>

<div class="signature">
  <div class="line1">Bedrock Association Management</div>
  <div>On behalf of the ${escapeHtml(community_name)} Board of Directors</div>
  <div class="footer-contact">(832) 588-2485 &nbsp;|&nbsp; bedrocktx.com</div>
</div>

</body></html>`;
}

module.exports = { renderCallForNominationsHTML };
