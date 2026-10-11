// ============================================================================
// lib/legal/team.js — Emma, Amanda and Kat on one attorney invoice
// (Ed 2026-10-11)
// ----------------------------------------------------------------------------
// Runs when Emma loads an attorney invoice (lib/ap/intake.js), or on demand
// (POST /api/legal-review/invoices/:id/run-team). Reuses what exists:
//
//   EMMA    reads the attorney PDF (review_data.readInvoicePdf), confirms the
//           AP record (accrual, not entered or paid twice) and, only when no
//           review exists yet, saves the engine's suggested draft.
//   AMANDA  researches each owner-attributed line (lib/legal/research.js) and,
//           when the draft is still the AI's own (never a person's), writes her
//           recommendation into it with the evidence; otherwise she records it
//           alongside without touching the person's draft.
//   KAT     verifies the accounting the plan would post (lib/legal/kat_verify.js).
//
// Each agent's result is its own row in objective_decisions (decided_by
// emma / amanda / kat), keyed so a re-run with nothing new writes nothing.
// The invoice's single activity lives in objectives (lib/manager), kind
// 'legal_invoice': research -> exceptions -> owner approval -> chargebacks
// -> payment release -> resolved. One open activity per invoice, closed
// automatically when the work is done.
//
// The team never approves a treatment, never posts, never releases a payment
// and never sends anything. Those remain the owner's separate actions.
// ============================================================================
const crypto = require('crypto');
const R = require('./review_data');
const S = require('./review_suggest');

const EMMA = 'emma-ai@bedrocktx.com';
const AMANDA = 'amanda-ai@bedrocktx.com';
const KAT = 'kat-ai@bedrocktx.com';
// Drafts Amanda may update: only those Emma or Amanda saved. Anything a
// person (or a supervised review) saved is recorded against, never rewritten.
const AI_ACTORS = new Set([EMMA, AMANDA]);
const KIND = 'legal_invoice';

const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const must = (r, what) => { if (r && r.error) throw Object.assign(new Error(`${what}: ${r.error.message}`), { cause: r.error }); return (r && r.data) || []; };
const $ = (c) => `$${(Number(c || 0) / 100).toFixed(2)}`;

// ---- EMMA ------------------------------------------------------------------
async function emmaPrepare(supabase, d, deps) {
  const notes = [];
  const inv = must(await supabase.from('ap_invoices').select('id, vendor_id, vendor_invoice_number, status, dedup_status, posting_journal_entry_id, amount_paid_cents').eq('id', d.invoice.id), 'invoice')[0] || {};
  const twins = inv.vendor_invoice_number ? must(await supabase.from('ap_invoices').select('id, status').eq('vendor_id', inv.vendor_id).eq('vendor_invoice_number', inv.vendor_invoice_number).neq('id', inv.id), 'duplicate check') : [];
  const apps = must(await supabase.from('ap_payment_applications').select('id').eq('invoice_id', inv.id), 'payment check');
  const checks = {
    accrued: !!inv.posting_journal_entry_id,
    duplicate_invoice_records: twins.filter((t) => t.status !== 'voided').length,
    dedup_status: inv.dedup_status || null,
    payments_recorded: apps.length,
    status: inv.status || null,
  };
  if (!checks.accrued) notes.push('no accrual entry yet: the invoice must be coded first');
  if (checks.duplicate_invoice_records) notes.push(`${checks.duplicate_invoice_records} other live AP record(s) with this vendor and number`);
  if (checks.payments_recorded) notes.push(`${checks.payments_recorded} payment(s) already recorded`);

  let read = null;
  if (!(d.extractionUse && d.extractionUse.ok) && d.invoice.has_file) {
    try { read = await (deps.readPdf || R.readInvoicePdf)(supabase, d, EMMA, {}); }
    catch (e) { read = { error: e.message }; notes.push(`PDF read failed: ${e.message}`); }
  }

  let draftSaved = null;
  const reloaded = read ? await R.loadInvoice(supabase, d.invoice.id) : d;
  const hasDraft = !!(reloaded.saved && reloaded.saved.review && reloaded.saved.review.revision);
  if (!hasDraft) {
    const sug = S.suggestReview(reloaded.invoice, reloaded.lines, reloaded.ctx);
    const items = sug.items.map((it) => ({
      source_line_ids: it.source_line_ids, matter_ref: it.matter_ref, service_date: null,
      allocations: it.allocations.map((a) => ({ amount_cents: a.amount_cents, classification: a.classification, property_id: a.property_id || null, charge_category: a.charge_category || null, note: null, confirmed: false })),
    }));
    draftSaved = await saveDraft(supabase, reloaded, items, EMMA, 0, 'Emma (AI): suggested draft from the invoice and attorney PDF');
  }
  return { checks, notes, pdf_read: read ? (read.error ? { error: read.error } : { status: read.status, reused: !!read.reused }) : 'existing', draft: draftSaved || (hasDraft ? 'existing' : null) };
}

