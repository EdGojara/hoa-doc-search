// ============================================================================
// lib/amanda/matter_facts.js  (Ed 2026-10-16, review of PR #216)
// ----------------------------------------------------------------------------
// The structured facts a Board-facing draft is held to, read from trustEd before
// drafting. Live drafts of Amanda's reply to Hugh's "Create RFP" email wrote
// "$47,854.69" and "near $47,855" for an installed estimate of $47,854.68, said
// "I will confirm with iTech" when no workflow authorizes vendor contact, claimed
// "the 12-month warranty stays covered without the $440 plan" when nothing in
// trustEd verifies it, and told the Board it "can move now" while the contract is
// not ready to sign.
//
// Everything here comes from stored records, never from Canyon Gate strings:
//   bid_requests (open, this community)       the matters, and structured_rfp
//                                              .decision_state when an RFP exists
//   vendor_proposals.extracted_data           comparison_items: pricing, payment
//                                              terms, warranty, insurance, retention,
//                                              cloud model, budgetary flag
// Returns { matters, money:[{cents,label}], vendorNames, unverified:[{topic,label}],
//           notAuthorized, rfpInProgress, vendorContactAuthorized, block }.
// Read-only and best-effort: any failure returns an empty fact set (the checks
// that need facts then do not run), with a warning.
// ============================================================================

