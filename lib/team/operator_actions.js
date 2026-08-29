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

// Map a reported issue to a service category. Conservative: an unmatched issue
// returns null and the team escalates to a human to pick the vendor rather than
// guessing. Each category also carries the name/keyword signals we use to match
// it against the community's actual vendors (whose own category fields are, in
// production today, mostly empty — so the vendor NAME is the strongest signal).
const SERVICE_CATEGORIES = {
  irrigation:   { match: /sprinkler|irrigation|drip|controller|zone/, vendorHints: /irrigation|sprinkler|landscap|lawn|grounds|green/i },
  plumbing:     { match: /water (pipe|line|leak|main)|plumb|leak|burst|backflow|sewer|drain/, vendorHints: /plumb|water|rooter|leak|backflow|sewer|drain/i },
  gate:         { match: /gate|access control|call ?box|clicker|fob|entry/, vendorHints: /gate|access|entry|door|fence|automat/i },
  pool:         { match: /pool|spa|jacuzzi|splash pad/, vendorHints: /pool|aqua|aquatic|splash|swim|water ?management/i },
  electrical:   { match: /electric|light|breaker|outlet|wiring|transformer/, vendorHints: /electric|light|power/i },
  hvac:         { match: /hvac|ac unit|air condition|heater|furnace|cooling/, vendorHints: /hvac|air|heat|cool|mechanical/i },
  pest_control: { match: /pest|rodent|ant|termite|mosquito|wasp|bee/, vendorHints: /pest|exterminat|termite|mosquito/i },
  landscape:    { match: /tree|mow|landscap|mulch|grass|shrub|weed|trim/, vendorHints: /landscap|lawn|grounds|tree|mow|green|turf/i },
};
function inferServiceCategory(issue) {
  const t = String(issue || '').toLowerCase();
  for (const [cat, def] of Object.entries(SERVICE_CATEGORIES)) {
    if (def.match.test(t)) return cat;
  }
  return null;
}

// Vendor email fields in production sometimes hold more than one address in one
// string ("matt@x.com / hill@x.com"). sendAs would reject the whole thing, so we
// extract the FIRST valid address rather than pass a compound string downstream.
function _firstEmail(s) {
  const m = String(s || '').match(/[^\s,;/<>]+@[^\s,;/<>]+\.[^\s,;/<>]+/);
  return m ? m[0] : null;
}
function _vendorEmail(v) { return v ? (_firstEmail(v.email) || _firstEmail(v.contact_email)) : null; }
function _vendorContact(v) { return (v && (v.contact_name || v.account_manager_name)) || null; }

// Who a community actually calls for a category. There is no populated
// community<->vendor mapping today (vendor_contracts is empty and vendor.category
// is mostly null), so the real, community-scoped signal is PAYMENT HISTORY: the
// vendors this community has actually paid, in ap_invoices. We rank those by
// whether the vendor's name/category matches the service category, then by how
// often and how recently the community has paid them.
//
// Returns { pick, candidates } — pick is chosen ONLY when there is a clear
// category match; otherwise pick is null and the caller proposes the candidate
// list for a human to choose. Never invents a vendor or a recipient the
// community has no relationship with. Read-only.
async function resolveCommunityVendor(supabase, communityId, category, { issue } = {}) {
  const empty = { pick: null, candidates: [] };
  if (!supabase || !communityId) return empty;
  const def = category ? SERVICE_CATEGORIES[category] : null;

  // 1) Preferred SSOT once populated: an active vendor contract for the category.
  if (category) {
    const vc = await supabase.from('vendor_contracts')
      .select('vendor:vendors(name, email, contact_email, contact_name, account_manager_name)')
      .eq('community_id', communityId).eq('status', 'active').eq('service_category', category).limit(1);
    if (!vc.error && vc.data && vc.data.length) {
      const v = vc.data[0].vendor || {};
      const email = _vendorEmail(v);
      if (email) return { pick: { name: v.name || 'Vendor', email, contactName: _vendorContact(v), category, source: 'contract', confidence: 'high' }, candidates: [] };
    }
  }

  // 2) Payment history: vendors this community has actually paid.
  const ai = await supabase.from('ap_invoices')
    .select('vendor_id, invoice_date, total_cents').eq('community_id', communityId);
  if (ai.error) throw ai.error; // fail loud, never read an errored query as "no vendors"
  const byVendor = new Map();
  for (const r of (ai.data || [])) {
    if (!r.vendor_id) continue;
    const e = byVendor.get(r.vendor_id) || { count: 0, last: null, spend: 0 };
    e.count += 1; e.spend += (r.total_cents || 0);
    if (!e.last || (r.invoice_date && r.invoice_date > e.last)) e.last = r.invoice_date || e.last;
    byVendor.set(r.vendor_id, e);
  }
  if (!byVendor.size) return empty;

  const vr = await supabase.from('vendors')
    .select('id, name, category, email, contact_email, contact_name, account_manager_name, status, is_active')
    .in('id', [...byVendor.keys()]);
  if (vr.error) throw vr.error;

  const candidates = (vr.data || [])
    .filter((v) => _vendorEmail(v) && v.is_active !== false && v.status !== 'inactive')
    .map((v) => {
      const hist = byVendor.get(v.id) || { count: 0, last: null, spend: 0 };
      const hay = `${v.name || ''} ${v.category || ''}`;
      const matches = !!(def && def.vendorHints.test(hay));
      return {
        vendor_id: v.id, name: v.name || 'Vendor', email: _vendorEmail(v), contactName: _vendorContact(v),
        category, matchesCategory: matches, invoiceCount: hist.count, lastInvoice: hist.last,
      };
    })
    // category matches first, then most-recently and most-often paid.
    .sort((a, b) => (Number(b.matchesCategory) - Number(a.matchesCategory))
      || String(b.lastInvoice || '').localeCompare(String(a.lastInvoice || ''))
      || (b.invoiceCount - a.invoiceCount));

  const strong = candidates.filter((c) => c.matchesCategory);
  // Confident pick only when exactly one paid vendor matches the category by
  // name. Zero matches -> propose the community's vendor list. More than one ->
  // let a human choose which of the matching vendors to use.
  let pick = null;
  if (strong.length === 1) {
    pick = { ...strong[0], source: 'history', confidence: 'medium' };
  }
  return { pick, candidates };
}

