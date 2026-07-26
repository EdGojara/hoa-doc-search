// ============================================================================
// lib/email/reply_learning.js  (Ed 2026-07-25)
// ----------------------------------------------------------------------------
// Encode-Ed for email replies. Two halves of one loop:
//
//   captureReplyEdit()  — on every send, record Claire's ORIGINAL draft next to
//                         the FINAL text the human sent, plus an edit distance.
//   getReplyExamples()  — before Claire drafts, pull a few of the most relevant
//                         PAST Ed-edits so she can match how he actually answers.
//
// Single-teacher (project_single_teacher_learning): only the OWNER's edits are
// fed back as examples — staff edits are captured for the record but do NOT
// encode. Both halves are best-effort: a failure (or the table not applied yet)
// must NEVER break sending or drafting.
// ============================================================================

// The reply-edit table doesn't exist until migration 335 is applied — until
// then every call here no-ops cleanly.

// An edit only teaches something if it's more than a typo fix. Below this
// normalized-distance floor we treat the send as "Claire nailed it" — good for
// the edit-rate metric, but not a correction worth showing as an example.
const SUBSTANTIVE_EDIT_RATIO = 0.08;
const MAX_EXAMPLES = 4;
const EXAMPLE_CHARS = 700;         // cap each side of an example in the prompt
const RATIO_CHAR_CAP = 2000;       // bound the O(n*m) distance calc

// Levenshtein distance (two-row, space-optimized), inputs bounded so a long
// reply can't blow up the calc. Returns an integer edit distance.
function levenshtein(a, b) {
  a = String(a || '').slice(0, RATIO_CHAR_CAP);
  b = String(b || '').slice(0, RATIO_CHAR_CAP);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[b.length];
}

// Normalized 0..1 edit ratio. 0 = identical, 1 = completely different.
// Whitespace-normalized so a reflow / trailing-newline change isn't counted
// as an edit.
function editRatio(original, final) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const a = norm(original), b = norm(final);
  if (!a && !b) return 0;
  const d = levenshtein(a, b);
  const denom = Math.max(a.length, b.length) || 1;
  return Math.min(1, d / denom);
}

