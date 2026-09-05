// ============================================================================
// lib/ea/lunch.js  (Ed 2026-09-05)
// ----------------------------------------------------------------------------
// Tessa's lunch-order collection loop: create a round, email the team/guests as
// Tessa asking what they want, then assemble the responses for Ed to approve.
// Modeled on the board-voting collection flow. Reuses the Tessa send primitive
// (lib/email/graph_send.sendAs from TESSA_MAILBOX + buildTessaEmail branding).
//
// The subject carries a [LUN-XXXX] ref-code so replies thread back to the round
// (sendAs threads by subject only — the ref-code is load-bearing, same as votes).
//
// This module never PLACES an order (that's a supervised browser step on Ed's
// own Lunchdrop session) and never auto-sends without an owner-triggered call.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const graphSend = require('../email/graph_send');
const { buildTessaEmail } = require('../email/tessa_signature');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const TESSA = graphSend.TESSA_MAILBOX;
const ED = graphSend.ED_MAILBOX;

// LUN-XXXX (matches the vote ref pattern /[A-Z0-9]{2,4}-[A-Z0-9]{3,6}/).
function genRefCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I/L
  let s = '';
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `LUN-${s}`;
}

function fmtUsd(cents) {
  if (cents == null) return null;
  return '$' + (Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d) return '';
  try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }); }
  catch (_) { return String(d); }
}

// Create a round + one invited row per recipient. recipients: [{email,name}].
async function createRound({ title, restaurant, lunch_date, order_url, deadline, created_by, recipients }) {
  const list = (recipients || [])
    .map((r) => (typeof r === 'string' ? { email: r } : r))
    .filter((r) => r && r.email && String(r.email).includes('@'))
    .map((r) => ({ email: String(r.email).trim().toLowerCase(), name: r.name || null }));
  if (!list.length) throw Object.assign(new Error('at_least_one_recipient_required'), { code: 'invalid_input' });

  // A fresh, unused ref-code (retry on the rare unique collision).
  let round = null;
  for (let attempt = 0; attempt < 5 && !round; attempt++) {
    const ref_code = genRefCode();
    const { data, error } = await supabase.from('lunch_order_rounds').insert({
      ref_code, title: title || `Lunch — ${restaurant || 'team'}`, restaurant: restaurant || null,
      lunch_date: lunch_date || null, order_url: order_url || null, deadline: deadline || null,
      created_by: created_by || ED, status: 'collecting',
    }).select('*').single();
    if (!error) { round = data; break; }
    if (!/duplicate key|unique/i.test(error.message || '')) throw error;
  }
  if (!round) throw new Error('could_not_allocate_ref_code');

  const items = list.map((r) => ({ round_id: round.id, participant_email: r.email, participant_name: r.name, status: 'invited' }));
  const { error: ie } = await supabase.from('lunch_order_items').insert(items);
  if (ie) throw ie;
  return { round, invited: list };
}

// Email each recipient as Tessa. Returns per-recipient send results.
async function sendInvites(round, { menuText } = {}) {
  const { data: items } = await supabase.from('lunch_order_items').select('*').eq('round_id', round.id);
  const results = [];
  const when = fmtDate(round.lunch_date);
  const cut = round.deadline ? new Date(round.deadline).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : null;
  for (const it of (items || [])) {
    const first = (it.participant_name || '').split(' ')[0] || 'there';
    const lines = [
      `Hi ${first},`,
      '',
      `I'm putting in the team lunch order${round.restaurant ? ` from ${round.restaurant}` : ''}${when ? ` for ${when}` : ''}. What would you like?`,
      '',
      'Just reply to this email with your order (include any customizations). ' + (cut ? `I need it by ${cut} to make the cutoff.` : 'Reply as soon as you can so I can make the cutoff.'),
    ];
    if (round.order_url) lines.push('', `Menu: ${round.order_url}`);
    if (menuText) lines.push('', menuText);
    lines.push('', 'Thanks!');
    const body = lines.join('\n');
    const subject = `[${round.ref_code}] Lunch order${round.restaurant ? ` — ${round.restaurant}` : ''}${when ? ` (${when})` : ''}`;
    try {
      const { html, attachments } = buildTessaEmail(body, null, null);
      await graphSend.sendAs({ from: TESSA, to: it.participant_email, subject, text: body, html, attachments });
      results.push({ email: it.participant_email, sent: true });
    } catch (e) {
      results.push({ email: it.participant_email, sent: false, error: e.message });
    }
  }
  return results;
}

