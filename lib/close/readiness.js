// ============================================================================
// lib/close/readiness.js  (Ed 2026-10-12: Kat's close-readiness report)
// ----------------------------------------------------------------------------
// One concise report per community and month, built from the existing close
// record (the latest checklist run = Kat's cutoff review, its overrides and
// accepted warnings) plus Kat's accounting runs still open for the month. It
// shows outstanding exceptions, proposed adjustments and supporting evidence.
// Read-only: it closes nothing and posts nothing (lib/close/policy.js).
// ============================================================================
const { CLOSE_POLICY, isKatCutoffReview } = require('./policy');

const $ = (c) => {
  const n = Number(c || 0) / 100;
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `($${s})` : `$${s}`;
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const monthLabel = (iso) => new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const PROCESS = { interest: 'Delinquent interest', bank_reconciliation: 'Bank reconciliation', recognition: 'Revenue / expense recognition', cutoff_adjustment: 'Cutoff corrections' };

// PURE. st = lib/close/service.status(); openRuns = gatherCutoff().open_runs; accounts = { [bank_account_id]: label }.
function buildReadiness({ community, st, openRuns = [], accounts = {} }) {
  const p = st.period; const run = st.run; const results = st.results || [];
  const isClosed = ['closed', 'locked'].includes(p.status);
  const review = run ? isKatCutoffReview({ run_by: run.run_by }, results) : false;
  const exceptions = results.filter((r) => r.status !== 'PASS').map((r) => ({
    code: r.code, group: r.group, label: r.label, status: r.status,
    resolution: r.status === 'BLOCK' ? (r.override ? `Overridden by ${r.override.actor}: ${r.override.reason}` : 'Open: fix, or owner override with a reason')
      : (r.accepted ? 'Accepted' : 'Open: accept or resolve'),
    amount_cents: r.amount_cents, count: r.count, explanation: r.explanation, next_step: r.action, evidence_link: r.drill || null,
  }));
  const adjustments = [];
  for (const r of results) {
    for (const pr of ((r.evidence && r.evidence.proposals) || [])) adjustments.push({ source: r.code, kind: pr.kind, posting_date: pr.posting_date, amount_cents: pr.amount_cents, text: pr.text, approval: 'Bill correction workflow (Bills)' });
  }
  for (const k of openRuns) {
    const who = k.process === 'bank_reconciliation' ? `${PROCESS[k.process]} ${accounts[k.subject_id] || ''}`.trim() : PROCESS[k.process] || k.process;
    if (k.process === 'interest') {
      const t = k.totals || {};
      adjustments.push({ source: `Kat run ${k.id.slice(0, 8)}`, kind: 'interest_run', posting_date: k.run_date, amount_cents: t.clean_interest_cents || 0,
        text: `${who} ${k.run_date}: ${t.clean_owners || 0} owners ${$(t.clean_interest_cents || 0)} ready to post (Dr homeowner AR / Cr interest income); ${t.exception_owners || 0} exception owners ${$(t.exception_interest_cents || 0)} held unless approved by name. Status: ${k.status}${k.held_reason ? ` (${k.held_reason})` : ''}.`,
        approval: 'Kat accounting runs (approve / hold)' });
    }
    for (const pr of k.proposals || []) adjustments.push({ source: `Kat run ${k.id.slice(0, 8)}`, kind: pr.kind, posting_date: pr.posting_date, amount_cents: pr.amount_cents, text: `${who}: ${pr.description || pr.kind}`, approval: 'Kat accounting runs (tick by name)' });
    for (const ri of k.recognition_items || []) adjustments.push({ source: `Kat run ${k.id.slice(0, 8)}`, kind: 'recognition', posting_date: ri.posting_date, amount_cents: ri.amount_cents, text: `${ri.schedule} ${String(ri.month).slice(0, 7)}`, approval: 'Kat accounting runs (approve)' });
  }
  const openBlocks = exceptions.filter((e) => e.status === 'BLOCK' && !/^Overridden/.test(e.resolution));
  const openWarn = exceptions.filter((e) => e.status === 'WARNING' && e.resolution !== 'Accepted');
  const pendingRuns = openRuns.filter((k) => ['prepared', 'approved', 'held', 'failed'].includes(k.status));
  const blockers = [];
  if (!run) blockers.push('Kat has not run the cutoff review for this month.');
  else if (!review) blockers.push('The latest checklist run is not a Kat cutoff review on the current engine; have Kat run the review.');
  if (openBlocks.length) blockers.push(`${openBlocks.length} BLOCK${openBlocks.length > 1 ? 's' : ''} open (${openBlocks.map((e) => e.code).join(', ')}).`);
  if (openWarn.length) blockers.push(`${openWarn.length} warning${openWarn.length > 1 ? 's' : ''} not accepted (${openWarn.map((e) => e.code).join(', ')}).`);
  if (pendingRuns.length) blockers.push(`${pendingRuns.length} Kat accounting run${pendingRuns.length > 1 ? 's' : ''} awaiting a decision (${[...new Set(pendingRuns.map((k) => PROCESS[k.process] || k.process))].join(', ')}).`);
  const ready = !isClosed && !blockers.length;
  return {
    community: { id: community.id, name: community.name }, period: { id: p.id, start: p.period_start, end: p.period_end, status: p.status, label: monthLabel(p.period_end) },
    policy: CLOSE_POLICY,
    review: run ? { run_id: run.id, run_at: run.run_at, run_by: run.run_by, engine_version: run.engine_version, is_kat_cutoff_review: review, summary: run.summary } : null,
    verdict: isClosed ? 'closed' : ready ? 'ready_for_owner_approval' : 'not_ready',
    blockers, exceptions, proposed_adjustments: adjustments,
    pending_runs: pendingRuns.map((k) => ({ id: k.id, process: PROCESS[k.process] || k.process, account: k.subject_id ? (accounts[k.subject_id] || null) : null, status: k.status, held_reason: k.held_reason,
      summary: k.process === 'interest' ? `${$((k.totals || {}).clean_interest_cents || 0)} ready, ${$((k.totals || {}).exception_interest_cents || 0)} held` : k.process === 'bank_reconciliation' ? `difference ${$((k.totals || {}).difference_cents || 0)}; ${(k.exceptions || []).length} open item(s)` : `${(k.recognition_items || []).length} entr(ies)` })),
    evidence: (st.events || []).filter((e) => ['block_overridden', 'warnings_accepted', 'evidence_added'].includes(e.event)).map((e) => ({ event: e.event, actor: e.actor, at: e.created_at, control: e.control_code, reason: e.reason })),
    note: 'Read-only. Closing is the owner\'s decision (Accounting > Close); each adjustment posts only through its own approval.',
  };
}

function renderReadinessHtml(r) {
  const row = (e) => `<tr><td><b>${esc(e.code)}</b><div class="m">${esc(e.group)}</div></td><td><span class="st ${esc(e.status)}">${esc(e.status)}</span></td><td>${esc(e.label)}<div class="m">${esc(e.explanation)}</div>${e.next_step ? `<div class="m"><b>Next step:</b> ${esc(e.next_step)}</div>` : ''}${e.evidence_link ? `<div class="m"><a href="${esc(e.evidence_link.href)}">${esc(e.evidence_link.label)}</a></div>` : ''}</td><td class="n">${e.amount_cents != null ? esc($(e.amount_cents)) : ''}</td><td>${esc(e.resolution)}</td></tr>`;
  const adj = (a) => `<tr><td>${esc(a.source)}</td><td>${esc(a.posting_date || '')}</td><td>${esc(a.text)}</td><td class="n">${a.amount_cents != null ? esc($(a.amount_cents)) : ''}</td><td>${esc(a.approval)}</td></tr>`;
  const verdict = { closed: 'Closed', ready_for_owner_approval: 'Ready for owner approval', not_ready: 'Not ready to close' }[r.verdict];
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Close readiness</title>
<style>body{font-family:Inter,Arial,sans-serif;color:#1f2937;margin:24px;max-width:1100px}h1{font-size:20px;margin:0}h2{font-size:15px;margin:22px 0 8px}.m{color:#6b7280;font-size:12px;margin-top:3px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid #e5e7eb;padding:7px 6px;text-align:left;vertical-align:top}th{font-size:11px;text-transform:uppercase;color:#6b7280}.n{text-align:right;white-space:nowrap}
.st{font-weight:700;font-size:11px;padding:2px 6px;border-radius:4px}.BLOCK{background:#fee2e2;color:#991b1b}.WARNING{background:#fef3c7;color:#92400e}.v{display:inline-block;margin-top:8px;padding:4px 10px;border-radius:6px;font-weight:700}
.v.not_ready{background:#fee2e2;color:#991b1b}.v.ready_for_owner_approval{background:#dcfce7;color:#166534}.v.closed{background:#e5e7eb}ul{margin:6px 0 0 18px;padding:0}</style></head><body>
<h1>${esc(r.community.name)}: ${esc(r.period.label)} close readiness</h1>
<div class="m">Prepared by Kat from ${r.review ? `the cutoff review run ${esc(String(r.review.run_at).slice(0, 16).replace('T', ' '))} UTC (${esc(r.review.run_by)})` : 'no cutoff review yet'}. ${esc(r.note)}</div>
<div class="v ${esc(r.verdict)}">${esc(verdict)}</div>
${r.blockers.length ? `<h2>What stands between this month and close</h2><ul>${r.blockers.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
<h2>Outstanding exceptions (${r.exceptions.length})</h2>${r.exceptions.length ? `<table><tr><th>Control</th><th>Status</th><th>Finding and evidence</th><th class="n">Amount</th><th>Resolution</th></tr>${r.exceptions.map(row).join('')}</table>` : '<div class="m">None.</div>'}
<h2>Proposed adjustments (${r.proposed_adjustments.length}), none posted</h2>${r.proposed_adjustments.length ? `<table><tr><th>Source</th><th>Date</th><th>Proposal</th><th class="n">Amount</th><th>Approved through</th></tr>${r.proposed_adjustments.map(adj).join('')}</table>` : '<div class="m">None.</div>'}
${r.pending_runs.length ? `<h2>Kat runs awaiting your decision (${r.pending_runs.length})</h2><table><tr><th>Run</th><th>Status</th><th>Summary</th></tr>${r.pending_runs.map((k) => `<tr><td>${esc(k.process)}${k.account ? ` ${esc(k.account)}` : ''}</td><td>${esc(k.status)}${k.held_reason ? `: ${esc(k.held_reason)}` : ''}</td><td>${esc(k.summary)}</td></tr>`).join('')}</table>` : ''}
${r.evidence.length ? `<h2>Decisions on record</h2><table><tr><th>When</th><th>Who</th><th>What</th></tr>${r.evidence.map((e) => `<tr><td>${esc(String(e.at).slice(0, 16).replace('T', ' '))}</td><td>${esc(e.actor)}</td><td>${esc(e.event.replace(/_/g, ' '))} ${esc(e.control || '')}${e.reason ? `: ${esc(e.reason)}` : ''}</td></tr>`).join('')}</table>` : ''}
<h2>${esc(r.policy.title)} (adopted ${esc(r.policy.adopted)})</h2><ul>${r.policy.rules.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
</body></html>`;
}

module.exports = { buildReadiness, renderReadinessHtml };
