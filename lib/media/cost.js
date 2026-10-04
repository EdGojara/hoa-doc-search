// ============================================================================
// lib/media/cost.js  (Issue #10 Media Studio) — EFFECTIVE cost, not list price
// ----------------------------------------------------------------------------
// A renderer can be bought through several CHANNELS (direct API, an aggregator
// such as Runway, a prepaid package). For one shot the effective cost of ONE
// ACCEPTED take is:
//
//   billable_s  = max(duration, channel.min_billable_seconds)
//   unit        = rate(resolution) + audio premium (if the shot needs audio) + per-reference surcharges
//   per_attempt = max(channel.min_charge, billable_s * unit)
//   accepted    = per_attempt * expected_attempts          (retry / reject waste)
//
// Rate per channel: a prepaid package with remaining credit uses its effective
// unit rate (package price / units) until exhausted, then list price; subscription
// credits apply ONLY when `subscription_applies_to_api === true` is verified
// (consumer plans usually do not cover API usage). The cheapest usable channel wins.
// Caps (per shot / project / day / month) can block a render outright.
// ============================================================================
const round = (n) => Math.round(n * 1e4) / 1e4;

function channelCost(ch, shot) {
  const res = shot.resolution; const rate = ch.rate_per_s && ch.rate_per_s[res];
  if (rate == null) return { usable: false, reason: `${ch.channel}: no rate for ${res}` };
  const seconds = Number(shot.duration_seconds);
  const billable = Math.max(seconds, Number(ch.min_billable_seconds || 0));
  const audio = shot.needs_audio ? Number((ch.audio_premium_per_s && ch.audio_premium_per_s[res]) ?? ch.audio_premium_per_s_flat ?? 0) : 0;
  const refs = Number(ch.reference_surcharge_per_image || 0) * Number(shot.reference_images || 0) + Number(ch.reference_video_per_s || 0) * Number(shot.reference_video_seconds || 0);
  let unit = rate + audio; let basis = 'list';
  // prepaid package: effective rate while credit remains (credits in USD-equivalent of list price)
  const pp = ch.prepaid;
  const listAttempt = Math.max(Number(ch.min_charge || 0), billable * unit) + refs;
  if (pp && Number(pp.remaining_usd_list) >= listAttempt && Number(pp.effective_discount) > 0) { unit = unit * (1 - Number(pp.effective_discount)); basis = 'prepaid'; }
  else if (pp && Number(pp.remaining_usd_list) < listAttempt) basis = 'list (prepaid exhausted)';
  // subscription credits: only when the vendor documents that they apply to API usage
  const sub = ch.subscription;
  if (sub && sub.applies_to_api === true && Number(sub.remaining_usd_list) >= listAttempt) { unit = unit * (1 - Number(sub.effective_discount || 0)); basis = 'subscription (verified API-eligible)'; }
  const perAttempt = Math.max(Number(ch.min_charge || 0), billable * unit) + refs;
  const attempts = Math.max(1, Number(ch.expected_attempts || shot.expected_attempts || 1));
  return { usable: true, channel: ch.channel, basis, billable_seconds: billable, unit_per_s: round(unit), per_attempt: round(perAttempt), expected_attempts: attempts, accepted_take_cost: round(perAttempt * attempts), list_per_attempt: round(listAttempt), source: ch.source || null };
}

function effectiveCost(channels, shot) {
  const all = (channels || []).map((ch) => channelCost(ch, shot));
  const usable = all.filter((c) => c.usable).sort((a, b) => a.accepted_take_cost - b.accepted_take_cost);
  return usable.length ? { ...usable[0], alternatives: usable.slice(1).map((c) => ({ channel: c.channel, accepted_take_cost: c.accepted_take_cost, basis: c.basis })) } : { usable: false, reasons: all.map((c) => c.reason) };
}

// Policy caps: returns null when the render fits, else the blocking reason.
function capBlock(cost, policy = {}, spend = {}) {
  const checks = [
    ['per_shot', policy.per_shot_usd, 0],
    ['project', policy.per_project_usd, Number(spend.project_usd || 0)],
    ['daily', policy.daily_usd, Number(spend.today_usd || 0)],
    ['monthly', policy.monthly_usd, Number(spend.month_usd || 0)],
  ];
  for (const [name, cap, spent] of checks) if (cap != null && spent + cost > Number(cap)) return { cap: name, cap_usd: Number(cap), spent_usd: spent, needed_usd: cost };
  return null;
}

module.exports = { effectiveCost, channelCost, capBlock };
