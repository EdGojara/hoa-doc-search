// ============================================================================
// lib/voice/tools.js — Tool definitions Claire can call mid-conversation
// ----------------------------------------------------------------------------
// Anthropic tool-use lets Claude pause mid-response, ask our backend to
// perform a specific action (look up data, etc.), receive the result, then
// continue generating a response that incorporates the data.
//
// Each tool is defined twice:
//   1. The DEFINITION (JSON schema) — passed to anthropic.messages.create
//      via the `tools` array so Claude knows what's available and how to
//      call it.
//   2. The HANDLER (async function) — wired in toolHandlers map, invoked
//      by streamTurn when Claude emits a tool_use block. Returns a result
//      object that's serialized as the tool_result content for Claude's
//      continuation.
//
// Design rules:
//   - Tools should be NARROW and SPECIFIC. "get_ar_for_property" not
//     "get_anything." Narrow tools = predictable model behavior + easier
//     to debug.
//   - Handlers must NEVER throw uncaught. Wrap DB calls in try/catch and
//     return structured error results so Claude can gracefully say
//     "I couldn't look that up — let me take a message."
//   - Handler results should include a `disclosure` field when the data
//     has freshness limitations (e.g., AR snapshot date). Claire reads
//     and surfaces it per the SYNTHESIS PRINCIPLE / disclosure pattern
//     in the system prompt.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ----------------------------------------------------------------------------
// TOOL: get_ar_for_property
// Looks up the most recent AR snapshot for a property identified by
// community + address. Used when a caller asks for their account balance.
// ----------------------------------------------------------------------------

const get_ar_for_property_definition = {
  name: 'get_ar_for_property',
  description:
    'Look up the most recent account receivable (AR) balance for a property at a given community. ' +
    'Use this when the caller asks about their account balance, dues owed, payment status, or amount due. ' +
    'IMPORTANT: Before calling this tool, you MUST first ask the caller to confirm the property address you are looking up — this serves as identity verification for sensitive financial info. ' +
    'The result is a SNAPSHOT, not a live ledger. Always disclose the as-of date and that any payments or charges since that date are not reflected.',
  input_schema: {
    type: 'object',
    properties: {
      community_name: {
        type: 'string',
        description: 'The name of the community (e.g., "Waterview Estates", "August Meadows"). Usually known from call context.',
      },
      address: {
        type: 'string',
        description:
          'The property street address as the caller stated it. Just house number + street name is fine; can omit unit/suite/city/state. Example: "5226 Jay Thrush" or "5226 Jay Thrush Way".',
      },
    },
    required: ['community_name', 'address'],
  },
};

/**
 * Handler for get_ar_for_property.
 *
 * @param {object} input — { community_name, address }
 * @param {object} ctx   — { community, caller } from streamTurn caller context
 * @returns {object} structured result or error
 */
