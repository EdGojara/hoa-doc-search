// ============================================================================
// lib/enforcement/stale_letter_guard.js  (Ed 2026-09-08)
// ----------------------------------------------------------------------------
// A letter is PRINTED (sealed) at one moment and MAILED at a later one. In
// between, an over-escalation correction can reduce the violation's stage — or
// void it outright. When that happens the already-sealed higher-stage letter is
// stale: it must never leave the building. Until now "do not mail" was written
// only as a prose observation note, so the mail run (confirm-mailed) — which
// sweeps every printed+unmailed letter — had no machine-readable signal and
// mailed it anyway (17715 Sunset River Lane got a certified §209 that had been
// explicitly marked stale two months earlier, and it was billed).
//
// This is the CLAUDE.md "cross-check against truth at send time" pattern: before
// a letter is marked mailed, compare its stage to the violation's CURRENT stage.
// If the letter escalates beyond where the corrected case now stands, or the
// violation is voided, HOLD it — never mail, never bill.
//
// Deliberately conservative to avoid false holds:
//  - A cured/closed violation is NOT a hold trigger on its own. A first notice
//    that legitimately mailed and was cured afterward must not be blocked.
//  - Only a STRICT rank increase over an ACTIVE lower stage holds. A letter at
//    the same stage as the (corrected) violation is the corrected letter itself
//    and mails normally.
// ============================================================================

// Letter-type escalation rank.
const LETTER_RANK = {
  letter_postcard_reminder: 1,
  letter_courtesy_1: 1,
  letter_courtesy_2: 2,
  letter_209: 3,
  letter_fine: 4,
  letter_fine_assessed: 4,
};

// Active violation-stage rank (matches LETTER_RANK so a letter at its own stage
// is never "ahead" of the case).
const STAGE_RANK = {
  courtesy_1: 1,
  courtesy_2: 2,
  certified_209: 3,
  fine_assessed: 4,
  hearing: 4,
};

// Stages/statuses that mean the case is dead — a letter for it must never mail.
const DEAD = new Set(['voided', 'withdrawn', 'reclassified', 'duplicate', 'wrong_property']);
// Stages that are neither active-ranked nor dead — do NOT rank-hold on these
// (a letter that legitimately went out and then cured must not be blocked).
const NEUTRAL = new Set(['cured', 'closed', 'resolved', 'complied']);

function letterRank(type) { return LETTER_RANK[type] || 0; }
function stageRank(stage) { return STAGE_RANK[stage] || 0; }

/**
 * Given candidate letters, split them into the ones safe to mail and the stale
 * ones to hold — by reading each violation's CURRENT stage/status.
 *
 * @param supabase
 * @param letters array of { id, type, violation_id, status }
 * @returns { mailable: [row...], stale: [{ id, type, violation_id, reason }] }
 */
async function partitionMailable(supabase, letters) {
  const rows = (letters || []).filter(Boolean);
  const vids = [...new Set(rows.map((l) => l.violation_id).filter(Boolean))];
  const stageBy = new Map();
  const statusBy = new Map();
  for (let i = 0; i < vids.length; i += 300) {
    const { data, error } = await supabase
      .from('violations').select('id, current_stage, status')
      .in('id', vids.slice(i, i + 300));
    if (error) throw error; // fail loud — never guess "no violation" on a query error
    for (const v of data || []) { stageBy.set(v.id, v.current_stage); statusBy.set(v.id, v.status); }
  }

  const mailable = [];
  const stale = [];
  for (const l of rows) {
    if (String(l.status || '').toLowerCase() === 'rejected') {
      stale.push({ ...l, reason: 'already rejected' });
      continue;
    }
    const vid = l.violation_id;
    if (!vid) { mailable.push(l); continue; } // not violation-linked — not this guard's concern
    const stage = String(stageBy.get(vid) || '').toLowerCase();
    const vstatus = String(statusBy.get(vid) || '').toLowerCase();

    if (DEAD.has(stage) || DEAD.has(vstatus)) {
      stale.push({ ...l, reason: `violation ${stage || vstatus}` });
      continue;
    }
    if (NEUTRAL.has(stage)) { mailable.push(l); continue; } // cured/closed after issue — allow
    if (STAGE_RANK[stage] && letterRank(l.type) > stageRank(stage)) {
      stale.push({ ...l, reason: `${l.type} outranks corrected stage ${stage}` });
      continue;
    }
    mailable.push(l);
  }
  return { mailable, stale };
}

module.exports = { partitionMailable, letterRank, stageRank, LETTER_RANK, STAGE_RANK, DEAD, NEUTRAL };
