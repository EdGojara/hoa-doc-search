// ============================================================================
// lib/email/quote_original.js  (Ed 2026-08-20)
// ----------------------------------------------------------------------------
// The quoted message underneath a reply.
//
// Ed: "i know we've talked about this before but we should be including the
// email history."
//
// Every persona reply went out as a bare paragraph and a signature, with the
// message being replied to nowhere on it. Three things break when you do that:
//
//   1. The recipient loses the thread. Martha gets "I'm doing well, thanks!"
//      under a subject of "Re: (none)" and has to remember what she asked.
//   2. Mail clients thread on References and In-Reply-To, but PEOPLE thread on
//      seeing the text. A reply with no quote reads as though it came out of
//      nowhere, and it is the single clearest tell that something automated
//      wrote it.
//   3. Forwarding it to a third party carries no context, which matters most on
//      exactly the threads that get forwarded: vendor, bank, attorney, board.
//
// ONE helper, used by every persona send, so a new teammate cannot ship without
// history the way each new signature file used to ship with its own copy of the
// name and title. See lib/email/persona_signature.js for the same lesson.
// ============================================================================

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const NAVY = '#0B1D34';
const MUTED = '#6b7a8d';
const LINE = '#d8dee7';

/** "Thursday, August 20, 2026 at 4:50 PM" in Central, the way Outlook writes it. */
function whenLine(sentAt) {
  if (!sentAt) return null;
  const d = new Date(sentAt);
  if (isNaN(d.getTime())) return null;
  try {
    return d.toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch (_) { return d.toISOString(); }
}

/** Plain text to HTML paragraphs, preserving the shape of the original. */
function textToHtml(text) {
  return String(text || '').trim().split(/\n{2,}/)
    .map((p) => '<p style="margin:0 0 10px;">' + esc(p).replace(/\n/g, '<br>') + '</p>')
    .join('\n');
}

/**
 * The quoted block that goes BELOW the reply and the signature, which is where
 * Outlook and Gmail both put it.
 *
 * @param {object} o
 * @param {string} o.fromName
 * @param {string} o.fromEmail
 * @param {string} o.sentAt      ISO timestamp of the original
 * @param {string|string[]} o.to recipients of the original
 * @param {string} o.subject
 * @param {string} o.bodyText    the original message as readable text
 * @param {number} o.maxChars    trim very long threads (default 20000)
 * @returns {string} HTML, or '' when there is nothing worth quoting
 */
function quotedOriginal({ fromName, fromEmail, sentAt, to, subject, bodyText, maxChars = 20000 } = {}) {
  const body = String(bodyText || '').trim();
  // Nothing to quote is not an error. A first-contact email has no history, and
  // an empty bordered box under the signature looks broken.
  if (!body) return '';

  const who = [fromName, fromEmail && fromEmail !== fromName ? '<' + fromEmail + '>' : '']
    .filter(Boolean).join(' ').trim();
  const toList = Array.isArray(to) ? to.filter(Boolean).join('; ') : (to || '');
  const when = whenLine(sentAt);

  const header = [
    who ? '<b>From:</b> ' + esc(who) : null,
    when ? '<b>Sent:</b> ' + esc(when) : null,
    toList ? '<b>To:</b> ' + esc(toList) : null,
    // A missing subject is left out rather than printed as "(none)", which is
    // how "Re: (none)" ended up on a real reply to Martha.
    subject && String(subject).trim() ? '<b>Subject:</b> ' + esc(String(subject).trim()) : null,
  ].filter(Boolean).join('<br>');

  const truncated = body.length > maxChars;
  const shown = truncated ? body.slice(0, maxChars) : body;

  return '\n<div style="margin-top:22px;padding-top:14px;border-top:1px solid ' + LINE + ';'
    + 'font-family:Arial,Helvetica,sans-serif;font-size:12.5px;line-height:1.5;color:' + NAVY + ';">\n'
    + (header ? '  <div style="margin:0 0 12px;color:' + MUTED + ';">' + header + '</div>\n' : '')
    + '  <div style="border-left:2px solid ' + LINE + ';padding-left:12px;color:' + NAVY + ';">\n'
    + textToHtml(shown)
    + (truncated ? '\n<p style="margin:0;color:' + MUTED + ';">[earlier messages trimmed]</p>' : '')
    + '\n  </div>\n</div>';
}

/**
 * "Re: ..." done properly.
 *
 * Never returns "Re: (none)". A message with no subject gets a plain "Re:"
 * rather than echoing a placeholder that was only ever meant for the screen.
 */
function replySubject(original) {
  const s = String(original || '').trim();
  // Placeholders the UI uses for display, which must never reach a recipient.
  const isPlaceholder = !s || /^\(?(none|no subject)\)?$/i.test(s);
  if (isPlaceholder) return 'Re:';
  return /^re\s*:/i.test(s) ? s : 'Re: ' + s;
}

module.exports = { quotedOriginal, replySubject, whenLine };
