// ============================================================================
// lib/agents/operational_facts.js — check what an agent says against current
// records, where a record exists (Ed 2026-10-22)
// ----------------------------------------------------------------------------
// Scar: a draft for Kat told NewFirst that Bedrock was uploading issued-check files,
// when no file had ever been uploaded, and treated NewFirst's 10:00 am exception
// deadline as the file-upload deadline.
//
// Narrow on purpose. A PROVIDER covers one topic for which trustEd holds the
// authoritative record (today: Positive Pay, from positive_pay_submissions and the
// bank's settings). For a covered topic it supplies a fact basis for the drafter
// (lib/agents/fact_basis) and checks the finished draft for statements those records
// contradict. Anything else is NOT verified, and the result says so in plain words:
// nothing here implies that every claim in a draft was checked.
// ============================================================================
const FB = require('./fact_basis');

const NEWFIRST_BANK_ID = '16e07b6a-8902-4d1a-980e-db78938b98b3';

// ---------------------------------------------------------------- Positive Pay
const PP_TOPIC = /positive\s*pay|issued[- ]check (?:file|report|register)|check (?:file|report) upload/i;

async function positivePayState(supabase) {
  const must = async (q, w) => { const { data, error } = await q; if (error) throw new Error(`${w}: ${error.message}`); return data || []; };
  const [bank] = await must(supabase.from('banks').select('positive_pay_settings').eq('id', NEWFIRST_BANK_ID).limit(1), 'bank settings');
  const subs = await must(supabase.from('positive_pay_submissions').select('status, prepared_at, uploaded_at, outcome_recorded_at').eq('bank_id', NEWFIRST_BANK_ID).limit(500), 'Positive Pay files');
  const s = (bank && bank.positive_pay_settings) || {};
  const accepted = subs.filter((x) => x.status === 'accepted' || x.status === 'partially_accepted');
  const uploaded = subs.filter((x) => x.uploaded_at);
  const last = accepted.map((x) => x.outcome_recorded_at).filter(Boolean).sort().pop() || null;
  return { start_date: s.export_from || null, exception_cutoff: s.exception_cutoff || null, files_prepared: subs.length, files_uploaded: uploaded.length, files_accepted: accepted.length, last_accepted_at: last };
}

function positivePayBasis(st) {
  const src = 'trustEd Positive Pay records';
  const observed = [
    { fact: st.files_accepted ? `${st.files_accepted} issued-check file(s) have been accepted by NewFirst, the latest on ${String(st.last_accepted_at).slice(0, 10)}` : 'No issued-check file has been uploaded to NewFirst and accepted yet', source: src },
    { fact: st.start_date ? `Positive Pay tracking covers checks issued on or after ${st.start_date}` : 'The Positive Pay start date has not been set, so no file has been prepared', source: src },
    { fact: `NewFirst's ${st.exception_cutoff || '10:00'} am cutoff is the deadline for approving or returning exception items; it is not a file-upload deadline`, source: 'NewFirst Positive Pay guide and settings' },
  ];
  const unknown = [{ fact: 'NewFirst\'s deadline, if any, for uploading the issued-check file', source: null }];
  return FB.basis({ observed, unknown });
}

// Statements the records can contradict. Sentence by sentence, deterministic.
const CLAIMS_UPLOADING = /\bwe(?:'re| are| have been)\s+(?:now\s+)?(?:uploading|submitting|sending)\b|\bwe(?:'ve| have)\s+(?:been\s+)?(?:uploaded|submitted)\b|\bwe upload(?:ed)?\b(?! (?:it|them|the file) (?:once|when|after))|\b(?:are|is) now using the template\b|\bfiles? (?:are|is) being uploaded\b/i;
function positivePayClaims(text, st) {
  const issues = [];
  const sentences = String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
  for (const sen of sentences) {
    if (CLAIMS_UPLOADING.test(sen) && !st.files_accepted && !/\b(?:will|expect|plan|begin|start|shortly|soon|once|when|after)\b/i.test(sen)) {
      issues.push({ kind: 'uploading_claim', sentence: sen, why: 'Says Bedrock is uploading issued-check files, but no file has been uploaded and accepted (trustEd Positive Pay records).' });
    }
    if (/\b10(?::00)?\s*(?:a\.?m\.?|am)\b/i.test(sen) && /\b(?:upload|submit|submission|file|send)\w*/i.test(sen) && !/\bexception/i.test(sen)) {
      issues.push({ kind: 'deadline_conflation', sentence: sen, why: 'Presents 10:00 am as a file-upload deadline; it is NewFirst\'s deadline for deciding exceptions. The upload deadline is unconfirmed.' });
    }
  }
  return issues;
}

const PROVIDERS = {
  positive_pay: { topic: PP_TOPIC, label: 'Positive Pay status', load: positivePayState, basis: positivePayBasis, check: positivePayClaims },
};

const NOT_VERIFIED = 'No record check covers this message; factual statements in it were not verified automatically. Review them before approving.';

function topicText(message) { return `${(message && message.subject) || ''}\n${(message && (message.body || message.body_full || message.body_preview)) || ''}`; }

/**
 * Before drafting: the fact basis for the providers this agent has that apply to the message.
 * @returns {{ covered: string[], basis: object|null, state: object, note: string|null }}
 */
async function factsFor(supabase, desk, message) {
  const keys = ((desk && desk.facts) || []).filter((k) => PROVIDERS[k] && PROVIDERS[k].topic.test(topicText(message)));
  if (!keys.length) return { covered: [], basis: null, state: {}, note: NOT_VERIFIED };
  const state = {}; let observed = [], unknown = [], conclusions = [];
  for (const k of keys) {
    const st = await PROVIDERS[k].load(supabase); state[k] = st;
    const b = PROVIDERS[k].basis(st); observed = observed.concat(b.observed); unknown = unknown.concat(b.unknown); conclusions = conclusions.concat(b.conclusions);
  }
  return { covered: keys.map((k) => PROVIDERS[k].label), basis: FB.basis({ observed, unknown, conclusions }), state, note: null };
}

/**
 * After drafting: statements the covered records contradict. Never claims more than it checked.
 * @returns {{ checked: string[], issues: object[], note: string }}
 */
function checkDraft(text, facts) {
  if (!facts || !facts.covered || !facts.covered.length) return { checked: [], issues: [], note: NOT_VERIFIED };
  const issues = [];
  for (const k of Object.keys(facts.state)) issues.push(...PROVIDERS[k].check(text, facts.state[k]));
  return { checked: facts.covered, issues, note: issues.length ? `${issues.length} statement(s) conflict with ${facts.covered.join(', ')}. Correct them before approving.` : `Checked against ${facts.covered.join(', ')} only; other statements were not verified automatically.` };
}

module.exports = { factsFor, checkDraft, positivePayState, positivePayBasis, positivePayClaims, PROVIDERS, NOT_VERIFIED };
