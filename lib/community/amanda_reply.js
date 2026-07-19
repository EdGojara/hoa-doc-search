// ============================================================================
// lib/community/amanda_reply.js  (Ed 2026-07-19)
// ----------------------------------------------------------------------------
// Amanda Albright — Senior Community Manager, the ESCALATION tier. The
// specialists own their lanes (Annie/ACC, Miranda/DRV, Emma/AP, Paige/board);
// Amanda owns the tough, cross-domain, relationship-heavy cases none of them
// can cleanly close alone. She is NOT a new inbox specialist — she's a
// supervisor fed by (1) direct mail to amanda@, (2) escalations handed up from
// a specialist, and (3) triage flags on hot threads. Her job: pull the WHOLE
// picture together across domains, take ownership with the person, and lay out
// concrete next steps.
//
// HARD BOUNDARY (same compliance scoping as Claire): Amanda COORDINATES and
// RECOMMENDS. She does not waive or reduce a fine, forgive or adjust a balance,
// grant an ACC approval/denial, or take a legal position. Anything touching a
// waiver, a dollar adjustment, a §209 decision, or a legal question is drafted
// as "here's what I'll bring to the board / the team" and held for a human.
// ============================================================================

// What makes an issue "tough" enough for Amanda — concrete triggers, so she is
// an escalation owner and not a vague dumping ground.
const EMOTION = /\b(furious|outrag|unacceptable|ridiculous|disgust|harass|threaten|sick of|fed up|never again|worst|incompeten|lawyer|attorney|sue|lawsuit|legal action|discriminat|ada|fair housing|retaliat)\b/i;
const HARDSHIP = /\b(hardship|medical|hospital|passed away|deceased|widow|disab|unemploy|lost my job|foreclos|bankrupt)\b/i;
const ESCALATE_WORDS = /\b(escalat|supervisor|manager|speak to someone|who is in charge|complaint|formal complaint|board member|president of the board)\b/i;

function looksLikeEscalation(email, { threadCount = 0 } = {}) {
  const text = [email.subject, email.body, email.body_preview].filter(Boolean).join('\n');
  const hits = [];
  if (EMOTION.test(text)) hits.push('charged/legal-adjacent language');
  if (HARDSHIP.test(text)) hits.push('hardship');
  if (ESCALATE_WORDS.test(text)) hits.push('explicit escalation ask');
  if (threadCount >= 4) hits.push(`${threadCount} unresolved back-and-forths`);
  return { escalate: hits.length > 0, reasons: hits };
}

function amandaSignoff() {
  return '\n\nI\'ll stay on this personally until it\'s resolved. If you\'d rather talk it through with someone on the team, just say the word and I\'ll set it up.';
}

async function propertyContext(supabase, { propertyId, communityId }) {
  const ctx = { violations: [], ar_balance: null, acc: [], flags: [] };
  if (!propertyId) return ctx;
  // Open enforcement (SSOT = property_enforcement_states; fall back to violations).
  try {
    const { data } = await supabase.from('violations')
      .select('current_stage, opened_at, enforcement_categories(label)')
      .eq('property_id', propertyId).not('current_stage', 'in', '(cured,closed,voided)').limit(25);
    ctx.violations = (data || []).map((v) => ({ stage: v.current_stage, category: v.enforcement_categories && v.enforcement_categories.label, opened_at: v.opened_at }));
  } catch (e) { /* defensive */ }
  // Current AR balance.
  try {
    const { data } = await supabase.from('v_homeowner_current_balance').select('balance_cents').eq('property_id', propertyId).maybeSingle();
    if (data) ctx.ar_balance = Number(data.balance_cents || 0) / 100;
  } catch (e) { /* defensive */ }
  // Open ACC/ARC items.
  try {
    const { data } = await supabase.from('acc_decisions').select('decision_type, status, project_summary, created_at').eq('property_id', propertyId).in('status', ['pending', 'in_review', 'submitted']).limit(10);
    ctx.acc = data || [];
  } catch (e) { /* defensive */ }
  return ctx;
}

// Build the INTERNAL situation summary for the reviewer (not sent to the person).
function reviewHint(reasons, ctx) {
  const bits = [];
  if (reasons && reasons.length) bits.push(reasons.join(' + '));
  if (ctx.violations.length) bits.push(`${ctx.violations.length} open violation(s) [${[...new Set(ctx.violations.map((v) => v.stage))].join(',')}]`);
  if (ctx.ar_balance != null && Math.abs(ctx.ar_balance) > 0.5) bits.push(`AR ${ctx.ar_balance > 0 ? 'owes' : 'credit'} $${Math.abs(ctx.ar_balance).toFixed(2)}`);
  if (ctx.acc.length) bits.push(`${ctx.acc.length} open ACC`);
  return `Amanda escalation: ${bits.join(' · ') || 'cross-domain'}`;
}

async function draftAmandaReply({ email, supabase, propertyId, communityId, contactName, communityName }) {
  const senderName = (contactName && String(contactName).trim().split(/\s+/)[0])
    || (String(email.sender_name || '').trim().split(/\s+/)[0]) || 'there';
  const trig = looksLikeEscalation(email);
  const ctx = await propertyContext(supabase, { propertyId, communityId });

  // No customer copy is written in Ed's voice with em-dashes; keep it warm,
  // plain, and compliance-safe. Amanda takes ownership and gives ONE concrete
  // next step; she never decides a waiver, balance, or legal position here.
  const acknowledgment = `Hi ${senderName},\n\n`
    + `Thank you for reaching out, and I'm sorry this has been frustrating. I'm Amanda, the senior manager for ${communityName || 'your community'}, and I've taken personal ownership of getting this sorted.`;

  // A grounded "here's what I see / here's the plan" without exposing internal
  // jargon or making a decision reserved for a human.
  const seePlan = `\n\nI've pulled the full history on your property so we're working from the complete picture, not one piece of it. Here's what happens next: I'll review everything end to end, coordinate with the right people on our side, and come back to you with a clear path and a timeline. You won't have to repeat yourself to anyone.`;

  const body = acknowledgment + seePlan + amandaSignoff();

  return {
    draftable: true, careful: true,
    subject: `Re: ${email.subject || 'your message'}`,
    body,
    review_hint: reviewHint(trig.reasons, ctx),
    context: ctx,
  };
}

module.exports = { draftAmandaReply, looksLikeEscalation };
