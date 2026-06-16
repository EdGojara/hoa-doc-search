// ============================================================================
// askEd tools — function-calling support for deterministic lookups.
// ----------------------------------------------------------------------------
// askEd's default retrieval (embeddings + community context block) is great
// for narrative answers. For "what's the phone number for the pool company at
// LPF?" we want a guaranteed-accurate, structured answer the model can read
// back verbatim. That's what tools are for.
//
// Each tool exports an Anthropic-compatible spec + a handler. The dispatcher
// at the bottom routes tool_use blocks to the right handler.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const MAX_TOOL_HOPS = 4;

// ----------------------------------------------------------------------------
// Tool: lookup_community_vendor
// ----------------------------------------------------------------------------
const LOOKUP_VENDOR_TOOL = {
  name: 'lookup_community_vendor',
  description:
    "Look up the active vendor / contact records for a community by service " +
    "category (pool, landscape, security, gate, electrical, plumbing, HVAC, pest " +
    "control, irrigation, cleaning, legal, accounting, insurance, banking, board " +
    "member, onsite staff, or any other). Returns an array of matching contacts — " +
    "a vendor may have multiple people on file (account manager + field supervisor " +
    "+ owner). Each match includes vendor name, contact person, role, phone, " +
    "email, and dates. Use this tool any time the user asks for a phone number, " +
    "email, or contact name for a specific community — never guess or recite from " +
    "memory. If multiple matches are returned, list them all unless the user named " +
    "a specific person or role.",
  input_schema: {
    type: 'object',
    properties: {
      community: {
        type: 'string',
        description:
          "The community name (e.g., 'Lakes of Pine Forest'). Fuzzy-matched — " +
          "partial names are OK. If the user did not name a community, pass an " +
          "empty string and the tool will return the list of available communities."
      },
      category: {
        type: 'string',
        description:
          "The service category keyword (e.g., 'pool', 'landscape', 'security'). " +
          "Fuzzy-matched against the fact's category, label, and value."
      }
    },
    required: ['community', 'category']
  }
};

function normalize(s) {
  return String(s || '').toLowerCase().trim();
}

async function listCommunities() {
  const { data } = await supabase
    .from('communities')
    .select('id, name, slug')
    .eq('management_company_id', BEDROCK_MGMT_CO_ID)
    .eq('active', true);
  return data || [];
}

function fuzzyMatchCommunity(communities, query) {
  const q = normalize(query);
  if (!q) return null;
  // exact slug or name match
  for (const c of communities) {
    if (normalize(c.name) === q || normalize(c.slug) === q) return c;
  }
  // substring match (community name contains query)
  for (const c of communities) {
    if (normalize(c.name).includes(q) || normalize(c.slug).includes(q)) return c;
  }
  // reverse — query contains community name
  for (const c of communities) {
    if (q.includes(normalize(c.name))) return c;
  }
  // token-overlap: every token of community appears in query
  for (const c of communities) {
    const tokens = normalize(c.name).split(/\s+/).filter((t) => t.length > 2);
    if (tokens.length && tokens.every((t) => q.includes(t))) return c;
  }
  return null;
}

function factMatchesCategory(fact, catQ) {
  const haystack = normalize(
    [fact.category, fact.label, fact.value, fact.key].filter(Boolean).join(' ')
  );
  return haystack.includes(catQ);
}

async function lookupCommunityVendor({ community, category }) {
  const catQ = normalize(category);
  const communities = await listCommunities();

  if (!community || !community.trim()) {
    return {
      ok: false,
      error: 'No community specified.',
      available_communities: communities.map((c) => c.name),
    };
  }
  const match = fuzzyMatchCommunity(communities, community);
  if (!match) {
    return {
      ok: false,
      error: `No community matched "${community}".`,
      available_communities: communities.map((c) => c.name),
    };
  }

  const matches = [];

  // 1) Manual facts (these override / supplement computed)
  const { data: facts } = await supabase
    .from('v_community_facts')
    .select('category, label, value, details, last_updated_at, expires_at, is_expired, key')
    .eq('community_id', match.id);

  for (const f of facts || []) {
    if (!factMatchesCategory(f, catQ)) continue;
    const d = f.details || {};
    matches.push({
      source: 'manual_contact',
      vendor_name: d.vendor_name || f.label || null,
      vendor_category: d.vendor_category || f.category || null,
      contact_name: d.contact_name || null,
      role: d.role || null,
      phone: d.phone || extractPhone(f.value),
      email: d.email || extractEmail(f.value),
      start_date: d.start_date || null,
      end_date: d.end_date || null,
      last_verified_at: d.last_verified_at || null,
      last_updated_at: f.last_updated_at,
      is_expired: !!f.is_expired,
      notes: d.notes || null,
    });
  }

  // 2) Computed facts — vendor_contracts joined to vendors
  try {
    const { data: contracts } = await supabase
      .from('vendor_contracts')
      .select(`
        id, service_category, contract_start_date, contract_end_date, status,
        vendor:vendors (
          id, name, primary_contact_name, primary_contact_email, primary_contact_phone
        )
      `)
      .eq('community_id', match.id)
      .eq('status', 'active');

    for (const c of contracts || []) {
      const haystack = normalize(
        [c.service_category, c.vendor?.name, c.vendor?.primary_contact_name].filter(Boolean).join(' ')
      );
      if (!haystack.includes(catQ)) continue;
      const v = c.vendor;
      if (!v) continue;
      matches.push({
        source: 'vendor_contract',
        vendor_name: v.name,
        vendor_category: c.service_category,
        contact_name: v.primary_contact_name,
        role: null,
        phone: v.primary_contact_phone,
        email: v.primary_contact_email,
        start_date: c.contract_start_date,
        end_date: c.contract_end_date,
        last_verified_at: null,
        last_updated_at: c.contract_start_date,
        is_expired: false,
        notes: null,
      });
    }
  } catch (err) {
    console.warn('[askEdTools] vendor_contracts lookup failed:', err.message);
  }

  if (matches.length === 0) {
    return {
      ok: false,
      error: `No vendor or contact records found for "${category}" in ${match.name}. The user can add one in the Profile → Contacts tab.`,
      community: match.name,
    };
  }

  return {
    ok: true,
    community: match.name,
    category_query: category,
    match_count: matches.length,
    matches,
  };
}

