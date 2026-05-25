// ============================================================================
// lib/correspondence/dual_rail.js
// ----------------------------------------------------------------------------
// Dual-rail outbound correspondence helper. Every homeowner-facing outbound
// communication (DRV letter, fine notice, broadcast email, annual meeting
// notice, ARC decision, etc.) goes through this function so the discipline
// is enforced structurally rather than by convention.
//
// Two rails per outbound:
//   1. STATUTORY/PRIMARY channel  — the actual delivery (certified mail,
//      first-class mail, email, SMS, etc.). Tracked via a delivery_receipts
//      row with the appropriate `channel` value.
//   2. PORTAL channel             — the same message posted to the
//      homeowner's portal inbox so it lives in the unified canonical record
//      and the homeowner sees it on their portal. Tracked via a
//      delivery_receipts row with channel='portal_notify'.
//
// Why this exists:
//   - Single source of truth: `interactions` is the canonical record. No
//     more "did we log this letter? check Outlook AND Vantaca AND the
//     letter PDFs folder."
//   - Audit-trail discipline: every outbound has provenance, delivery
//     method, AND portal copy.
//   - Franchise pitch: "Your manager sees the full history in 2 seconds.
//     Your board sees response-time metrics they've never had before."
//
// Reply-token routing (task 5): every outbound gets a unique reply_token
// embedded into the interaction row. The email outbound layer reads this
// token and constructs a Reply-To address like reply+<token>@bedrocktx.com.
// When the homeowner replies via email, the ingester parses the token and
// threads the reply back to the originating interaction via
// parent_interaction_id + thread_id.
//
// Reference: project_correspondence_dual_rail memory note, CLAUDE.md
// "Two-stage data flow: extract → validate → render", project_homeowner_portal.
// ============================================================================

const crypto = require('crypto');

// Allowed interaction types — must match the CHECK constraint on interactions.type
// (migration 050). New types require a migration to expand the constraint.
const ALLOWED_TYPES = new Set([
  'email_inbound', 'email_outbound',
  'letter_courtesy_1', 'letter_courtesy_2', 'letter_209',
  'letter_other', 'phone', 'in_person', 'sms',
  'board_communication', 'vendor_communication',
  'ai_draft', 'observation_note', 'internal_note',
]);

// Allowed delivery_method values — must match the CHECK constraint on
// interactions.delivery_method (migration 050).
const ALLOWED_DELIVERY_METHODS = new Set([
  'email', 'first_class_mail', 'certified_mail',
  'in_person', 'phone', 'sms', 'portal', 'other',
]);

// Allowed channel values on delivery_receipts — must match the CHECK
// constraint on delivery_receipts.channel (migration 065).
const ALLOWED_RECEIPT_CHANNELS = new Set([
  'email', 'sms', 'first_class_mail', 'certified_mail',
  'postcard', 'portal_notify',
]);

/**
 * Generate a unique reply token for an outbound interaction. The token is
 * embedded in the Reply-To address (reply+<token>@bedrocktx.com) so that
 * when the homeowner replies via email, the ingester knows which thread
 * to thread the reply into. Format: 16 hex chars (8 bytes) — short enough
 * to read in headers, long enough to be unguessable.
 */
function generateReplyToken() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Parse a Reply-To address (or any email) and extract the reply token if
 * present. Returns null if the address doesn't match the reply+<token>@
 * pattern. Case-insensitive on the local-part prefix.
 *
 * Examples:
 *   reply+a1b2c3d4@bedrocktx.com    → 'a1b2c3d4'
 *   ReplY+ABC123def0@bedrocktx.com  → 'abc123def0'
 *   contact@bedrocktx.com           → null
 */
function parseReplyToken(emailAddress) {
  if (!emailAddress || typeof emailAddress !== 'string') return null;
  const m = emailAddress.match(/(?:^|<)\s*reply\+([a-f0-9]{8,32})@/i);
  if (!m) return null;
  return m[1].toLowerCase();
}

