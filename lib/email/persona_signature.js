// ============================================================================
// lib/email/persona_signature.js  (Ed 2026-08-20)
// ----------------------------------------------------------------------------
// ONE branded email signature, identity read from the roster.
//
// There were nine of these files. Nine copies of the same table, the same
// colours and the same logo attachment, each with a name and a job title typed
// into it by hand. That is a tenth copy of "who works here", and roster.js
// exists precisely because hand-mirrored lists drift. Its own header says it:
// "A hand-mirrored list is not a source of truth, it is a promise to remember."
//
// They had already drifted by the time Ed asked whether everyone's signature
// was as complete as Amanda's:
//
//   * Kat signed her mail "Katherine Reed" while the roster, the team board and
//     every other surface called her Kat Reed. A board member meets Kat on the
//     platform and gets email from Katherine.
//   * Emma's title was the bare word "Accounting", not a role, and she was the
//     only teammate whose signature never named the community — the send path
//     called her builder without passing one, so a vendor bill about Waterview
//     never said Waterview.
//   * Reese had no phone number at all, on the one lane where the caller is a
//     title company chasing an estoppel against a closing date.
//
// None of that could be seen from inside any single file, which is the point.
//
// Adding a teammate is now one roster entry. The nine buildXEmail functions
// still exist as thin wrappers so no caller had to change.
// ============================================================================
const fs = require('fs');
const path = require('path');
const { ROSTER } = require('../team/roster');

const LOGO_PATH = path.join(__dirname, '..', '..', 'public', 'brand-assets', 'bedrock-mark-email-sig.png');
let LOGO_B64 = null;
try { LOGO_B64 = fs.readFileSync(LOGO_PATH).toString('base64'); } catch (e) { /* logo optional */ }

// Each teammate's headshot, embedded in the signature so the person's FACE
// travels with the email. The M365 directory photo only resolves for recipients
// inside our tenant; an external board member or a homeowner on gmail just sees
// initials ("AA"). Embedding the photo makes the AI team feel real to the
// customer, which is the whole point (Ed 2026-09-02). Cached per persona.
const PHOTO_DIR = path.join(__dirname, '..', '..', 'public', 'assets', 'presentations', 'team');
const _photoCache = new Map();
function photoB64(persona) {
  const key = String(persona || '').toLowerCase();
  if (_photoCache.has(key)) return _photoCache.get(key);
  let b64 = null;
  try { b64 = fs.readFileSync(path.join(PHOTO_DIR, key + '.jpg')).toString('base64'); } catch (e) { /* headshot optional */ }
  _photoCache.set(key, b64);
  return b64;
}

const NAVY = '#0B1D34';
const GOLD = '#D4AF37';
const MUTED = '#6b7a8d';
const DOMAIN = 'bedrocktx.com';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const byPersona = new Map(ROSTER.map((m) => [m.persona, m]));

/** The identity block for one teammate, straight off the roster. */
function identity(persona) {
  const m = byPersona.get(String(persona || '').toLowerCase());
  if (!m) throw new Error('no roster entry for persona "' + persona + '"');
  if (!m.signature_title) throw new Error(persona + ' has no signature_title in the roster');
  // self_mailbox is stored as "amanda@" — the alias people reply to, which is
  // not always the Graph identity the mail is sent from (amandaalbright@).
  const local = String(m.self_mailbox || '').replace(/@$/, '');
  return {
    name: m.name,
    title: m.signature_title,
    email: local ? local + '@' + DOMAIN : null,
    phone: m.signature_phone || null,
  };
}

function bodyToHtml(text) {
  // A standalone short line with no terminal punctuation, sitting between the
  // greeting and the sign-off, is a section header (e.g. "What the revision
  // resolved", "Recommendation"). Bold those so a structured email reads like a
  // clean document instead of a wall of paragraphs (Ed 2026-09-02). The greeting
  // (ends in a comma) and the sign-off (last paragraph) are excluded, so a
  // conversational homeowner email with no such lines is unaffected.
  const paras = String(text || '').trim().split(/\n{2,}/);
  return paras.map((p, i) => {
    const t = p.trim();
    const isHeader = !/\n/.test(p) && i > 0 && i < paras.length - 1
      && t.length >= 3 && t.length <= 70 && !/[.,:;!?]$/.test(t);
    if (isHeader) {
      return '<p style="margin:18px 0 8px;"><strong style="color:' + NAVY + ';">' + esc(t) + '</strong></p>';
    }
    return '<p style="margin:0 0 12px;">' + esc(p).replace(/\n/g, '<br>') + '</p>';
  }).join('\n');
}

