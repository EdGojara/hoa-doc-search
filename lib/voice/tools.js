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

  // Step 4: fetch current AR via the unified resolver. Tries the
  // transactions view first (canonical post-Jun-2026), falls back to
  // owner_ar_snapshots for communities not yet on the new pipeline.
  // Either way Claire sees the same shape.
  const { resolveCurrentAR } = require('../ar/resolve_current_ar');
  let snapshot;
  try {
    snapshot = await resolveCurrentAR(supabase, { propertyId: propertyRow.id });
  } catch (e) {
    console.warn(`[tool get_ar_for_property] AR resolve failed: ${e.message}`);
    return { error: 'snapshot_lookup_failed' };
  }
  if (!snapshot) {
    return {
      error: 'no_ar_snapshot_on_file',
      property_address: propertyRow.street_address,
      detail: 'No AR data has been uploaded for this property yet.',
    };
  }

  // Format date for human readability ("as of June 7, 2026")
  let snapshotDateHuman = snapshot.as_of;
  try {
    const d = new Date(snapshot.as_of);
    snapshotDateHuman = d.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  } catch (_) { /* fall back to raw date string */ }

  // Format balance as dollars (input is cents from the unified resolver)
  let balanceFormatted = null;
  if (snapshot.balance_cents != null) {
    const dollars = Number(snapshot.balance_cents) / 100;
    if (Number.isFinite(dollars)) balanceFormatted = `$${dollars.toFixed(2)}`;
  }

  return {
    ok: true,
    property_address: propertyRow.street_address,
    community: communityRow.name,
    balance: balanceFormatted,
    balance_raw: snapshot.balance_cents != null ? (Number(snapshot.balance_cents) / 100) : null,
    snapshot_date: snapshot.as_of,
    snapshot_date_human: snapshotDateHuman,
    at_legal: !!snapshot.at_legal,
    in_collections: !!snapshot.in_collections,
    payment_plan_active: !!snapshot.payment_plan_active,
    payment_plan_terms: snapshot.payment_plan_terms_text || null,
    enforcement_stage: snapshot.enforcement_stage || null,
    source: snapshot.source,   // 'transactions' or 'snapshot' — informational
    disclosure:
      `This balance is from a ${snapshot.source === 'transactions' ? 'transaction ledger' : 'snapshot'} as of ${snapshotDateHuman} — it is NOT live Vantaca state. ` +
      `Any payments or charges since that date are NOT reflected. ` +
      `For the precise current balance, the caller can log into Vantaca or you can offer to have Martha pull it and call them back.`,
  };
}

// ============================================================================
// TOOL: send_form_to_caller
// Sends a specific Bedrock-managed form to the caller via email. Identity
// is bound to the resolved caller context — Claire CANNOT send to an
// arbitrary recipient. Narrow, curated form list prevents Claire from
// sending random documents or being abused as a generic email relay.
//
// Curated form_type list (Ed 2026-06-08): only forms Bedrock actually has
// in the application library. Adding a new form requires a code change
// here — that's the intent. Cost-conscious + predictable.
//
// Cost: ~$0.001 per email send via Resend. Marginal at any volume.
// ============================================================================

const SEND_FORM_TEMPLATES = {
  key_fob_application: {
    subject: 'Bedrock — Key Fob Application',
    body_text: (caller_name, community_name) =>
      `Hi ${caller_name || 'there'},\n\n` +
      `Thanks for reaching out. Attached is the key fob application for ${community_name || 'your community'}.\n\n` +
      `Send the completed form back along with the required documents (lease + photo ID for tenants, owner info for owners) and the team will process it from there.\n\n` +
      `If you have any questions, reply to this email or give us a call at (832) 588-2485.\n\n` +
      `Thanks,\nBedrock Association Management`,
    note: 'Application form delivery — covers both owner and tenant requests.',
  },
  amenity_rental_application: {
    subject: 'Bedrock — Amenity Rental Application',
    body_text: (caller_name, community_name) =>
      `Hi ${caller_name || 'there'},\n\n` +
      `Attached is the amenity rental application for ${community_name || 'your community'}.\n\n` +
      `Fill it out, include the rental date, time window, and your contact info — the team will check availability and confirm.\n\n` +
      `Questions? Reply to this email or call us at (832) 588-2485.\n\n` +
      `Thanks,\nBedrock Association Management`,
    note: 'Amenity reservation request flow.',
  },
  acc_application: {
    subject: 'Bedrock — ARC / ACC Application',
    body_text: (caller_name, community_name) =>
      `Hi ${caller_name || 'there'},\n\n` +
      `Attached is the architectural review application for ${community_name || 'your community'}.\n\n` +
      `Submit the form along with project details, drawings or photos, and contractor info if applicable. The committee reviews submissions on the standard cadence and you'll receive a decision letter when complete.\n\n` +
      `Questions? Reply to this email or call us at (832) 588-2485.\n\n` +
      `Thanks,\nBedrock Association Management`,
    note: 'Architectural / ACC submission request.',
  },
  estoppel_request: {
    subject: 'Bedrock — Resale Certificate / Estoppel Request',
    body_text: (caller_name, community_name) =>
      `Hi ${caller_name || 'there'},\n\n` +
      `Attached is the resale certificate / estoppel request form for ${community_name || 'your community'}.\n\n` +
      `Include the closing date, title company info, and authorization. Standard turnaround is 10 business days; rush options are noted on the form.\n\n` +
      `Questions? Reply to this email or call us at (832) 588-2485.\n\n` +
      `Thanks,\nBedrock Association Management`,
    note: 'Title company / closing flow.',
  },
};