async function saveDraft(supabase, d, items, actor, baseRevision, label) {
  const built = R.buildDraft(d, { items }, actor);
  if (built.errors) return { error: built.errors.slice(0, 5) };
  const rec = built.reconciliation;
  const { data, error } = await supabase.rpc('legal_review_save_draft', {
    p_ap_invoice_id: d.invoice.id, p_community_id: d.invoice.community_id, p_base_revision: baseRevision, p_actor: actor, p_items: built.items,
    p_summary: { items: built.items.length, allocations: built.items.reduce((a, x) => a + x.allocations.length, 0), invoice_total_cents: rec.invoice_total_cents,
      allocated_cents: rec.allocated_cents, reconciled: rec.reconciled, ready_for_approval: rec.ready_for_approval, blocking: rec.blocking.length, prepared_by: label },
  });
  if (error) return { error: error.message };
  if (!data || !data.ok) return { error: (data && data.error) || 'save_failed' };
  return { revision: data.revision };
}

// ---- AMANDA ----------------------------------------------------------------
// Fold Amanda's recommendations into a draft that is still the AI's own.
function applyRecommendations(d, findings) {
  const byAlloc = new Map(findings.filter((f) => f.allocation_id).map((f) => [f.allocation_id, f]));
  let changed = false;
  const items = d.saved.items.map((it) => ({
    source_line_ids: it.source_line_ids, matter_ref: it.matter_ref, service_date: it.service_date_source === 'staff' ? it.service_date : null,
    allocations: it.allocations.map((a) => {
      const f = byAlloc.get(a.id);
      const keep = { amount_cents: a.amount_cents, classification: a.classification, property_id: a.property_id || null, charge_category: a.charge_category || null, note: a.note || null,
        confirmed: (a.evidence || []).some((e) => e.kind === 'staff_confirmed') };
      if (!f) return keep;
      const evidence = f.verified.slice(0, 6).map((v) => `${v.source}: ${v.fact}`).join(' | ');
      const note = `Amanda (AI): ${f.recommendation} - ${f.reason}.${evidence ? ` Verified: ${evidence}.` : ''}${f.missing.length ? ` Missing: ${f.missing.join('; ')}.` : ''}`.slice(0, 1000);
      const next = { amount_cents: a.amount_cents, classification: f.classification, property_id: a.property_id, charge_category: f.charge_category, note,
        // An attestation only on verified evidence; it never clears a hard stop.
        confirmed: f.recommendation === 'recoverable' && f.evidence_grade === 'verified' };
      if (next.classification !== keep.classification || next.charge_category !== keep.charge_category || next.note !== keep.note || next.confirmed !== keep.confirmed) changed = true;
      return next;
    }),
  }));
  return { items, changed };
}

async function amandaResearch(supabase, d, deps) {
  if (!(d.saved && d.saved.items && d.saved.items.length)) return { findings: [], skipped: 'no draft' };
  const research = await (deps.research || require('./research').researchInvoice)(supabase, d, { sources: deps.sources });
  const aiOwned = d.saved.review && AI_ACTORS.has(d.saved.review.updated_by);
  let saved = null;
  if (aiOwned && research.findings.length) {
    const { items, changed } = applyRecommendations(d, research.findings);
    if (changed) saved = await saveDraft(supabase, d, items, AMANDA, d.saved.review.revision, 'Amanda (AI): recommendation and evidence');
  }
  return Object.assign(research, { applied_to_draft: saved || (aiOwned ? 'unchanged' : 'recorded only: the draft was saved by a person') });
}

