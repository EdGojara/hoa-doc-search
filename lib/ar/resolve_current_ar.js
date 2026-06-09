// ============================================================================
// lib/ar/resolve_current_ar.js — single source of truth for current AR
// ----------------------------------------------------------------------------
// Ed 2026-06-08 standing rule: ONE Vantaca report per data domain, ONE
// canonical table, all consumers read from one place. This function is the
// shared resolver every "what's this homeowner's current balance?" surface
// goes through.
//
// MERGE LOGIC:
//   Balance + as_of_date:
//     1. Try v_homeowner_current_balance (sum of homeowner_transactions from
//        committed batches) — the canonical post-Jun-2026 source.
//     2. Fall back to owner_ar_snapshots — legacy mirror, kept readable
//        for communities that haven't done a transaction import yet.
//   Enforcement signals (at_legal, in_collections, payment_plan_active,
//   enforcement_stage):
//     - Only owner_ar_snapshots has these today; transactions doesn't track
//       them yet. So we ALWAYS try the snapshot for these signals, even
//       when balance comes from transactions.
//     - When an "enforcement_state" table eventually exists, this is the
//       one place that needs to change.
//
// INPUT:
//   { propertyId?, vantacaAccountId?, communityId? }
//   - propertyId alone is enough; the function resolves the other two.
//   - vantacaAccountId + communityId together skip the property lookup.
//
// OUTPUT:
//   { balance_cents, as_of, source, enforcement_stage, at_legal,
//     in_collections, payment_plan_active, payment_plan_terms_text }
//   OR null when nothing is on file.
//
// source = 'transactions' | 'snapshot' | 'none' — tells the caller which
//   path won. Useful for the disclosure language Claire uses on voice.
// ============================================================================

