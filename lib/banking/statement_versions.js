// ============================================================================
// lib/banking/statement_versions.js  (Ed 2026-11-21)
// ----------------------------------------------------------------------------
// Bank statements are evidence. A corrected statement SUPERSEDES the original;
// it never deletes it. The original import and every one of its transaction
// lines stay in place with status 'voided' (bank_statement_imports' existing
// CHECK list) and a note naming the statement that replaced it, so a
// reconciliation approved against it can still open the exact statement and
// lines it relied on.
//
// Order matters: the corrected statement is written as 'processing', then ALL its
// lines, then it is made 'completed', and only then is the original voided. Any
// failure before that leaves the original active and unchanged; the half-written
// correction is never active (marked failed, or left processing).
//
// "Active" = status 'completed' (not voided, not a failed upload). Every current calculation reads active only
// (ACTIVE below); a reconciliation's own
// bank_statement_import_id is read by id and stays reachable after it is voided.
// ============================================================================

const ACTIVE = (q) => q.eq('status', 'completed');

async function insertStatementVersion(supabase, { base, txRows, period_end, bank_account_id, actor = null }) {
  const must = async (q, what) => { const { data, error } = await q; if (error) throw Object.assign(new Error(`${what}: ${error.message}`), { code: 'statement_write_failed' }); return data; };

  // The active statement(s) this one would replace: same account, same statement end date.
  const priors = period_end
    ? await must(ACTIVE(supabase.from('bank_statement_imports').select('id, source_filename, extraction_warnings').eq('bank_account_id', bank_account_id).eq('statement_period_end', period_end)), 'prior statements')
    : [];

  // Written as 'processing' (not active): it becomes the active version only once every line is saved.
  const bsi = await must(supabase.from('bank_statement_imports').insert({ ...base, status: 'processing' }).select('*').single(), 'insert statement');
  const rows = (txRows || []).map((t) => ({ ...t, bank_statement_import_id: bsi.id }));
  if (rows.length) {
    const { error: txErr } = await supabase.from('bank_statement_transactions').insert(rows);
    if (txErr) {
      // The correction is incomplete: never let it become the active version.
      await supabase.from('bank_statement_imports').update({ status: 'failed', extraction_warnings: [...(base.extraction_warnings || []), `Transaction lines were not saved (${txErr.message}); the prior statement stays active.`] }).eq('id', bsi.id);
      console.error('[statement_versions] corrected statement lines failed; original kept', JSON.stringify({ bank_account_id, period_end, new_import: bsi.id, error: txErr.message }));
      throw Object.assign(new Error(`statement lines were not saved: ${txErr.message}`), { code: 'statement_write_failed', import_id: bsi.id });
    }
  }

  await must(supabase.from('bank_statement_imports').update({ status: 'completed' }).eq('id', bsi.id).select('id'), 'activate corrected statement');
  bsi.status = 'completed';

  const superseded = [];
  for (const p of priors) {
    const note = `Superseded ${new Date().toISOString().slice(0, 10)} by corrected statement ${bsi.id}${base.source_filename ? ` (${base.source_filename})` : ''}${actor ? `; uploaded by ${actor}` : ''}. Kept as evidence; its transaction lines are unchanged.`;
    await must(supabase.from('bank_statement_imports').update({ status: 'voided', extraction_warnings: [...(p.extraction_warnings || []), note] }).eq('id', p.id).select('id'), 'supersede prior statement');
    superseded.push(p.id);
  }
  return { bsi, transaction_count: rows.length, superseded };
}

module.exports = { insertStatementVersion, ACTIVE };
