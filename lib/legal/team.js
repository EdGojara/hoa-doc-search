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
// Three activities per invoice live in objectives (lib/manager), each closed
// only by its own completion: attorney payment (legal_invoice), homeowner
// recovery (legal_recovery) and documentation (legal_documentation). Paying the
// attorney never closes an unresolved recovery or documentation gap.
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
// The AI-prepared review account (claude-ai-review@) is an AI too: its drafts are Amanda's to
// update (Ed 2026-10-12), never a person's.
const AI_ACTORS = new Set([EMMA, AMANDA, 'claude-ai-review@bedrocktx.com']);

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
// Amanda's note on an allocation: outcome first, then the work type and its
// source, any limitation the owner accepts, what was verified, what is missing.
function amandaNote(f) {
  const label = f.outcome_label || (f.recommendation === 'recoverable' ? 'READY FOR APPROVAL' : 'NEEDS DECISION');
  const evidence = (f.verified || []).slice(0, 5).map((v) => `${v.source}: ${v.fact}`).join(' | ');
  return [`Amanda (AI): ${label} - ${f.reason}.`,
    f.work_type ? `Work type: ${f.work_type === 'drv' ? 'deed restriction (DRV)' : 'collections'} (${f.work_type_source || 'evidence'}).` : '',
    (f.limitations || []).length ? `Limitation: ${f.limitations.join(' ')}` : '',
    (f.judgment || []).length ? `Decision: ${f.judgment.join('; ')}.` : '',
    (f.missing || []).length ? `Missing: ${f.missing.join('; ')}.` : '',
    evidence ? `Verified: ${evidence}.` : ''].filter(Boolean).join(' ').slice(0, 1000);
}

