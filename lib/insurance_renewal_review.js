// ============================================================================
// lib/insurance_renewal_review.js  (Ed 2026-08-28)
// ----------------------------------------------------------------------------
// The autonomous insurance-renewal review. When a broker proposal lands in
// amanda@, this: (1) extracts the proposed program from the attached PDFs,
// (2) loads the community's policy-of-record (the stored insurance_programs
// row), (3) runs compareInsurancePrograms, and (4) renders the parity re-quote
// reply — the email Amanda drafted by hand on Lakes of Pine Forest, now produced
// before anyone opens the message.
//
// The reply is RENDERED from the structured comparison, not freestyled by a
// model — insurance numbers must be exact (CLAUDE.md two-stage rule: extract ->
// validate -> render, renders never freestyle from raw input). The draft is
// queued for human review like every other outbound.
// ============================================================================

const { compareInsurancePrograms } = require('./insurance_compare');

function fmtMoney(n) {
  if (n == null) return 'n/a';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Detection: an inbound that is plausibly an insurance renewal proposal with a
// PDF to read. Conservative — a false negative just means Amanda handles it as a
// normal message; a false positive wastes one extraction.
function looksLikeInsuranceProposal(email, attachments = []) {
  const hay = [email && email.subject, email && email.body, email && email.body_preview].filter(Boolean).join('\n').toLowerCase();
  const insuranceWords = /(insurance|policy|coverage|premium|quote|proposal|renewal|dec page|declarations|carrier|umbrella|liability|d&o|acord)/.test(hay);
  const hasPdf = (attachments || []).some((a) => /pdf/i.test((a && (a.mime || a.contentType || a.name || a.filename)) || ''));
  return insuranceWords && hasPdf;
}

// Load the community's active policy-of-record into the comparator's program
// shape: { entity, coverages:[{line,carrier,annual_premium,limits,deductibles,
// key_terms}], statement_of_values }. Returns null if none is on file.
async function loadPolicyOfRecord(supabase, communityId) {
  if (!communityId) return null;
  const { data: programs, error } = await supabase.from('insurance_programs')
    .select('id, status, entity, statement_of_values, notes, policy_period_start, policy_period_end, named_insured')
    .eq('community_id', communityId)
    .order('policy_period_start', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  const active = (programs || []).find((p) => p.status === 'active') || (programs || [])[0];
  if (!active) return null;
  const { data: pol, error: pErr } = await supabase.from('insurance_policies')
    .select('coverage_line, carrier, annual_premium_cents, limits, deductibles')
    .eq('program_id', active.id).limit(100);
  if (pErr) throw pErr;
  const coverages = (pol || []).map((p) => ({
    line: p.coverage_line,
    carrier: p.carrier,
    annual_premium: p.annual_premium_cents != null ? '$' + (Number(p.annual_premium_cents) / 100).toFixed(2) : null,
    limits: Array.isArray(p.limits) ? p.limits : [],
    deductibles: Array.isArray(p.deductibles) ? p.deductibles : [],
    key_terms: [],
  }));
  // Surface curated coinsurance / replacement-cost notes as key_terms so the
  // comparator's coinsurance detector can see them.
  const noteTerms = (Array.isArray(active.notes) ? active.notes : []).map(String).filter((n) => /coins|replacement|blanket|agreed value/i.test(n));
  if (coverages.length && noteTerms.length) coverages[0].key_terms = coverages[0].key_terms.concat(noteTerms);
  return { entity: active.entity || {}, coverages, statement_of_values: Array.isArray(active.statement_of_values) ? active.statement_of_values : [], _period: { start: active.policy_period_start, end: active.policy_period_end } };
}

// Render the parity re-quote reply from the structured comparison + the current
// program's schedule of values. Deterministic: every figure comes from the data.
function renderRenewalRecommendation(comparison, { communityName, currentProgram, senderName } = {}) {
  const { premium, property, dropped } = comparison;
  const who = communityName || 'the association';
  const p = [];
  p.push(`${senderName ? senderName + ',' : 'Hello,'}`);
  p.push(`Thank you for putting the proposal together for ${who}. I have reviewed it against the current program.`);

  if (property.coinsuranceExposure) {
    p.push(`Before we can compare it head to head, the property needs to be corrected. The proposal insures the building at ${fmtMoney(property.propBldg)}, but its insured replacement value is ${fmtMoney(property.curBldg)}. At ${fmtMoney(property.propBldg)} it is insured below the coinsurance floor, which would expose the association to a coinsurance penalty on any loss, not only a total loss. Please re-quote the building at ${fmtMoney(property.curBldg)}.`);
  }

  const sov = (currentProgram && currentProgram.statement_of_values) || [];
  if (property.totalDelta != null && property.totalDelta < 0 && sov.length) {
    const bullets = sov.map((s) => `- ${s.description}: ${s.value}`).join('\n');
    p.push(`For reference, the current program insures ${fmtMoney(property.curTotal)} of total property. Please quote to the same schedule so we are comparing like for like:\n${bullets}`);
  }

  for (const d of dropped) {
    p.push(`The current program includes ${d}. Please confirm that coverage is built into the proposed program, or add it so the two line up.`);
  }

  if (premium.delta != null && premium.delta < 0 && (dropped.length || (property.totalDelta != null && property.totalDelta < 0))) {
    p.push(`The proposed premium is lower, but that is largely because the property and coverage above are thinner than what the association carries today. Once the building value and the items above are squared away, we can put the two programs side by side on equal footing.`);
  } else {
    p.push(`Once the items above are confirmed, we can put the two programs side by side.`);
  }

  p.push(`Thank you,`);

  const subject = `Insurance renewal, ${who}, re-quote at parity`;
  return { subject, body: p.join('\n\n') };
}

// One-line-per-finding internal summary for the reviewer (draft_reason).
function findingsSummary(comparison) {
  return (comparison.findings || []).map((f) => `[${f.severity}] ${f.title}`).join(' · ');
}

// Full flow from an already-extracted proposed program (the testable core;
// reviewRenewalFromFiles wraps this with the PDF extraction step).
async function reviewRenewalFromProposal({ supabase, communityId, communityName, proposedProgram, senderName }) {
  const currentProgram = await loadPolicyOfRecord(supabase, communityId);
  if (!currentProgram) {
    return { status: 'no_policy_of_record', message: `No policy-of-record on file for ${communityName || 'this community'}; cannot compare. Upload the current policy first.` };
  }
  const comparison = compareInsurancePrograms(currentProgram, proposedProgram);
  const draft = renderRenewalRecommendation(comparison, { communityName, currentProgram, senderName });
  return { status: 'ok', comparison, currentProgram, draftSubject: draft.subject, draftBody: draft.body, reason: 'Insurance renewal parity review. ' + findingsSummary(comparison) };
}

// Intake entry point: extract the proposal from PDFs, then review.
async function reviewRenewalFromFiles({ supabase, anthropic, communityId, communityName, files, senderName }) {
  const { extractInsuranceProgram } = require('./insurance_extract');
  const { normalizeInsuranceProgram } = require('./insurance_rfp');
  const raw = await extractInsuranceProgram(anthropic, files);
  const proposedProgram = normalizeInsuranceProgram(raw);
  return reviewRenewalFromProposal({ supabase, communityId, communityName, proposedProgram, senderName });
}

module.exports = {
  looksLikeInsuranceProposal, loadPolicyOfRecord, renderRenewalRecommendation,
  findingsSummary, reviewRenewalFromProposal, reviewRenewalFromFiles,
};
