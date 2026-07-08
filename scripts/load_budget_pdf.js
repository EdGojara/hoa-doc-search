#!/usr/bin/env node
// ===========================================================================
// load_budget_pdf.js  (Ed 2026-06-30)
// ---------------------------------------------------------------------------
// Load an approved annual budget PDF for a community: extract line items via
// Claude (document API — handles scanned/native PDFs), match to the community's
// chart of accounts by account number, and save into community_budgets +
// budget_line_items (the same tables the Budget-vs-Actual report + board packet
// read). Reports matched/unmatched + tie-out to the PDF's total.
//
//   node -r dotenv/config scripts/load_budget_pdf.js "<community substr>" "<pdf path>" <fiscal_year> [status]
//   status: active (default) | draft
// ===========================================================================

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const commQuery = process.argv[2];
const pdfPath = process.argv[3];
const fiscalYear = parseInt(process.argv[4], 10);
const status = process.argv[5] || 'active';

(async () => {
  if (!commQuery || !pdfPath || !fiscalYear) { console.error('usage: "<community>" "<pdf>" <year> [status]'); process.exit(1); }

  const { data: comm } = await sb.from('communities').select('id, name').ilike('name', `%${commQuery}%`).limit(1).maybeSingle();
  if (!comm) { console.error('community not found:', commQuery); process.exit(1); }
  console.log('community:', comm.name, comm.id);

  // 1) extract
  const b64 = fs.readFileSync(pdfPath).toString('base64');
  const r = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 8000,
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
      { type: 'text', text: 'This is an HOA annual budget. Return STRICT JSON only: {"line_items":[{"account_number":"<string>","account_name":"<string>","category":"revenue"|"expense","annual_amount":<number dollars>}],"total_revenue":<number>,"total_expense":<number>}. Include EVERY line item. Category=revenue for income/assessment/interest lines, expense otherwise. Output ONLY the JSON.' },
    ] }],
  });
  const raw = r.content.map((c) => c.text || '').join('').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const ex = JSON.parse(raw);
  const items = ex.line_items || [];
  console.log(`extracted ${items.length} lines | PDF totals: rev $${ex.total_revenue} / exp $${ex.total_expense}`);

  // 2) match to CoA
  const { data: coa } = await sb.from('chart_of_accounts').select('id, account_number, account_name, fund_id, vantaca_account_number, account_type').eq('community_id', comm.id).limit(2000);
  const byNum = {}, byVan = {};
  (coa || []).forEach((a) => { if (a.account_number) byNum[String(a.account_number)] = a; if (a.vantaca_account_number) byVan[String(a.vantaca_account_number)] = a; });

  const matched = [], unmatched = [];
  for (const li of items) {
    const a = byNum[String(li.account_number)] || byVan[String(li.account_number)] || null;
    if (a) matched.push({ account_id: a.id, fund_id: a.fund_id || null, annual_amount_cents: Math.round((Number(li.annual_amount) || 0) * 100), _num: li.account_number, _name: li.account_name });
    else unmatched.push(li);
  }
  console.log(`matched ${matched.length}, unmatched ${unmatched.length}`);
  if (unmatched.length) unmatched.forEach((u) => console.log('  ⚠ no match:', u.account_number, u.account_name, '$' + u.annual_amount));
  if (!matched.length) { console.error('nothing matched — aborting.'); process.exit(1); }

  // 3) upsert budget header + lines
  const { data: existing } = await sb.from('community_budgets').select('id').eq('community_id', comm.id).eq('fiscal_year', fiscalYear).maybeSingle();
  let budgetId;
  if (existing) {
    await sb.from('community_budgets').update({ status, source_filename: pdfPath.split(/[\\/]/).pop() }).eq('id', existing.id);
    await sb.from('budget_line_items').delete().eq('budget_id', existing.id);
    budgetId = existing.id;
    console.log('updated existing budget', budgetId);
  } else {
    const { data: ins, error } = await sb.from('community_budgets').insert({ community_id: comm.id, fiscal_year: fiscalYear, status, source_filename: pdfPath.split(/[\\/]/).pop() }).select('id').single();
    if (error) { console.error('header insert failed:', error.message); process.exit(1); }
    budgetId = ins.id;
    console.log('created budget', budgetId);
  }
  const rows = matched.map((m) => {
    const annual = m.annual_amount_cents; const each = Math.floor(annual / 12);
    const monthly = Array(12).fill(each); monthly[11] += annual - each * 12;
    return { budget_id: budgetId, account_id: m.account_id, fund_id: m.fund_id, annual_amount_cents: annual, monthly_amounts_cents: monthly };
  });
  const { error: lnErr } = await sb.from('budget_line_items').insert(rows);
  if (lnErr) { console.error('line insert failed:', lnErr.message); process.exit(1); }

  const rev = matched.filter((m) => Number(m.annual_amount_cents) > 0 && /^4/.test(String(m._num))).reduce((s, m) => s + m.annual_amount_cents, 0);
  const exp = matched.filter((m) => /^[56]/.test(String(m._num))).reduce((s, m) => s + m.annual_amount_cents, 0);
  console.log(`\nSaved FY${fiscalYear} budget (${status}): ${rows.length} lines`);
  console.log(`  loaded revenue $${(rev / 100).toFixed(2)} vs PDF $${ex.total_revenue}`);
  console.log(`  loaded expense $${(exp / 100).toFixed(2)} vs PDF $${ex.total_expense}`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
