// ============================================================================
// demo-mode.js — the persistent DEMO chip (indicator + Exit + role switcher).
// Inert unless the Demo Mode launcher (/demo.html) set sessionStorage.demoMode.
// Reused across demo surfaces; touches no product logic. Staff-only capability.
// ============================================================================
(function () {
  'use strict';
  var state;
  try { state = JSON.parse(sessionStorage.getItem('demoMode') || 'null'); } catch (_) { state = null; }
  if (!state || !state.org) return;   // not in Demo Mode → do nothing

  function build() {
    if (document.getElementById('bedrockDemoChip')) return;
    var wrap = document.createElement('div');
    wrap.id = 'bedrockDemoChip';
    wrap.setAttribute('style', [
      'position:fixed', 'z-index:2147483000', 'bottom:14px', 'left:50%', 'transform:translateX(-50%)',
      'display:flex', 'align-items:center', 'gap:10px',
      'background:#0B1D34', 'color:#fff', 'border:1px solid #D4AF37', 'border-radius:999px',
      'padding:7px 12px 7px 14px', 'font:600 12px/1 -apple-system,Segoe UI,Roboto,sans-serif',
      'box-shadow:0 4px 16px rgba(0,0,0,.28)'
    ].join(';'));
    var label = document.createElement('span');
    label.textContent = '🎬 DEMO · ' + state.org + (state.role ? ' · ' + state.role : '');
    label.style.letterSpacing = '.02em';
    var sw = document.createElement('button');
    sw.textContent = 'Switch role';
    sw.setAttribute('style', 'background:transparent;color:#D4AF37;border:1px solid #D4AF37;border-radius:999px;padding:4px 10px;font:inherit;cursor:pointer');
    sw.onclick = function () { location.href = '/demo.html'; };
    var ex = document.createElement('button');
    ex.textContent = 'Exit Demo';
    ex.setAttribute('style', 'background:#D4AF37;color:#0B1D34;border:none;border-radius:999px;padding:4px 11px;font:inherit;font-weight:700;cursor:pointer');
    ex.onclick = async function () {
      ex.textContent = 'Exiting…';
      try { await fetch('/api/portal/mimic/stop', { method: 'POST', credentials: 'include' }); } catch (_) {}
      try { sessionStorage.removeItem('demoMode'); } catch (_) {}
      location.href = '/';   // back to the normal staff environment
    };
    wrap.appendChild(label); wrap.appendChild(sw); wrap.appendChild(ex);
    document.body.appendChild(wrap);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
