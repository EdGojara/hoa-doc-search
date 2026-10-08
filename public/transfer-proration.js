// public/transfer-proration.js  (Ed 2026-10-08, GitHub issue #94)
// The assessment proration a builder-to-homeowner transfer posts, shown to
// staff BEFORE anything is written (Home Sales "Record closing" and Ownership
// Review "Approve" share this). The numbers come from the server's plan
// (transfer_proration_plan, migration 500); nothing is calculated here.
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => (Number(c) < 0 ? '-' : '') + '$' + (Math.abs(Number(c || 0)) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const day = (d) => { if (!d) return ''; const t = new Date(String(d).slice(0, 10) + 'T00:00:00'); return isNaN(t) ? d : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
  const pct = (p) => String(Number(p));
  const row = (k, v, strong) => '<tr><td style="padding:3px 12px 3px 0; color:#5b6472; vertical-align:top;">' + k + '</td><td style="padding:3px 0; text-align:right; vertical-align:top; overflow-wrap:anywhere;' + (strong ? ' font-weight:700;' : '') + '">' + v + '</td></tr>';
  const box = (inner, tone) => '<div style="margin:10px 0; padding:12px 14px; border-radius:8px; border:1px solid ' + (tone === 'warn' ? '#e8b86d; background:#fff8ec' : '#d8d2c2; background:#fff') + ';">' + inner + '</div>';

  // The calculation table. plan = transfer_proration_plan output.
  function breakdown(p) {
    const prior = Number(p.builder_prior_billed_cents || 0);
    const adj = Number(p.builder_adjustment_cents || 0);
    return '<table style="border-collapse:collapse; font-size:13.5px; width:100%;">'
      + row('Annual assessment', money(p.annual_assessment_cents))
      + row('Builder rate (' + esc(p.builder) + ')', pct(p.builder_rate_pct) + '%')
      + row('Homeowner rate', '100%')
      + row('Transfer date', day(p.settlement_date))
      + row('Builder days', esc(p.builder_days) + ' of ' + esc(p.days_in_year) + ' (' + day(p.builder_period_start) + ' to ' + day(p.builder_period_end) + ')')
      + row('Homeowner days', esc(p.homeowner_days) + ' of ' + esc(p.days_in_year) + ' (' + day(p.homeowner_period_start) + ' to ' + day(p.homeowner_period_end) + ')')
      + row('Builder prorated amount', money(p.builder_due_cents), true)
      + row('Homeowner prorated amount', money(p.homeowner_due_cents), true)
      + (prior ? row('Already billed to the builder this year', money(prior)) : '')
      + row(adj >= 0 ? 'Builder charge to post' : 'Builder credit to post', money(adj))
      + row('Charge to the new owner', money(p.homeowner_due_cents))
      + '</table>'
      + '<div style="font-size:12px; color:#5b6472; margin-top:6px;">Books: '
      + (adj > 0 ? 'Dr 1300 AR / Cr 4000 Assessment Income ' + money(adj) + ' (builder); ' : adj < 0 ? 'Dr 4000 Assessment Income / Cr 1300 AR ' + money(-adj) + ' (builder); ' : '')
      + 'Dr 1300 AR / Cr 4000 Assessment Income ' + money(p.homeowner_due_cents) + ' (new owner), dated ' + day(p.settlement_date) + '.</div>';
  }

  // The panel shown when the server asks for confirmation (409).
  // onConfirm / onAck are called when staff choose to proceed.
  function confirmPanel(body, { onConfirm, onAck }) {
    const p = body.proration || {};
    const wrap = document.createElement('div');
    if (body.code === 'proration_blocked') {
      const rows = (p.builder_prior_rows || []).map((x) => '<li>' + day(x.date) + ' ' + esc(x.description) + ' ' + money(x.amount_cents) + '</li>').join('');
      wrap.innerHTML = box('<b>Assessment proration needs a person</b> (' + esc(p.builder || 'builder') + ' to new owner)'
        + '<div style="margin:6px 0;">' + esc((p.blocked_text || []).join('; ')) + '.</div>'
        + (rows ? '<div>The builder\'s assessment activity this year:</div><ul style="margin:4px 0 8px 18px;">' + rows + '</ul>' : '')
        + '<div style="font-size:12.5px;">Nothing is guessed. You can record the ownership change now; the proration stays open until the ledger is clear, then post it from the sale.</div>'
        + '<button class="btn" data-tp="ack" style="margin-top:8px;">Record the transfer, leave the proration open</button>', 'warn');
      wrap.querySelector('[data-tp="ack"]').addEventListener('click', (e) => { e.preventDefault(); onAck(); });
    } else {
      wrap.innerHTML = box('<b>Assessment proration</b> (' + esc(p.builder || 'builder') + ' to ' + esc(p.buyer_name || 'new owner') + ')'
        + '<div style="margin:8px 0;">' + breakdown(p) + '</div>'
        + '<button class="btn" data-tp="ok" style="margin-top:4px;">Confirm and record</button>');
      wrap.querySelector('[data-tp="ok"]').addEventListener('click', (e) => { e.preventDefault(); onConfirm(); });
    }
    return wrap;
  }

  // After the transfer: what happened to the proration.
  function resultHtml(r, retryJs) {
    if (!r) return '';
    if (r.status === 'posted' || r.status === 'already_posted' || r.status === 'completed_retry') {
      return '<span class="badge ok">Assessment proration posted</span> builder ' + money(r.builder_adjustment_cents) + ', new owner ' + money(r.homeowner_due_cents) + (r.journal_reference ? ' · GL ' + esc(r.journal_reference) : '') + '.';
    }
    if (r.status === 'blocked') return '<span class="badge err">Assessment proration not posted</span> ' + esc((r.blocked_text || r.blocked_reasons || []).join('; ')) + '. Resolve the ledger, then post it.' + (retryJs ? ' <a class="link" onclick="' + retryJs + '">Post proration</a>' : '');
    if (r.status === 'pending') return '<span class="badge err">Assessment proration NOT posted yet</span> ' + esc(r.error || '') + (retryJs ? ' <a class="link" onclick="' + retryJs + '">Retry</a>' : '');
    return '';
  }

  window.TransferProration = { breakdown, confirmPanel, resultHtml, money };
})();