/**
 * Send dual-rail outbound correspondence. Writes the interaction row,
 * writes delivery_receipts rows for both rails (primary + portal_notify),
 * and returns identifiers + reply_token for the caller to use in the
 * actual delivery (e.g., setting the Reply-To header on the outbound email).
 *
 * The caller is responsible for actually delivering the message via the
 * primary channel (sending the email, mailing the letter, etc.). This
 * helper does the BOOKKEEPING — writes the canonical record. The two-step
 * pattern (record-first, deliver-second) is intentional: if delivery fails,
 * the interaction row is still there with status='draft' or the failure
 * recorded on the delivery_receipt, so the failure is visible in the
 * unified stream rather than silently lost.
 *
 * @param {object} supabase — service-role Supabase client
 * @param {object} opts
 * @param {string} opts.community_id   (required)
 * @param {string} [opts.contact_id]   the homeowner this is to
 * @param {string} [opts.property_id]  property context if applicable
 * @param {string} [opts.violation_id] violation context (DRV letters)
 * @param {string} opts.type           one of ALLOWED_TYPES
 * @param {string} [opts.subject]      message subject / title
 * @param {string} [opts.content]      message body (plain text or HTML)
 * @param {string} opts.delivery_method one of ALLOWED_DELIVERY_METHODS
 * @param {object} [opts.primary_delivery] primary-rail delivery metadata:
 *   { to_address, vendor?, vendor_message_id?, certified_tracking_number? }
 * @param {boolean} [opts.also_post_to_portal=true] whether to write the
 *   portal_notify delivery_receipt (set false for vendor/internal comms
 *   that aren't homeowner-facing)
 * @param {object} [opts.attachments] JSONB attachments array
 * @param {string} [opts.sent_by_user_id] staff user id, if a person sent it
 * @param {boolean} [opts.ai_drafted=false]
 * @param {string} [opts.ai_model]
 * @param {string} [opts.parent_interaction_id] if this is a reply / followup
 * @param {string} [opts.thread_id] explicit thread id (else generated)
 * @param {string} [opts.source='forward']
 *
 * @returns {Promise<{
 *   interaction_id: string,
 *   reply_token: string,
 *   thread_id: string,
 *   delivery_receipt_ids: string[]
 * }>}
 */
async function sendOutboundCorrespondence(supabase, opts) {
  if (!supabase) throw new Error('supabase client required');
  if (!opts || typeof opts !== 'object') throw new Error('opts required');
  if (!opts.community_id) throw new Error('community_id required');
  if (!opts.type) throw new Error('type required');
  if (!ALLOWED_TYPES.has(opts.type)) throw new Error(`invalid type: ${opts.type}`);
  if (!opts.delivery_method) throw new Error('delivery_method required');
  if (!ALLOWED_DELIVERY_METHODS.has(opts.delivery_method)) {
    throw new Error(`invalid delivery_method: ${opts.delivery_method}`);
  }

  const replyToken = generateReplyToken();
  const alsoPostToPortal = opts.also_post_to_portal !== false; // default true

  // 1. Write the interaction row (the canonical record)
  const interactionPayload = {
    community_id: opts.community_id,
    contact_id: opts.contact_id || null,
    property_id: opts.property_id || null,
    violation_id: opts.violation_id || null,
    type: opts.type,
    direction: 'outbound',
    subject: opts.subject || null,
    content: opts.content || null,
    delivery_method: opts.delivery_method,
    certified_tracking_number: opts.primary_delivery?.certified_tracking_number || null,
    attachments: opts.attachments || null,
    status: 'sent',
    sent_at: new Date().toISOString(),
    sent_by_user_id: opts.sent_by_user_id || null,
    ai_drafted: !!opts.ai_drafted,
    ai_model: opts.ai_model || null,
    source: opts.source || 'forward',
    reply_token: replyToken,
    parent_interaction_id: opts.parent_interaction_id || null,
    thread_id: opts.thread_id || null, // set after insert if not provided
  };

  const { data: interaction, error: iErr } = await supabase
    .from('interactions')
    .insert(interactionPayload)
    .select('id, thread_id')
    .single();
  if (iErr) throw new Error(`interactions insert failed: ${iErr.message}`);

  // If thread_id wasn't provided, default it to the interaction's own id
  // so it becomes the root of a new thread. Replies will inherit this.
  let threadId = interaction.thread_id;
  if (!threadId) {
    threadId = interaction.id;
    await supabase
      .from('interactions')
      .update({ thread_id: threadId })
      .eq('id', interaction.id);
  }

  // 2. Write delivery_receipts rows for each rail
  const receiptIds = [];
  const receiptsToInsert = [];

  // Primary rail — only when we have a real primary_delivery target
  if (opts.primary_delivery && opts.primary_delivery.to_address) {
    const primaryChannel = _deliveryMethodToReceiptChannel(opts.delivery_method);
    if (primaryChannel && ALLOWED_RECEIPT_CHANNELS.has(primaryChannel)) {
      receiptsToInsert.push({
        interaction_id: interaction.id,
        contact_id: opts.contact_id || null,
        community_id: opts.community_id,
        property_id: opts.property_id || null,
        violation_id: opts.violation_id || null,
        channel: primaryChannel,
        to_address: opts.primary_delivery.to_address,
        status: 'queued',
        vendor: opts.primary_delivery.vendor || null,
        vendor_message_id: opts.primary_delivery.vendor_message_id || null,
      });
    }
  }

  // Portal rail — always (when also_post_to_portal=true AND contact_id is
  // known, since portal posts need a homeowner anchor). This is the
  // structural guarantee that every outbound shows up in the homeowner's
  // portal inbox regardless of how the primary rail was delivered.
  if (alsoPostToPortal && opts.contact_id) {
    receiptsToInsert.push({
      interaction_id: interaction.id,
      contact_id: opts.contact_id,
      community_id: opts.community_id,
      property_id: opts.property_id || null,
      violation_id: opts.violation_id || null,
      channel: 'portal_notify',
      to_address: 'portal://inbox',
      status: 'queued',
      vendor: 'trustEd',
    });
  }

  if (receiptsToInsert.length > 0) {
    const { data: receipts, error: rErr } = await supabase
      .from('delivery_receipts')
      .insert(receiptsToInsert)
      .select('id');
    if (rErr) {
      // Receipt write failures are non-fatal — the interaction row is
      // canonical. Log and continue.
      console.warn(`[dual_rail] delivery_receipts insert failed: ${rErr.message}`);
    } else {
      (receipts || []).forEach((r) => receiptIds.push(r.id));
    }
  }

  return {
    interaction_id: interaction.id,
    reply_token: replyToken,
    thread_id: threadId,
    delivery_receipt_ids: receiptIds,
  };
}

