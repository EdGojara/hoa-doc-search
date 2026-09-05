// ============================================================================
// lib/ea/lunch_question.js  (Ed 2026-09-05)
// ----------------------------------------------------------------------------
// Answer a free-form "what's for lunch Wednesday?" email as Tessa, from the
// captured Lunchdrop menu (lunch_menu_cache — filled by a browser capture, since
// the server can't read Lunchdrop directly). Detects the question, resolves the
// day, looks up that day's restaurants + a few highlights, and replies. If the
// menu isn't captured yet, she says so honestly rather than guessing.
// ============================================================================
const graphSend = require('../email/graph_send');
const { buildTessaEmail } = require('../email/tessa_signature');

const TESSA = graphSend.TESSA_MAILBOX;
const OFFICE = process.env.LUNCH_OFFICE || 'boxer';
const DOW = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

// Is this email asking about lunch? (Scoped so we only answer genuine lunch Qs.)
function isLunchQuestion(text) {
  const t = String(text || '').toLowerCase();
  if (!/lunch|lunchdrop/.test(t)) return false;
  return /\?/.test(t) || /\bwhat|\bwhich|\bwho|\bwhere|\bmenu|\boptions?\b|\bfor lunch\b/.test(t);
}

// Resolve the day the question is about → 'YYYY-MM-DD'. Handles today/tomorrow,
// a weekday name (the next occurrence, including today), or an explicit date.
// Defaults to today when no day is named.
function resolveDate(text, now = new Date()) {
  const t = String(text || '').toLowerCase();
  const iso = t.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const ymd = (d) => d.toISOString().slice(0, 10);
  if (/\btomorrow\b/.test(t)) { const d = new Date(now); d.setDate(d.getDate() + 1); return ymd(d); }
  if (/\btoday\b/.test(t)) return ymd(now);
  for (const [name, dow] of Object.entries(DOW)) {
    if (new RegExp('\\b' + name + '\\b').test(t)) {
      const d = new Date(now);
      const delta = (dow - d.getDay() + 7) % 7; // 0..6, includes today
      d.setDate(d.getDate() + delta);
      return ymd(d);
    }
  }
  return ymd(now);
}

function fmtUsd(c) { return c == null ? null : '$' + (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtDate(d) { try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }); } catch (_) { return d; } }

// Build Tessa's answer text from the cached rows for one date.
function buildAnswer(dateStr, rows, firstName) {
  const hi = firstName || 'there';
  const when = fmtDate(dateStr);
  if (!rows || !rows.length) {
    return `Hi ${hi},\n\nI don't have the Lunchdrop menu for ${when} yet — either it isn't posted or I haven't captured it. I'll follow up as soon as it's up.\n\nThanks!`;
  }
  const lines = [`Hi ${hi},`, '', `Here's Lunchdrop for ${when}:`, ''];
  for (const r of rows) {
    lines.push(`• ${r.restaurant_name || 'Restaurant'}`);
    const items = Array.isArray(r.items) ? r.items.slice(0, 3) : [];
    for (const it of items) {
      const p = it.price_cents != null ? ` — ${fmtUsd(it.price_cents)}` : '';
      lines.push(`    - ${it.name}${p}`);
    }
  }
  const cutoff = rows.find((r) => r.cutoff_text) ? rows.find((r) => r.cutoff_text).cutoff_text : null;
  if (cutoff) lines.push('', cutoff + '.');
  lines.push('', 'Want me to put in an order? Just say the word.');
  return lines.join('\n');
}

// Detect + answer. supabase passed in (trusted caller). Returns a status.
async function respondToLunchQuestion(supabase, { from, subject, body }) {
  const email = String(from || '').trim().toLowerCase();
  const text = `${subject || ''}\n${body || ''}`;
  if (!isLunchQuestion(text)) return { status: 'not_a_question' };
  if (!email || !email.includes('@')) return { status: 'ignored' };

  const dateStr = resolveDate(text);
  const { data: rows } = await supabase.from('lunch_menu_cache')
    .select('restaurant_name, restaurant_slug, order_url, cutoff_text, items')
    .eq('office', OFFICE).eq('lunch_date', dateStr).order('restaurant_name');

  const first = email.split('@')[0].split(/[._]/)[0];
  const answer = buildAnswer(dateStr, rows || [], first.charAt(0).toUpperCase() + first.slice(1));
  const subj = `Re: ${String(subject || 'Lunch').replace(/^re:\s*/i, '')}`;
  try {
    const { html, attachments } = buildTessaEmail(answer, null, null);
    await graphSend.sendAs({ from: TESSA, to: email, subject: subj, text: answer, html, attachments });
  } catch (e) { return { status: 'send_failed', error: e.message }; }
  return { status: 'answered', date: dateStr, restaurants: (rows || []).length };
}

module.exports = { isLunchQuestion, resolveDate, buildAnswer, respondToLunchQuestion };
