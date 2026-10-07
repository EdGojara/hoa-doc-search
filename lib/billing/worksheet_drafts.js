// ============================================================================
// lib/billing/worksheet_drafts.js  (Ed 2026-10-07)
// ----------------------------------------------------------------------------
// SAVE PROGRESS for the Bedrock Office Billing invoice worksheet.
//
// One saved worksheet per community + invoice type + service month
// (billing_worksheet_drafts, migration 493). Saving never generates, posts,
// finalizes or sends anything, and never touches association accounting.
//
// Rules:
//   * Saving the same worksheet again UPDATES it (revision + 1); it never
//     creates a second row (UNIQUE community/type/month).
//   * Every save names the revision it was based on. A save or a generate based
//     on an OLDER revision than the stored one is refused (409), so a stale tab
//     or a generate click can never silently overwrite a later save.
//   * Restoring returns the saved lines exactly. One-off charges (pending items)
//     staged AFTER the save are added; one-offs the operator removed stay
//     removed; a saved one-off that is no longer pending (billed or deleted
//     elsewhere) is dropped so it can never bill twice, and that is reported.
//   * Generating marks the worksheet with the invoice it became. Existing
//     invoices are never changed by anything here.
// ============================================================================
const LINE_FIELDS = ['source', 'source_ref_id', 'category', 'description', 'qty', 'unit_price', 'amount', 'vantaca_source_ref', 'sort_order', 'pending_item_id'];
const MAX_LINES = 300;
const TYPES = new Set(['fixed', 'activity']);
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class DraftError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); }
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Keep only the worksheet fields, as numbers/strings. Pure. */
function normalizeLines(lines) {
  if (!Array.isArray(lines)) throw new DraftError(400, 'lines_required', 'lines must be an array');
  if (lines.length > MAX_LINES) throw new DraftError(400, 'too_many_lines', `at most ${MAX_LINES} lines`);
  return lines.map((l, i) => {
    if (!l || typeof l !== 'object') throw new DraftError(400, 'bad_line', `line ${i + 1} is not an object`);
    const out = {};
    for (const k of LINE_FIELDS) if (l[k] !== undefined) out[k] = l[k];
    out.description = String(out.description == null ? '' : out.description).slice(0, 500);
    out.qty = num(out.qty); out.unit_price = num(out.unit_price); out.amount = Math.round(num(out.amount) * 100) / 100;
    out.sort_order = out.sort_order == null ? i * 10 : num(out.sort_order);
    if (out.pending_item_id != null && !UUID_RE.test(String(out.pending_item_id))) delete out.pending_item_id;
    return out;
  });
}

function normalizeRemoved(ids) {
  if (ids == null) return [];
  if (!Array.isArray(ids)) throw new DraftError(400, 'bad_removed', 'removed_pending_item_ids must be an array');
  return [...new Set(ids.map(String).filter((x) => UUID_RE.test(x)))];
}

function assertKey({ communityId, type, period }) {
  if (!communityId || !UUID_RE.test(String(communityId))) throw new DraftError(400, 'bad_community', 'community id required');
  if (!TYPES.has(type)) throw new DraftError(400, 'bad_type', "type must be 'fixed' or 'activity'");
  if (!PERIOD_RE.test(String(period || ''))) throw new DraftError(400, 'bad_period', "period must be 'YYYY-MM'");
}

/**
 * The worksheet to show when a saved draft exists. Pure.
 * @param savedLines        the saved worksheet lines
 * @param removedPendingIds one-offs the operator removed from this invoice
 * @param pendingLines      one-off charges pending NOW (pendingItemsAsLines)
 */
function mergeRestore({ savedLines = [], removedPendingIds = [], pendingLines = [] }) {
  const pendingNow = new Map(pendingLines.filter((p) => p.pending_item_id).map((p) => [String(p.pending_item_id), p]));
  const removed = new Set(removedPendingIds.map(String));
  const kept = []; const dropped = [];
  for (const l of savedLines) {
    if (l.pending_item_id && !pendingNow.has(String(l.pending_item_id))) { dropped.push(l); continue; }   // billed/deleted elsewhere: never bill twice
    kept.push({ ...l });
  }
  const inSaved = new Set(kept.filter((l) => l.pending_item_id).map((l) => String(l.pending_item_id)));
  const added = [...pendingNow.values()].filter((p) => !inSaved.has(String(p.pending_item_id)) && !removed.has(String(p.pending_item_id)));
  return { lines: [...kept, ...added.map((p) => ({ ...p }))], added_pending: added.length, dropped_pending: dropped.map((l) => ({ pending_item_id: l.pending_item_id, description: l.description, amount: l.amount })) };
}