// ---- the activity (one per invoice, lib/manager objectives) ------------------
async function loadLegalState(supabase, apInvoiceId) {
  const d = await R.loadInvoice(supabase, apInvoiceId);
  if (!d) return null;
  const inv = must(await supabase.from('ap_invoices').select('id, community_id, vendor_invoice_number, total_cents, amount_paid_cents, status').eq('id', apInvoiceId), 'invoice')[0];
  const approvals = must(await supabase.from('ap_invoice_approvals').select('action').eq('invoice_id', apInvoiceId), 'approvals');
  let postings = [];
  const pr = await supabase.from('legal_invoice_postings').select('status, kind, amount_cents').eq('ap_invoice_id', apInvoiceId);
  if (!pr.error) postings = pr.data || [];
  const items = (d.saved && d.saved.items) || [];
  const exceptions = [];
  items.forEach((it) => {
    const t = S.triageItem(it);
    if (t.status !== 'exception') return;
    const text = `${t.reasons.join(' ')} ${(it.allocations || []).map((a) => a.note || '').join(' ')}`;
    const kind = /bankrupt/i.test(text) ? 'bankruptcy' : /current owner|owner at the time|ownership/i.test(text) ? 'ownership'
      : /notice/i.test(text) ? 'missing_notice' : /duplicate|already references/i.test(text) ? 'duplicate' : 'review';
    exceptions.push({ matter: it.matter_ref || null, kind, reason: t.reasons[0], amount_cents: it.amount_cents });
  });
  const sum = items.length ? S.summarize(d.invoice.total_cents, items) : null;
  return {
    id: apInvoiceId, community_id: inv.community_id, invoice_number: inv.vendor_invoice_number, vendor: d.invoice.vendor, total_cents: Number(inv.total_cents),
    ap_status: inv.status, paid: inv.status === 'paid', released: approvals.some((a) => a.action === 'released_for_payment'),
    manager_approved: approvals.some((a) => a.action === 'approved'), read_only: d.readOnly || null,
    review_status: d.saved && d.saved.review ? d.saved.review.status : null, has_draft: !!items.length,
    homeowner_cents: sum ? sum.recoverable.cents : 0, exceptions,
    postings: { pending: postings.filter((p) => p.status === 'pending').length, posted: postings.filter((p) => p.status === 'posted').length },
  };
}

// Pure: the current stage of the invoice as an activity.
function legalInvoice(row) {
  const refs = { table: 'ap_invoices', id: row.id, invoice_number: row.invoice_number || null };
  const base = { domain: 'legal', objective_type: 'legal', owner_kind: 'workflow', owner_key: 'legal.invoice', community_id: row.community_id || null, subject_refs: refs };
  const label = `${row.vendor || 'Attorney'} ${row.invoice_number || ''} (${$(row.total_cents)})`.replace(/\s+/g, ' ');
  const basis = { ap: row.ap_status, released: row.released, review: row.review_status, draft: row.has_draft, exceptions: row.exceptions.map((e) => `${e.matter}:${e.kind}`), homeowner: row.homeowner_cents, postings: row.postings };
  if (row.read_only) return { ...base, basis, action: 'clear', outcome: 'no_action', reason: row.read_only };
  if (row.ap_status === 'voided') return { ...base, basis, action: 'clear', outcome: 'resolved', reason: 'invoice voided' };
  if (!row.has_draft) return { ...base, basis, action: 'track', outcome: 'review', autonomy_class: 'REVIEW', priority: 'normal',
    title: `Legal invoice ${label}: research in progress`, next_action: 'Emma prepares the draft; Amanda researches each owner line.', reason: 'no review draft yet' };
  if (row.exceptions.length) {
    const kinds = [...new Set(row.exceptions.map((e) => e.kind))];
    const bk = kinds.includes('bankruptcy');
    const word = { bankruptcy: 'bankruptcy exception', missing_notice: 'missing legal notice', ownership: 'ownership change', duplicate: 'possible duplicate charge', review: 'needs a decision' };
    return { ...base, basis, action: 'track', outcome: bk ? 'block' : 'review', autonomy_class: bk ? 'BLOCK' : 'REVIEW', priority: bk ? 'high' : 'normal',
      blocked_reason: bk ? 'bankruptcy: an owner charge needs the owner\'s decision' : null,
      title: `Legal invoice ${label}: ${row.exceptions.length} exception${row.exceptions.length === 1 ? '' : 's'} (${kinds.map((k) => word[k] || k).join(', ')})`,
      next_action: row.exceptions.slice(0, 3).map((e) => `${e.matter || 'item'}: ${e.reason}`).join(' / '), reason: 'exceptions open' };
  }
  if (row.homeowner_cents > 0 && row.review_status !== 'approved') return { ...base, basis, action: 'track', outcome: 'review', autonomy_class: 'REVIEW', priority: 'normal',
    title: `Approval required: ${$(row.homeowner_cents)} homeowner chargebacks on ${label}`, next_action: 'The owner reviews the evidence and approves the treatment (Legal Invoice Review).', reason: 'awaiting owner approval' };
  if (row.postings.pending) return { ...base, basis, action: 'track', outcome: 'review', autonomy_class: 'REVIEW', priority: 'high',
    title: `Chargeback posting pending on ${label}`, next_action: 'Finish posting, or cancel the pending posting with a reason.', reason: 'pending postings' };
  if (!row.paid) {
    return { ...base, basis, action: 'track', outcome: 'review', autonomy_class: 'REVIEW', priority: 'normal',
      title: row.released ? `Payment released, awaiting payment: ${label}` : `Payment awaiting release: ${label}${row.postings.posted ? ' (chargebacks posted)' : ''}`,
      next_action: row.released ? 'Cut the check or record the ACH.' : 'The owner releases the payment (approval queue).', reason: row.released ? 'released, not paid' : 'awaiting payment release' };
  }
  return { ...base, basis, action: 'clear', outcome: 'resolved', reason: `complete: ${row.postings.posted ? 'chargebacks posted, ' : ''}invoice paid` };
}