function extractPhone(s) {
  if (!s) return null;
  const m = String(s).match(/(?:\+?1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  return m ? m[0] : null;
}
function extractEmail(s) {
  if (!s) return null;
  const m = String(s).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m ? m[0] : null;
}

// ----------------------------------------------------------------------------
// Tool: get_homeowner_contact_history
// ----------------------------------------------------------------------------
// Pulls the call/email/note timeline for a property and returns a brief AI
// summary + the last 8 interactions + any open follow-ups. Use when the user
// asks "what's the story on 5226 Jay Thrush", "did we hear back from the
// owner at 123 Main", "is there a follow-up pending", "what was the last
// thing we talked to them about", or similar history questions.
//
// Staff-facing — full content access including internal notes. (The voice
// version in lib/voice/tools.js filters those for caller-facing replies.)
// ----------------------------------------------------------------------------
const HOMEOWNER_HISTORY_TOOL = {
  name: 'get_homeowner_contact_history',
  description:
    "Look up the recent contact history (calls, notes, emails, follow-ups) for a homeowner / property. " +
    "Use this whenever the user asks about a property's contact history, prior conversations, what was " +
    "discussed last, who called when, what was promised, or whether a follow-up is pending. " +
    "Returns a short AI summary plus the last 8 interactions in chronological order. " +
    "Pass either a community + address (preferred when the user names a property by address) OR a " +
    "property_id if one is already known. Never guess a homeowner's history — call this tool.",
  input_schema: {
    type: 'object',
    properties: {
      community: {
        type: 'string',
        description: "The community name (e.g., 'Waterview Estates'). Fuzzy-matched.",
      },
      address: {
        type: 'string',
        description: "Property street address as the user stated it. House number + street name is enough (e.g., '5226 Jay Thrush' or '14219 Sloan Street').",
      },
      property_id: {
        type: 'string',
        description: "Optional — the property UUID if already known from context. If supplied, community + address are ignored.",
      },
    },
    required: [],
  },
};

async function getHomeownerContactHistory(input) {
  const { getInteractionHistoryBundle } = require('./interactions/history');
  return await getInteractionHistoryBundle({
    property_id: input.property_id || null,
    community_name: input.community || null,
    address: input.address || null,
    caller_facing: false,
    include_recent: true,
  });
}

// ----------------------------------------------------------------------------
// Dispatcher — used by both /ask-ed and /ask-ed-stream
// ----------------------------------------------------------------------------
const TOOLS = [LOOKUP_VENDOR_TOOL, HOMEOWNER_HISTORY_TOOL];

async function executeAskEdTool(name, input) {
  try {
    if (name === LOOKUP_VENDOR_TOOL.name) {
      return await lookupCommunityVendor(input || {});
    }
    if (name === HOMEOWNER_HISTORY_TOOL.name) {
      return await getHomeownerContactHistory(input || {});
    }
    return { ok: false, error: `Unknown tool: ${name}` };
  } catch (err) {
    console.error('[askEdTools] handler error:', err.stack || err.message);
    return { ok: false, error: 'Tool execution failed: ' + err.message };
  }
}

// ----------------------------------------------------------------------------
// runAskEdWithTools — non-streaming tool loop.
// Caller passes the initial messages + system prompt; we run the loop until the
// model stops asking for tools (or we hit MAX_TOOL_HOPS) and return the final
// concatenated text. Use this for /ask-ed and any other non-stream endpoint.
// ----------------------------------------------------------------------------
async function runAskEdWithTools({
  anthropic,
  messages,
  system,
  model = 'claude-sonnet-4-6',
  max_tokens = 1500,
}) {
  if (!anthropic) throw new Error('runAskEdWithTools: anthropic client is required');
  const convo = [...messages];
  let response;
  for (let i = 0; i < MAX_TOOL_HOPS; i++) {
    response = await anthropic.messages.create({
      model, max_tokens, system, tools: TOOLS, messages: convo,
    });
    if (response.stop_reason !== 'tool_use') break;
    convo.push({ role: 'assistant', content: response.content });
    const results = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const result = await executeAskEdTool(block.name, block.input);
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }
    convo.push({ role: 'user', content: results });
  }
  const text = (response?.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return { text: text || 'I was unable to produce a response.', raw: response };
}

module.exports = {
  TOOLS,
  LOOKUP_VENDOR_TOOL,
  HOMEOWNER_HISTORY_TOOL,
  lookupCommunityVendor,
  getHomeownerContactHistory,
  executeAskEdTool,
  runAskEdWithTools,
};