const dollars = (c) => '$' + (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// "$22,309.87" -> 2230987
function moneyInText(text) {
  const out = [];
  const re = /\$\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(Math.round(Number(m[1].replace(/,/g, '')) * 100));
  return out;
}

// First distinctive word of a vendor name: "iTech Monitoring, Inc." -> "iTech".
const GENERIC = /^(?:the|inc|llc|co|corp|company|services?|systems?|solutions?|group|usa|us|security|monitoring|technologies|technology|of|and)$/i;
function vendorShortName(name) {
  const w = String(name || '').replace(/[,.&]/g, ' ').split(/\s+/).filter((x) => x.length >= 3 && !GENERIC.test(x));
  return w[0] || null;
}

const UNVERIFIED_LABEL = {
  warranty: 'equipment and workmanship warranty terms',
  insurance: "the vendor's insurance and certificate of insurance",
  retention: 'how many days of recordings are retained',
  cloud: 'whether cloud access or storage is available without the optional plan, and its cost',
  firm_price: 'a firm price (the proposal is a budgetary bid)',
};

async function boardMatterFacts(supabase, communityId, { env = process.env } = {}) {
  const empty = { matters: [], money: [], vendorNames: [], unverified: [], notAuthorized: false, rfpInProgress: false, vendorContactAuthorized: false, block: '' };
  if (!supabase || !communityId) return empty;
  try {
    const { data: bids, error } = await supabase.from('bid_requests')
      .select('id, title, status, selected_proposal_id, structured_rfp, closed_at')
      .eq('community_id', communityId).is('closed_at', null).order('created_at', { ascending: false }).limit(5);
    if (error) { console.warn('[matter_facts] bid_requests read failed:', error.message); return empty; }
    if (!bids || !bids.length) return empty;
    const { data: props, error: pe } = await supabase.from('vendor_proposals')
      .select('id, bid_request_id, vendor_name_raw, total_amount, proposal_date, extracted_data')
      .in('bid_request_id', bids.map((b) => b.id)).limit(50);
    if (pe) { console.warn('[matter_facts] vendor_proposals read failed:', pe.message); return empty; }

    const money = []; const vendorNames = new Set(); const unverified = new Map(); const matters = [];
    const addMoney = (cents, label) => { if (Number.isFinite(cents) && cents > 0 && !money.some((x) => x.cents === cents)) money.push({ cents: Math.round(cents), label }); };
    for (const b of bids) {
      const rfp = b.structured_rfp || null;
      const ds = (rfp && rfp.decision_state) || null;
      // No RFP decision state stored: an open matter with no selected proposal has no award,
      // so nothing is ready to sign or authorized to execute.
      const decision = ds ? { ...ds, source: 'structured_rfp.decision_state' }
        : { contract_readiness: b.selected_proposal_id ? 'Proposal selected; execution not confirmed' : 'Not ready to sign', execution_status: 'Not authorized', source: 'derived: open bid request, no award' };
      const notReady = !/^ready/i.test(String(decision.contract_readiness || '')) || /not authorized/i.test(String(decision.execution_status || ''));
      // Vendor contact needs the workflow switched on AND a Board-confirmed bidder list.
      const bidderListConfirmed = !!(rfp && (rfp.bidder_list_confirmed === true || (rfp.decision_state && /confirmed/i.test(String(rfp.decision_state.bidder_list || '')))));
      const contactAuthorized = String(env.AMANDA_RFP_WORKFLOW || 'dry_run').toLowerCase() === 'write' && bidderListConfirmed;
      matters.push({ id: b.id, title: b.title, status: b.status, decision, notReady, bidderListConfirmed, contactAuthorized, rfp: !!rfp });
      for (const p of (props || []).filter((x) => x.bid_request_id === b.id)) {
        const short = vendorShortName(p.vendor_name_raw);
        if (short) vendorNames.add(short);
        const e = p.extracted_data || {};
        const status = e.classification && e.classification.status;
        if (p.total_amount != null) addMoney(Number(p.total_amount) * 100, `${short || 'vendor'} proposal total`);
        for (const ci of e.comparison_items || []) {
          const pr = ci.pricing || {};
          if (pr.upfront_cents) {
            addMoney(pr.upfront_cents, `${short} upfront`);
            if (pr.tax_rate_pct != null && !pr.tax_included) {
              const tax = Math.round(pr.upfront_cents * Number(pr.tax_rate_pct) / 100);
              addMoney(tax, `${short} sales tax at ${pr.tax_rate_pct}%`);
              addMoney(pr.upfront_cents + tax, `${short} installed estimate including tax`);
            }
          }
          for (const r of pr.recurring || []) if (r.monthly_cents) addMoney(r.monthly_cents, `${short} ${r.label} per month`);
          if (ci.printed_subtotal_cents) addMoney(ci.printed_subtotal_cents, `${short} printed subtotal`);
          for (const c of moneyInText(ci.payment_terms)) addMoney(c, `${short} payment terms`);
          // Terms a current proposal leaves unstated are not facts Amanda may assert.
          if (status === 'current' && !pr.unpriced) {
            if (ci.warranty == null) unverified.set('warranty', `${UNVERIFIED_LABEL.warranty} (${short})`);
            if (ci.insurance == null) unverified.set('insurance', `${UNVERIFIED_LABEL.insurance} (${short})`);
            if (!ci.scope || ci.scope.retention_days == null) unverified.set('retention', `${UNVERIFIED_LABEL.retention} (${short})`);
            if (!ci.model || ci.model.cloud_access !== 'included') unverified.set('cloud', `${UNVERIFIED_LABEL.cloud} (${short})`);
            if (ci.budgetary) unverified.set('firm_price', `${UNVERIFIED_LABEL.firm_price} (${short})`);
          }
        }
      }
    }
    const notAuthorized = matters.some((m) => m.notReady);
    const vendorContactAuthorized = matters.length > 0 && matters.every((m) => m.contactAuthorized);
    const unv = [...unverified.entries()].map(([topic, label]) => ({ topic, label }));
    const block = matters.map((m) => `- "${m.title}": contract readiness ${m.decision.contract_readiness}; execution ${m.decision.execution_status} (${m.decision.source}).`).join('\n')
      + `\n- Vendor contact: ${vendorContactAuthorized ? 'authorized for the confirmed bidder list' : 'NOT authorized. Do not say you will contact, confirm with, ask, invite or send anything to any vendor; choosing bidders is a Board decision'}.`
      + (money.length ? `\n- Exact figures on file (use these exactly; never round, recompute or approximate): ${money.map((x) => `${x.label} ${dollars(x.cents)}`).join('; ')}.` : '')
      + (unv.length ? `\n- NOT verified in trustEd (say these remain to be confirmed; never state them as fact): ${unv.map((u) => u.label).join('; ')}.` : '');
    return { matters, money, vendorNames: [...vendorNames], unverified: unv, notAuthorized, rfpInProgress: matters.length > 0, vendorContactAuthorized, block };
  } catch (e) {
    console.warn('[matter_facts] failed:', e.message);
    return empty;
  }
}

module.exports = { boardMatterFacts, moneyInText, vendorShortName, dollars };
