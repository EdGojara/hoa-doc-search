// ===========================================================================
// board_package/paige_reply.js  (Ed 2026-07-18)
// ---------------------------------------------------------------------------
// Paige's inbound handler. A manager emails paige@ ("build the Lakes of Pine
// Forest board package") → Paige identifies the community, runs the readiness
// engine over live trustEd data, and drafts a REPLY-FIRST response: here's
// where the package stands, here's what's ready and what still needs
// attention, reply "go" and I'll assemble it. Reply-first keeps a human in the
// loop before anything is generated. The draft is queued for review like every
// other agent reply (outbound stays manual).
// ===========================================================================
const { getProfile, financialCutoff, buildReadiness } = require('./engine');
const { nativeContext } = require('./native');

const BUILD_INTENT = /\b(build|create|assemble|prepare|generate|put\s+together|start|get\s+ready)\b[\s\S]{0,40}\b(board\s*(package|packet|book|meeting)|packet|meeting\s*package)\b/i;

function paigeSignature() {
  return '\n\n— Paige Chandler · board-operations assistant (AI) · Bedrock Association Management'
    + '\nReply "go" and I\'ll assemble the review draft. Want a person instead? Just reply and I\'ll pass you to the team.';
}

async function matchCommunity(text, supabase) {
  const { data: comms } = await supabase.from('communities').select('id, name');
  const low = String(text || '').toLowerCase();
  // longest name first so "Lakes of Pine Forest" beats "Lakes"
  const sorted = (comms || []).slice().sort((a, b) => b.name.length - a.name.length);
  for (const c of sorted) {
    const n = String(c.name || '').toLowerCase();
    if (n && low.includes(n)) return c;
  }
  // token match: every significant word of a community name appears
  for (const c of sorted) {
    const toks = String(c.name || '').toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !['the', 'of', 'at', 'and'].includes(w));
    if (toks.length >= 2 && toks.every((t) => low.includes(t))) return c;
  }
  return null;
}

function parseMeetingDate(text) {
  const iso = String(text || '').match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];
  const mdy = String(text || '').match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (mdy) return `${mdy[3]}-${String(mdy[1]).padStart(2, '0')}-${String(mdy[2]).padStart(2, '0')}`;
  return null;
}

async function draftPaigeReply({ email, supabase }) {
  const text = [email.subject, email.body, email.body_preview].filter(Boolean).join('\n');
  const senderName = (String(email.sender_name || '').trim().split(/\s+/)[0]) || 'there';
  const isBuild = BUILD_INTENT.test(text) || /\b(readiness|package|packet|board\s*book)\b/i.test(text);
  const community = await matchCommunity(text, supabase);

  // Not a package request at all → let the generic path handle it.
  if (!isBuild && !community) return { draftable: false };

  if (!community) {
    return {
      draftable: true, careful: true,
      subject: `Re: ${email.subject || 'board package'}`,
      body: `Hi ${senderName},\n\nHappy to put that board package together — which community is it for? Once I know, I'll pull everything trustEd has and send you a readiness snapshot.${paigeSignature()}`,
      review_hint: 'Paige: package request, community not identified',
    };
  }

  const { data: communityRow } = await supabase.from('communities').select('*').eq('id', community.id).maybeSingle();
  const profile = getProfile(communityRow);
  const meetingDate = parseMeetingDate(text) || new Date().toISOString().slice(0, 10);
  const cutoff = financialCutoff(profile, meetingDate);
  const { data: mm } = await supabase.from('meeting_minutes').select('meeting_date')
    .eq('community_id', community.id).order('meeting_date', { ascending: false }).limit(1);
  const priorMeetingDate = mm && mm[0] ? mm[0].meeting_date : null;

  const nat = await nativeContext(supabase, communityRow, cutoff, priorMeetingDate);
  const { summary, items } = buildReadiness(profile, new Map(), { cutoff, priorMeetingDate, native: nat });

  const ready = items.filter((i) => i.validation_status === 'ready');
  const attention = items.filter((i) => i.required && ['missing', 'wrong_period', 'incomplete', 'restricted', 'duplicate'].includes(i.validation_status));
  const readyList = ready.map((i) => i.label).join(', ');
  const attnList = attention.map((i) => `  • ${i.label} — ${i.detail || i.validation_status.replace(/_/g, ' ')} (owner: ${i.owner})`).join('\n');

  const body = `Hi ${senderName},\n\n`
    + `Here's where the ${community.name} board package stands (financials tied to ${cutoff}):\n\n`
    + `${summary.ready} of ${summary.required_total} required sections are ready to assemble straight from trustEd.\n\n`
    + (readyList ? `Ready now: ${readyList}.\n\n` : '')
    + (attention.length
      ? `Still needs attention:\n${attnList}\n\n`
      : `Everything's in place — nothing outstanding.\n\n`)
    + `Reply "go" and I'll assemble the review draft and route the open items to their owners. If the meeting isn't this month, tell me the date and I'll re-check the financial period.`
    + paigeSignature();

  return {
    draftable: true, careful: true,
    subject: `${community.name} board package — ${summary.ready}/${summary.required_total} sections ready`,
    body,
    review_hint: `Paige readiness: ${summary.ready}/${summary.required_total} ready · ${attention.length} need attention`,
  };
}

module.exports = { draftPaigeReply };
