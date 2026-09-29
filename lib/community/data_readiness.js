// ============================================================================
// lib/community/data_readiness.js — what came over, what reconciles, what's
// missing, per community (Issue #6, Communities + Data Readiness)
// ----------------------------------------------------------------------------
// Two layers:
//   fetchFacts(supabase, community)  bounded, read-only queries. Every read
//                                    returns { ok, value } or { ok:false,
//                                    error } — a failed read is NEVER turned
//                                    into zero rows.
//   evaluate(community, facts, now)  PURE status rules (tests/test_data_
//                                    readiness.js). One row per data area.
//
// Rules (Ed 2026-09-29, source map on Issue #6):
// - Never invent readiness. "ready" only where a stored control proves it
//   (posted ledger conversion with no open exceptions, exact AR tie, budget
//   loaded, bank recs at $0, active insurance). Presence without a source total
//   to compare is "imported · not verified", never green; that includes a
//   complete, indexed resale document set (no Vantaca document manifest).
// - A read that fails is "error", not "not imported".
// - Lifecycle decides "not applicable": a terminating/terminated community is
//   not being imported at all (Eaglewood, Ed: "they are leaving us ... we won't
//   be importing them"; its existing violations/ACC records stay as they are),
//   a prospect hasn't started, financials_active=false or books_of_record other
//   than 'trusted' takes the financial areas out, enforcement_active=false takes
//   violations out.
// - Owner ledger conversion and GL are SEPARATE rows: a GL cutover date is not
//   a ledger conversion (Quail Ridge has one without the other).
// ============================================================================
const { fetchAll } = require('../db/fetch_all');
const { arControl } = require('../ar/ar_control');

const S = {
  NA: 'not_applicable',
  NOT_IMPORTED: 'not_imported',
  IN_PROGRESS: 'in_progress',
  PARTIAL: 'partial',
  NOT_VERIFIED: 'imported_not_verified',
  NOT_RECONCILED: 'imported_not_reconciled',
  READY: 'ready',
  ERROR: 'error',
};
// Worst first: drives sorting and the portfolio summary.
const SEVERITY = [S.ERROR, S.PARTIAL, S.NOT_RECONCILED, S.IN_PROGRESS, S.NOT_IMPORTED, S.NOT_VERIFIED, S.READY, S.NA];
const NEEDS_ACTION = new Set([S.ERROR, S.PARTIAL, S.NOT_RECONCILED, S.IN_PROGRESS, S.NOT_IMPORTED]);

const LINKS = {
  profile: '/#tab=community',
  properties: '/#tab=community',
  accounting: '/admin/accounting',
  ownerar: '/#tab=ownerar',
  imports: '/#tab=vantaca-imports',
  violations: '/#tab=inspect',
  vendors: '/#tab=vendors',
  docs: '/#tab=docs',
  board: '/#tab=roster',
};

// accounting.html opens a specific community + view from ?community_id=&view=.
const acct = (c, view) => `/admin/accounting?community_id=${encodeURIComponent(c.id)}&view=${view}`;

const PROFILE_FIELDS = [
  ['legal_name', 'Legal name'], ['ein', 'EIN'], ['county', 'County'],
  ['vantaca_code', 'Vantaca code'], ['total_lots', 'Lot count'],
];
const FINANCIAL = new Set(['ledger', 'ar', 'gl', 'budget', 'bank']);

function chicagoToday(now) {
  return new Date(now || Date.now()).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}