// Record a draft->sent pair. Best-effort: swallows every error (incl. the
// table not existing yet). `editedBy` is the sender's identity (single-teacher
// filtering happens at retrieval).
async function captureReplyEdit(supabase, {
  inboundId, outboundId, communityId, persona, classification, subject,
  originalDraft, finalSent, editedBy,
}) {
  try {
    const orig = String(originalDraft || '');
    const fin = String(finalSent || '');
    if (!orig || !fin) return { ok: false, skipped: 'no_draft' }; // composed-from-scratch: no baseline to learn from
    const ratio = editRatio(orig, fin);
    const { error } = await supabase.from('email_reply_edits').insert({
      inbound_message_id: inboundId || null,
      outbound_message_id: outboundId || null,
      community_id: communityId || null,
      persona: persona || null,
      classification: classification || null,
      subject: subject || null,
      original_draft: orig,
      final_sent: fin,
      was_edited: ratio >= 0.005,             // anything beyond a whitespace tweak
      edit_ratio: Number(ratio.toFixed(4)),
      edited_by: editedBy || null,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, was_edited: ratio >= 0.005, edit_ratio: ratio };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Pull the most relevant past OWNER edits to show Claire how Ed answers this
// kind of mail. Prefers same persona + classification (and same community when
// available); falls back to persona-only so a brand-new class still learns
// something. Returns [] on any failure. ownerEmail enforces single-teacher.
async function getReplyExamples(supabase, { persona, classification, communityId, ownerEmail, limit = MAX_EXAMPLES } = {}) {
  if (!supabase || !persona) return [];
  const base = () => {
    let q = supabase.from('email_reply_edits')
      .select('original_draft, final_sent, subject, classification, community_id, edit_ratio, created_at')
      .eq('persona', persona)
      .eq('was_edited', true)
      .gte('edit_ratio', SUBSTANTIVE_EDIT_RATIO)
      .order('created_at', { ascending: false })
      .limit(limit * 3); // over-fetch, then rank in JS
    if (ownerEmail) q = q.ilike('edited_by', ownerEmail);
    return q;
  };
  try {
    const { data, error } = await base();
    if (error || !data || !data.length) return [];
    // Rank: same classification first, then same community, then recency.
    const ranked = data.slice().sort((x, y) => {
      const cx = (x.classification === classification ? 2 : 0) + (communityId && x.community_id === communityId ? 1 : 0);
      const cy = (y.classification === classification ? 2 : 0) + (communityId && y.community_id === communityId ? 1 : 0);
      if (cx !== cy) return cy - cx;
      return String(y.created_at).localeCompare(String(x.created_at));
    });
    return ranked.slice(0, limit).map((r) => ({
      subject: r.subject || null,
      original_draft: r.original_draft || '',
      final_sent: r.final_sent || '',
      edit_ratio: Number(r.edit_ratio) || 0,
    }));
  } catch (_) {
    return [];
  }
}

// ── Training readiness ──────────────────────────────────────────────────────
// Ed's plan: "release the team to auto-respond when the error rate gets low
// enough." This turns that gut call into a number. For each teammate, over the
// OWNER's recent sends (single-teacher), what share of the AI's drafts went out
// with only a trivial edit ("clean"), how big were the edits on average, and is
// the recent trend clean enough + on enough volume to trust it unsupervised.
//
// "error" here = a SUBSTANTIVE edit (edit_ratio >= SUBSTANTIVE_EDIT_RATIO). A
// whitespace/typo tweak is not the AI being wrong. Composed-from-scratch replies
// never reach the table (no baseline), so the denominator is honestly "drafts
// the AI produced that Ed acted on."
const READY_MIN_N = 20;                 // don't call anything ready on a handful
const READY_MAX_SUBSTANTIVE_RATE = 0.15; // 85%+ of recent drafts go out ~as-is
const RECENT_WINDOW = 20;               // "recent" = last N sends per persona

async function personaReadiness(supabase, { ownerEmail, window = 1000 } = {}) {
  const out = {};
  if (!supabase) return out;
  try {
    let q = supabase.from('email_reply_edits')
      .select('persona, was_edited, edit_ratio, created_at')
      .order('created_at', { ascending: false })
      .limit(window);
    if (ownerEmail) q = q.ilike('edited_by', ownerEmail);
    const { data, error } = await q;
    if (error || !data) return out;
    // Group by persona (data already newest-first, so per-persona slices keep order).
    const byPersona = {};
    for (const r of data) {
      const p = r.persona || 'unknown';
      (byPersona[p] = byPersona[p] || []).push(r);
    }
    for (const [persona, rows] of Object.entries(byPersona)) {
      const n = rows.length;
      const isSub = (r) => Number(r.edit_ratio) >= SUBSTANTIVE_EDIT_RATIO;
      const substantive = rows.filter(isSub).length;
      const meanRatio = rows.reduce((s, r) => s + (Number(r.edit_ratio) || 0), 0) / (n || 1);
      const recent = rows.slice(0, RECENT_WINDOW);
      const recentSub = recent.filter(isSub).length;
      const recentRate = recent.length ? recentSub / recent.length : 0;
      const ready = n >= READY_MIN_N && recentRate <= READY_MAX_SUBSTANTIVE_RATE;
      out[persona] = {
        n,
        substantive_edits: substantive,
        clean_rate: Number((1 - substantive / (n || 1)).toFixed(3)),
        substantive_rate: Number((substantive / (n || 1)).toFixed(3)),
        mean_edit_ratio: Number(meanRatio.toFixed(3)),
        recent_n: recent.length,
        recent_substantive_rate: Number(recentRate.toFixed(3)),
        ready,
        reason: ready
          ? `Clean on ${Math.round((1 - recentRate) * 100)}% of the last ${recent.length} — ready to consider auto-send`
          : n < READY_MIN_N
            ? `Only ${n} edits so far — need ${READY_MIN_N}+ to judge`
            : `Still editing ${Math.round(recentRate * 100)}% of recent drafts — keep training`,
      };
    }
    return out;
  } catch (_) {
    return out;
  }
}

// Format examples into a prompt block. Returns '' when there are none, so the
// caller can inject it unconditionally.
function formatExamplesForPrompt(examples) {
  if (!examples || !examples.length) return '';
  const clip = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, EXAMPLE_CHARS);
  const blocks = examples.map((e, i) => `Example ${i + 1}${e.subject ? ` (re: ${clip(e.subject).slice(0, 80)})` : ''}:
AI's first draft: ${clip(e.original_draft)}
What Ed actually sent: ${clip(e.final_sent)}`).join('\n\n');
  return `HOW ED EDITS THESE REPLIES — this is the most important guidance below. Each example is a real reply of this kind: the AI's first draft, then what Ed actually sent after editing it. Learn the PATTERN of his changes — his tone, how direct he is, what he adds, what he cuts, the positions he takes — and write this draft the way HE would. Apply the pattern; do NOT copy these verbatim or mention them.

${blocks}`;
}

module.exports = { captureReplyEdit, getReplyExamples, personaReadiness, formatExamplesForPrompt, editRatio, SUBSTANTIVE_EDIT_RATIO };