// The service-request email, rendered once so the preview and the queued draft
// are byte-identical. Plain text, in the team's voice (see FOOTER conventions).
function renderVendorOutreach(vendor, { issue, communityName, category, accessNote } = {}) {
  const greeting = vendor && vendor.contactName ? vendor.contactName.split(/\s+/)[0] : 'Team';
  const access = accessNote ? `\n\nAccess and location: ${accessNote}.` : '';
  const body = `Hi ${greeting},\n\n`
    + `We have a service request for ${communityName || 'one of our communities'}. ${issue}\n\n`
    + `Please schedule an assessment and repair at your earliest availability, and let us know your ETA and any access needs.${access}\n\n`
    + `You can reply to this email or reach us at builders@bedrocktx.com. Thank you.`;
  return { subject: `Service request — ${communityName || 'community'} — ${category || 'service'}`, body };
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
    if (!category) return { status: 'needs_human', reason: 'could not infer a service category from the issue — a human should pick the vendor', candidates: [] };

    // An explicit vendor choice (a human picked from candidates) wins; otherwise
    // resolve from real data. A confident single pick drafts; anything uncertain
    // comes back for a human to choose — we never email a guessed third party.
    let vendor, candidates = [];
    if (args.vendorId) {
      const vr = await ctx.supabase.from('vendors')
        .select('name, email, contact_email, contact_name, account_manager_name').eq('id', args.vendorId).limit(1);
      if (vr.error) throw vr.error;
      const v = (vr.data || [])[0];
      const email = _vendorEmail(v);
      if (!v || !email) return { status: 'needs_human', reason: 'chosen vendor has no email on file', candidates: [] };
      vendor = { name: v.name || 'Vendor', email, contactName: v.contact_name || v.account_manager_name || null, category, source: 'chosen' };
    } else {
      const r = await resolveCommunityVendor(ctx.supabase, ctx.communityId, category, { issue: args.issue });
      vendor = r.pick; candidates = r.candidates;
      if (!vendor) {
        return {
          status: 'needs_human',
          reason: candidates.length
            ? `no single ${category} vendor is unambiguous for ${args.communityName || 'this community'} — a human should choose from vendors this community has paid`
            : `no ${category} vendor found in ${args.communityName || 'this community'}'s payment history — a human should assign one`,
          category, candidates,
        };
      }
    }

    const { subject, body } = renderVendorOutreach(vendor, { ...args, category });
    const { queueDraft } = require('../email/outbound_drafts');
    const graphSend = require('../email/graph_send');
    const fromMailbox = graphSend[`${String(ctx.persona || 'amanda').toUpperCase()}_MAILBOX`] || graphSend.AMANDA_MAILBOX;
    const q = await queueDraft({
      communityId: ctx.communityId, communityName: args.communityName || null,
      persona: ctx.persona || 'amanda', fromMailbox,
      toEmail: vendor.email, toName: vendor.name,
      subject,
      bodyText: body,
      draftKind: 'vendor_outreach', relatedType: 'vendor_outreach', aiDrafted: true,
      // Outbound to a third party: always a human-reviewed exception until the
      // lane is trusted, even though DRAFTING it is a safe autonomous step.
      disposition: 'needs_review', confidence: 'medium',
      dispositionReason: `Vendor outreach for a reported ${category} issue — outbound to a third party, hold for review.`,
      draftReason: `Reported issue: ${String(args.issue || '').slice(0, 200)}. Vendor chosen from ${vendor.source === 'contract' ? 'the active vendor contract' : vendor.source === 'chosen' ? 'a human selection' : 'this community\'s payment history'}.`,
    });
    return { status: 'queued', queued: q.status, draft_id: q.id || null, vendor: vendor.name, vendor_email: vendor.email, category, source: vendor.source, candidates };
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

module.exports = { ACTIONS, resolveAction, runAction, log_interaction, draft_vendor_outreach, inferServiceCategory, resolveCommunityVendor, renderVendorOutreach, SERVICE_CATEGORIES };
