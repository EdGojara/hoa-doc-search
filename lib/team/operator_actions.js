// ============================================================================
// lib/team/operator_actions.js  (Ed 2026-08-29)
// ----------------------------------------------------------------------------
// The action layer — where a teammate stops just answering and starts DOING.
// The north star is a management company that executes autonomously with humans
// watching; the only way that is safe is if "what may run on its own" is a hard,
// enforced-in-code distinction, not a prompt's good intentions.
//
// Two risk classes, and the boundary is absolute:
//   safe      reversible, append-only, no money/legal/records-of-decision.
//             MAY run autonomously once its lane is trusted.
//   reserved  irreversible or authority-bearing (waive, pay, approve, send a
//             §209 letter, delete). May ONLY ever be proposed for a human. There
//             is no autonomy setting that lets these self-execute.
//
// And it is DARK by default: autonomy = 'propose' means even safe actions are
// only described, never run, so the whole layer can be built and trained before
// anything mutates. Flip a lane to 'execute' when its exception rate has earned
// it — the same discipline as auto-send.
//
// Every executed action returns an audit record. Humans watching is a north-star
// requirement, not a nicety: the team's work must always be on the record.
// ============================================================================

// ---- Actions -------------------------------------------------------------
// Each: { name, risk, summarize(args), async execute(ctx, args) -> result }

const log_interaction = {
  name: 'log_interaction',
  risk: 'safe', // append-only row on the property/community timeline
  summarize: (args) => `Log a ${args.type || 'note'} on the timeline: "${String(args.subject || '').slice(0, 80)}"`,
  async execute(ctx, args) {
    if (!ctx.supabase) throw new Error('no supabase in context');
    if (!ctx.communityId) throw new Error('community_id is required to log an interaction');
    const row = {
      community_id: ctx.communityId,
      property_id: ctx.propertyId || null,
      contact_id: ctx.contactId || null,
      type: args.type || 'internal_note',
      direction: args.direction || 'internal',
      subject: args.subject || null,
      content: args.content || null,
      created_by: `${ctx.persona || 'operator'} (Bedrock AI)`,
      sent_at: args.occurredAt || new Date().toISOString(),
    };
    const { data, error } = await ctx.supabase.from('interactions').insert(row).select('id').single();
    if (error) throw error;
    return { interaction_id: data.id };
  },
};

// Map a reported issue to a vendor service category (the real vendor_service_
// categories vocabulary). Conservative: an unmatched issue returns null and the
// team escalates to a human to pick the vendor rather than guessing.
function inferServiceCategory(issue) {
  const t = String(issue || '').toLowerCase();
  if (/sprinkler|irrigation|drip|controller|zone/.test(t)) return 'irrigation';
  if (/water (pipe|line|leak|main)|plumb|leak|burst|backflow|sewer/.test(t)) return 'plumbing';
  if (/gate|access control|call ?box|clicker|fob/.test(t)) return 'gate';
  if (/pool|spa|jacuzzi/.test(t)) return 'pool';
  if (/electric|light|breaker|outlet|wiring/.test(t)) return 'electrical';
  if (/hvac|ac unit|air condition|heater|furnace/.test(t)) return 'hvac';
  if (/pest|rodent|ant|termite|mosquito/.test(t)) return 'pest_control';
  if (/tree|mow|landscap|mulch|grass|shrub/.test(t)) return 'landscape';
  return null;
}

// The active vendor for a community + service category, from the vendor contract
// (SSOT for who serves a community). Read-only; exported so a preview can show
// who would be contacted before anything is drafted.
async function resolveCommunityVendor(supabase, communityId, category) {
  if (!supabase || !communityId || !category) return null;
  const { data, error } = await supabase.from('vendor_contracts')
    .select('vendor_name_raw, vendor:vendors(name, email, contact_email, primary_contact_name)')
    .eq('community_id', communityId).eq('status', 'active').eq('service_category', category).limit(1);
  if (error || !data || !data.length) return null;
  const c = data[0];
  const v = c.vendor || {};
  const email = v.email || v.contact_email || null;
  if (!email) return null;
  return { name: v.name || c.vendor_name_raw || 'Vendor', email, contactName: v.primary_contact_name || null, category };
}

