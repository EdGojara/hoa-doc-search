// ============================================================================
// public/deploy-watcher.js  (Ed 2026-07-31, shared 2026-08-01)
// ----------------------------------------------------------------------------
// Deploy freshness watcher. Repeated "I deployed but it still does the old
// thing" was a stale OPEN TAB running JS loaded before the deploy — the page is
// served no-cache, but an already-open tab never re-fetches until reloaded. This
// polls /version; when the running commit changes from the one this tab loaded,
// it shows a reload prompt so staff never keep clicking against old code (and
// never have to reach for Ctrl+Shift+R). Single source: include on any staff
// page with <script src="/deploy-watcher.js"></script>.
// ============================================================================
(function () {
  if (window.__bedrockDeployWatcher) return; // guard against double-include
  window.__bedrockDeployWatcher = true;
  var loadedCommit = null;
  async function check() {
    try {
      var r = await fetch('/version', { cache: 'no-store' });
      if (!r.ok) return;
      var j = await r.json();
      var v = j.commit || j.commit_short || null;
      if (!v) return;
      if (loadedCommit === null) { loadedCommit = v; return; }
      if (v !== loadedCommit && !document.getElementById('_bedrockReloadBanner')) showBanner();
    } catch (_) {}
  }
  function showBanner() {
    var d = document.createElement('div');
    d.id = '_bedrockReloadBanner';
    d.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#0B1D34;color:#fff;padding:11px 16px;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.35);font-size:13px;display:flex;gap:14px;align-items:center;font-family:Arial,Helvetica,sans-serif;';
    var s = document.createElement('span');
    s.innerHTML = '🔄 A new version was just deployed — reload to use it.';
    var b = document.createElement('button');
    b.textContent = 'Reload now';
    b.style.cssText = 'background:#d4af37;color:#0B1D34;border:0;padding:7px 14px;border-radius:7px;font-weight:800;cursor:pointer;';
    b.onclick = function () { location.reload(); };
    var x = document.createElement('button');
    x.textContent = 'Later';
    x.title = 'Dismiss — you can reload whenever you reach a stopping point';
    x.style.cssText = 'background:transparent;color:#cbd5e1;border:0;padding:7px 4px;cursor:pointer;font-size:12px;';
    x.onclick = function () { d.remove(); };
    d.appendChild(s); d.appendChild(b); d.appendChild(x);
    document.body.appendChild(d);
  }
  check();
  setInterval(check, 90000);
})();
