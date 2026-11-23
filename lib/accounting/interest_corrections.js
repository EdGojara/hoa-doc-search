// ============================================================================
// lib/accounting/interest_corrections.js  (Ed 2026-11-23)
// ----------------------------------------------------------------------------
// Corrections to interest ALREADY POSTED, through Kat's existing journal-entry queue.
// A payment, credit, reversal or assessment adjustment entered late but effective in a
// month already charged changes what that month should have been (lib/ar/monthly_interest
// reviewPostedInterest, principal only). Each owner and month that differs becomes one
// entry for the owner's in-app approval:
//   overcharged   Dr interest income / Cr homeowner AR, and a credit on the owner ledger
//   undercharged  Dr homeowner AR / Cr interest income, and a charge on the owner ledger
// The original charge is never edited, voided or deleted. The correction is a NEW row dated
// the day it is prepared and tagged with the month it corrects (raw_row_jsonb.corrects_month),
// so the month nets to the right amount and the next review finds nothing.
// Listed for a person, never prepared: a former owner, an account with an exception (legal,
// plan, bankruptcy, returned payment) that would be charged MORE, waived interest, and a
// month with no clear owner.
// ============================================================================
const I = require('../ar/monthly_interest');

const PREFIX = 'intcorr-';
const usd = (c) => `$${(Math.abs(Number(c)) / 100).toFixed(2)}`;
const isCorrection = (id) => String(id || '').startsWith(PREFIX);
const centralToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());

// PURE. review rows -> { items for Kat, held: [{ text }] }
function buildItems(review, { today, incomeAccount = '4030' }) {
  const items = []; const held = [];
  for (const r of review) {
    const what = `${r.address || r.property_id} ${r.month}: posted ${usd(r.posted_cents)}, recalculated ${usd(r.recalculated_cents)}`;
    const why = !r.tenure_id ? 'no clear owner for that month' : r.former_owner ? 'the owner charged has since sold' : r.waived ? 'interest was waived on this account'
      : r.correction_cents > 0 && r.exception ? `an additional charge on an account needing review (${r.flags.join(', ')})` : null;
    if (why) { held.push({ month: r.month, property_id: r.property_id, address: r.address, correction_cents: r.correction_cents, reason: why, text: `${what}; not prepared: ${why}.` }); continue; }
    const amt = Math.abs(r.correction_cents); const credit = r.correction_cents < 0;
    const memo = `Interest correction ${r.month} ${r.address || ''}`.trim();
    items.push({
      id: `${PREFIX}${r.tenure_id}-${r.month}-${r.prior_corrections + 1}`, posting_date: today,
      label: `Interest correction ${r.month} ${r.address || r.property_id}: ${credit ? 'credit' : 'charge'} ${usd(amt)}`,
      description: `Interest correction for ${r.month}: ${usd(r.posted_cents)} posted, ${usd(r.recalculated_cents)} due`,
      lines: credit ? [{ account_number: incomeAccount, debit_cents: amt, credit_cents: 0, memo }, { account_number: '1300', debit_cents: 0, credit_cents: amt, memo }]
        : [{ account_number: '1300', debit_cents: amt, credit_cents: 0, memo }, { account_number: incomeAccount, debit_cents: 0, credit_cents: amt, memo }],
      homeowner: { property_id: r.property_id, charge_category: 'interest', corrects_month: r.month, tenure_id: r.tenure_id },
      evidence: { basis: `Interest for ${r.month} posted at ${usd(r.posted_cents)}. Recalculated on unpaid assessment principal of ${usd(r.principal_cents)} at ${r.cutoff}: ${usd(r.recalculated_cents)}. ${r.causes.length ? `Entered since: ${r.causes.join('; ')}.` : 'The ledger as it stands no longer supports the posted amount.'} The original charge is unchanged.`,
        source: `homeowner ledger at ${today}` },
    });
  }
  return { items, held };
}