async function updateActivity(supabase, apInvoiceId, wakeReason) {
  const row = await loadLegalState(supabase, apInvoiceId);
  if (!row) return { outcome: 'source_missing', objective_id: null };
  const { apply } = require('../manager/state');
  return apply(supabase, KIND, apInvoiceId, legalInvoice(row), { wakeReason });
}

// ---- decisions (one row per agent per distinct finding) ----------------------
async function record(supabase, objectiveId, communityId, agent, apInvoiceId, revision, d) {
  if (!objectiveId) return null;
  const ref = `legal:${apInvoiceId}:r${revision}:${agent}:${sha(d.evidence)}`;
  const { data: ex, error } = await supabase.from('objective_decisions').select('id').eq('objective_id', objectiveId).eq('triggering_event_ref', ref).limit(1);
  if (error) throw error;
  if (ex && ex.length) return { id: ex[0].id, already: true };
  const { recordDecision } = require('../team/reconcile');
  return recordDecision(supabase, objectiveId, Object.assign({ communityId, triggeringEventRef: ref, decidedBy: agent }, d));
}

// ---- the run ------------------------------------------------------------------
async function runLegalTeam(supabase, apInvoiceId, { trigger = 'manual', deps = {} } = {}) {
  let d = await R.loadInvoice(supabase, apInvoiceId);
  if (!d) return { ok: true, skipped: 'not_a_legal_invoice' };
  if (d.readOnly) return { ok: true, skipped: 'read_only', reason: d.readOnly };
  if (!d.schemaReady) return { ok: true, skipped: 'migration_pending', reason: 'legal review tables (473) not available' };

  const emma = await emmaPrepare(supabase, d, deps);
  d = await R.loadInvoice(supabase, apInvoiceId);
  const amanda = await amandaResearch(supabase, d, deps);
  d = await R.loadInvoice(supabase, apInvoiceId);

  const T = require('./treatment');
  const plan = await T.planTreatment(supabase, d, deps.periods ? { periods: deps.periods } : {});
  const kat = await require('./kat_verify').verifyTreatment(supabase, d, plan, { livePostings: deps.livePostings });

  const act = await updateActivity(supabase, apInvoiceId, `legal_team:${trigger}`);
  const rev = d.saved && d.saved.review ? d.saved.review.revision : 0;
  const cid = d.invoice.community_id;
  const holds = amanda.findings.filter((f) => f.recommendation !== 'recoverable');
  const external = amanda.findings.map((f) => f.external_request).filter(Boolean);
  const decisions = {
    emma: await record(supabase, act.objective_id, cid, 'emma', apInvoiceId, rev, {
      verdict: emma.notes.length ? 'ESCALATE' : 'PROPOSE_ACTION', confidence: emma.notes.length ? 'medium' : 'high',
      reason: emma.notes.length ? emma.notes.join('; ') : 'AP record verified: accrued, not entered or paid twice; review draft in place',
      evidence: { checks: emma.checks, pdf_read: emma.pdf_read, draft: emma.draft }, rulesConsulted: ['AP duplicate controls', 'accrual before treatment'],
      proposedCapability: 'log_note', proposedActionDetail: 'Invoice prepared for legal review.', authorizationBoundary: false,
    }),
    amanda: await record(supabase, act.objective_id, cid, 'amanda', apInvoiceId, rev, {
      verdict: holds.length ? 'ESCALATE' : 'PROPOSE_ACTION', confidence: holds.length ? 'medium' : 'high',
      reason: amanda.findings.length ? `${amanda.findings.length} owner line(s) researched: ${amanda.findings.filter((f) => f.recommendation === 'recoverable').length} supported, ${holds.length} for review` : (amanda.skipped || 'no owner-attributed lines'),
      evidence: { findings: amanda.findings, governing: amanda.governing, applied_to_draft: amanda.applied_to_draft },
      rulesConsulted: ['Tex. Prop. Code 209.0064 (pre-referral notice)', 'Tex. Prop. Code 209.006 (violation notice)', 'bankruptcy stop', 'current-owner tenure'],
      proposedCapability: external.length ? 'request_document' : 'log_note',
      proposedActionDetail: external.length ? `Held for approval: ${external.map((x) => x.subject).join('; ')}` : 'Recommendation recorded on the review.',
      authorizationBoundary: true, authorizationReason: 'Homeowner charges and any outside request require the owner\'s approval.',
    }),
    kat: await record(supabase, act.objective_id, cid, 'kat', apInvoiceId, rev, {
      verdict: kat.ready_for_owner_approval ? 'PROPOSE_ACTION' : 'ESCALATE', confidence: kat.verified ? 'high' : 'medium',
      reason: kat.ready_for_owner_approval ? `Treatment verified: ${$(kat.totals.homeowner_cents)} homeowner recovery, posting ${kat.posting_date}` : `Not ready: ${(kat.checks.filter((c) => !c.ok).map((c) => c.name).concat(kat.blocking)).slice(0, 3).join('; ')}`,
      evidence: { checks: kat.checks, totals: kat.totals, posting_date: kat.posting_date, blocking: kat.blocking },
      rulesConsulted: ['Dr 1300 / Cr accrued legal expense; never AP', 'balanced entry', 'open period after accrual and cutover', 'no duplicate posting'],
      proposedCapability: 'log_note', proposedActionDetail: 'Treatment prepared; the owner approves posting.', authorizationBoundary: true,
      authorizationReason: 'Posting homeowner charges requires the owner\'s Approve Treatment.',
    }),
  };
  return { ok: true, invoice: apInvoiceId, emma, amanda: { findings: amanda.findings.length, holds: holds.length, applied_to_draft: amanda.applied_to_draft, external_requests_held: external.length },
    kat: { verified: kat.verified, ready_for_owner_approval: kat.ready_for_owner_approval }, activity: act, decisions };
}

// Fire-and-forget from intake: never delays or fails the bill load.
function triggerFromIntake(supabase, apInvoiceId) {
  setImmediate(() => {
    runLegalTeam(supabase, apInvoiceId, { trigger: 'intake' })
      .then((r) => console.log('[legal-team] intake run', JSON.stringify({ invoice: apInvoiceId, skipped: r.skipped || null, findings: r.amanda && r.amanda.findings })))
      .catch((e) => {
        console.warn('[legal-team] intake run failed', JSON.stringify({ invoice: apInvoiceId, error: e.message }));
        supabase.from('system_errors').insert({ method: 'TEAM', path: `legal_team/${apInvoiceId}`, status_code: null, error_message: String(e.message).slice(0, 2000), user_agent: 'legal.team' }).then(() => {}, () => {});
      });
  });
}

module.exports = { runLegalTeam, triggerFromIntake, emmaPrepare, amandaResearch, applyRecommendations, loadLegalState, legalInvoice, updateActivity, KIND, EMMA, AMANDA, KAT, AI_ACTORS };
