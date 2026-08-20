// ============================================================================
// lib/accounting/kat_book_checks.js  (Ed 2026-08-19)
// ----------------------------------------------------------------------------
// Kat reads the BOOKS, not just the PDF she was sent.
//
// This is the difference between her review and Amanda's. Amanda reviews a
// document's words. Kat can go and check whether the thing the document claims
// is actually true in the ledger, which means her findings are facts rather
// than impressions — and a fact survives an argument with a board treasurer.
//
// Every check here corresponds to a machine_checkable rule in kat_standards.js
// and to a defect that really happened. Each returns the evidence, not just a
// verdict, because "Waterview is carrying Quail Ridge's $476.30 landscaping
// bill, invoice 43444, posted 2026-08-01" is actionable and "possible duplicate
// detected" is not.
//
// READ ONLY. Kat reports and recommends; she never posts, recodes or reverses.
// ============================================================================

/** Same bill posted to two associations. The worst of the four. */
async function checkCrossCommunityPostings(supabase) {
  const { data, error } = await supabase.from('journal_entries')
    .select('id, community_id, description, total_debits_cents, posting_date')
    .eq('source_module', 'ap_invoice').eq('status', 'posted').is('reverses_je_id', null)
    .limit(2000);
  if (error) return { rule_id: 'cross_community_posting', ok: false, error: error.message };

  const byBill = {};
  (data || []).forEach((r) => {
    const k = String(r.description || '').trim() + '|' + r.total_debits_cents;
    (byBill[k] = byBill[k] || []).push(r);
  });

  const findings = [];
  for (const [, rows] of Object.entries(byBill)) {
    if (new Set(rows.map((r) => r.community_id)).size < 2) continue;
    for (const r of rows) {
      const { data: owns } = await supabase.from('ap_invoices')
        .select('id').eq('posting_journal_entry_id', r.id).maybeSingle();
      if (!owns) {
        findings.push({
          community_id: r.community_id,
          amount_cents: r.total_debits_cents,
          posting_date: r.posting_date,
          description: r.description,
          journal_entry_id: r.id,
          detail: 'posted here but the invoice belongs to another association',
        });
      }
    }
  }
  return { rule_id: 'cross_community_posting', ok: findings.length === 0, findings };
}

/** A posted expense with no invoice, or an invoice with no source document. */
async function checkOrphanEntries(supabase, communityId) {
  let q = supabase.from('journal_entries')
    .select('id, community_id, description, posting_date, total_debits_cents')
    .eq('source_module', 'ap_invoice').eq('status', 'posted').is('reverses_je_id', null).limit(1000);
  if (communityId) q = q.eq('community_id', communityId);
  const { data, error } = await q;
  if (error) return { rule_id: 'orphan_gl_entry', ok: false, error: error.message };

  const findings = [];
  for (const j of data || []) {
    const { data: inv } = await supabase.from('ap_invoices')
      .select('id, source_storage_path, source_document_id').eq('posting_journal_entry_id', j.id).maybeSingle();
    if (!inv) {
      findings.push({ journal_entry_id: j.id, posting_date: j.posting_date, description: j.description,
        amount_cents: j.total_debits_cents, detail: 'no invoice behind this entry' });
    } else if (!inv.source_storage_path && !inv.source_document_id) {
      findings.push({ journal_entry_id: j.id, posting_date: j.posting_date, description: j.description,
        amount_cents: j.total_debits_cents, detail: 'invoice on file but no source document attached' });
    }
  }
  return { rule_id: 'orphan_gl_entry', ok: findings.length === 0, findings, checked: (data || []).length };
}

/** Owner balances derived from transactions that stopped weeks ago. */
async function checkArFreshness(supabase, communityId) {
  let q = supabase.from('transaction_upload_batches')
    .select('community_id, as_of_date, max_transaction_date')
    .eq('status', 'committed').order('as_of_date', { ascending: false }).limit(500);
  if (communityId) q = q.eq('community_id', communityId);
  const { data, error } = await q;
  if (error) return { rule_id: 'stale_ar_data', ok: false, error: error.message };

  const latest = new Map();
  (data || []).forEach((b) => { if (!latest.has(b.community_id)) latest.set(b.community_id, b); });

  const findings = [];
  for (const [cid, b] of latest.entries()) {
    const days = Math.floor((Date.now() - new Date(String(b.as_of_date) + 'T12:00:00Z').getTime()) / 86400000);
    if (days > 35) {
      findings.push({ community_id: cid, last_import: String(b.as_of_date).slice(0, 10), days_stale: days,
        detail: `owner balances rest on data ending ${String(b.as_of_date).slice(0, 10)}` });
    }
  }
  return { rule_id: 'stale_ar_data', ok: findings.length === 0, findings };
}

/** A voided check whose journal entry is still posted. */
async function checkVoidedChecksStillPosted(supabase, communityId) {
  let q = supabase.from('check_register')
    .select('id, check_number, amount_cents, status, ap_payment_id, community_id')
    .in('status', ['voided', 'stop_payment']).limit(1000);
  if (communityId) q = q.eq('community_id', communityId);
  const { data, error } = await q;
  if (error) return { rule_id: 'void_leaves_books_intact', ok: false, error: error.message };

  const findings = [];
  for (const c of data || []) {
    if (!c.ap_payment_id) continue;
    const { data: pay } = await supabase.from('ap_payments')
      .select('id, status, posting_journal_entry_id').eq('id', c.ap_payment_id).maybeSingle();
    if (!pay) continue;
    if (pay.status !== 'voided') {
      findings.push({ check_number: c.check_number, amount_cents: c.amount_cents, community_id: c.community_id,
        detail: 'check is void but the AP payment is still live' });
      continue;
    }
    if (pay.posting_journal_entry_id) {
      const { data: je } = await supabase.from('journal_entries')
        .select('status').eq('id', pay.posting_journal_entry_id).maybeSingle();
      if (je && je.status !== 'voided') {
        findings.push({ check_number: c.check_number, amount_cents: c.amount_cents, community_id: c.community_id,
          detail: 'check is void but its journal entry is still posted — the books still show the cash gone' });
      }
    }
  }
  return { rule_id: 'void_leaves_books_intact', ok: findings.length === 0, findings };
}

/**
 * Run every machine check. Scoped to one community when given, portfolio-wide
 * otherwise (the cross-community check is ALWAYS portfolio-wide — scoping it to
 * one community is exactly how the defect stays invisible).
 */
async function runBookChecks(supabase, { communityId = null } = {}) {
  const results = await Promise.all([
    checkCrossCommunityPostings(supabase),
    checkOrphanEntries(supabase, communityId),
    checkArFreshness(supabase, communityId),
    checkVoidedChecksStillPosted(supabase, communityId),
  ]);
  const failed = results.filter((r) => r.ok === false && !r.error);
  return {
    results,
    clean: failed.length === 0,
    finding_ids: failed.map((r) => r.rule_id),
    total_findings: failed.reduce((n, r) => n + (r.findings ? r.findings.length : 0), 0),
  };
}

module.exports = {
  runBookChecks,
  checkCrossCommunityPostings,
  checkOrphanEntries,
  checkArFreshness,
  checkVoidedChecksStillPosted,
};