// What needs correcting now. null when this community has no configured interest policy.
async function currentItems(supabase, community_id, { today = centralToday() } = {}) {
  const { data: auto, error } = await supabase.from('community_accounting_automation').select('enabled, settings').eq('community_id', community_id).eq('process', 'interest').maybeSingle();
  if (error) throw new Error(`interest policy: ${error.message}`);
  if (!auto || !auto.enabled) return null;
  let settings; try { settings = I.requirePolicy(auto.settings); } catch (_) { return null; }
  const inp = await I.loadInputs(supabase, community_id);
  return buildItems(I.reviewPostedInterest({ ...inp, cutoverDate: inp.community.gl_cutover_date, settings }), { today, incomeAccount: settings.income_account_number || '4030' });
}

const sameItems = (a, b) => { const k = (xs) => xs.map((i) => `${i.id}|${JSON.stringify(i.lines.map((l) => [l.account_number, l.debit_cents, l.credit_cents]))}`).sort().join('\n'); return k(a) === k(b); };

// Prepare, refresh or withdraw Kat's one open correction run for this community. Never posts.
async function prepareCorrections(supabase, { community_id, reason = 'the ledger changed', today = centralToday() }) {
  const now = await currentItems(supabase, community_id, { today });
  if (!now) return { skipped: 'no interest policy configured' };
  const M = require('./monthly_runs');
  const { data: open, error } = await supabase.from('accounting_runs').select('id, status, preview').eq('community_id', community_id).eq('process', 'journal_entry').in('status', ['prepared', 'held', 'failed']).order('created_at', { ascending: false }).limit(200);
  if (error) throw new Error(`open runs: ${error.message}`);
  const mine = (open || []).filter((r) => { const s = (r.preview && r.preview.submitted) || []; return s.length && s.every((i) => isCorrection(i.id)); });
  // Dated in an earlier month (which may close): prepared again with today's date.
  const cur = mine.find((r) => r.status === 'prepared' && sameItems(r.preview.submitted, now.items) && r.preview.submitted.every((i) => String(i.posting_date).slice(0, 7) === today.slice(0, 7)));
  if (cur && now.items.length) return { existing: true, run: cur, run_id: cur.id, items: now.items.length, held: now.held };
  for (const r of mine) await M.supersede(supabase, { run_id: r.id, actor: M.KAT, reason: `Interest corrections recalculated: ${reason}.` });
  if (!now.items.length) return { run: null, items: 0, held: now.held, withdrawn: mine.length };
  const p = await M.prepare(supabase, { community_id, process: 'journal_entry', period_month: `${today.slice(0, 7)}-01`, actor: `${M.KAT} (interest corrections: ${reason})`, items: now.items });
  return { run: p.run, run_id: p.run && p.run.id, skipped: p.skipped, failed: p.failed, error: p.error, items: now.items.length, held: now.held };
}

// At approval: every included correction must still be exactly what the ledger calls for.
async function assertCurrent(supabase, run, include) {
  const sub = ((run.preview && run.preview.submitted) || []).filter((i) => isCorrection(i.id) && include.includes(i.id));
  if (!sub.length) return;
  const now = await currentItems(supabase, run.community_id);
  const ok = new Map(((now && now.items) || []).map((i) => [i.id, i]));
  const bad = sub.filter((i) => { const n = ok.get(i.id); return !n || !sameItems([i], [n]) || n.homeowner.property_id !== i.homeowner.property_id; });
  if (bad.length) throw Object.assign(new Error(`the ledger changed since these interest corrections were prepared (${bad.slice(0, 5).map((i) => i.label).join('; ')}). Refresh the run, then approve it.`), { code: 'stale_preview' });
}

// After a posting that can carry backdated owner activity. A problem here never affects the posting.
async function afterPosting(supabase, { community_id, reason }) {
  try { return await prepareCorrections(supabase, { community_id, reason }); }
  catch (e) { console.error('[interest_corrections] review failed', JSON.stringify({ community_id, reason, error: e.message })); return { error: e.message }; }
}

module.exports = { buildItems, currentItems, prepareCorrections, assertCurrent, afterPosting, sameItems, isCorrection };
