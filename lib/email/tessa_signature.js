// ============================================================================
// lib/email/tessa_signature.js  (Ed 2026-07-13, upgraded 2026-07-29)
// ----------------------------------------------------------------------------
// Tessa McCall — Ed's executive assistant. When she sends correspondence AS
// Tessa she now carries the FULL branded signature (logo + gold rule + honest-
// AI disclosure), same pattern as the front-office personas (see
// annie_signature.js) — because she is sending real correspondence, not just a
// personal note. Only the name/title/mailbox differ.
//   - Title is "Executive Assistant," full stop — NO owner (Ed's) name in it.
//   - Not community-scoped: no community name in the org line.
//   - No invented phone number.
// When she GHOSTWRITES as Ed the email carries no signature block (it's his
// own) — that path never calls this builder.
// ============================================================================
const fs = require('fs');
const path = require('path');

const LOGO_PATH = path.join(__dirname, '..', '..', 'public', 'brand-assets', 'bedrock-mark-email-sig.png');
let LOGO_B64 = null;
try { LOGO_B64 = fs.readFileSync(LOGO_PATH).toString('base64'); } catch (e) { /* logo optional */ }

const NAVY = '#0B1D34';
const GOLD = '#D4AF37';
const MUTED = '#6b7a8d';
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function bodyToHtml(text) {
  return String(text || '').trim().split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px;">${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');
}

function signatureHtml() {
  const logoImg = LOGO_B64 ? `<img src="cid:bedrocklogo" width="150" height="45" alt="Bedrock Association Management" style="width:150px;height:45px;max-width:150px;display:block;border:0;">` : '';
  return `
  <table cellpadding="0" cellspacing="0" role="presentation" style="margin-top:18px;border-top:2px solid ${GOLD};padding-top:12px;font-family:Arial,Helvetica,sans-serif;">
    <tr>
      <td style="font-size:13px;line-height:1.5;color:${NAVY};">
        <strong style="color:${NAVY};">Tessa McCall</strong><br>
        <span style="color:${MUTED};">Executive Assistant</span><br>
        Bedrock Association Management<br>
        <a href="mailto:tessa@bedrocktx.com" style="color:${NAVY};">tessa@bedrocktx.com</a>
      </td>
    </tr>
    ${logoImg ? `<tr><td style="padding-top:14px;">${logoImg}</td></tr>` : ''}
    <tr>
      <td style="padding-top:12px;font-size:11px;color:${MUTED};max-width:420px;">Powered by Bedrock Intelligence. A member of our team is always available if you need assistance.</td>
    </tr>
  </table>`;
}

function buildTessaEmail(bodyText) {
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a2230;">
${bodyToHtml(bodyText)}
${signatureHtml()}
</div>`;
  const attachments = LOGO_B64 ? [{
    '@odata.type': '#microsoft.graph.fileAttachment', name: 'bedrock-logo.png',
    contentType: 'image/png', contentBytes: LOGO_B64, contentId: 'bedrocklogo', isInline: true,
  }] : [];
  return { html, attachments };
}

module.exports = { buildTessaEmail };