const SELECT = 'id, community_id, invoice_type, service_period, lines, removed_pending_item_ids, revision, saved_at, saved_by, generated_invoice_id, generated_at';
const tableMissing = (e) => e && /billing_worksheet_drafts|relation .* does not exist|schema cache|PGRST20[45]|42P01/i.test(`${e.message} ${e.code}`);

async function getDraft(supabase, key) {
  assertKey(key);
  const { data, error } = await supabase.from('billing_worksheet_drafts').select(SELECT)
    .eq('community_id', key.communityId).eq('invoice_type', key.type).eq('service_period', key.period).maybeSingle();
  if (error) { if (tableMissing(error)) return null; throw error; }
  return data || null;
}

/**
 * Save (create or update) the worksheet. baseRevision = the revision the screen
 * was showing (0 when it had no saved worksheet). Returns the saved row.
 */
async function saveDraft(supabase, { communityId, type, period, lines, removedPendingIds, baseRevision, savedBy = null }) {
  assertKey({ communityId, type, period });
  const cleanLines = normalizeLines(lines);
  const cleanRemoved = normalizeRemoved(removedPendingIds);
  const base = Number(baseRevision || 0);
  const now = new Date().toISOString();
  const existing = await getDraft(supabase, { communityId, type, period });
  if (!existing) {
    if (base > 0) throw new DraftError(409, 'draft_missing', 'the saved worksheet you were editing no longer exists; reload');
    const { data, error } = await supabase.from('billing_worksheet_drafts')
      .insert({ community_id: communityId, invoice_type: type, service_period: period, lines: cleanLines, removed_pending_item_ids: cleanRemoved, revision: 1, saved_at: now, saved_by: savedBy })
      .select(SELECT).single();
    if (error) {
      if (error.code === '23505') throw new DraftError(409, 'newer_draft_saved', 'someone saved this worksheet first; reload to see it');
      throw error;
    }
    return data;
  }
  if (base !== existing.revision) {
    throw new DraftError(409, 'newer_draft_saved', `this worksheet was saved again after you opened it (revision ${existing.revision}, ${existing.saved_at}); reload before saving`, { current: { revision: existing.revision, saved_at: existing.saved_at, saved_by: existing.saved_by } });
  }
  const { data, error } = await supabase.from('billing_worksheet_drafts')
    .update({ lines: cleanLines, removed_pending_item_ids: cleanRemoved, revision: existing.revision + 1, saved_at: now, saved_by: savedBy })
    .eq('id', existing.id).eq('revision', existing.revision)          // optimistic: only if nobody saved in between
    .select(SELECT);
  if (error) throw error;
  if (!data || data.length !== 1) throw new DraftError(409, 'newer_draft_saved', 'this worksheet was saved again while you were saving; reload');
  return data[0];
}

/** Refuse a generate based on an older worksheet than the saved one. */
async function assertGenerateNotStale(supabase, { communityId, type, period, draftRevision }) {
  const d = await getDraft(supabase, { communityId, type, period });
  if (d && Number(draftRevision || 0) < d.revision) {
    throw new DraftError(409, 'newer_draft_saved', `a newer saved worksheet exists for this month (revision ${d.revision}, saved ${d.saved_at}); reload it before generating`, { current: { revision: d.revision, saved_at: d.saved_at, saved_by: d.saved_by } });
  }
  return d;
}

/** After a successful generate: record which invoice the worksheet became. Never creates a row. */
async function markGenerated(supabase, { communityId, type, period, draftRevision, invoiceId }) {
  if (!draftRevision) return null;
  const { data, error } = await supabase.from('billing_worksheet_drafts')
    .update({ generated_invoice_id: invoiceId, generated_at: new Date().toISOString() })
    .eq('community_id', communityId).eq('invoice_type', type).eq('service_period', period).eq('revision', Number(draftRevision))
    .select('id');
  if (error) { if (tableMissing(error)) return null; throw error; }
  return (data && data[0]) || null;
}

module.exports = { normalizeLines, normalizeRemoved, mergeRestore, getDraft, saveDraft, assertGenerateNotStale, markGenerated, DraftError };
