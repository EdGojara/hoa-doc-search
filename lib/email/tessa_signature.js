// ============================================================================
// lib/email/tessa_signature.js  (Ed 2026-07-13)
// ----------------------------------------------------------------------------
// Tessa McCall — Ed's executive assistant. A LIGHT branded sign-off (brand
// colors + a gold accent line), NOT the full customer signature: no logo, no
// phone, no honest-AI disclosure. Her mail is Ed's personal correspondence, not
// a Bedrock front-office persona. Only used when she sends AS Tessa; when she
// ghostwrites AS Ed the email carries no signature block (it's his own).
// Per Ed: no owner name in it — "Executive Assistant," full stop.
// ============================================================================
const NAVY = '#0B1D34';
const GOLD = '#D4AF37';
const MUTED = '#6b7a8d';
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function bodyToHtml(text) {
  return String(text || '').trim().split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px;">${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');
}

function buildTessaEmail(bodyText) {
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a2230;">
${bodyToHtml(bodyText)}
<table cellpadding="0" cellspacing="0" role="presentation" style="margin-top:16px;border-top:2px solid ${GOLD};padding-top:10px;font-family:Arial,Helvetica,sans-serif;">
  <tr>
    <td style="font-size:13px;line-height:1.5;color:${NAVY};">
      <strong style="color:${NAVY};">Tessa McCall</strong><br>
      <span style="color:${MUTED};">Executive Assistant</span><br>
      Bedrock Association Management<br>
      <a href="mailto:tessa@bedrocktx.com" style="color:${NAVY};">tessa@bedrocktx.com</a>
    </td>
  </tr>
</table>
</div>`;
  return { html, attachments: [] };
}

module.exports = { buildTessaEmail };
