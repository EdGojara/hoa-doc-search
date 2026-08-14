// ============================================================================
// lib/email/portal_invite.js  (Ed 2026-08-14)
// ----------------------------------------------------------------------------
// The portal invitation email — the FIRST thing a board member or homeowner
// sees from Bedrock. Understated and professional (the Porsche bar): white
// space, one navy header, one gold action, no clutter. Customer copy: commas
// not em-dashes, community-specific, no vendor/AI branding.
// ============================================================================

const { sendEmail } = require('../notifications/email');

const NAVY = '#0B1D34';
const GOLD = '#D4AF37';
const INK = '#334155';
const FAINT = '#94a3b8';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderInviteEmail({ toName, communityName, magicLink, role }) {
  const isBoard = role === 'board_member';
  const community = communityName || 'your community';
  const portalLabel = isBoard ? 'board portal' : 'resident portal';
  const first = toName ? String(toName).trim().split(/\s+/)[0] : '';
  const greeting = first ? `Hi ${esc(first)},` : 'Hello,';
  const capability = isBoard
    ? 'your community’s finances, open violations, architectural requests, documents, and board motions, all in one place'
    : 'your balance, online assessment payments, community documents, and requests, all in one place';

  const html = `<!doctype html>
<html>
<body style="margin:0; padding:0; background:#f1f3f6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f3f6; padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px; background:#ffffff; border-radius:14px; overflow:hidden; border:1px solid #e6e9ee;">
        <tr><td style="background:${NAVY}; padding:26px 32px;">
          <div style="color:#ffffff; font-family:Georgia,'Times New Roman',serif; font-size:19px; font-weight:700; letter-spacing:0.2px;">Bedrock Association Management</div>
          <div style="color:${GOLD}; font-family:Arial,Helvetica,sans-serif; font-size:12px; letter-spacing:1.5px; text-transform:uppercase; margin-top:4px;">${esc(community)}</div>
        </td></tr>
        <tr><td style="padding:32px 32px 8px 32px; font-family:Arial,Helvetica,sans-serif; color:${INK}; font-size:15px; line-height:1.6;">
          <p style="margin:0 0 14px 0;">${greeting}</p>
          <p style="margin:0 0 14px 0;">Your ${esc(community)} ${portalLabel} is ready. It gives you ${capability}.</p>
          <p style="margin:0 0 26px 0;">Click below to open it. No password to remember, the link signs you in.</p>
        </td></tr>
        <tr><td align="center" style="padding:0 32px 30px 32px;">
          <a href="${esc(magicLink)}" style="display:inline-block; background:${GOLD}; color:${NAVY}; font-family:Arial,Helvetica,sans-serif; font-size:15px; font-weight:700; text-decoration:none; padding:13px 34px; border-radius:9px;">Open your portal</a>
        </td></tr>
        <tr><td style="padding:0 32px 30px 32px; font-family:Arial,Helvetica,sans-serif; color:${FAINT}; font-size:12px; line-height:1.6; border-top:1px solid #eef1f5;">
          <p style="margin:16px 0 0 0;">This link is personal to you and expires in 7 days. If it expires, you can request a new one from the portal sign-in page.</p>
        </td></tr>
      </table>
      <div style="font-family:Arial,Helvetica,sans-serif; color:${FAINT}; font-size:11px; margin-top:16px;">Bedrock Association Management</div>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `${greeting}

Your ${community} ${portalLabel} is ready. It gives you ${capability.replace(/’/g, "'")}.

Open your portal: ${magicLink}

No password to remember, the link signs you in. It is personal to you and expires in 7 days. If it expires, request a new one from the portal sign-in page.

Bedrock Association Management`;

  return { subject: `Your ${community} ${portalLabel} access`, html, text };
}

async function sendPortalInvite({ toEmail, toName, communityName, magicLink, role }) {
  if (!toEmail || !magicLink) throw new Error('toEmail and magicLink are required');
  const { subject, html, text } = renderInviteEmail({ toName, communityName, magicLink, role });
  return sendEmail({ to: toEmail, subject, html, text });
}

module.exports = { sendPortalInvite, renderInviteEmail };
