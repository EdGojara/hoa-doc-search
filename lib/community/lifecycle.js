// ============================================================================
// lib/community/lifecycle.js — is this community still one we do that for?
// ----------------------------------------------------------------------------
// Ed 2026-08-21: "we aren't going to onboard eaglewood, we are losing them as a
// client. we need to keep the DRV and ARC in our system but lets not do any
// financials or payments. our last day will be 9/30" — then "we are going to
// keep in vantaca and stop all migration" and "only DRV and ARC will need to be
// exported later."
//
// A community can be winding down in one area and fully operating in another.
// Eaglewood's financials stop now, its enforcement runs to the last day, and its
// records outlive both. One `active` boolean cannot say that.
//
// THE POINT OF THIS FILE is that the flags from migration 382 are READ. Today
// produced six separate bugs of the shape "a value was computed and nothing
// consumed it" — body_full, attachment filenames, recipient lists, the MICR
// pre-encoded flag, generated PDFs, Ed's own identity. A lifecycle flag that
// nothing checks would be the seventh, and the failure would be a check cut for
// a community we no longer manage.
//
// Read-only and fail-OPEN on a lookup error. A database hiccup must not block
// work for the seven communities that are perfectly fine; the refusals here are
// deliberate answers about a known state, never the fallout of a failed query.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const SELECT = 'id, name, management_status, management_end_date, financials_active, '
  + 'enforcement_active, arc_active, books_of_record, records_handover_due_date';

// Cached briefly: this is consulted on write paths that can run in a loop
// (posting a batch of invoices), and the answer changes about once a year.
const CACHE = new Map();
const TTL_MS = 60 * 1000;

async function getLifecycle(communityId, { now = null } = {}) {
  if (!communityId) return null;
  const hit = CACHE.get(communityId);
  const stamp = now ? new Date(now).getTime() : Date.now();
  if (hit && (stamp - hit.at) < TTL_MS) return hit.row;
  try {
    const { data, error } = await supabase.from('communities')
      .select(SELECT).eq('id', communityId).maybeSingle();
    if (error) throw error;
    CACHE.set(communityId, { at: stamp, row: data || null });
    return data || null;
  } catch (e) {
    // Column-not-found means migration 382 has not run yet. Everything behaves
    // exactly as it did before, which is the correct answer in that world.
    if (!/does not exist|schema cache/i.test(e.message || '')) {
      console.warn('[lifecycle] lookup failed:', e.message);
    }
    return null;
  }
}

/** Past the last day we manage it? */
function isPastEnd(row, today = null) {
  if (!row || !row.management_end_date) return false;
  const end = String(row.management_end_date).slice(0, 10);
  const day = (today ? new Date(today) : new Date()).toISOString().slice(0, 10);
  return day > end;
}

/**
 * May we do <service> for this community right now?
 *
 * Returns { allowed, reason, row }. `reason` is written for a person to read on
 * screen, because a refusal nobody understands gets worked around.
 *
 *   financials   GL, AP, checks, statements
 *   payments     Stripe, online payment surfaces
 *   enforcement  DRV / §209
 *   arc          architectural review
 *   welcome      new-homeowner welcome packet
 */
async function canDo(service, communityId, { today = null } = {}) {
  const row = await getLifecycle(communityId);
  return evaluate(service, row, today);
}

/**
 * The decision itself, with no database in it.
 *
 * Split out so the rules that gate money can be tested directly, against rows
 * that do not have to exist yet. A gate this consequential should not be
 * verifiable only by having the right client mid-termination in production.
 */
function evaluate(service, row, today = null) {
  if (!row) return { allowed: true, reason: null, row: null };

  if (row.management_status === 'terminated' || isPastEnd(row, today)) {
    const when = row.management_end_date ? ` on ${String(row.management_end_date).slice(0, 10)}` : '';
    // Records stay reachable forever — reading and exporting are not services.
    return {
      allowed: false, row,
      reason: `Bedrock stopped managing ${row.name}${when}. Records stay available to read and export; new work does not.`,
    };
  }

  // Welcoming someone to a community we are handing off is the one refusal that
  // is about the RESIDENT rather than about us. A packet that says "here is how
  // to reach your management company" is false the moment the engagement ends,
  // and the new owner is the person least able to know that. So `welcome` is
  // the only service refused while merely 'terminating' — everything else keeps
  // running to the last day on purpose. (Ed 2026-08-24: "each community except
  // eaglewood" — Eaglewood ends 2026-09-30.)
  if (service === 'welcome' && row.management_status === 'terminating') {
    const when = row.management_end_date ? ` on ${String(row.management_end_date).slice(0, 10)}` : ' shortly';
    return {
      allowed: false, row,
      reason: `Bedrock stops managing ${row.name}${when}, so a welcome packet would introduce a new owner to a management company they are about to lose. Enforcement and architectural review continue to the last day.`,
    };
  }

  const flag = {
    financials: 'financials_active',
    payments: 'financials_active',
    enforcement: 'enforcement_active',
    arc: 'arc_active',
  }[service];
  if (!flag) return { allowed: true, reason: null, row };

  if (row[flag] === false) {
    const detail = service === 'payments'
      ? `Online payments are switched off for ${row.name}.`
      : service === 'financials'
        ? `Financial work is switched off for ${row.name}${row.books_of_record && row.books_of_record !== 'trusted' ? ` — the books are in ${row.books_of_record}` : ''}.`
        : `${service} is switched off for ${row.name}.`;
    const end = row.management_end_date ? ` Management ends ${String(row.management_end_date).slice(0, 10)}.` : '';
    return { allowed: false, reason: detail + end, row };
  }
  return { allowed: true, reason: null, row };
}

/**
 * Can financial statements be rendered from OUR data?
 *
 * Separate from canDo('financials') on purpose. Switching financial work off
 * stops new activity; this asks a different and more dangerous question —
 * whether the numbers we hold are the association's actual books.
 *
 * Eaglewood is the case that forced it: 179 journal entries covering January to
 * August 2026 sit in trustEd from a cutover that was abandoned. A balance sheet
 * built from them renders perfectly and is wrong, because the rest of the year
 * is in Vantaca. Nothing on the page would say so.
 */
async function canRenderFinancials(communityId) {
  return evaluateFinancials(await getLifecycle(communityId));
}

/** The books-of-record decision, without a database. */
function evaluateFinancials(row) {
  if (!row) return { allowed: true, reason: null, row: null };
  if (row.books_of_record && row.books_of_record !== 'trusted') {
    return {
      allowed: false, row,
      reason: `${row.name}'s books are kept in ${row.books_of_record}, so what trustEd holds is partial. Statements produced from it would look complete and be wrong.`,
    };
  }
  return { allowed: true, reason: null, row };
}

/** Communities that are winding down, for an ops view. */
async function terminatingCommunities() {
  try {
    const { data, error } = await supabase.from('communities')
      .select(SELECT).in('management_status', ['terminating', 'terminated'])
      .order('management_end_date');
    if (error) throw error;
    return data || [];
  } catch (e) {
    if (!/does not exist|schema cache/i.test(e.message || '')) {
      console.warn('[lifecycle] terminating lookup failed:', e.message);
    }
    return [];
  }
}

function _clearCache() { CACHE.clear(); }

module.exports = { getLifecycle, canDo, canRenderFinancials, evaluate, evaluateFinancials, terminatingCommunities, isPastEnd, _clearCache };