const send_form_to_caller_definition = {
  name: 'send_form_to_caller',
  description:
    'Send a Bedrock form to the caller via email. Identity is bound to the caller from caller-ID; you cannot specify a different recipient. ' +
    'Use this when the caller asks for an application, form, or paperwork. Curated form_type list — only those values are supported. ' +
    'Returns confirmation including the email used so you can read it back to the caller.',
  input_schema: {
    type: 'object',
    properties: {
      form_type: {
        type: 'string',
        enum: ['key_fob_application', 'amenity_rental_application', 'acc_application', 'estoppel_request'],
        description: 'Which form to send. key_fob = pool/gate fob applications; acc = architectural review; estoppel = resale certificate for closings.',
      },
      email_override: {
        type: 'string',
        description:
          'Optional. If the caller gave you a different email than what is on file (or there is no email on file), pass it here. Always read the email back to the caller for confirmation BEFORE you call this tool with an override.',
      },
    },
    required: ['form_type'],
  },
};

async function send_form_to_caller_handler(input, ctx) {
  const { form_type, email_override } = input || {};
  if (!SEND_FORM_TEMPLATES[form_type]) {
    return { error: 'unknown_form_type', allowed: Object.keys(SEND_FORM_TEMPLATES) };
  }
  const template = SEND_FORM_TEMPLATES[form_type];
  const caller = ctx?.caller || {};
  const community = ctx?.community || {};
  const callerName = caller.preferred_name || caller.first_name || (caller.full_name || '').split(' ')[0] || '';

  // Identity binding: we only send to the email on file OR the override
  // the caller explicitly provided (which they read back during the call).
  // Never sends to an arbitrary recipient Claire could be tricked into.
  const recipientEmail = (email_override || '').trim() || caller.primary_email || caller.email || null;
  if (!recipientEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipientEmail)) {
    return {
      error: 'no_email_on_file',
      detail: 'No email address available for this caller. Ask the caller for their email and pass it as email_override.',
    };
  }

  // Send the email via Resend
  const { sendEmail, isConfigured } = require('../notifications/email');
  if (!isConfigured()) {
    return { error: 'email_not_configured', detail: 'Resend API not configured on this environment.' };
  }
  try {
    const bodyText = template.body_text(callerName, community.name);
    const bodyHtml = '<div style="font-family:-apple-system,system-ui,Segoe UI,Roboto,sans-serif;font-size:15px;color:#222;line-height:1.55;max-width:560px;">'
      + bodyText.split('\n').map(line => line.trim() ? `<p style="margin:0 0 12px;">${line.replace(/</g, '&lt;')}</p>` : '').join('')
      + '</div>';
    const sendResult = await sendEmail({
      to: recipientEmail,
      subject: template.subject,
      html: bodyHtml,
      text: bodyText,
      // from: omitted → uses default from env (forms@bedrocktx.com)
    });
    if (!sendResult || sendResult.ok === false) {
      return { error: 'send_failed', detail: sendResult?.error || 'unknown failure' };
    }

    // Log to interactions table for audit (best-effort, non-blocking error)
    try {
      await supabase.from('interactions').insert({
        community_id: community.id || null,
        property_id: caller.property_id || null,
        contact_id: caller.id || null,
        type: 'email_sent',
        subject: template.subject,
        content: `Claire sent the ${form_type.replace(/_/g, ' ')} via email to ${recipientEmail} during call.`,
        delivery_method: 'email',
        status: 'sent',
        sent_at: new Date().toISOString(),
        notes: `Sent automatically by Claire — form=${form_type}, channel=email`,
      });
    } catch (e) {
      console.warn(`[tool send_form_to_caller] interactions log failed (non-fatal): ${e.message}`);
    }

    return {
      ok: true,
      form_type,
      recipient_email: recipientEmail,
      sent_at: new Date().toISOString(),
      claire_can_say: `Just sent the ${form_type.replace(/_/g, ' ')} to ${recipientEmail}. You should see it within the next minute or two.`,
    };
  } catch (e) {
    console.warn(`[tool send_form_to_caller] send failed: ${e.message}`);
    return { error: 'send_failed', detail: e.message };
  }
}