async function get_ar_for_property_handler(input, _ctx) {
  const { community_name, address } = input || {};
  if (!community_name || !address) {
    return { error: 'missing_input', detail: 'community_name and address required' };
  }

  // Step 1: resolve community by name (fuzzy via ILIKE)
  let communityRow;
  try {
    const { data, error } = await supabase
      .from('communities')
      .select('id, name')
      .ilike('name', `%${community_name.trim()}%`)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    communityRow = data;
  } catch (e) {
    console.warn(`[tool get_ar_for_property] community lookup failed: ${e.message}`);
    return { error: 'community_lookup_failed' };
  }
  if (!communityRow) {
    return { error: 'community_not_found', community_searched: community_name };
  }

  // Step 2: extract a house number + street-name fragment from the address.
  // Caller speech often includes more or less than the canonical address;
  // we want to be forgiving. Use the leading digit run + a few non-numeric
  // words as the fuzzy match key.
  const cleanedAddr = String(address).trim().replace(/\s+/g, ' ');
  // Match common spoken patterns: "5226 Jay Thrush" or "5226 Jay Thrush Way"
  const houseNumMatch = cleanedAddr.match(/^\s*(\d+)\s+(.+?)\s*$/);
  if (!houseNumMatch) {
    return { error: 'address_unparseable', address_given: address };
  }
  const houseNum = houseNumMatch[1];
  const streetFragment = houseNumMatch[2]
    .split(/\s+/)
    .slice(0, 2)            // first two words after house number — usually enough
    .join(' ');

  // Step 3: find the property. ILIKE pattern: "5226%Jay Thrush%" — matches
  // "5226 Jay Thrush Way", "5226 Jay Thrush Lane", etc.
  let propertyRow;
  try {
    const { data, error } = await supabase
      .from('properties')
      .select('id, street_address')
      .eq('community_id', communityRow.id)
      .ilike('street_address', `${houseNum}%${streetFragment}%`)
      .limit(2);
    if (error) throw error;
    if (!data || data.length === 0) {
      return {
        error: 'property_not_found',
        community: communityRow.name,
        address_given: address,
      };
    }
    if (data.length > 1) {
      // Ambiguous match — return both so Claire can ask the caller to clarify
      return {
        error: 'address_ambiguous',
        community: communityRow.name,
        candidates: data.map((r) => r.street_address),
      };
    }
    propertyRow = data[0];
  } catch (e) {
    console.warn(`[tool get_ar_for_property] property lookup failed: ${e.message}`);
    return { error: 'property_lookup_failed' };
  }

  // Step 4: fetch most recent AR snapshot for this property
  let snapshot;
  try {
    const { data, error } = await supabase
      .from('owner_ar_snapshots')
      .select('balance_total, snapshot_date, at_legal, in_collections, payment_plan_active, payment_plan_terms_text, enforcement_stage')
      .eq('property_id', propertyRow.id)
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    snapshot = data;
  } catch (e) {
    console.warn(`[tool get_ar_for_property] snapshot lookup failed: ${e.message}`);
    return { error: 'snapshot_lookup_failed' };
  }
  if (!snapshot) {
    return {
      error: 'no_ar_snapshot_on_file',
      property_address: propertyRow.street_address,
      detail: 'No AR snapshot has been uploaded for this property yet.',
    };
  }

  // Format snapshot_date for human readability
  let snapshotDateHuman = snapshot.snapshot_date;
  try {
    const d = new Date(snapshot.snapshot_date);
    snapshotDateHuman = d.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  } catch (_) { /* fall back to raw date string */ }

  // Format balance as dollars
  let balanceFormatted = null;
  if (snapshot.balance_total != null) {
    const n = Number(snapshot.balance_total);
    if (Number.isFinite(n)) {
      balanceFormatted = `$${n.toFixed(2)}`;
    }
  }

  return {
    ok: true,
    property_address: propertyRow.street_address,
    community: communityRow.name,
    balance: balanceFormatted,
    balance_raw: snapshot.balance_total,
    snapshot_date: snapshot.snapshot_date,
    snapshot_date_human: snapshotDateHuman,
    at_legal: !!snapshot.at_legal,
    in_collections: !!snapshot.in_collections,
    payment_plan_active: !!snapshot.payment_plan_active,
    payment_plan_terms: snapshot.payment_plan_terms_text || null,
    enforcement_stage: snapshot.enforcement_stage || null,
    disclosure:
      `This balance is from a snapshot as of ${snapshotDateHuman} — it is NOT live ledger state. ` +
      `Any payments or charges since that date are NOT reflected. ` +
      `For the precise current balance, the caller can log into Vantaca or you can offer to have Martha pull it and call them back.`,
  };
}

// ----------------------------------------------------------------------------
// Exports — tool definitions array + handler map
// ----------------------------------------------------------------------------

const VOICE_TOOLS = [get_ar_for_property_definition];

const VOICE_TOOL_HANDLERS = {
  get_ar_for_property: get_ar_for_property_handler,
};

module.exports = {
  VOICE_TOOLS,
  VOICE_TOOL_HANDLERS,
  // Exported individually for testing / future tool composition
  get_ar_for_property_definition,
  get_ar_for_property_handler,
};