// Aggregate the responses so far into an assembled order.
async function assembleOrder(roundId) {
  const { data: round } = await supabase.from('lunch_order_rounds').select('*').eq('id', roundId).maybeSingle();
  if (!round) throw Object.assign(new Error('round_not_found'), { code: 'invalid_input' });
  const { data: items } = await supabase.from('lunch_order_items').select('*').eq('round_id', roundId).order('participant_name');
  const responded = (items || []).filter((i) => i.status === 'responded' || i.status === 'confirmed');
  const unclear = (items || []).filter((i) => i.status === 'unclear');
  const waiting = (items || []).filter((i) => i.status === 'invited');
  const totalCents = responded.reduce((s, i) => s + (Number(i.price_cents) || 0), 0);
  const anyPrice = responded.some((i) => i.price_cents != null);
  const line = (i) => {
    const who = i.participant_name || i.participant_email;
    const what = i.parsed_item || i.raw_reply || '(no order yet)';
    const notes = i.parsed_notes ? ` — ${i.parsed_notes}` : '';
    const price = i.price_cents != null ? `  ${fmtUsd(i.price_cents)}` : '';
    return `- ${who}: ${what}${notes}${price}`;
  };
  return {
    round, items: items || [], responded, unclear, waiting,
    totalCents: anyPrice ? totalCents : null,
    summaryText: [
      `${round.restaurant || 'Lunch'}${round.lunch_date ? ` — ${fmtDate(round.lunch_date)}` : ''}`,
      `${responded.length} of ${(items || []).length} in${waiting.length ? `, still waiting on ${waiting.length}` : ''}${unclear.length ? `, ${unclear.length} need a look` : ''}.`,
      '',
      ...responded.map(line),
      ...(unclear.length ? ['', 'Need clarifying:', ...unclear.map(line)] : []),
      ...(waiting.length ? ['', 'No reply yet:', ...waiting.map((i) => `- ${i.participant_name || i.participant_email}`)] : []),
      ...(anyPrice ? ['', `Estimated total: ${fmtUsd(totalCents)}`] : []),
    ].join('\n'),
  };
}

// Send the assembled order to Ed for a final approve-to-place. Marks 'assembled'.
async function sendAssemblyToEd(roundId) {
  const a = await assembleOrder(roundId);
  const r = a.round;
  const body = [
    'Here is the team lunch order, ready for your approval:',
    '',
    a.summaryText,
    '',
    r.order_url ? `Place it here: ${r.order_url}` : '',
    'Reply "approve" and I will place it on the card on file, or make changes and let me know.',
  ].filter((x) => x !== '').join('\n');
  const subject = `[${r.ref_code}] Ready to place — ${r.restaurant || 'lunch'} (${a.responded.length} order${a.responded.length === 1 ? '' : 's'}${a.totalCents != null ? `, ${fmtUsd(a.totalCents)}` : ''})`;
  const { html, attachments } = buildTessaEmail(body, null, null);
  await graphSend.sendAs({ from: TESSA, to: ED, subject, text: body, html, attachments });
  await supabase.from('lunch_order_rounds').update({ status: 'assembled' }).eq('id', roundId);
  return { sent: true, assembly: a };
}

module.exports = { genRefCode, createRound, sendInvites, assembleOrder, sendAssemblyToEd, fmtUsd, fmtDate };
