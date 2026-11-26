// ============================================================================
// lib/acc/received_date.js  (Ed 2026-11-26)
// ----------------------------------------------------------------------------
// WHEN WAS THE APPLICATION RECEIVED? The homeowner's own submission time, not
// the time a property manager forwarded it and not the time we processed it.
//
// Scar: 6331 Clear Canyon (Canyon Gate). The homeowner sent the application to
// the property manager at 11:19 AM on 11/26; she forwarded it to annie@ at
// 12:14 PM. The case only knew 12:17 PM (created_at). Review deadlines run
// from the homeowner's submission, so the forward's quoted header is the
// evidence of that time and is read here.
//
// Reads the FIRST quoted header block of a forward (Outlook "From/Sent", Gmail
// "---------- Forwarded message ---------" "Date:", or "On <date>, X wrote:").
// A time without a zone is read as Central time (Bedrock is in Texas). A parsed
// time is used only when it is not after the email's own arrival and not more
// than 120 days before it; otherwise the email's arrival time is the receipt.
//
//   originalReceivedAt({ subject, body, receivedAt })
//     -> { at: ISO string | null, basis: 'forwarded_original' | 'email_received' }
// ============================================================================

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const MAX_BACK_DAYS = 120;

const toText = (s) => String(s || '')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ');

// Offset (minutes) of America/Chicago from UTC at a given UTC instant.
function chicagoOffsetMinutes(utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(utcMs)).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return Math.round((asUtc - utcMs) / 60000);
}

// Wall-clock Central time -> UTC ms.
function centralToUtc(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo, d, h, mi);
  const off1 = chicagoOffsetMinutes(guess - 6 * 3600000);
  const t = guess - off1 * 60000;
  const off2 = chicagoOffsetMinutes(t);
  return off2 === off1 ? t : guess - off2 * 60000;
}

// "Thursday, November 26, 2026 11:19 AM" | "Thu, Nov 26, 2026 at 11:19 AM" |
// "11/26/2026 11:19 AM" | "Thu, 26 Nov 2026 11:19:00 -0600"
function parseHeaderDate(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const zone = s.match(/([+-])(\d{2}):?(\d{2})\b|\b(?:UTC|GMT)\b/i);
  let y, mo, d, h = 0, mi = 0;
  let m = s.match(/\b([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})/);           // November 26, 2026
  if (m && MONTHS[m[1].slice(0, 4).toLowerCase()] == null && MONTHS[m[1].slice(0, 3).toLowerCase()] == null) m = null;
  if (m) { mo = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()]; d = +m[2]; y = +m[3]; }
  if (!m) {
    m = s.match(/\b(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4})/);               // 26 Nov 2026
    if (m && MONTHS[m[2].slice(0, 3).toLowerCase()] != null) { d = +m[1]; mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; y = +m[3]; } else m = null;
  }
  if (!m) {
    m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);                   // 11/26/2026
    if (m) { mo = +m[1] - 1; d = +m[2]; y = +m[3]; }
  }
  if (!m) return null;
  const tm = s.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp]\.?[Mm]\.?)?/);
  if (tm) {
    h = +tm[1]; mi = +tm[2];
    const ap = tm[3] ? tm[3][0].toLowerCase() : null;
    if (ap === 'p' && h < 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
  }
  if (!(y > 2000 && mo >= 0 && mo <= 11 && d >= 1 && d <= 31 && h <= 23 && mi <= 59)) return null;
  if (zone && zone[1]) {
    const off = (zone[1] === '-' ? -1 : 1) * (+zone[2] * 60 + +zone[3]);
    return Date.UTC(y, mo, d, h, mi) - off * 60000;
  }
  if (zone) return Date.UTC(y, mo, d, h, mi);
  return centralToUtc(y, mo, d, h, mi);
}

// The first quoted header date in a forwarded body, or null.
function forwardedHeaderDate(body) {
  const t = toText(body);
  const lines = t.split('\n').map((x) => x.trim());
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    // Gmail / Apple: "On Thu, Nov 26, 2026 at 11:19 AM Name <a@b> wrote:"
    const on = L.match(/^On (.{8,240}?)wrote:\s*$/i);
    if (on) { const v = parseHeaderDate(on[1]); if (v) return v; }
    // Outlook / Gmail header block: a From: line followed within a few lines by Sent:/Date:
    if (/^(?:\*\s*)?From:/i.test(L)) {
      for (let j = i; j < Math.min(lines.length, i + 6); j++) {
        const sd = lines[j].match(/^(?:\*\s*)?(?:Sent|Date):\*?\s*(.+)$/i);
        if (sd) { const v = parseHeaderDate(sd[1]); if (v) return v; break; }
      }
    }
  }
  return null;
}

function originalReceivedAt({ subject = '', body = '', receivedAt = null } = {}) {
  const arrived = receivedAt ? Date.parse(receivedAt) : NaN;
  const fallback = { at: Number.isFinite(arrived) ? new Date(arrived).toISOString() : null, basis: 'email_received' };
  const looksForwarded = /^\s*(?:fw|fwd)\s*:/i.test(String(subject || '')) || /forwarded message|^\s*from:.*\n\s*(?:sent|date):/im.test(toText(body));
  if (!looksForwarded) return fallback;
  const v = forwardedHeaderDate(body);
  if (!Number.isFinite(v)) return fallback;
  if (Number.isFinite(arrived)) {
    if (v > arrived + 60000) return fallback;                                  // after it reached us: not the original
    if (arrived - v > MAX_BACK_DAYS * 86400000) return fallback;               // implausibly old quote
  }
  return { at: new Date(v).toISOString(), basis: 'forwarded_original' };
}

// "November 26, 2026" in Central time.
function receivedDateLabel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'long', day: 'numeric' });
}

module.exports = { originalReceivedAt, forwardedHeaderDate, parseHeaderDate, receivedDateLabel };