/**
 * Mark a delivery_receipt as sent (or any other lifecycle status). Use this
 * after the actual delivery happens (e.g., after the email goes out via
 * Resend, after USPS confirms certified mail acceptance, etc.).
 *
 * @param {object} supabase
 * @param {string} receiptId
 * @param {object} updates  — { status, vendor_message_id?, sent_at?, delivered_at?, failure_reason?, raw_response? }
 */
async function updateDeliveryReceipt(supabase, receiptId, updates) {
  if (!receiptId) return;
  const allowed = ['status', 'vendor_message_id', 'sent_at', 'delivered_at',
                   'opened_at', 'clicked_at', 'failed_at', 'failure_reason', 'raw_response'];
  const patch = { updated_at: new Date().toISOString() };
  for (const k of allowed) if (k in updates) patch[k] = updates[k];
  const { error } = await supabase
    .from('delivery_receipts')
    .update(patch)
    .eq('id', receiptId);
  if (error) console.warn(`[dual_rail] receipt update failed: ${error.message}`);
}

/**
 * Build the Reply-To address for an outbound email so inbound replies thread
 * back to the originating interaction via the reply_token.
 *
 * @param {string} replyToken — from sendOutboundCorrespondence return value
 * @param {string} [domain]   — defaults to env REPLY_DOMAIN || 'bedrocktx.com'
 * @returns {string} formatted Reply-To address
 */
function buildReplyToAddress(replyToken, domain) {
  const d = domain || process.env.REPLY_DOMAIN || 'bedrocktx.com';
  return `reply+${replyToken}@${d}`;
}

// Internal: map interactions.delivery_method enum to delivery_receipts.channel enum.
// The two enums overlap significantly but aren't identical (e.g., 'first_class_mail'
// exists in both, 'in_person' is on interactions but not receipts).
function _deliveryMethodToReceiptChannel(method) {
  const map = {
    email: 'email',
    sms: 'sms',
    first_class_mail: 'first_class_mail',
    certified_mail: 'certified_mail',
    // No direct receipt channel for these — primary-rail receipt is omitted
    in_person: null,
    phone: null,
    portal: 'portal_notify', // a portal-only message IS its own receipt
    other: null,
  };
  return map[method] || null;
}

module.exports = {
  sendOutboundCorrespondence,
  updateDeliveryReceipt,
  generateReplyToken,
  parseReplyToken,
  buildReplyToAddress,
  ALLOWED_TYPES,
  ALLOWED_DELIVERY_METHODS,
  ALLOWED_RECEIPT_CHANNELS,
};
