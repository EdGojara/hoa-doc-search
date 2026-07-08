// ============================================================================
// lib/email/emma_signature.js  (Ed 2026-07-08)
// ----------------------------------------------------------------------------
// Emma's outbound email: approved reply body + branded Bedrock signature +
// honest-AI line, sent from emma@bedrocktx.com. Mirrors claire_signature.js
// (same logo-as-inline-CID approach) but with Emma's AP identity. Graph-sent
// mail ignores the mailbox's Outlook signature, so it lives in the message.
// ============================================================================
const fs = require('fs');
const path = require('path');

const LOGO_PATH = path.join(__dirname, '..', '..', 'public', 'brand-assets', 'bedrock-mark-email-1x.png');
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
  const logoImg = LOGO_B64 ? `<img src="cid:bedrocklogo" width="165" height="49" alt="Bedrock Association Management" style="display:block;border:0;">` : '';
  return `
  <table cellpadding="0" cellspacing="0" role="presentation" style="margin-top:18px;border-top:2px solid ${GOLD};padding-top:12px;font-family:Arial,Helvetica,sans-serif;">
    <tr>
      <td style="font-size:13px;line-height:1.5;color:${NAVY};">
        <strong style="color:${NAVY};">Emma Brooks</strong><br>
        <span style="color:${MUTED};">Accounts Payable</span><br>
        Bedrock Association Management<br>
        <a href="mailto:emma@bedrocktx.com" style="color:${NAVY};">emma@bedrocktx.com</a> <span style="color:${MUTED};">· (832) 588-2485</span>
      </td>
    </tr>
    ${logoImg ? `<tr><td style="padding-top:14px;">${logoImg}</td></tr>` : ''}
    <tr>
      <td style="padding-top:12px;font-size:11px;color:${MUTED};max-width:420px;">I'm Bedrock's AI team member on accounts payable, so I can get you answers fast. Need a person? Just reply and I'll pass you to the team.</td>
    </tr>
  </table>`;
}

function buildEmmaEmail(bodyText) {
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a2230;">
${bodyToHtml(bodyText)}
${signatureHtml()}
</div>`;
  const attachments = LOGO_B64 ? [{
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: 'bedrock-logo.png', contentType: 'image/png', contentBytes: LOGO_B64,
    contentId: 'bedrocklogo', isInline: true,
  }] : [];
  return { html, attachments };
}

module.exports = { buildEmmaEmail };
