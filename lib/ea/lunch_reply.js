// ============================================================================
// lib/ea/lunch_reply.js  (Ed 2026-09-05)
// ----------------------------------------------------------------------------
// Turn a reply to Tessa's "what do you want for lunch" email into a recorded
// order line. Modeled on lib/board/vote_reply.js, with one deliberate
// difference: a lunch reply is NEVER dropped. Even if we can't cleanly parse the
// item, we store the person's raw words (status 'unclear') so Tessa/Ed can read
// it — the reply itself is the valuable thing. (A vote records nothing when
// unclear; a lunch order records the raw text and flags it.)
//
// Matching: the [LUN-XXXX] ref-code in the subject pins the round (sendAs threads
// by subject only). Falls back to the sender's most recent open round.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

function topOfReply(body) {
  let t = String(body || '');
  const cuts = [/\nOn .*wrote:/i, /\n-----Original Message-----/i, /\n________________________________/, /\nFrom: /i, /\n>/];
  for (const re of cuts) { const m = t.search(re); if (m > 0) t = t.slice(0, m); }
  return t.trim().slice(0, 1000);
}

// Extract {item, notes} from the reply. Best-effort; on any failure the caller
// still stores the raw reply. Returns null if nothing order-like is present.
async function parseOrder(replyText, restaurant) {
  const clean = String(replyText || '').trim();
  if (!clean) return null;
  if (!anthropic) return { item: clean.slice(0, 200), notes: null, confident: false };
  try {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 200,
      messages: [{ role: 'user', content:
        `A coworker replied with their lunch order${restaurant ? ` from ${restaurant}` : ''}. Extract it.\n\nReply:\n"${clean.slice(0, 900)}"\n\nRespond as compact JSON only: {"item": "<the dish they want, or empty if none>", "notes": "<customizations like no onions, dressing on side, or empty>"}. If the reply contains no lunch order at all, respond {"item":"","notes":""}.` }],
    });
    const raw = (r.content?.[0]?.text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const j = JSON.parse(raw);
    const item = String(j.item || '').trim();
    if (!item) return null;
    return { item: item.slice(0, 200), notes: (String(j.notes || '').trim() || null), confident: true };
  } catch (_) {
    // AI hiccup — keep the raw words rather than lose the order.
    return { item: clean.slice(0, 200), notes: null, confident: false };
  }
}

// supabase passed in (trusted caller). Returns a status object. Unlike votes,
// a matched round ALWAYS records the reply (status 'responded' or 'unclear').
async function resolveLunchReply(supabase, { from, subject, body }) {
  const email = String(from || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return { status: 'ignored', reason: 'no sender' };

  // Pin the round by the subject ref-code; else the sender's newest open round.
  let round = null;
  const refMatch = String(subject || '').match(/\[(LUN-[A-Z0-9]{3,6})\]/i);
  if (refMatch) {
    const { data } = await supabase.from('lunch_order_rounds').select('*')
      .eq('ref_code', refMatch[1].toUpperCase()).in('status', ['collecting', 'assembled']).maybeSingle();
    round = data || null;
  }
  if (!round) {
    // Fallback: a round in progress that this person was invited to.
    const { data: items } = await supabase.from('lunch_order_items')
      .select('round_id').ilike('participant_email', email);
    const ids = [...new Set((items || []).map((i) => i.round_id))];
    if (ids.length) {
      const { data: rounds } = await supabase.from('lunch_order_rounds').select('*')
        .in('id', ids).in('status', ['collecting', 'assembled']).order('created_at', { ascending: false });
      round = (rounds && rounds[0]) || null;
    }
  }
  if (!round) return { status: 'no_round', email };

  const reply = topOfReply(body);
  const parsed = await parseOrder(reply, round.restaurant);
  const status = parsed && parsed.confident ? 'responded' : (parsed ? 'responded' : 'unclear');

  // Upsert this person's line — updates their invited row, or adds them as a
  // guest if they were forwarded the email. Raw reply is always kept.
  const row = {
    round_id: round.id, participant_email: email,
    raw_reply: reply.slice(0, 2000),
    parsed_item: parsed ? parsed.item : null,
    parsed_notes: parsed ? parsed.notes : null,
    status, responded_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('lunch_order_items')
    .upsert(row, { onConflict: 'round_id,participant_email' });
  if (error) throw error;

  return { status: status === 'responded' ? 'recorded' : 'unclear', email, round: { id: round.id, ref_code: round.ref_code }, item: parsed ? parsed.item : null };
}

module.exports = { resolveLunchReply, parseOrder, topOfReply };
