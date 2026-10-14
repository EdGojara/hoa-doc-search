// public/app/confirm.js — in-page confirmation for financial actions (Ed 2026-10-14).
// Native confirm() is suppressed in embedded browsers (the Claude desktop Browser pane
// answers Cancel without showing it), so an approval silently did nothing. This renders
// the question on the page instead and resolves true only on an explicit click.
//
//   await txConfirm('Post this?')                                  -> true | false
//   await txConfirm({ title, message, items:[{label, cents}], total_cents, confirmLabel, danger })
//
// Escape, the Cancel button or a click outside resolve false. Resolves once; the confirm
// button disables on click so a double click cannot answer twice.
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const money = (c) => { const n = Number(c) || 0; const s = (Math.abs(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return n < 0 ? `($${s})` : `$${s}`; };
  function txConfirm(opts) {
    const o = typeof opts === 'string' ? { message: opts } : (opts || {});
    return new Promise((resolve) => {
      const bg = document.createElement('div');
      bg.setAttribute('role', 'dialog'); bg.setAttribute('aria-modal', 'true');
      bg.style.cssText = 'position:fixed;inset:0;background:rgba(11,29,52,.55);z-index:100000;display:flex;align-items:flex-start;justify-content:center;padding:60px 16px;overflow:auto;font-family:Inter,-apple-system,"Segoe UI",sans-serif;';
      const items = (o.items || []).map((it) => `<tr><td style="padding:4px 10px 4px 0;font-size:13px;color:#1A2233;">${esc(it.label)}</td><td style="padding:4px 0;font-size:13px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;">${it.cents == null ? '' : money(it.cents)}</td></tr>`).join('');
      bg.innerHTML = `<div style="background:#fff;border-radius:12px;max-width:560px;width:100%;box-shadow:0 18px 50px rgba(0,0,0,.25);overflow:hidden;">
        <div style="background:#0B1D34;color:#fff;padding:13px 18px;font-weight:700;font-size:15px;border-bottom:2px solid #D4AF37;">${esc(o.title || 'Please confirm')}</div>
        <div style="padding:16px 18px;">
          ${o.message ? `<div style="font-size:13.5px;color:#1A2233;white-space:pre-wrap;line-height:1.45;">${esc(o.message)}</div>` : ''}
          ${items ? `<table style="width:100%;border-collapse:collapse;margin-top:10px;">${items}${o.total_cents != null ? `<tr><td style="padding:7px 10px 2px 0;font-weight:700;border-top:1px solid #0B1D34;">Total</td><td style="padding:7px 0 2px;font-weight:700;text-align:right;border-top:1px solid #0B1D34;font-variant-numeric:tabular-nums;">${money(o.total_cents)}</td></tr>` : ''}</table>` : ''}
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:18px;">
            <button type="button" data-x="no" style="padding:9px 16px;border:1px solid #dde3ea;background:#fff;border-radius:7px;font-size:14px;cursor:pointer;">Cancel</button>
            <button type="button" data-x="yes" style="padding:9px 18px;border:none;background:${o.danger ? '#8E2A22' : '#0B1D34'};color:#fff;border-radius:7px;font-size:14px;font-weight:700;cursor:pointer;">${esc(o.confirmLabel || 'Confirm')}</button>
          </div>
        </div></div>`;
      let done = false;
      const finish = (v) => { if (done) return; done = true; document.removeEventListener('keydown', onKey, true); bg.remove(); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(false); } };
      bg.addEventListener('click', (e) => { if (e.target === bg) finish(false); });
      bg.querySelector('[data-x="no"]').addEventListener('click', () => finish(false));
      const yes = bg.querySelector('[data-x="yes"]');
      yes.addEventListener('click', () => { yes.disabled = true; finish(true); });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(bg);
      setTimeout(() => yes.focus(), 0);
    });
  }
  // In-page replacement for prompt(): resolves the trimmed text, or null on cancel or empty.
  function txPrompt(title, { placeholder = '', confirmLabel = 'Save' } = {}) {
    return new Promise((resolve) => {
      const bg = document.createElement('div');
      bg.setAttribute('role', 'dialog'); bg.setAttribute('aria-modal', 'true');
      bg.style.cssText = 'position:fixed;inset:0;background:rgba(11,29,52,.55);z-index:100000;display:flex;align-items:flex-start;justify-content:center;padding:60px 16px;font-family:Inter,-apple-system,"Segoe UI",sans-serif;';
      bg.innerHTML = `<div style="background:#fff;border-radius:12px;max-width:520px;width:100%;box-shadow:0 18px 50px rgba(0,0,0,.25);overflow:hidden;">
        <div style="background:#0B1D34;color:#fff;padding:13px 18px;font-weight:700;font-size:15px;border-bottom:2px solid #D4AF37;">${esc(title)}</div>
        <div style="padding:16px 18px;"><textarea rows="3" placeholder="${esc(placeholder)}" style="width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #dde3ea;border-radius:7px;font:inherit;font-size:14px;"></textarea>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:14px;">
            <button type="button" data-x="no" style="padding:9px 16px;border:1px solid #dde3ea;background:#fff;border-radius:7px;font-size:14px;cursor:pointer;">Cancel</button>
            <button type="button" data-x="yes" style="padding:9px 18px;border:none;background:#0B1D34;color:#fff;border-radius:7px;font-size:14px;font-weight:700;cursor:pointer;">${esc(confirmLabel)}</button>
          </div></div></div>`;
      let done = false; const ta = bg.querySelector('textarea');
      const finish = (v) => { if (done) return; done = true; document.removeEventListener('keydown', onKey, true); bg.remove(); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } };
      bg.querySelector('[data-x="no"]').addEventListener('click', () => finish(null));
      bg.querySelector('[data-x="yes"]').addEventListener('click', () => finish(ta.value.trim() || null));
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(bg); setTimeout(() => ta.focus(), 0);
    });
  }
  window.txConfirm = txConfirm;
  window.txPrompt = txPrompt;
  window.txMoney = money;
})();
