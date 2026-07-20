// ============================================================================
// lib/ap/vendor_community.js  (Ed 2026-07-12)
// ----------------------------------------------------------------------------
// The learning map behind hands-off vendor accounting. resolveMapping() answers
// "which community + GL account does this bill belong to?" from a service
// account number (strongest), then a vendor that serves exactly one community.
// learnMapping() writes back every time Ed codes an item, so the next identical
// bill resolves itself. Code the exception once; the system executes it after.
// (project_single_teacher_learning + project_system_as_operator.)
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const normName = (s) => String(s || '').toLowerCase().replace(/\b(inc|llc|ltd|co|corp|company|services|service)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const normAcct = (s) => String(s || '').replace(/[^a-z0-9]/gi, '').toLowerCase();

// Resolve a vendor bill to a community + default GL account. Returns
// { community_id, gl_account_id, confidence: 'high'|'medium'|'none', via, mapping_id } — never throws.
async function resolveMapping({ accountNumber, vendorId, vendorName } = {}) {
  const none = { community_id: null, gl_account_id: null, confidence: 'none', via: null, mapping_id: null };
  try {
    // 1) Exact account number — the strongest signal, unique per service line.
    const acct = normAcct(accountNumber);
    if (acct) {
      const { data } = await supabase.from('vendor_community_accounts')
        .select('id, community_id, default_gl_account_id, account_number').not('account_number', 'is', null);
      const hit = (data || []).find((r) => normAcct(r.account_number) === acct);
      if (hit) return { community_id: hit.community_id, gl_account_id: hit.default_gl_account_id, confidence: 'high', via: 'account_number', mapping_id: hit.id };
    }
    // 2) Vendor that serves exactly ONE community (unambiguous).
    let rows = [];
    if (vendorId) {
      const { data } = await supabase.from('vendor_community_accounts').select('id, community_id, default_gl_account_id').eq('vendor_id', vendorId);
      rows = data || [];
    }
    if (!rows.length && vendorName) {
      const vn = normName(vendorName);
      if (vn) {
        const { data } = await supabase.from('vendor_community_accounts').select('id, community_id, default_gl_account_id, vendor_name_norm').eq('vendor_name_norm', vn);
        rows = data || [];
      }
    }
    const communities = [...new Set(rows.map((r) => r.community_id))];
    if (communities.length === 1) {
      const r = rows[0];
      return { community_id: r.community_id, gl_account_id: r.default_gl_account_id, confidence: 'medium', via: 'vendor_single_community', mapping_id: r.id };
    }
    // 3) PRIOR EXPENSES — we've already recorded a bill for this account/vendor.
    // Infer the community from actual paid history (ap_invoices), so the platform
    // learns from what it has already posted even without an explicit map.
    // (Ed 2026-07-20: "look through prior expenses to apply it to a community".)
    if (acct) {
      const { data } = await supabase.from('ap_invoices').select('community_id, coded_gl_account_id').eq('account_number', String(accountNumber).trim()).limit(50);
      const comms = [...new Set((data || []).map((r) => r.community_id).filter(Boolean))];
      if (comms.length === 1) return { community_id: comms[0], gl_account_id: (data.find((r) => r.coded_gl_account_id) || {}).coded_gl_account_id || null, confidence: 'high', via: 'prior_expense_account', mapping_id: null };
    }
    if (vendorId) {
      const { data } = await supabase.from('ap_invoices').select('community_id').eq('vendor_id', vendorId).limit(200);
      const comms = [...new Set((data || []).map((r) => r.community_id).filter(Boolean))];
      if (comms.length === 1) return { community_id: comms[0], gl_account_id: null, confidence: 'medium', via: 'prior_expense_vendor', mapping_id: null };
    }
    return none;
  } catch (e) { console.warn('[vendor_community] resolve failed:', e.message); return none; }
}

// Write back what Ed coded. Keyed on account number when present, else on
// (vendor, community). Bumps times_recorded so we can see what the system has
// learned. Best-effort — a learning failure never blocks the recording itself.
async function learnMapping({ accountNumber, vendorId, vendorName, communityId, glAccountId, serviceAddress, taughtByUserId, taughtByName } = {}) {
  if (!communityId) return null;
  try {
    const acct = String(accountNumber || '').trim();
    const vnorm = normName(vendorName);
    let existing = null;
    if (acct) {
      const { data } = await supabase.from('vendor_community_accounts').select('*').not('account_number', 'is', null);
      existing = (data || []).find((r) => normAcct(r.account_number) === normAcct(acct)) || null;
    } else if (vendorId || vnorm) {
      let q = supabase.from('vendor_community_accounts').select('*').eq('community_id', communityId);
      q = vendorId ? q.eq('vendor_id', vendorId) : q.eq('vendor_name_norm', vnorm);
      const { data } = await q;
      existing = (data || []).find((r) => !r.account_number) || (data && data[0]) || null;
    }
    const now = new Date().toISOString();
    if (existing) {
      await supabase.from('vendor_community_accounts').update({
        community_id: communityId,
        default_gl_account_id: glAccountId || existing.default_gl_account_id,
        vendor_id: vendorId || existing.vendor_id, vendor_name_norm: vnorm || existing.vendor_name_norm,
        service_address: serviceAddress || existing.service_address,
        times_recorded: (existing.times_recorded || 0) + 1, last_recorded_at: now, updated_at: now,
      }).eq('id', existing.id);
      return existing.id;
    }
    const { data } = await supabase.from('vendor_community_accounts').insert({
      vendor_id: vendorId || null, vendor_name_norm: vnorm || null, community_id: communityId,
      account_number: acct || null, service_address: serviceAddress || null, default_gl_account_id: glAccountId || null,
      times_recorded: 1, last_recorded_at: now, taught_by_user_id: taughtByUserId || null, taught_by_name: taughtByName || null,
    }).select('id').single();
    return data ? data.id : null;
  } catch (e) { console.warn('[vendor_community] learn failed:', e.message); return null; }
}

module.exports = { resolveMapping, learnMapping, normName, normAcct };