// ============================================================================
// TOOL: send_sms_link_to_caller
// Sends an SMS containing a link to the caller's mobile number (the number
// they called from). Used when the caller prefers a text over an email,
// or when delivering a quick portal/website reference.
//
// Identity bound to the caller's phone — Claire CANNOT send to an
// arbitrary number. Curated link_type list controls what destinations
// are reachable.
//
// Cost: ~$0.0075 per SMS via Twilio. Marginal.
// ============================================================================

const SEND_LINK_TARGETS = {
  community_portal:    (community) => (community?.homeowner_portal_url || 'home.bedrocktx.com'),
  community_website:   (community) => (community?.community_website_url || null),
  payment_portal:      (_community) => 'pay.bedrocktx.com',  // placeholder — future
  forms_email_address: (_community) => 'forms@bedrocktx.com',
};

const send_sms_link_to_caller_definition = {
  name: 'send_sms_link_to_caller',
  description:
    "Send a text message with a link to the caller's mobile number (the one they called from). " +
    'Use this when the caller prefers a text over an email, or when sending a quick portal/website reference. ' +
    'Identity is bound to caller-ID — you cannot specify a different number. ' +
    'Returns confirmation including the destination URL so you can read it back to the caller.',
  input_schema: {
    type: 'object',
    properties: {
      link_type: {
        type: 'string',
        enum: ['community_portal', 'community_website', 'payment_portal', 'forms_email_address'],
        description: 'Which destination link to send.',
      },
      custom_message: {
        type: 'string',
        description: 'Optional brief intro for the text (1 sentence, conversational). If omitted, a default intro is used.',
      },
    },
    required: ['link_type'],
  },
};

async function send_sms_link_to_caller_handler(input, ctx) {
  const { link_type, custom_message } = input || {};
  if (!SEND_LINK_TARGETS[link_type]) {
    return { error: 'unknown_link_type', allowed: Object.keys(SEND_LINK_TARGETS) };
  }
  const community = ctx?.community || {};
  const url = SEND_LINK_TARGETS[link_type](community);
  if (!url) {
    return { error: 'link_not_configured', detail: `${link_type} is not configured for this community yet.` };
  }
  const callerPhone = ctx?.caller_phone || ctx?.callContext?.caller_phone || null;
  if (!callerPhone) {
    return { error: 'no_caller_phone', detail: 'Cannot send SMS without a caller phone number.' };
  }

  // Build the SMS message — short, since SMS bandwidth is limited
  const intro = (custom_message && String(custom_message).trim().slice(0, 100))
              || `Bedrock — here's the link you asked about:`;
  // sendSms() auto-appends a STOP footer via ensureStopFooter — do not add one here.
  const body = `${intro}\n${url}`;

  // Send via Twilio
  const { sendSms, isConfigured } = require('../notifications/sms');
  if (!isConfigured()) {
    return { error: 'sms_not_configured', detail: 'Twilio SMS not configured on this environment.' };
  }
  try {
    const sendResult = await sendSms({ to: callerPhone, body });
    if (!sendResult || sendResult.ok === false) {
      return { error: 'send_failed', detail: sendResult?.error || 'unknown failure' };
    }

    // Log to interactions table for audit
    try {
      await supabase.from('interactions').insert({
        community_id: community.id || null,
        property_id: ctx?.caller?.property_id || null,
        contact_id: ctx?.caller?.id || null,
        type: 'sms_sent',
        subject: `${link_type} link via SMS`,
        content: body,
        delivery_method: 'sms',
        status: 'sent',
        sent_at: new Date().toISOString(),
        notes: `Sent automatically by Claire — link_type=${link_type}, target=${url}`,
      });
    } catch (e) {
      console.warn(`[tool send_sms_link_to_caller] interactions log failed (non-fatal): ${e.message}`);
    }

    return {
      ok: true,
      link_type,
      destination_url: url,
      sent_to: callerPhone,
      sent_at: new Date().toISOString(),
      claire_can_say: `Just texted you the link — should be on your phone any second.`,
    };
  } catch (e) {
    console.warn(`[tool send_sms_link_to_caller] send failed: ${e.message}`);
    return { error: 'send_failed', detail: e.message };
  }
}