// Draft a service request to the community's vendor for a reported issue, and
// QUEUE it for review. Safe: it creates a draft, it does not send — sending to a
// third party is the separate reserved step. Autonomous up to the send.
const draft_vendor_outreach = {
  name: 'draft_vendor_outreach',
  risk: 'safe',
  summarize: (args) => `Draft a ${args.serviceCategory || inferServiceCategory(args.issue) || 'vendor'} service request for ${args.communityName || 'the community'}: "${String(args.issue || '').slice(0, 80)}"`,
  async execute(ctx, args) {
    if (!ctx.supabase || !ctx.communityId) throw new Error('supabase + community_id required');
    const category = args.serviceCategory || inferServiceCategory(args.issue);
    if (!category) throw new Error(`could not infer a service category from the issue — a human should pick the vendor`);
    const vendor = await resolveCommunityVendor(ctx.supabase, ctx.communityId, category);
    if (!vendor) throw new Error(`no active ${category} vendor on file for ${args.communityName || 'this community'} — needs a human to assign one`);

    const greeting = vendor.contactName ? vendor.contactName.split(/\s+/)[0] : 'Team';
    const access = args.accessNote ? `\n\nAccess and location: ${args.accessNote}.` : '';
    const body = `Hi ${greeting},\n\n`
      + `We have a service request for ${args.communityName || 'one of our communities'}. ${args.issue}\n\n`
      + `Please schedule an assessment and repair at your earliest availability, and let us know your ETA and any access needs.${access}\n\n`
      + `You can reply to this email or reach us at builders@bedrocktx.com. Thank you.`;

    const { queueDraft } = require('../email/outbound_drafts');
    const graphSend = require('../email/graph_send');
    const fromMailbox = graphSend[`${String(ctx.persona || 'amanda').toUpperCase()}_MAILBOX`] || graphSend.AMANDA_MAILBOX;
    const q = await queueDraft({
      communityId: ctx.communityId, communityName: args.communityName || null,
      persona: ctx.persona || 'amanda', fromMailbox,
      toEmail: vendor.email, toName: vendor.name,
      subject: `Service request — ${args.communityName || 'community'} — ${category}`,
      bodyText: body,
      draftKind: 'reply', aiDrafted: true,
      // Outbound to a third party: always a human-reviewed exception until the
      // lane is trusted, even though DRAFTING it is a safe autonomous step.
      disposition: 'needs_review', confidence: 'medium',
      dispositionReason: `Autonomous vendor outreach for a reported ${category} issue — outbound to a third party, hold for review.`,
      draftReason: `Reported issue: ${String(args.issue || '').slice(0, 200)}`,
    });
    return { queued: q.status, draft_id: q.id || null, vendor: vendor.name, vendor_email: vendor.email, category };
  },
};

const ACTIONS = Object.freeze({ log_interaction, draft_vendor_outreach });

function resolveAction(name) {
  return ACTIONS[name] || null;
}

// The gate. reserved is never executed. safe runs only when the lane is on
// 'execute'; otherwise it is proposed. Returns an audit-shaped result either way.
async function runAction(action, args, ctx, { autonomy = 'propose' } = {}) {
  if (!action || typeof action.execute !== 'function') {
    return { status: 'error', error: 'unknown_action' };
  }
  const base = { action: action.name, risk: action.risk, summary: action.summarize ? action.summarize(args) : action.name, at: (ctx && ctx.now) || null };

  if (action.risk === 'reserved') {
    return { ...base, status: 'proposed', reason: 'reserved action — a human must approve and perform it' };
  }
  if (action.risk === 'safe' && autonomy === 'execute') {
    try {
      const result = await action.execute(ctx, args);
      return { ...base, status: 'done', result };
    } catch (e) {
      return { ...base, status: 'error', error: e.message };
    }
  }
  // safe but the lane is dark
  return { ...base, status: 'proposed', reason: 'autonomy is off for this lane (propose-only)' };
}

module.exports = { ACTIONS, resolveAction, runAction, log_interaction };