// Fold Amanda's recommendations into a draft that is still the AI's own.
// Amanda's routine determinations on association lines, from documented policy only
// (Ed 2026-10-12). Returns the basis, or null when no documented policy applies.
const POLICY_BANKRUPTCY = 'Bedrock policy (Ed Gojara, 2026-10-11): legal work on a bankruptcy matter stays association legal expense unless authority permits recovery; no owner is charged.';
function associationDetermination(it, a) {
  if (a.classification !== 'association_legal_expense' || a.property_id) return null;
  if (a.bankruptcy_stop) return POLICY_BANKRUPTCY;
  const pdf = (a.evidence || []).find((e) => e && e.kind === 'pdf_matter');
  if (pdf && /general (hoa |association )?(representation|matters?)|general hoa/i.test(String(pdf.value || ''))) return `General association representation (attorney matter "${String(pdf.value).replace(/^invoice PDF matter /, '').slice(0, 120)}"); no homeowner is named; association legal expense.`;
  return null;
}
const AI_STAMP = /(claude|ai-review|-ai@)/i;
function applyRecommendations(d, findings) {
  const byAlloc = new Map(findings.filter((f) => f.allocation_id).map((f) => [f.allocation_id, f]));
  let changed = false;
  const items = d.saved.items.map((it) => ({
    source_line_ids: it.source_line_ids, matter_ref: it.matter_ref, service_date: it.service_date_source === 'staff' ? it.service_date : null,
    allocations: it.allocations.map((a) => {
      const f = byAlloc.get(a.id);
      const det = (a.evidence || []).find((e) => e && e.kind === 'agent_determination');
      const keep = { amount_cents: a.amount_cents, classification: a.classification, property_id: a.property_id || null, charge_category: a.charge_category || null, note: a.note || null,
        // A person's confirmation is kept; an AI account's bare stamp is not carried forward.
        confirmed: (a.evidence || []).some((e) => e.kind === 'staff_confirmed' && !AI_STAMP.test(String(e.value || ''))),
        determination: det ? Object.assign({ basis: det.basis, at: det.at }, det.resolves ? { resolves: det.resolves } : {}) : null };
      if (!f) {
        const basis = !det ? associationDetermination(it, a) : null;
        if (basis) { changed = true; return Object.assign({}, keep, { determination: { basis } }); }
        return keep;
      }
      // The note leads with Amanda's outcome so the review shows WHY a line is open
      // (her specific reason), never a generic "needs a decision".
      const note = amandaNote(f);
      // A recorded determination that answers this exact research question stands; a new
      // or different question reopens the line with Amanda's finding.
      if (det && det.resolves) {
        const now0 = S.amandaOutcome({ note });
        if (!now0 || now0.state === 'ready' || now0.reason === det.resolves) return keep;
      }
      const next = { amount_cents: a.amount_cents, classification: f.classification, property_id: a.property_id, charge_category: f.charge_category, note,
        // An attestation only on verified evidence; it never clears a hard stop.
        confirmed: f.recommendation === 'recoverable' && f.evidence_grade === 'verified' };
      // Re-save only when the treatment changes; a reworded note alone is not a change
      // (the full evidence is in Amanda's recorded decision either way).
      // A changed OUTCOME (state or reason, e.g. an address discrepancy found) is
      // a change the owner must see; reworded evidence alone is not.
      const was = S.amandaOutcome({ note: keep.note }), now = S.amandaOutcome({ note: next.note });
      const outcomeChanged = !!now && (!was || was.state !== now.state || was.reason !== now.reason || was.limitation !== now.limitation);
      const wasConfirmed = (a.evidence || []).some((e) => e.kind === 'staff_confirmed');   // as recorded, for change detection only
      if (next.classification !== keep.classification || next.charge_category !== keep.charge_category || next.confirmed !== wasConfirmed || (!keep.note && next.note) || outcomeChanged) changed = true;
      if (det) next.determination = keep.determination;
      // Amanda's VERIFIED research is her determination, recorded with its basis (an AI stamp is not).
      else if (f.recommendation === 'recoverable' && f.evidence_grade === 'verified') { next.determination = { basis: `Amanda verified: work type ${f.work_type || 'n/a'} (${f.work_type_source || 'n/a'}); ${f.reason}.`.slice(0, 600) }; changed = true; }
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
  if (aiOwned) {
    const { items, changed } = applyRecommendations(d, research.findings);
    if (changed) saved = await saveDraft(supabase, d, items, AMANDA, d.saved.review.revision, 'Amanda (AI): recommendation, evidence and routine determinations');
  }
  return Object.assign(research, { applied_to_draft: saved || (aiOwned ? 'unchanged' : 'recorded only: the draft was saved by a person') });
}

// ---- activities (lib/manager objectives), three per invoice ------------------
// Each has its own completion criteria, so paying the attorney never closes an
// unresolved homeowner recovery or a documentation gap:
//   legal_invoice        attorney invoice processing and payment -> closes when paid
//   legal_recovery       homeowner recovery: research -> exceptions -> owner
//                        approval -> posting -> closes when every owner charge is
//                        posted or reclassified (independent of payment)
//   legal_documentation  missing or inaccessible evidence -> closes when nothing is
//                        missing or the recovery itself is resolved
const KINDS = { payment: 'legal_invoice', recovery: 'legal_recovery', documentation: 'legal_documentation' };

async function loadLegalState(supabase, apInvoiceId, { loadInvoice } = {}) {
  const d = await (loadInvoice || R.loadInvoice)(supabase, apInvoiceId);
  if (!d) return null;
  const inv = must(await supabase.from('ap_invoices').select('id, community_id, vendor_invoice_number, total_cents, amount_paid_cents, status').eq('id', apInvoiceId), 'invoice')[0];
  const approvals = must(await supabase.from('ap_invoice_approvals').select('action').eq('invoice_id', apInvoiceId), 'approvals');
  let postings = [];
  const pr = await supabase.from('legal_invoice_postings').select('status, kind, amount_cents').eq('ap_invoice_id', apInvoiceId);
  if (!pr.error) postings = pr.data || [];
  const items = (d.saved && d.saved.items) || [];
  const exceptions = [];
  let recoverableCount = 0;
  items.forEach((it) => {
    recoverableCount += (it.allocations || []).filter((a) => a.classification === 'homeowner_recoverable').length;
    const t = S.triageItem(it);
    if (t.status !== 'exception') return;
    const text = `${t.reasons.join(' ')} ${(it.allocations || []).map((a) => a.note || '').join(' ')}`;
    const kind = /bankrupt/i.test(text) ? 'bankruptcy' : /current owner|owner at the time|ownership/i.test(text) ? 'ownership'
      : /notice|mailing/i.test(text) ? 'missing_notice' : /duplicate|already references/i.test(text) ? 'duplicate' : 'review';
    exceptions.push({ matter: it.matter_ref || null, kind, reason: t.reasons[0], amount_cents: it.amount_cents });
  });
  // Amanda's latest findings: what is missing or inaccessible (documentation activity).
  const docs = { missing: [], inaccessible: [] };
  const ro = await supabase.from('objectives').select('id').eq('subject_key', `${KINDS.recovery}:${apInvoiceId}`).order('created_at', { ascending: false }).limit(1);
  if (!ro.error && ro.data && ro.data[0]) {
    const dec = await supabase.from('objective_decisions').select('evidence').eq('objective_id', ro.data[0].id).eq('decided_by', 'amanda').order('created_at', { ascending: false }).limit(1);
    const f = !dec.error && dec.data && dec.data[0] && dec.data[0].evidence ? dec.data[0].evidence.findings || [] : [];
    for (const x of f) {
      for (const m of x.missing || []) if (!/^internal search incomplete/.test(m)) docs.missing.push(`${x.address || x.matter_ref}: ${m}`);
      for (const u of x.inaccessible || x.unavailable || []) docs.inaccessible.push(`${x.address || x.matter_ref}: ${u}`);
    }
  }
  const sum = items.length ? S.summarize(d.invoice.total_cents, items) : null;
  return {
    id: apInvoiceId, community_id: inv.community_id, invoice_number: inv.vendor_invoice_number, vendor: d.invoice.vendor, total_cents: Number(inv.total_cents),
    ap_status: inv.status, paid: inv.status === 'paid', released: approvals.some((a) => a.action === 'released_for_payment'),
    manager_approved: approvals.some((a) => a.action === 'approved'), read_only: d.readOnly || null,
    review_status: d.saved && d.saved.review ? d.saved.review.status : null, has_draft: !!items.length,
    homeowner_cents: sum ? sum.recoverable.cents : 0, recoverable_count: recoverableCount, exceptions, docs,
    postings: { pending: postings.filter((p) => p.status === 'pending').length, posted: postings.filter((p) => p.status === 'posted').length },
  };
}

const labelOf = (row) => `${row.vendor || 'Attorney'} ${row.invoice_number || ''} (${$(row.total_cents)})`.replace(/\s+/g, ' ');
const baseOf = (row, key) => ({ domain: 'legal', objective_type: 'other', owner_kind: 'workflow', owner_key: key, community_id: row.community_id || null,
  subject_refs: { table: 'ap_invoices', id: row.id, invoice_number: row.invoice_number || null } });

// Pure: attorney invoice processing and payment.
function legalPayment(row) {
  const base = baseOf(row, 'legal.payment'); const label = labelOf(row);
  const basis = { ap: row.ap_status, released: row.released, manager: row.manager_approved };
  if (row.read_only) return { ...base, basis, action: 'clear', outcome: 'no_action', reason: row.read_only };
  if (row.ap_status === 'voided') return { ...base, basis, action: 'clear', outcome: 'resolved', reason: 'invoice voided' };
  if (row.paid) return { ...base, basis, action: 'clear', outcome: 'resolved', reason: 'attorney invoice paid' };
  const track = (title, next, reason) => ({ ...base, basis, action: 'track', outcome: 'review', autonomy_class: 'REVIEW', priority: 'normal', title, next_action: next, reason });
  if (row.released) return track(`Payment released, awaiting payment: ${label}`, 'Cut the check or record the ACH.', 'released, not paid');
  if (!row.manager_approved) return track(`Attorney invoice awaiting approval: ${label}`, 'The manager approves the invoice (AP).', 'awaiting manager approval');
  return track(`Payment awaiting release: ${label}`, 'The owner releases the payment (approval queue).', 'awaiting payment release');
}

// Pure: homeowner recovery. Payment status is deliberately not an input.
function recoveryResolved(row) {
  if (row.read_only || row.ap_status === 'voided') return true;
  if (!row.has_draft || row.exceptions.length) return false;
  if (row.homeowner_cents === 0) return true;
  return row.review_status === 'approved' && !row.postings.pending && row.postings.posted >= row.recoverable_count;
}
function legalRecovery(row) {
  const base = baseOf(row, 'legal.recovery'); const label = labelOf(row);
  const basis = { review: row.review_status, draft: row.has_draft, exceptions: row.exceptions.map((e) => `${e.matter}:${e.kind}`), homeowner: row.homeowner_cents, recoverable: row.recoverable_count, postings: row.postings };
  if (row.read_only) return { ...base, basis, action: 'clear', outcome: 'no_action', reason: row.read_only };
  if (row.ap_status === 'voided') return { ...base, basis, action: 'clear', outcome: 'resolved', reason: 'invoice voided' };
  if (!row.has_draft) return { ...base, basis, action: 'track', outcome: 'review', autonomy_class: 'REVIEW', priority: 'normal',
    title: `Homeowner recovery research: ${label}`, next_action: 'Emma prepares the draft; Amanda researches each owner line.', reason: 'no review draft yet' };
  if (row.exceptions.length) {
    const kinds = [...new Set(row.exceptions.map((e) => e.kind))];
    const bk = kinds.includes('bankruptcy');
    const word = { bankruptcy: 'bankruptcy exception', missing_notice: 'notice or mailing not verified', ownership: 'ownership change', duplicate: 'possible duplicate charge', review: 'needs a decision' };
    return { ...base, basis, action: 'track', outcome: bk ? 'block' : 'review', autonomy_class: bk ? 'BLOCK' : 'REVIEW', priority: bk ? 'high' : 'normal',
      blocked_reason: bk ? 'bankruptcy: an owner charge needs the owner\'s decision' : null,
      title: `Homeowner recovery on ${label}: ${row.exceptions.length} exception${row.exceptions.length === 1 ? '' : 's'} (${kinds.map((k) => word[k] || k).join(', ')})`,
      next_action: row.exceptions.slice(0, 3).map((e) => `${e.matter || 'item'}: ${e.reason}`).join(' / '), reason: 'exceptions open' };
  }
  if (row.homeowner_cents === 0) return { ...base, basis, action: 'clear', outcome: 'resolved', reason: 'no homeowner recovery on this invoice (association expense)' };
  if (row.review_status !== 'approved') return { ...base, basis, action: 'track', outcome: 'review', autonomy_class: 'REVIEW', priority: 'normal',
    title: `Approval required: ${$(row.homeowner_cents)} homeowner chargebacks on ${label}`, next_action: 'The owner reviews the evidence and approves the treatment (Legal Invoice Review).', reason: 'awaiting owner approval' };
  if (row.postings.pending || row.postings.posted < row.recoverable_count) return { ...base, basis, action: 'track', outcome: 'review', autonomy_class: 'REVIEW', priority: 'high',
    title: `Chargeback posting ${row.postings.pending ? 'pending' : 'incomplete'} on ${label}`, next_action: 'Finish posting, or cancel the pending posting with a reason.', reason: 'postings not complete' };
  return { ...base, basis, action: 'clear', outcome: 'resolved', reason: `homeowner charges posted (${row.postings.posted})` };
}

// Pure: missing or inaccessible documentation.
function legalDocumentation(row) {
  const base = baseOf(row, 'legal.documentation'); const label = labelOf(row);
  const basis = { missing: row.docs.missing, inaccessible: row.docs.inaccessible };
  if (recoveryResolved(row)) return { ...base, basis, action: 'clear', outcome: 'resolved', reason: 'recovery resolved; no documentation outstanding' };
  // A source the system cannot search is work only when evidence is actually missing (Ed 2026-10-12):
  // with nothing missing and every owner line resolved, an inaccessible OneDrive is not a task.
  if (!row.docs.missing.length && (!row.docs.inaccessible.length || !(row.exceptions || []).length)) return { ...base, basis, action: 'clear', outcome: 'resolved', reason: row.docs.inaccessible.length ? 'no documentation missing (some sources not searchable, nothing needed from them)' : 'no documentation missing' };
  return { ...base, basis, action: 'track', outcome: 'review', autonomy_class: 'REVIEW', priority: 'normal',
    title: `Documentation needed for ${label}: ${row.docs.missing.length} missing${row.docs.inaccessible.length ? `, ${row.docs.inaccessible.length} source(s) inaccessible` : ''}`,
    next_action: row.docs.missing.concat(row.docs.inaccessible.map((x) => `check ${x}`)).slice(0, 4).join(' / '), reason: 'documentation gaps' };
}

async function updateActivity(supabase, apInvoiceId, wakeReason, { loadInvoice } = {}) {
  const row = await loadLegalState(supabase, apInvoiceId, { loadInvoice });
  if (!row) return { payment: { outcome: 'source_missing', objective_id: null } };
  const { apply } = require('../manager/state');
  return {
    payment: await apply(supabase, KINDS.payment, apInvoiceId, legalPayment(row), { wakeReason }),
    recovery: await apply(supabase, KINDS.recovery, apInvoiceId, legalRecovery(row), { wakeReason }),
    documentation: await apply(supabase, KINDS.documentation, apInvoiceId, legalDocumentation(row), { wakeReason }),
  };
}

// ---- decisions (one row per agent per distinct finding) ----------------------
async function record(supabase, objectiveId, communityId, agent, apInvoiceId, revision, d) {
  if (!objectiveId) return null;
  // Key on the substance only: whether this run created the draft or found it
  // already there must not make an unchanged finding look new.
  const basis = Object.assign({}, d.evidence); delete basis.draft; delete basis.pdf_read; delete basis.applied_to_draft;
  // Draft row ids change on every save; a finding is identified by matter + property.
  if (Array.isArray(basis.findings)) basis.findings = basis.findings.map((f) => { const c = Object.assign({}, f); delete c.allocation_id; delete c.item_id; delete c.corrections; return c; });
  const ref = `legal:${apInvoiceId}:r${revision}:${agent}:${sha({ verdict: d.verdict, basis })}`;
  const { data: ex, error } = await supabase.from('objective_decisions').select('id').eq('objective_id', objectiveId).eq('triggering_event_ref', ref).limit(1);
  if (error) throw error;
  if (ex && ex.length) return { id: ex[0].id, already: true };
  const { recordDecision } = require('../team/reconcile');
  return recordDecision(supabase, objectiveId, Object.assign({ communityId, triggeringEventRef: ref, decidedBy: agent }, d));
}

// ---- the run ------------------------------------------------------------------
async function runLegalTeam(supabase, apInvoiceId, { trigger = 'manual', deps = {} } = {}) {
  const load = deps.loadInvoice || R.loadInvoice;
  let d = await load(supabase, apInvoiceId);
  if (!d) return { ok: true, skipped: 'not_a_legal_invoice' };
  if (d.readOnly) return { ok: true, skipped: 'read_only', reason: d.readOnly };
  if (!d.schemaReady) return { ok: true, skipped: 'migration_pending', reason: 'legal review tables (473) not available' };

  const emma = await emmaPrepare(supabase, d, deps);
  d = await load(supabase, apInvoiceId);
  const amanda = await amandaResearch(supabase, d, deps);
  d = await load(supabase, apInvoiceId);

  const T = require('./treatment');
  const plan = await T.planTreatment(supabase, d, deps.periods ? { periods: deps.periods } : {});
  const KV = require('./kat_verify');
  const katCheck = await KV.verifyTreatment(supabase, d, plan, { livePostings: deps.livePostings });
  const verdict = await KV.katDecision(supabase, d, plan, katCheck);
  const kat = Object.assign({}, katCheck, { ready_for_owner_approval: verdict.state === 'ready', verdict });

  let act = await updateActivity(supabase, apInvoiceId, `legal_team:${trigger}`, { loadInvoice: deps.loadInvoice });
  const payObj = act.payment && act.payment.objective_id;
  const recObj = (act.recovery && act.recovery.objective_id) || payObj;
  const rev = d.saved && d.saved.review ? d.saved.review.revision : 0;
  const cid = d.invoice.community_id;
  const holds = amanda.findings.filter((f) => f.recommendation !== 'recoverable');
  const external = amanda.findings.map((f) => f.external_request).filter(Boolean);
  const decisions = {
    emma: await record(supabase, payObj, cid, 'emma', apInvoiceId, rev, {
      verdict: emma.notes.length ? 'ESCALATE' : 'PROPOSE_ACTION', confidence: emma.notes.length ? 'medium' : 'high',
      reason: emma.notes.length ? emma.notes.join('; ') : 'AP record verified: accrued, not entered or paid twice; review draft in place',
      evidence: { checks: emma.checks, pdf_read: emma.pdf_read, draft: emma.draft }, rulesConsulted: ['AP duplicate controls', 'accrual before treatment'],
      proposedCapability: 'log_note', proposedActionDetail: 'Invoice prepared for legal review.', authorizationBoundary: false,
    }),
    amanda: await record(supabase, recObj, cid, 'amanda', apInvoiceId, rev, {
      verdict: holds.length ? 'ESCALATE' : 'PROPOSE_ACTION', confidence: holds.length ? 'medium' : 'high',
      reason: amanda.findings.length ? `${amanda.findings.length} owner line(s) researched: ${amanda.findings.filter((f) => f.outcome === 'ready').length} ready for approval, ${amanda.findings.filter((f) => f.outcome === 'needs_information').length} need information, ${amanda.findings.filter((f) => f.outcome === 'needs_decision').length} need a decision` : (amanda.skipped || 'no owner-attributed lines'),
      evidence: { findings: amanda.findings, governing: amanda.governing, applied_to_draft: amanda.applied_to_draft },
      rulesConsulted: ['Tex. Prop. Code 209.0064 (pre-referral notice)', 'Tex. Prop. Code 209.006 (violation notice)', 'bankruptcy stop', 'current-owner tenure'],
      proposedCapability: external.length ? 'request_document' : 'log_note',
      proposedActionDetail: external.length ? `Held for approval: ${external.map((x) => x.subject).join('; ')}` : 'Recommendation recorded on the review.',
      authorizationBoundary: true, authorizationReason: 'Homeowner charges and any outside request require the owner\'s approval.',
    }),
    kat: await record(supabase, recObj, cid, 'kat', apInvoiceId, rev, {
      verdict: kat.ready_for_owner_approval ? 'PROPOSE_ACTION' : 'ESCALATE', confidence: kat.verified ? 'high' : 'medium',
      reason: kat.ready_for_owner_approval ? `Treatment verified: ${$(kat.totals.homeowner_cents)} homeowner recovery, posting ${kat.posting_date}` : verdict.summary,
      evidence: { checks: verdict.checks, totals: kat.totals, posting_date: kat.posting_date, state: verdict.state, issues: verdict.issues, items: verdict.items, charges: verdict.charges },
      rulesConsulted: ['Dr 1300 / Cr accrued legal expense; never AP', 'balanced entry', 'open period after accrual and cutover', 'no duplicate posting'],
      proposedCapability: 'log_note', proposedActionDetail: 'Treatment prepared; the owner approves posting.', authorizationBoundary: true,
      authorizationReason: 'Posting homeowner charges requires the owner\'s Approve Treatment.',
    }),
  };
  act = await updateActivity(supabase, apInvoiceId, `legal_team:${trigger}:after_findings`, { loadInvoice: deps.loadInvoice });
  return { ok: true, invoice: apInvoiceId, emma, amanda: { findings: amanda.findings.length, holds: holds.length, applied_to_draft: amanda.applied_to_draft, external_requests_held: external.length },
    kat: { verified: kat.verified, ready_for_owner_approval: kat.ready_for_owner_approval, state: verdict.state, issues: verdict.issues, charges: verdict.charges }, activity: act, decisions };
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

module.exports = { associationDetermination, runLegalTeam, triggerFromIntake, emmaPrepare, amandaResearch, applyRecommendations, amandaNote, loadLegalState, legalPayment, legalRecovery, legalDocumentation, recoveryResolved, updateActivity, KINDS, EMMA, AMANDA, KAT, AI_ACTORS };