function signatureHtml(persona, communityName) {
  const me = identity(persona);
  const headImg = photoB64(persona)
    ? '<img src="cid:headshot" width="64" height="64" alt="' + esc(me.name) + '" style="width:64px;height:64px;border-radius:50%;display:block;border:0;object-fit:cover;">'
    : '';
  const logoImg = LOGO_B64
    ? '<img src="cid:bedrocklogo" width="150" height="45" alt="Bedrock Association Management" style="width:150px;height:45px;max-width:150px;display:block;border:0;">'
    : '';
  const contact = [
    me.email ? '<a href="mailto:' + me.email + '" style="color:' + NAVY + ';">' + me.email + '</a>' : '',
    me.phone ? '<span style="color:' + MUTED + ';">· ' + esc(me.phone) + '</span>' : '',
  ].filter(Boolean).join(' ');

  const identityCell = '<td style="font-size:13px;line-height:1.5;color:' + NAVY + ';vertical-align:top;">\n'
    + '        <strong style="color:' + NAVY + ';">' + esc(me.name) + '</strong><br>\n'
    + '        <span style="color:' + MUTED + ';">' + esc(me.title) + '</span><br>\n'
    + '        Bedrock Association Management' + (communityName ? ' — ' + esc(communityName) : '') + '<br>\n'
    + '        ' + contact + '\n'
    + '      </td>';

  return '\n  <table cellpadding="0" cellspacing="0" role="presentation" style="margin-top:18px;border-top:2px solid ' + GOLD + ';padding-top:12px;font-family:Arial,Helvetica,sans-serif;">\n'
    + '    <tr>\n'
    + (headImg ? '      <td style="vertical-align:top;padding-right:12px;">' + headImg + '</td>\n' : '')
    + '      ' + identityCell + '\n'
    + '    </tr>\n'
    + (logoImg ? '    <tr><td' + (headImg ? ' colspan="2"' : '') + ' style="padding-top:14px;">' + logoImg + '</td></tr>\n' : '')
    + '    <tr>\n'
    // The soft mark Ed settled on: present, not announced. No teammate says
    // "AI assistant" in the body, and nothing here leads with it.
    + '      <td' + (headImg ? ' colspan="2"' : '') + ' style="padding-top:12px;font-size:11px;color:' + MUTED + ';max-width:420px;">Powered by Bedrock Intelligence. A member of our team is always available if you need assistance.</td>\n'
    + '    </tr>\n'
    + '  </table>';
}

/**
 * Body plus signature, with the inline logo attachment Graph needs.
 *
 * @param quotedHtml  the message being replied to, from
 *                    lib/email/quote_original.js. Goes BELOW the signature,
 *                    which is where Outlook and Gmail both put it. Ed
 *                    2026-08-20: "we should be including the email history."
 *                    Optional, because a first-contact email has none.
 */
function buildPersonaEmail(persona, bodyText, communityName, quotedHtml) {
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a2230;">\n'
    + bodyToHtml(bodyText) + '\n'
    + signatureHtml(persona, communityName) + '\n'
    + (quotedHtml || '') + '\n'
    + '</div>';
  const attachments = [];
  const head = photoB64(persona);
  if (head) attachments.push({
    '@odata.type': '#microsoft.graph.fileAttachment', name: 'headshot.jpg',
    contentType: 'image/jpeg', contentBytes: head, contentId: 'headshot', isInline: true,
  });
  if (LOGO_B64) attachments.push({
    '@odata.type': '#microsoft.graph.fileAttachment', name: 'bedrock-logo.png',
    contentType: 'image/png', contentBytes: LOGO_B64, contentId: 'bedrocklogo', isInline: true,
  });
  return { html, attachments };
}

module.exports = { buildPersonaEmail, signatureHtml, identity, bodyToHtml };