function money(cents) {
  const n = Number(cents || 0) / 100;
  const s = Math.abs(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  return n < 0 ? `(${s})` : s;
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
const readErr = (key, title, source, f, href) => ({ key, title, status: S.ERROR, summary: `Couldn’t read ${source}.`, source, missing: [], next: 'Refresh. If it keeps failing, the read itself needs fixing; nothing here is assumed.', href, error: f && f.error });

// ---------------------------------------------------------------------------
// Lifecycle → why an area is not applicable (or null when it applies).
// ---------------------------------------------------------------------------
function notApplicableReason(c, key) {
  const ms = c.management_status;
  if (ms === 'terminating' || ms === 'terminated') {
    return `Leaving Bedrock${c.management_end_date ? ` (last day ${c.management_end_date})` : ''}: not being imported. Existing records stay as they are.`;
  }
  if (ms === 'prospect') return 'Prospect: nothing is imported until onboarding starts.';
  if (FINANCIAL.has(key)) {
    if (c.financials_active === false) return 'We don’t keep the books for this community (financials off).';
    if (c.books_of_record && c.books_of_record !== 'trusted') return `Books of record are in ${c.books_of_record === 'vantaca' ? 'Vantaca' : c.books_of_record}, not trustEd.`;
  }
  if (key === 'violations' && c.enforcement_active === false) return 'Enforcement isn’t a Bedrock service here.';
  return null;
}

// ---------------------------------------------------------------------------
// Area rules (pure)
// ---------------------------------------------------------------------------
const AREAS = [
  ['profile', 'Community profile'],
  ['properties', 'Properties and owners'],
  ['ledger', 'Owner ledger conversion'],
  ['ar', 'Receivables vs GL'],
  ['gl', 'General ledger'],
  ['budget', 'Budget'],
  ['bank', 'Bank reconciliation'],
  ['violations', 'Violations history'],
  ['vendors', 'Vendors'],
  ['documents', 'Documents'],
  ['board', 'Board and contacts'],
  ['insurance', 'Insurance'],
];

const RULES = {
  profile(c) {
    const missing = PROFILE_FIELDS.filter(([k]) => c[k] == null || String(c[k]).trim() === '').map(([, label]) => label);
    return missing.length
      ? { status: S.PARTIAL, summary: `${plural(missing.length, 'field')} missing.`, missing, next: 'Fill them in on the community profile.', source: 'communities table', href: LINKS.profile }
      : { status: S.READY, summary: 'Legal name, EIN, county, Vantaca code and lot count are on file.', missing: [], next: null, source: 'communities table', href: LINKS.profile };
  },

  properties(c, f) {
    if (!f.propertyCount.ok) return readErr('properties', 'Properties and owners', 'properties', f.propertyCount, LINKS.properties);
    if (!f.ownedProperties.ok) return readErr('properties', 'Properties and owners', 'current owners', f.ownedProperties, LINKS.properties);
    const n = f.propertyCount.value, owned = f.ownedProperties.value;
    const src = 'properties + v_current_property_owners';
    if (!n) return { status: S.NOT_IMPORTED, summary: 'No properties on file.', missing: ['Property roster'], next: 'Import the property and owner roster.', source: src, href: LINKS.properties };
    const noOwner = Math.max(0, n - owned);
    if (noOwner) return { status: S.PARTIAL, summary: `${plural(n, 'property', 'properties')}; ${noOwner} without a current owner.`, missing: [`${noOwner} without a current owner`], next: 'Resolve the properties with no current owner.', source: src, href: LINKS.properties };
    const lots = c.total_lots == null ? null : Number(c.total_lots);
    if (lots != null && lots > 0 && lots === n) return { status: S.READY, summary: `${plural(n, 'property', 'properties')}, all with a current owner; matches the lot count.`, missing: [], next: null, source: src, href: LINKS.properties };
    if (lots != null && lots > 0 && lots !== n) return { status: S.PARTIAL, summary: `${plural(n, 'property', 'properties')} on file, but the lot count is ${lots}.`, missing: [`${Math.abs(lots - n)} ${lots > n ? 'missing' : 'more than the lot count'}`], next: 'Check the roster against the lot count.', source: src, href: LINKS.properties };
    return { status: S.NOT_VERIFIED, summary: `${plural(n, 'property', 'properties')}, all with a current owner.`, missing: ['Lot count not on file, so completeness can’t be checked'], next: 'Add the lot count to the profile.', source: src, href: LINKS.properties };
  },

  ledger(c, f) {
    if (!f.conversion.ok) return readErr('ledger', 'Owner ledger conversion', 'conversion batches', f.conversion, LINKS.accounting);
    const { batches, latestRun, openExceptions } = f.conversion.value;
    const src = 'conversion_batches / conversion_runs / conversion_exceptions';
    const posted = batches.find((b) => b.status === 'posted');
    if (posted) {
      // Posted with unresolved exceptions still needs Ed: action-bearing
      // (partial), never a quiet "ready" (ChatGPT review of 22f2b6f0).
      if (openExceptions) return { status: S.PARTIAL, summary: `Posted: ${posted.batch_code}, as of ${posted.as_of_date}; ${plural(openExceptions, 'conversion exception')} still open.`, missing: [`${plural(openExceptions, 'open conversion exception')} (decided by Ed)`], next: 'Decide the open conversion exceptions.', source: src, href: null };
      return { status: S.READY, summary: `Posted: ${posted.batch_code}, as of ${posted.as_of_date}; no open exceptions.`, missing: [], next: null, source: src, href: null };
    }
    const active = batches.find((b) => ['draft', 'staged', 'validated', 'approved'].includes(b.status));
    if (active) {
      const failing = latestRun && latestRun.all_pass === false;
      return { status: failing ? S.NOT_RECONCILED : S.IN_PROGRESS, summary: `${active.batch_code || 'Conversion'} is ${active.status}${failing ? '; the latest control run did not pass' : ''}.`, missing: openExceptions ? [plural(openExceptions, 'open exception')] : [], next: failing ? 'Clear the failing controls, then approve and post.' : 'Finish the conversion and post it.', source: src, href: null };
    }
    if (batches.some((b) => b.status === 'voided')) return { status: S.ERROR, summary: 'The only conversion batch was voided.', missing: ['A posted conversion'], next: 'Redo the conversion.', source: src, href: null };
    return { status: S.NOT_IMPORTED, summary: 'No ledger conversion yet.', missing: ['Owner ledger conversion'], next: 'Stage and post the owner ledger conversion.', source: src, href: null };
  },

  ar(c, f) {
    if (!f.ar.ok) return readErr('ar', 'Receivables vs GL', 'owner ledger and GL', f.ar, LINKS.ownerar);
    const a = f.ar.value;
    const src = 'lib/ar/ar_control.js (v_homeowner_current_balance vs GL 1300 + 2400)';
    const latest = f.arLatestImport.ok && f.arLatestImport.value ? ` Latest owner-ledger import as of ${f.arLatestImport.value}.` : '';
    if (!a.accounts) return { status: S.NOT_IMPORTED, summary: 'No owner ledger imported.' + latest, missing: ['Owner transaction history'], next: 'Import the owner transaction history.', source: src, href: acct(c, 'ar') };
    if (!a.conversion || !a.conversion.ready) {
      // Never validate an unconverted community: the comparison isn't run.
      return { status: S.NOT_RECONCILED, summary: `${money(a.subledger_cents)} owed by owners. Compared with the GL once the ledger conversion is posted.` + latest, missing: ['Posted ledger conversion'], next: 'Post the owner ledger conversion first.', source: src, href: acct(c, 'ar') };
    }
    if (a.ties) return { status: S.READY, summary: `${money(a.subledger_cents)} ties to GL 1300 + 2400 · difference $0.00.` + latest, missing: [], next: null, source: src, href: acct(c, 'ar') };
    return { status: S.ERROR, summary: `${money(a.subledger_cents)} vs GL ${money(a.gl_1300_2400_net_cents)} · difference ${money(a.diff_cents)}.` + latest, missing: ['Tie-out difference'], next: 'Find the difference between the owner ledger and GL 1300 + 2400.', source: src, href: acct(c, 'ar') };
  },

  gl(c, f) {
    if (!f.gl.ok) return readErr('gl', 'General ledger', 'chart of accounts / journal entries', f.gl, LINKS.accounting);
    const { coa, je, debits, credits } = f.gl.value;
    const src = 'chart_of_accounts, journal_entries, v_trial_balance';
    if (!coa || !je) return { status: S.NOT_IMPORTED, summary: coa ? 'Chart of accounts is set up; no journal entries yet.' : 'No chart of accounts yet.', missing: [coa ? 'Journal entries / opening balances' : 'Chart of accounts'], next: 'Migrate the GL from Vantaca.', source: src, href: acct(c, 'trial') };
    if (debits !== credits) return { status: S.ERROR, summary: `Trial balance is out by ${money(debits - credits)}.`, missing: ['A balanced trial balance'], next: 'Find the unbalanced entries.', source: src, href: acct(c, 'trial') };
    if (!c.gl_cutover_date) return { status: S.PARTIAL, summary: `${plural(je, 'journal entry', 'journal entries')}; trial balance balances; no GL cutover date set.`, missing: ['GL cutover date'], next: 'Set the cutover date once trustEd is the book of record.', source: src, href: acct(c, 'trial') };
    return { status: S.NOT_VERIFIED, summary: `Cut over ${c.gl_cutover_date}; ${plural(je, 'journal entry', 'journal entries')}; trial balance balances.`, missing: ['The tie-out to Vantaca’s ending balances isn’t stored'], next: null, source: src, href: acct(c, 'trial') };
  },

  budget(c, f, now) {
    if (!f.budget.ok) return readErr('budget', 'Budget', 'community budgets', f.budget, LINKS.accounting);
    const fy = Number(chicagoToday(now).slice(0, 4));
    const b = f.budget.value;
    const src = 'community_budgets + budget_line_items';
    if (!b) return { status: S.NOT_IMPORTED, summary: `No ${fy} budget.`, missing: [`${fy} budget`], next: 'Load the budget.', source: src, href: acct(c, 'budget') };
    if (!b.lines) return { status: S.PARTIAL, summary: `${fy} budget exists with no lines.`, missing: ['Budget lines'], next: 'Load the budget lines.', source: src, href: acct(c, 'budget') };
    if (b.status === 'draft') return { status: S.IN_PROGRESS, summary: `${fy} budget is a draft (${plural(b.lines, 'line')}).`, missing: ['Board approval recorded'], next: 'Approve the budget.', source: src, href: acct(c, 'budget') };
    return { status: S.READY, summary: `${fy} budget ${b.status} (${plural(b.lines, 'line')}).`, missing: [], next: null, source: src, href: acct(c, 'budget') };
  },

  bank(c, f) {
    if (!f.bank.ok) return readErr('bank', 'Bank reconciliation', 'bank accounts / reconciliations', f.bank, LINKS.accounting);
    const { accounts } = f.bank.value;
    const src = 'bank_accounts + latest bank_reconciliations';
    if (!accounts.length) return { status: S.NOT_IMPORTED, summary: 'No bank accounts set up.', missing: ['Bank accounts'], next: 'Set up the bank accounts.', source: src, href: acct(c, 'bankrec') };
    const unbalanced = accounts.filter((a) => a.latest && (a.latest.status === 'unbalanced' || (a.latest.status === 'reconciled' && Number(a.latest.difference_cents || 0) !== 0)));
    if (unbalanced.length) return { status: S.ERROR, summary: `${plural(unbalanced.length, 'account')} not balancing.`, missing: unbalanced.map((a) => `${a.name}: off ${money(a.latest.difference_cents)} (${a.latest.period_end})`), next: 'Resolve the reconciliation differences.', source: src, href: acct(c, 'bankrec') };
    const unrec = accounts.filter((a) => !a.latest || a.latest.status !== 'reconciled');
    if (unrec.length) return { status: S.PARTIAL, summary: `${plural(accounts.length - unrec.length, 'account')} of ${accounts.length} reconciled.`, missing: unrec.map((a) => `${a.name}: ${a.latest ? `${a.latest.status.replace(/_/g, ' ')} (latest ${a.latest.period_end})` : 'no reconciliation'}`), next: 'Reconcile the remaining accounts.', source: src, href: acct(c, 'bankrec') };
    const through = accounts.map((a) => a.latest.period_end).sort()[0];
    return { status: S.READY, summary: `All ${plural(accounts.length, 'account')} reconciled at $0.00 difference, through ${through}.`, missing: [], next: null, source: src, href: acct(c, 'bankrec') };
  },

  violations(c, f) {
    if (!f.violations.ok) return readErr('violations', 'Violations history', 'violations', f.violations, LINKS.violations);
    const { total, vantaca } = f.violations.value;
    const src = "violations (source = 'vantaca_import')";
    if (!vantaca) return { status: S.NOT_IMPORTED, summary: total ? `${plural(total, 'violation')} recorded in trustEd; no Vantaca history imported.` : 'No violation history.', missing: ['Vantaca violation history'], next: 'Import the Vantaca violations export.', source: src, href: LINKS.violations };
    return { status: S.NOT_VERIFIED, summary: `${plural(vantaca, 'violation')} imported from Vantaca; ${total} in total.`, missing: ['Vantaca imports keep no batch record, so completeness can’t be checked'], next: null, source: src, href: LINKS.violations };
  },

  vendors(c, f) {
    if (!f.vendors.ok) return readErr('vendors', 'Vendors', 'vendor accounts', f.vendors, LINKS.vendors);
    const n = f.vendors.value;
    const src = 'vendor_community_accounts';
    if (!n) return { status: S.NOT_IMPORTED, summary: 'No vendors linked to this community.', missing: ['Vendor list'], next: 'Link the community’s vendors.', source: src, href: LINKS.vendors };
    return { status: S.NOT_VERIFIED, summary: `${plural(n, 'vendor account')} linked.`, missing: ['No Vantaca vendor list to compare against'], next: null, source: src, href: LINKS.vendors };
  },

  documents(c, f) {
    if (!f.documents.ok) return readErr('documents', 'Documents', 'library documents', f.documents, LINKS.docs);
    const { current, required, failedIndex, pendingIndex } = f.documents.value;
    const src = 'library_documents + document_categories.required_for_resale';
    if (!current.length) return { status: S.NOT_IMPORTED, summary: 'No documents on file.', missing: ['Governing documents'], next: 'Upload the governing documents.', source: src, href: LINKS.docs };
    const have = new Set(current.map((d) => d.category));
    const missingCats = required.filter((r) => !have.has(r.category)).map((r) => r.display_name || r.category);
    if (failedIndex) return { status: S.ERROR, summary: `${plural(failedIndex, 'document')} failed to index.`, missing: missingCats, next: 'Re-run indexing for the failed documents.', source: src, href: LINKS.docs };
    if (missingCats.length || pendingIndex) return { status: S.PARTIAL, summary: `${plural(current.length, 'current document')}${missingCats.length ? `; ${plural(missingCats.length, 'required category', 'required categories')} missing` : ''}${pendingIndex ? `; ${pendingIndex} waiting to index` : ''}.`, missing: missingCats, next: missingCats.length ? 'Upload the missing required documents.' : 'Let indexing finish.', source: src, href: LINKS.docs };
    // Required resale set present + indexed = usable, but that is not proof the
    // Vantaca document history came over. Without a source manifest this stays
    // "not verified", never green (ChatGPT review of 22f2b6f0).
    return { status: S.NOT_VERIFIED, summary: `${plural(current.length, 'current document')}; every required resale category present and indexed.`, missing: ['No Vantaca document list to compare against'], next: null, source: src, href: LINKS.docs };
  },

  board(c, f) {
    if (!f.board.ok) return readErr('board', 'Board and contacts', 'board members / contacts', f.board, LINKS.board);
    const { members, contacts } = f.board.value;
    const src = 'board_members (active) + community_contacts';
    if (!members) return { status: S.NOT_IMPORTED, summary: `No active board members on file${contacts ? `; ${plural(contacts, 'community contact')}` : ''}.`, missing: ['Board roster'], next: 'Add the board roster.', source: src, href: LINKS.board };
    return { status: S.NOT_VERIFIED, summary: `${plural(members, 'active board member')}; ${plural(contacts, 'community contact')}.`, missing: ['Nothing to check the roster against'], next: null, source: src, href: LINKS.board };
  },

  insurance(c, f, now) {
    if (!f.insurance.ok) return readErr('insurance', 'Insurance', 'insurance policies', f.insurance, LINKS.profile);
    const policies = f.insurance.value;
    const src = 'insurance_policies';
    if (!policies.length) return { status: S.NOT_IMPORTED, summary: 'No insurance policies on file.', missing: ['Current policies'], next: 'Upload the insurance declarations.', source: src, href: LINKS.profile };
    const today = chicagoToday(now);
    const active = policies.filter((p) => !p.expiration_date || p.expiration_date >= today);
    if (!active.length) return { status: S.ERROR, summary: `All ${plural(policies.length, 'policy', 'policies')} on file have expired.`, missing: ['A current policy'], next: 'Upload the renewal.', source: src, href: LINKS.profile };
    const soonest = active.map((p) => p.expiration_date).filter(Boolean).sort()[0];
    return { status: S.READY, summary: `${plural(active.length, 'current policy', 'current policies')}${soonest ? `; next expiry ${soonest}` : ''}.`, missing: [], next: null, source: src, href: LINKS.profile };
  },
};

function evaluate(community, facts, now) {
  const areas = AREAS.map(([key, title]) => {
    const na = notApplicableReason(community, key);
    if (na) return { key, title, status: S.NA, summary: na, missing: [], next: null, source: 'communities lifecycle', href: null };
    try {
      return Object.assign({ key, title }, RULES[key](community, facts, now));
    } catch (e) {
      return { key, title, status: S.ERROR, summary: 'Couldn’t evaluate this area.', missing: [], next: 'Refresh.', source: null, href: null, error: e.message };
    }
  });
  const counts = {};
  for (const s of Object.values(S)) counts[s] = 0;
  for (const a of areas) counts[a.status] += 1;
  return {
    community: { id: community.id, name: community.name, management_status: community.management_status, management_end_date: community.management_end_date || null },
    areas,
    counts,
    needs_action: areas.filter((a) => NEEDS_ACTION.has(a.status)).length,
    worst: SEVERITY.find((s) => counts[s] > 0) || S.NA,
  };
}

// ---------------------------------------------------------------------------
// Reads (bounded; each returns { ok, value } | { ok:false, error })
// ---------------------------------------------------------------------------
async function attempt(fn) {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}
async function headCount(q) {
  const { count, error } = await q;
  if (error) throw error;
  return count || 0;
}

async function fetchFacts(supabase, c, now) {
  const id = c.id;
  const fy = Number(chicagoToday(now).slice(0, 4));
  const [propertyCount, ownedProperties, conversion, ar, arLatestImport, gl, budget, bank, violations, vendors, documents, board, insurance] = await Promise.all([
    attempt(() => headCount(supabase.from('properties').select('id', { count: 'exact', head: true }).eq('community_id', id))),
    attempt(async () => {
      const rows = await fetchAll(supabase, 'v_current_property_owners', { select: 'property_id, owner_contact_id', filters: { community_id: id }, orderBy: 'property_id' });
      return new Set(rows.filter((r) => r.owner_contact_id).map((r) => r.property_id)).size;
    }),
    attempt(async () => {
      const { data: batches, error } = await supabase.from('conversion_batches').select('id, batch_code, as_of_date, status, created_at').eq('community_id', id).order('created_at', { ascending: false }).limit(50);
      if (error) throw error;
      const current = (batches || []).find((b) => b.status === 'posted') || (batches || []).find((b) => b.status !== 'voided') || null;
      let latestRun = null, openExceptions = 0;
      if (current) {
        const r = await supabase.from('conversion_runs').select('all_pass, run_at').eq('batch_id', current.id).order('run_at', { ascending: false }).limit(1);
        if (r.error) throw r.error;
        latestRun = (r.data || [])[0] || null;
        openExceptions = await headCount(supabase.from('conversion_exceptions').select('id', { count: 'exact', head: true }).eq('batch_id', current.id).eq('status', 'open'));
      }
      return { batches: batches || [], latestRun, openExceptions };
    }),
    attempt(() => arControl(supabase, id)),
    attempt(async () => {
      const { data, error } = await supabase.from('transaction_upload_batches').select('as_of_date').eq('community_id', id).eq('status', 'committed').order('as_of_date', { ascending: false }).limit(1);
      if (error) throw error;
      return (data || [])[0] ? data[0].as_of_date : null;
    }),
    attempt(async () => {
      const coa = await headCount(supabase.from('chart_of_accounts').select('id', { count: 'exact', head: true }).eq('community_id', id));
      const je = await headCount(supabase.from('journal_entries').select('id', { count: 'exact', head: true }).eq('community_id', id));
      const tb = await fetchAll(supabase, 'v_trial_balance', { select: 'account_number, total_debits_cents, total_credits_cents', filters: { community_id: id }, orderBy: 'account_number' });
      return { coa, je, debits: tb.reduce((s, r) => s + Number(r.total_debits_cents || 0), 0), credits: tb.reduce((s, r) => s + Number(r.total_credits_cents || 0), 0) };
    }),
    attempt(async () => {
      const { data, error } = await supabase.from('community_budgets').select('id, status').eq('community_id', id).eq('fiscal_year', fy).order('created_at', { ascending: false }).limit(1);
      if (error) throw error;
      const b = (data || [])[0];
      if (!b) return null;
      const lines = await headCount(supabase.from('budget_line_items').select('id', { count: 'exact', head: true }).eq('budget_id', b.id));
      return { status: b.status, lines };
    }),
    attempt(async () => {
      const { data: accts, error } = await supabase.from('bank_accounts').select('id, account_nickname, bank_name, account_last4').eq('community_id', id).eq('is_active', true).order('account_nickname').limit(100);
      if (error) throw error;
      // Latest rec PER active account (one bounded read each), so long history
      // on one account can never push another account's latest row out of a cap.
      const latest = await Promise.all((accts || []).map(async (a) => {
        const r = await supabase.from('bank_reconciliations').select('bank_account_id, period_end, status, difference_cents')
          .eq('community_id', id).eq('bank_account_id', a.id).order('period_end', { ascending: false }).limit(1);
        if (r.error) throw r.error;
        return (r.data || [])[0] || null;
      }));
      return { accounts: (accts || []).map((a, i) => ({ id: a.id, name: a.account_nickname || [a.bank_name, a.account_last4 && '…' + a.account_last4].filter(Boolean).join(' ') || 'Account', latest: latest[i] })) };
    }),
    attempt(async () => ({
      total: await headCount(supabase.from('violations').select('id', { count: 'exact', head: true }).eq('community_id', id)),
      vantaca: await headCount(supabase.from('violations').select('id', { count: 'exact', head: true }).eq('community_id', id).eq('source', 'vantaca_import')),
    })),
    attempt(() => headCount(supabase.from('vendor_community_accounts').select('id', { count: 'exact', head: true }).eq('community_id', id))),
    attempt(async () => {
      const current = await fetchAll(supabase, 'library_documents', { select: 'id, category, index_status', filters: { community_id: id, status: 'current' } });
      const { data: required, error } = await supabase.from('document_categories').select('category, display_name').eq('required_for_resale', true).order('sort_order').limit(200);
      if (error) throw error;
      return {
        current,
        required: required || [],
        failedIndex: current.filter((d) => d.index_status === 'failed' || d.index_status === 'failed_permanent').length,
        pendingIndex: current.filter((d) => d.index_status === 'pending').length,
      };
    }),
    attempt(async () => ({
      members: await headCount(supabase.from('board_members').select('id', { count: 'exact', head: true }).eq('community_id', id).eq('is_active', true)),
      contacts: await headCount(supabase.from('community_contacts').select('id', { count: 'exact', head: true }).eq('community_id', id)),
    })),
    attempt(async () => {
      const { data, error } = await supabase.from('insurance_policies').select('id, coverage_line, expiration_date').eq('community_id', id).order('expiration_date', { ascending: false }).limit(200);
      if (error) throw error;
      return data || [];
    }),
  ]);
  return { propertyCount, ownedProperties, conversion, ar, arLatestImport, gl, budget, bank, violations, vendors, documents, board, insurance };
}

const COMMUNITY_SELECT = 'id, name, legal_name, ein, county, vantaca_code, total_lots, active, is_demo, management_company_id, management_status, management_end_date, financials_active, enforcement_active, books_of_record, gl_cutover_date';

async function communityReadiness(supabase, community, now) {
  return evaluate(community, await fetchFacts(supabase, community, now), now);
}

module.exports = { S, SEVERITY, NEEDS_ACTION, AREAS, LINKS, COMMUNITY_SELECT, evaluate, fetchFacts, communityReadiness, notApplicableReason };
