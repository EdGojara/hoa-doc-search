// ============================================================================
// lib/legal/review_data.js — Legal Invoice Review reads + draft validation
// (Issue #9 step 2: draft-only)
// ----------------------------------------------------------------------------
// Reads everything the review screen needs for one attorney invoice (lines, GL
// accounts, accrual state, the community's properties, owner tenures, owner
// names, bankruptcy and legal status, the saved draft) and validates a draft
// save. The server recomputes evidence, tenure and the bankruptcy stop on every
// save; the browser's copy of those is never trusted.
//
// DRAFT ONLY. Nothing here posts to the GL, reclassifies an accrual or writes a
// homeowner charge. The one write path is the legal_review_save_draft()
// function (migration 473), which writes only the review workpaper tables.
// ============================================================================
const { fetchAll, fetchAllQuery } = require('../db/fetch_all');
const S = require('./review_suggest');

// The attorney firms on file (migration 473 flags these by id). Used only to
// keep the list readable before 473 is applied; after that the flag decides.
const LEGAL_VENDOR_IDS = [
  '22488091-2642-489d-a84a-50c72fb05645',   // Winstead PC
  '35f76d51-0753-4f9f-b46d-df3c73d6092a',   // Daughtry & Farine, P.C.
  'ee565db3-2c94-4830-8855-ccea1740dfa7',   // RMWBH
];
const CLASSIFICATIONS = ['homeowner_recoverable', 'association_legal_expense', 'needs_review'];
const CATEGORIES = ['attorney_fee', 'attorney_fee_other'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INVOICE_SELECT = 'id, community_id, vendor_id, vendor_invoice_number, invoice_date, due_date, total_cents, status, voided_at, '
  + 'posting_journal_entry_id, service_period_start, service_period_end, source_storage_path, intake_method';
const COMMUNITY_SELECT = 'id, name, management_status, management_end_date, books_of_record, financials_active';

const missingColumn = (e) => e && (e.code === '42703' || /is_legal_counsel/.test(e.message || ''));
const missingTable = (e) => e && (e.code === '42P01' || e.code === 'PGRST205' || /legal_invoice_reviews|schema cache/.test(e.message || ''));

// Why a community's legal invoices are view-only here (or null when editable).
function readOnlyReason(c) {
  if (!c) return 'Community not found.';
  const ms = c.management_status;
  if (ms === 'terminating' || ms === 'terminated') return `Leaving Bedrock${c.management_end_date ? ` (last day ${c.management_end_date})` : ''}: view only.`;
  if (ms === 'prospect') return 'Prospect: view only.';
  if (c.financials_active === false) return 'We don’t keep the books for this community: view only.';
  if (c.books_of_record && c.books_of_record !== 'trusted') return `Books of record are in ${c.books_of_record === 'vantaca' ? 'Vantaca' : c.books_of_record}: view only.`;
  return null;
}

async function legalVendors(supabase) {
  const { data, error } = await supabase.from('vendors').select('id, name').eq('is_legal_counsel', true).order('name');
  if (!error) return { vendors: data || [], flag_ready: true };
  if (!missingColumn(error)) throw error;
  const r = await supabase.from('vendors').select('id, name').in('id', LEGAL_VENDOR_IDS).order('name');
  if (r.error) throw r.error;
  return { vendors: r.data || [], flag_ready: false };
}

async function reviewTablesReady(supabase) {
  const { error } = await supabase.from('legal_invoice_reviews').select('id', { head: true, count: 'exact' }).limit(1);
  if (!error) return true;
  if (missingTable(error)) return false;
  throw error;
}

// ---- list ------------------------------------------------------------------------
const LIST_CAP = 500;
async function listInvoices(supabase) {
  const { vendors, flag_ready } = await legalVendors(supabase);
  const schemaReady = flag_ready && await reviewTablesReady(supabase);
  if (!vendors.length) return { invoices: [], schema_ready: schemaReady, truncated: false };
  const { data, error } = await supabase.from('ap_invoices')
    .select(INVOICE_SELECT + ', vendors(name), communities(' + COMMUNITY_SELECT + ')')
    .in('vendor_id', vendors.map((v) => v.id)).is('voided_at', null)
    .order('invoice_date', { ascending: false }).order('id').limit(LIST_CAP);
  if (error) throw error;
  const rows = data || [];
  let reviews = new Map();
  if (schemaReady && rows.length) {
    const r = await supabase.from('legal_invoice_reviews').select('ap_invoice_id, revision, updated_at, updated_by')
      .in('ap_invoice_id', rows.map((x) => x.id)).limit(LIST_CAP);
    if (r.error) throw r.error;
    reviews = new Map((r.data || []).map((x) => [x.ap_invoice_id, x]));
  }
  return {
    schema_ready: schemaReady,
    truncated: rows.length >= LIST_CAP,
    invoices: rows.map((i) => {
      const rv = reviews.get(i.id);
      return {
        id: i.id, vendor: i.vendors ? i.vendors.name : null, invoice_number: i.vendor_invoice_number, invoice_date: i.invoice_date,
        total_cents: Number(i.total_cents || 0), ap_status: i.status, accrued: !!i.posting_journal_entry_id,
        community: i.communities ? { id: i.communities.id, name: i.communities.name } : null,
        read_only: readOnlyReason(i.communities),
        review: rv ? { revision: rv.revision, updated_at: rv.updated_at, updated_by: rv.updated_by } : null,
      };
    }),
  };
}

// ---- one invoice -----------------------------------------------------------------
async function loadContext(supabase, communityId) {
  const [properties, tenures, owners, pes, arc] = await Promise.all([
    fetchAll(supabase, 'properties', { select: 'id, street_address, unit, normalized_address, trusted_account_number, vantaca_account_id', filters: { community_id: communityId } }),
    fetchAll(supabase, 'ownership_tenures', { select: 'id, property_id, kind, start_date, end_date, origin', filters: { community_id: communityId } }),
    // Owner names per tenure. property_ownerships has no community_id, so scope
    // through the property (inner join) rather than an unbounded id list.
    fetchAllQuery(() => supabase.from('property_ownerships')
      .select('id, property_id, tenure_id, contacts(full_name), properties!inner(community_id)')
      .eq('properties.community_id', communityId)),
    fetchAllQuery(() => supabase.from('property_enforcement_states').select('id, property_id, state')
      .eq('community_id', communityId).is('ended_at', null)),
    fetchAllQuery(() => supabase.from('ar_account_collections')
      .select('id, property_id, collection_status, bankruptcy_petition_date, bankruptcy_discharge_date, bankruptcy_dismissed_date')
      .eq('community_id', communityId)),
  ]);
  const bankrupt = new Set();
  const legalStates = {};
  for (const s of pes) {
    if (!s.property_id) continue;
    if (s.state === 'in_bankruptcy') bankrupt.add(s.property_id);
    else if (s.state !== 'current') legalStates[s.property_id] = s.state;
  }
  for (const a of arc) {
    if (!a.property_id) continue;
    const open = !a.bankruptcy_discharge_date && !a.bankruptcy_dismissed_date;
    if (open && (a.collection_status === 'bankruptcy' || a.bankruptcy_petition_date)) bankrupt.add(a.property_id);
  }
  return {
    properties,
    tenures,
    owners: owners.map((o) => ({ property_id: o.property_id, tenure_id: o.tenure_id, name: o.contacts ? o.contacts.full_name : null })).filter((o) => o.name),
    bankruptcyPropertyIds: [...bankrupt],
    legalStates,
  };
}

async function loadSavedDraft(supabase, invoiceId) {
  const { data: review, error } = await supabase.from('legal_invoice_reviews')
    .select('id, revision, status, created_by, created_at, updated_by, updated_at').eq('ap_invoice_id', invoiceId).maybeSingle();
  if (error) throw error;
  if (!review || !review.revision) return review ? { review, items: [] } : null;
  const [items, allocs, events] = await Promise.all([
    fetchAllQuery(() => supabase.from('legal_invoice_items')
      .select('id, sort_order, source_line_ids, source_text, matter_ref, amount_cents, service_date, service_period_start, service_period_end, service_date_source, created_by, created_at')
      .eq('review_id', review.id).eq('revision', review.revision).eq('is_active', true)),
    fetchAllQuery(() => supabase.from('legal_invoice_allocations')
      .select('id, item_id, amount_cents, classification, property_id, tenure_id, charge_category, tenure_match, confidence, bankruptcy_stop, evidence, suggested, note')
      .eq('review_id', review.id).eq('revision', review.revision).eq('is_active', true)),
    supabase.from('legal_invoice_review_events').select('revision, action, actor, summary, created_at')
      .eq('review_id', review.id).order('created_at', { ascending: false }).limit(20),
  ]);
  if (events.error) throw events.error;
  const byItem = new Map();
  for (const a of allocs) { if (!byItem.has(a.item_id)) byItem.set(a.item_id, []); byItem.get(a.item_id).push(Object.assign({}, a, { amount_cents: Number(a.amount_cents) })); }
  return {
    review,
    events: events.data || [],
    items: items.sort((a, b) => a.sort_order - b.sort_order).map((it) => Object.assign({}, it, {
      amount_cents: Number(it.amount_cents),
      allocations: (byItem.get(it.id) || []).sort((a, b) => b.amount_cents - a.amount_cents),
    })),
  };
}

// Everything the screen (and a save) needs. Returns null when the invoice is
// not an attorney invoice (the review never widens to other vendors).
async function loadInvoice(supabase, invoiceId) {
  const { vendors, flag_ready } = await legalVendors(supabase);
  const { data: inv, error } = await supabase.from('ap_invoices').select(INVOICE_SELECT + ', vendors(name)').eq('id', invoiceId).maybeSingle();
  if (error) throw error;
  if (!inv || !vendors.some((v) => v.id === inv.vendor_id)) return null;
  const [{ data: community, error: ce }, lines] = await Promise.all([
    supabase.from('communities').select(COMMUNITY_SELECT).eq('id', inv.community_id).maybeSingle(),
    fetchAllQuery(() => supabase.from('ap_invoice_lines').select('id, line_number, description, amount_cents, gl_account_id').eq('invoice_id', invoiceId), { orderBy: 'line_number' }),
  ]);
  if (ce) throw ce;
  const accountIds = [...new Set(lines.map((l) => l.gl_account_id).filter(Boolean))];
  let accounts = new Map();
  if (accountIds.length) {
    const { data: coa, error: ae } = await supabase.from('chart_of_accounts').select('id, account_number, account_name').in('id', accountIds);
    if (ae) throw ae;
    accounts = new Map((coa || []).map((a) => [a.id, a]));
  }
  const schemaReady = flag_ready && await reviewTablesReady(supabase);
  const [ctx, saved] = await Promise.all([loadContext(supabase, inv.community_id), schemaReady ? loadSavedDraft(supabase, invoiceId) : null]);
  const invoice = {
    id: inv.id, vendor: inv.vendors ? inv.vendors.name : null, invoice_number: inv.vendor_invoice_number,
    invoice_date: inv.invoice_date, due_date: inv.due_date, total_cents: Number(inv.total_cents || 0), ap_status: inv.status,
    voided: !!inv.voided_at, accrued: !!inv.posting_journal_entry_id, has_file: !!inv.source_storage_path,
    service_period_start: inv.service_period_start, service_period_end: inv.service_period_end, community_id: inv.community_id,
  };
  const shapedLines = lines.map((l) => {
    const a = accounts.get(l.gl_account_id);
    return { id: l.id, line_number: l.line_number, description: l.description, amount_cents: Number(l.amount_cents || 0),
      account: a ? `${a.account_number} ${a.account_name}` : null };
  });
  return { invoice, community, lines: shapedLines, ctx, saved, schemaReady, readOnly: invoice.voided ? 'This payable is void: view only.' : readOnlyReason(community) };
}

// The screen payload: suggestions from the engine, plus the saved draft if any.
function detailPayload(d) {
  const suggestion = S.suggestReview(d.invoice, d.lines, d.ctx);
  const props = new Map(d.ctx.properties.map((p) => [p.id, p]));
  const label = (id) => { const p = props.get(id); return p ? [p.street_address, p.unit].filter(Boolean).join(' #') : null; };
  const owners = new Map();
  for (const o of d.ctx.owners) { const k = o.property_id + '|' + (o.tenure_id || ''); if (!owners.has(k)) owners.set(k, []); owners.get(k).push(o.name); }
  const decorate = (items) => items.map((it) => Object.assign({}, it, {
    service_basis: it.service_basis || S.describeBasis({ date: it.service_date, start: it.service_period_start, end: it.service_period_end, source: it.service_date_source }),
    allocations: it.allocations.map((a) => Object.assign({}, a, {
    property_label: a.property_id ? label(a.property_id) : null,
    owner_names: a.property_id && a.tenure_id ? owners.get(a.property_id + '|' + a.tenure_id) || [] : [],
  })) }));
  const draftItems = d.saved && d.saved.items && d.saved.items.length ? decorate(d.saved.items) : null;
  return {
    invoice: d.invoice,
    community: d.community ? { id: d.community.id, name: d.community.name } : null,
    lines: d.lines,
    read_only: d.readOnly,
    schema_ready: d.schemaReady,
    suggestion: { items: decorate(suggestion.items), reconciliation: suggestion.reconciliation },
    draft: draftItems ? { items: draftItems, reconciliation: S.reconcile(d.invoice.total_cents, draftItems) } : null,
    revision: d.saved && d.saved.review ? d.saved.review.revision : 0,
    review: d.saved ? d.saved.review : null,
    events: d.saved ? d.saved.events || [] : [],
  };
}

// ---- draft validation (pure over a loaded invoice) --------------------------------
// body: { base_revision, items:[{ source_line_ids, matter_ref, service_date,
//         allocations:[{ amount_cents, classification, property_id, charge_category, note }] }] }
// service_date is a staff-entered point date (optional). Without one, the
// server derives the basis from the item's own line text, then the invoice's
// service period (kept as a range), exactly as the suggestions do.
// Returns { errors:[...] } or { items } ready for legal_review_save_draft().
function buildDraft(d, body) {
  const errors = [];
  const err = (m) => { if (errors.length < 50) errors.push(m); };
  if (!body || !Array.isArray(body.items)) return { errors: ['items must be a list'] };
  if (!body.items.length) return { errors: ['a draft needs at least one item'] };
  if (body.items.length > 500) return { errors: ['too many items (max 500)'] };
  const ix = S.buildIndex(d.ctx);
  const lineById = new Map(d.lines.map((l) => [l.id, l]));
  const used = new Map();
  const items = body.items.map((raw, i) => {
    const n = i + 1;
    const ids = Array.isArray(raw && raw.source_line_ids) ? raw.source_line_ids.map(String) : [];
    if (!ids.length) err(`item ${n}: pick at least one invoice line`);
    for (const id of ids) {
      if (!lineById.has(id)) err(`item ${n}: a line is not on this invoice`);
      else if (used.has(id)) err(`item ${n}: line ${lineById.get(id).line_number} is already in item ${used.get(id)}`);
      else used.set(id, n);
    }
    const lines = ids.map((id) => lineById.get(id)).filter(Boolean);
    const amount = lines.reduce((s, l) => s + l.amount_cents, 0);
    if (lines.length && amount === 0) err(`item ${n}: its lines total zero`);
    const text = lines.map((l) => String(l.description || '').replace(/\s+/g, ' ').trim()).join(' | ').slice(0, 2000);
    let staffDate = raw && raw.service_date ? String(raw.service_date) : null;
    if (staffDate && (!DATE.test(staffDate) || Number.isNaN(Date.parse(staffDate + 'T12:00:00Z')))) { err(`item ${n}: service date is not a date`); staffDate = null; }
    const derived = S.serviceBasis(d.invoice, text);
    const basis = staffDate && staffDate !== derived.date ? { date: staffDate, start: null, end: null, source: 'staff' } : derived;
    const matterRef = raw && raw.matter_ref ? String(raw.matter_ref).trim().slice(0, 200) || null : null;

    // What the text itself says (server-side, never the browser's copy).
    const ev = S.extractEvidence(text);
    const cls = S.classifyText(text);
    const textMatch = S.matchProperty(ix, ev);
    const allocsIn = Array.isArray(raw && raw.allocations) ? raw.allocations : [];
    if (!allocsIn.length) err(`item ${n}: needs at least one allocation`);
    if (allocsIn.length > 50) err(`item ${n}: too many allocations (max 50)`);
    const allocations = allocsIn.slice(0, 50).map((a, j) => {
      const tag = `item ${n}, allocation ${j + 1}`;
      const cents = Number(a && a.amount_cents);
      if (!Number.isInteger(cents) || cents === 0) err(`${tag}: amount must be a non-zero whole number of cents`);
      const classification = a && a.classification;
      if (!CLASSIFICATIONS.includes(classification)) err(`${tag}: unknown classification`);
      let pid = a && a.property_id ? String(a.property_id) : null;
      if (pid && (!UUID.test(pid) || !ix.props[pid])) { err(`${tag}: that property is not in this community`); pid = null; }
      if (classification === 'homeowner_recoverable' && !pid) err(`${tag}: a homeowner-recoverable charge needs a property`);
      let category = a && a.charge_category ? String(a.charge_category) : null;
      if (category && !CATEGORIES.includes(category)) { err(`${tag}: unknown charge category`); category = null; }
      if (category && classification !== 'homeowner_recoverable') category = null;   // only a recoverable charge carries one
      const note = a && a.note ? String(a.note).trim().slice(0, 1000) || null : null;

      let out;
      if (pid) {
        const staffPicked = pid !== textMatch.property_id || !!textMatch.conflict;
        const match = staffPicked
          ? { property_id: pid, via: {}, evidence: [{ kind: 'staff_selected', value: 'property chosen by staff' }].concat(textMatch.property_id && textMatch.property_id !== pid ? [{ kind: 'staff_override', value: 'the line text points at a different property' }] : []) }
          : textMatch;
        out = S.assess(ix, match, ev, cls, basis, d.invoice.invoice_date);
        if (staffPicked) out.confidence = 'none';
      } else {
        out = { property_id: null, tenure_id: null, tenure_match: 'not_applicable', confidence: 'none', bankruptcy_stop: !!cls.bankruptcy,
          evidence: cls.bankruptcy ? [{ kind: 'bankruptcy', value: 'the line text mentions bankruptcy' }] : [] };
      }
      const suggested = !!pid && pid === textMatch.property_id && !textMatch.conflict;
      return {
        amount_cents: cents, classification, property_id: pid, tenure_id: out.tenure_id || null,
        charge_category: category, tenure_match: out.tenure_match, confidence: out.confidence,
        bankruptcy_stop: !!out.bankruptcy_stop, evidence: out.evidence, suggested, note,
      };
    });
    return { source_line_ids: ids, source_text: text, matter_ref: matterRef, amount_cents: amount, service_date: basis.date,
      service_period_start: basis.start, service_period_end: basis.end, service_date_source: basis.source,
      service_basis: S.describeBasis(basis), allocations };
  });
  // Every invoice line with an amount belongs to exactly one item.
  const missing = d.lines.filter((l) => l.amount_cents !== 0 && !used.has(l.id));
  if (missing.length) err(`${missing.length === 1 ? 'line' : 'lines'} ${missing.map((l) => l.line_number).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in any item`);
  if (errors.length) return { errors };
  return { items, reconciliation: S.reconcile(d.invoice.total_cents, items) };
}

module.exports = { LEGAL_VENDOR_IDS, readOnlyReason, legalVendors, reviewTablesReady, listInvoices, loadInvoice, loadContext, detailPayload, buildDraft };
