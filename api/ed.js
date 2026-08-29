// ============================================================================
// api/ed.js  (Ed 2026-08-29)
// ----------------------------------------------------------------------------
// The owner command center's cross-domain endpoints. GET /pending aggregates
// everything gated on Ed into ONE prioritized to-do, from a set of SOURCES —
// each source a small block that returns items in a common shape. New gates
// plug in as a source; the screen never changes. Owner-only.
// ============================================================================
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const { requireOwner } = require('./_require_admin');

// GET /api/ed/pending — the unified pending list. Each source returns
// { key, icon, label, count, stakes_cents?, action, note? }. Sorted by stakes.
router.get('/pending', async (req, res) => {
  const owner = await requireOwner(req, res);
  if (!owner) return;
  const sources = [];

  // Source 1 — invoices a manager approved that are waiting on Ed to release.
  try {
    const { data } = await supabase.from('ap_invoices')
      .select('total_cents, ap_invoice_approvals(action)')
      .eq('status', 'awaiting_approval').limit(500);
    let n = 0, sum = 0;
    for (const inv of (data || [])) {
      const a = inv.ap_invoice_approvals || [];
      if (a.find((x) => x.action === 'approved') && !a.find((x) => x.action === 'released_for_payment')) { n += 1; sum += Number(inv.total_cents || 0); }
    }
    if (n > 0) sources.push({ key: 'invoices', icon: '💵', label: 'Invoices awaiting your approval', count: n, stakes_cents: sum, action: '/ed.html' });
  } catch (e) { /* source best-effort */ }

  // Source 2 — team-drafted replies waiting on human review (the exception queue).
  try {
    const { data } = await supabase.from('outbound_email_drafts')
      .select('id').eq('status', 'draft').limit(1000);
    const n = (data || []).length;
    if (n > 0) sources.push({ key: 'drafts', icon: '✉️', label: 'Team drafts awaiting review', count: n, action: '/draft-queue.html' });
  } catch (e) { /* pre-migration or empty — skip */ }

  // Source 3 — builder ARC submissions still needing a decision.
  try {
    const { data } = await supabase.from('builder_applications')
      .select('id').eq('status', 'received').limit(1000);
    const n = (data || []).length;
    if (n > 0) sources.push({ key: 'builder_arc', icon: '📐', label: 'Builder ARC submissions to review', count: n, action: '/builder-arc-review.html' });
  } catch (e) { /* skip */ }

  sources.sort((a, b) => (b.stakes_cents || 0) - (a.stakes_cents || 0) || b.count - a.count);
  res.json({ sources });
});

module.exports = router;