// ============================================================================
// TOOL: check_amenity_access
// Decides whether a property's owner / tenant can be granted pool, clubhouse,
// gym, key-fob or other amenity access. Composition-aware: a $500 balance
// of fines does NOT trigger denial, but $500 of past-due assessments + no
// payment plan DOES.
//
// Why a separate tool from get_ar_for_property:
//   - Claire only needs to call this when the topic is access, keeping the
//     balance lookup tool narrow and predictable.
//   - The decision is its own legal artifact — operator UI replays the
//     basis from this call too.
// ============================================================================

const check_amenity_access_definition = {
  name: 'check_amenity_access',
  description:
    'Check whether amenity access (pool, clubhouse, key fob, gym, etc.) can be granted for a property. ' +
    'Use this when the caller asks about USING an amenity, getting a fob, reserving a clubhouse, or anything access-related — NOT when they ask about their balance. ' +
    'The decision is composition-aware: only past-due ASSESSMENTS trigger denial (fines, attorney fees, admin fees do not). ' +
    'Returns { allowed, reason, basis } — read the reason field to explain to the caller.',
  input_schema: {
    type: 'object',
    properties: {
      community_name: {
        type: 'string',
        description: 'The community name (usually known from call context).',
      },
      address: {
        type: 'string',
        description: 'The property street address as the caller stated it. Just house number + street name is fine.',
      },
    },
    required: ['community_name', 'address'],
  },
};

async function check_amenity_access_handler(input, _ctx) {
  const { community_name, address } = input || {};
  if (!community_name || !address) {
    return { error: 'missing_input', detail: 'community_name and address required' };
  }

  // Reuse the property resolution logic from get_ar_for_property.
  // Step 1: resolve community
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
    return { error: 'community_lookup_failed', detail: e.message };
  }
  if (!communityRow) return { error: 'community_not_found', community_searched: community_name };

  // Step 2: parse address + look up property
  const houseNumMatch = String(address).trim().match(/^\s*(\d+)\s+(.+?)\s*$/);
  if (!houseNumMatch) return { error: 'address_unparseable', address_given: address };
  const houseNum = houseNumMatch[1];
  const streetFragment = houseNumMatch[2].split(/\s+/).slice(0, 2).join(' ');

  let propertyRow;
  try {
    const { data, error } = await supabase
      .from('properties')
      .select('id, street_address, vantaca_account_id, community_id')
      .eq('community_id', communityRow.id)
      .ilike('street_address', `${houseNum}%${streetFragment}%`)
      .limit(2);
    if (error) throw error;
    if (!data || data.length === 0) {
      return { error: 'property_not_found', community: communityRow.name, address_given: address };
    }
    if (data.length > 1) {
      return {
        error: 'address_ambiguous',
        community: communityRow.name,
        candidates: data.map((r) => r.street_address),
      };
    }
    propertyRow = data[0];
  } catch (e) {
    return { error: 'property_lookup_failed', detail: e.message };
  }

  // Step 3: run the amenity-access decision
  const { evaluateAmenityAccess } = require('../ar/amenity_access');
  let decision;
  try {
    decision = await evaluateAmenityAccess(supabase, {
      propertyId: propertyRow.id,
      vantacaAccountId: propertyRow.vantaca_account_id,
      communityId: propertyRow.community_id,
    });
  } catch (e) {
    return { error: 'decision_failed', detail: e.message };
  }

  // Translate cents → dollars in the basis for Claire to read
  const dollars = (cents) => (cents == null ? null : `$${(Number(cents) / 100).toFixed(2)}`);
  const basisHuman = {};
  for (const [k, v] of Object.entries(decision.basis || {})) {
    basisHuman[k.replace(/_cents$/, '')] = dollars(v);
  }

  return {
    ok: true,
    property_address: propertyRow.street_address,
    community: communityRow.name,
    allowed: decision.allowed,
    reason: decision.reason,
    basis: basisHuman,
    enforcement_override: decision.enforcement_override || null,
    claire_guidance: decision.allowed
      ? `Access is allowed — handle the request normally. Briefly: ${decision.reason}`
      : `Access is denied. Explain WHAT specifically is keeping it closed and HOW to restore it (set up a payment plan with accounting). Don't just say "you owe money" — be specific and offer the path forward. Detail: ${decision.reason}`,
  };
}

