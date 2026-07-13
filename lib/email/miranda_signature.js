// ============================================================================
// lib/email/miranda_signature.js  (Ed 2026-07-12)
// ----------------------------------------------------------------------------
// Miranda Pierce — Bedrock's DRV / compliance coordinator. Builds the HTML she
// sends when a human approves her drafted reply to a homeowner's response on an
// open enforcement case. Same branded-logo + honest-AI pattern as Claire (see
// claire_signature.js); only the name, title, and mailbox differ.
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

function signatureHtml(communityName) {
  const logoImg = LOGO_B64 ? `<img src="cid:bedrocklogo" width="165" height="49" alt="Bedrock Association Management" style="display:block;border:0;">` : '';
  return `
  <table cellpadding="0" cellspacing="0" role="presentation" style="margin-top:18px;border-top:2px solid ${GOLD};padding-top:12px;font-family:Arial,Helvetica,sans-serif;">
    <tr>
      <td style="font-size:13px;line-height:1.5;color:${NAVY};">
        <strong style="color:${NAVY};">Miranda Pierce</strong><br>
        <span style="color:${MUTED};">Compliance Coordinator</span><br>
        Bedrock Association Management${communityName ? ` — ${esc(communityName)}` : ''}<br>
        <a href="mailto:miranda@bedrocktx.com" style="color:${NAVY};">miranda@bedrocktx.com</a> <span style="color:${MUTED};">· (832) 588-2485</span>
      </td>
    </tr>
    ${logoImg ? `<tr><td style="padding-top:14px;">${logoImg}</td></tr>` : ''}
    <tr>
      <td style="padding-top:12px;font-size:11px;color:${MUTED};max-width:420px;">I'm Bedrock's AI team member, so I can help fast. Want a person instead? Just reply and I'll pass you to the team.</td>
    </tr>
  </table>`;
}

function buildMirandaEmail(bodyText, communityName) {
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a2230;">
${bodyToHtml(bodyText)}
${signatureHtml(communityName)}
</div>`;
  const attachments = LOGO_B64 ? [{
    '@odata.type': '#microsoft.graph.fileAttachment', name: 'bedrock-logo.png',
    contentType: 'image/png', contentBytes: LOGO_B64, contentId: 'bedrocklogo', isInline: true,
  }] : [];
  return { html, attachments };
}

module.exports = { buildMirandaEmail };