async function resolveCurrentAR(supabase, opts = {}) {
  let { propertyId, vantacaAccountId, communityId } = opts;

  // Step 1 — resolve any missing identifiers from the property
  if (propertyId && (!vantacaAccountId || !communityId)) {
    try {
      const { data: p } = await supabase
        .from('properties')
        .select('vantaca_account_id, community_id')
        .eq('id', propertyId)
        .maybeSingle();
      if (p) {
        vantacaAccountId = vantacaAccountId || p.vantaca_account_id || null;
        communityId      = communityId      || p.community_id      || null;
      }
    } catch (_) { /* fall through to whatever we have */ }
  }

  // Step 2 — fetch all three sources in parallel
  // (1) Transactions view — canonical balance source
  // (2) Snapshot — legacy fallback for balance + legacy enforcement signals
  // (3) Enforcement state — canonical operator-managed state
  //     (migration 202, catastrophic-output class — overrides legacy)
  const [txnRes, snapRes, esRes] = await Promise.allSettled([
    (vantacaAccountId && communityId)
      ? supabase
          .from('v_homeowner_current_balance')
          .select('balance_cents, most_recent_txn_date')
          .eq('community_id', communityId)
          .eq('vantaca_account_id', vantacaAccountId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    propertyId
      ? supabase
          .from('owner_ar_snapshots')
          .select('balance_total, snapshot_date, enforcement_stage, at_legal, in_collections, payment_plan_active, payment_plan_terms_text')
          .eq('property_id', propertyId)
          .order('snapshot_date', { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    propertyId
      ? supabase
          .from('v_current_enforcement_state')
          .select('state, attorney_name, attorney_firm, attorney_email, attorney_phone, bankruptcy_chapter, bankruptcy_case_number, bankruptcy_court, bankruptcy_filing_date, bankruptcy_attorney_name, bankruptcy_attorney_email, payment_plan_terms_text, payment_plan_monthly_cents, payment_plan_remaining_cents, effective_at, expected_through, notes')
          .eq('property_id', propertyId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const txn  = (txnRes.status === 'fulfilled') ? txnRes.value?.data  : null;
  const snap = (snapRes.status === 'fulfilled') ? snapRes.value?.data : null;
  const es   = (esRes.status === 'fulfilled')  ? esRes.value?.data   : null;

  if (!txn && !snap && !es) return null;

  // Step 2.5 — pre/post-petition split when bankruptcy is on file with
  // a filing date. Petition date is the dividing line:
  //   - Pre-petition debt is subject to §362 stay; may be discharged
  //     (Ch 7) or paid through plan (Ch 13)
  //   - Post-petition assessments accrue normally and are owed
  //
  // Operator + attorney work together to settle pre-petition treatment
  // at case close. Post-petition continues as a normal AR.
  let prePetitionBalanceCents = null;
  let postPetitionBalanceCents = null;
  if (es?.state === 'in_bankruptcy' && es.bankruptcy_filing_date && vantacaAccountId && communityId) {
    try {
      const filingDate = es.bankruptcy_filing_date;
      // Sum transactions BEFORE OR ON the filing date (pre-petition)
      const { data: preRows } = await supabase
        .from('homeowner_transactions')
        .select('amount_cents, source_batch:source_batch_id(status)')
        .eq('community_id', communityId)
        .eq('vantaca_account_id', vantacaAccountId)
        .lte('transaction_date', filingDate);
      // Sum transactions AFTER the filing date (post-petition)
      const { data: postRows } = await supabase
        .from('homeowner_transactions')
        .select('amount_cents, source_batch:source_batch_id(status)')
        .eq('community_id', communityId)
        .eq('vantaca_account_id', vantacaAccountId)
        .gt('transaction_date', filingDate);
      const sumCommitted = (rows) => (rows || [])
        .filter(r => r.source_batch?.status === 'committed')
        .reduce((acc, r) => acc + Number(r.amount_cents || 0), 0);
      prePetitionBalanceCents  = sumCommitted(preRows);
      postPetitionBalanceCents = sumCommitted(postRows);
    } catch (e) {
      console.warn('[resolveCurrentAR] pre/post-petition split failed:', e.message);
    }
  }

  // Step 3 — balance + as_of: prefer transactions (granular, recent),
  // fall back to snapshot (legacy).
  let balance_cents, as_of, source;
  if (txn) {
    balance_cents = (txn.balance_cents != null) ? Number(txn.balance_cents) : null;
    as_of         = txn.most_recent_txn_date || null;
    source        = 'transactions';
  } else {
    balance_cents = (snap.balance_total != null) ? Math.round(Number(snap.balance_total) * 100) : null;
    as_of         = snap.snapshot_date || null;
    source        = 'snapshot';
  }

  // Step 4 — enforcement signals: enforcement_state table (operator-managed,
  // catastrophic-output class) OVERRIDES the legacy snapshot signals
  // whenever it has data. Order matters — a bankruptcy filing entered by
  // staff must not be overridden by a stale Vantaca AR snapshot that
  // doesn't know about it yet.
  let enforcement_state, at_legal, in_collections, payment_plan_active,
      in_bankruptcy, lien_filed, judgment, payment_plan_terms_text,
      attorney = null, bankruptcy = null, payment_plan = null;
  if (es) {
    // Canonical source — operator-managed
    enforcement_state    = es.state;
    at_legal             = es.state === 'at_legal';
    in_collections       = es.state === 'in_collections';
    payment_plan_active  = es.state === 'on_payment_plan';
    in_bankruptcy        = es.state === 'in_bankruptcy';
    lien_filed           = es.state === 'lien_filed';
    judgment             = es.state === 'judgment';
    payment_plan_terms_text = es.payment_plan_terms_text || null;
    if (es.attorney_name || es.attorney_firm || es.attorney_email) {
      attorney = {
        name: es.attorney_name,
        firm: es.attorney_firm,
        email: es.attorney_email,
        phone: es.attorney_phone,
      };
    }
    if (es.bankruptcy_case_number || es.bankruptcy_chapter) {
      bankruptcy = {
        chapter: es.bankruptcy_chapter,
        case_number: es.bankruptcy_case_number,
        court: es.bankruptcy_court,
        filing_date: es.bankruptcy_filing_date,
        attorney_name: es.bankruptcy_attorney_name,
        attorney_email: es.bankruptcy_attorney_email,
      };
    }
    if (es.payment_plan_terms_text || es.payment_plan_monthly_cents) {
      payment_plan = {
        terms_text: es.payment_plan_terms_text,
        monthly_cents: es.payment_plan_monthly_cents,
        remaining_cents: es.payment_plan_remaining_cents,
        expected_through: es.expected_through,
      };
    }
  } else {
    // Legacy — derive from owner_ar_snapshots (transitional)
    enforcement_state       = snap?.enforcement_stage || null;
    at_legal                = !!snap?.at_legal;
    in_collections          = !!snap?.in_collections;
    payment_plan_active     = !!snap?.payment_plan_active;
    in_bankruptcy           = false;   // Not tracked on snapshots — operator must use enforcement_states
    lien_filed              = snap?.enforcement_stage === 'lien_filed';
    judgment                = snap?.enforcement_stage === 'judgment';
    payment_plan_terms_text = snap?.payment_plan_terms_text || null;
  }

  return {
    balance_cents,
    as_of,
    source,
    enforcement_source: es ? 'enforcement_states' : (snap ? 'legacy_snapshot' : 'none'),
    // Boolean signals — what every consumer (Claire HARD RULEs, letter
    // renderer, board portal, draft AI) checks before any communication
    at_legal,
    in_collections,
    in_bankruptcy,
    on_payment_plan: payment_plan_active,
    payment_plan_active,                       // legacy alias for compat
    lien_filed,
    judgment,
    // Consumers read .enforcement_stage (legacy name from owner_ar_snapshots);
    // internally the variable is enforcement_state.
    enforcement_stage: enforcement_state,
    enforcement_state,
    // Structured detail when present (used by render-time templates)
    attorney,
    bankruptcy,
    payment_plan,
    payment_plan_terms_text,
    // Pre/post-petition split when bankruptcy is on file with filing date.
    // Operator + attorney work together to settle pre-petition treatment
    // at case close (discharge, plan payments, etc.); post-petition
    // continues as normal AR.
    petition_date: es?.bankruptcy_filing_date || null,
    pre_petition_balance_cents:  prePetitionBalanceCents,
    post_petition_balance_cents: postPetitionBalanceCents,
  };
}

module.exports = { resolveCurrentAR };