// ----------------------------------------------------------------------------
// TOOL: get_homeowner_contact_history
// Pull the call/email/note timeline + AI summary for a homeowner Claire is
// talking to. Caller-facing mode: strips internal-note rows + direction=
// internal so Claire NEVER reads staff scratch out loud. Summary is tuned
// for spoken context — 1-3 short sentences a voice agent can paraphrase
// without sounding like a paralegal reading from a file.
// ----------------------------------------------------------------------------
const get_homeowner_contact_history_definition = {
  name: 'get_homeowner_contact_history',
  description:
    'Look up the recent contact history (calls, notes, emails, follow-ups) for the caller / their property. ' +
    'Use this when the caller asks "what did we discuss last time", "is there a follow-up", "did anyone get back to me", ' +
    'or when you need to know whether the property has open commitments before continuing the call. ' +
    'IMPORTANT: Before calling this tool, you MUST first ask the caller to confirm the property address — same identity ' +
    'verification rule as for AR lookups. ' +
    'Returns a short summary suitable for paraphrasing aloud plus the last 8 caller-facing interactions. ' +
    'Internal staff notes are NEVER returned by this tool — only what the caller has been part of.',
  input_schema: {
    type: 'object',
    properties: {
      community_name: {
        type: 'string',
        description: 'The community name (e.g., "Waterview Estates"). Usually known from call context.',
      },
      address: {
        type: 'string',
        description: 'The property street address as the caller stated it. House number + street name is fine (e.g., "5226 Jay Thrush").',
      },
    },
    required: ['community_name', 'address'],
  },
};

async function get_homeowner_contact_history_handler(input, _ctx) {
  const { community_name, address } = input || {};
  if (!community_name || !address) {
    return { error: 'missing_input', detail: 'community_name and address required' };
  }
  try {
    const { getInteractionHistoryBundle } = require('../interactions/history');
    const bundle = await getInteractionHistoryBundle({
      community_name,
      address,
      caller_facing: true,
      include_recent: true,
    });
    if (bundle.ok === false) {
      // Propagate the error shape resolvePropertyByAddress uses so Claire
      // can ask the caller to clarify ("I have two on file — which one?").
      return bundle;
    }
    return {
      ...bundle,
      disclosure:
        'This summary covers contact history Bedrock has on file with this property. ' +
        'Internal staff notes are intentionally excluded. Speak in plain English; do not quote dates ' +
        'or follow-up phrasing verbatim unless the caller specifically asks for the timeline.',
    };
  } catch (e) {
    console.warn(`[tool get_homeowner_contact_history] failed: ${e.message}`);
    return { error: 'history_lookup_failed', detail: e.message };
  }
}

// ----------------------------------------------------------------------------
// Exports — tool definitions array + handler map
// ----------------------------------------------------------------------------

const VOICE_TOOLS = [
  get_ar_for_property_definition,
  check_amenity_access_definition,
  send_form_to_caller_definition,
  send_sms_link_to_caller_definition,
  get_homeowner_contact_history_definition,
];

const VOICE_TOOL_HANDLERS = {
  get_ar_for_property: get_ar_for_property_handler,
  check_amenity_access: check_amenity_access_handler,
  send_form_to_caller: send_form_to_caller_handler,
  send_sms_link_to_caller: send_sms_link_to_caller_handler,
  get_homeowner_contact_history: get_homeowner_contact_history_handler,
};

module.exports = {
  VOICE_TOOLS,
  VOICE_TOOL_HANDLERS,
  // Exported individually for testing / future tool composition
  get_ar_for_property_definition,
  get_ar_for_property_handler,
  get_homeowner_contact_history_definition,
  get_homeowner_contact_history_handler,
};
