// ============================================================================
// lib/email/claire_signature.js  (Ed 2026-07-06)
// ----------------------------------------------------------------------------
// Build the HTML email Claire actually sends: the approved reply body + a
// branded Bedrock signature with logo + the honest-AI line. Graph-sent mail
// ignores the mailbox's Outlook signature, so the signature has to live in the
// message we send — this is that.
//
// The logo is delivered as an INLINE CID attachment (not a data: URI and not a
// hosted URL) so it renders reliably across clients including Gmail, and works
// even though the app's static assets are auth-gated. Referenced in the HTML as
// <img src="cid:bedrocklogo">.
// ============================================================================
const fs = require('fs');
const path = require('path');

const LOGO_PATH = path.join(__dirname, '..', '..', 'public', 'brand-assets', 'bedrock-mark-email-1x.png');
let LOGO_B64 = null;
try { LOGO_B64 = fs.readFileSync(LOGO_PATH).toString('base64'); } catch (e) { /* logo optional; signature still renders without it */ }

const NAVY = '#0B1D34';
const GOLD = '#D4AF37';
const MUTED = '#6b7a8d';

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Plain draft text -> simple HTML paragraphs (blank line = new paragraph,
// single newline = <br>). Keeps Claire's wording exactly; just formats it.
function bodyToHtml(text) {
  const paras = String(text || '').trim().split(/\n{2,}/).map((p) =>
    `<p style="margin:0 0 12px;">${esc(p).replace(/\n/g, '<br>')}</p>`);
  return paras.join('\n');
}

function signatureHtml(communityName) {
  // Native logo is 600x178 (a wide horizontal lockup). Render at that aspect
  // ratio — a forced square crushes it and makes "BEDROCK" unreadable.
  const logoImg = LOGO_B64 ? `<img src="cid:bedrocklogo" width="165" height="49" alt="Bedrock Association Management" style="display:block;border:0;">` : '';
  // Single column: contact block on top, logo underneath (matches Ed's own
  // signature layout), honest-AI disclosure last.
  return `
  <table cellpadding="0" cellspacing="0" role="presentation" style="margin-top:18px;border-top:2px solid ${GOLD};padding-top:12px;font-family:Arial,Helvetica,sans-serif;">
    <tr>
      <td style="font-size:13px;line-height:1.5;color:${NAVY};">
        <strong style="color:${NAVY};">Claire</strong><br>
        <span style="color:${MUTED};">Customer Support Specialist</span><br>
        Bedrock Association Management${communityName ? ` — ${esc(communityName)}` : ''}<br>
        <a href="mailto:claire@bedrocktx.com" style="color:${NAVY};">claire@bedrocktx.com</a> <span style="color:${MUTED};">· (832) 588-2485</span>
      </td>
    </tr>
    ${logoImg ? `<tr><td style="padding-top:14px;">${logoImg}</td></tr>` : ''}
    <tr>
      <td style="padding-top:12px;font-size:11px;color:${MUTED};max-width:420px;">I'm Bedrock's AI team member, so I can help fast. Want a person instead? Just reply and I'll pass you to the team.</td>
    </tr>
  </table>`;
}

// Returns { html, attachments } ready for graph sendMail.
function buildClaireEmail(bodyText, communityName) {
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a2230;">
${bodyToHtml(bodyText)}
${signatureHtml(communityName)}
</div>`;
  const attachments = LOGO_B64 ? [{
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: 'bedrock-logo.png',
    contentType: 'image/png',
    contentBytes: LOGO_B64,
    contentId: 'bedrocklogo',
    isInline: true,
  }] : [];
  return { html, attachments };
}

module.exports = { buildClaireEmail };
