// ============================================================================
// public/app/tx.js — Trusted app shell (Issue #6, v3 canonical direction)
// ----------------------------------------------------------------------------
// Shared by every page under /app/. Provides:
//   TX.boot({ active })  sign-in check (same Supabase session as the main app),
//                        renders the sidebar shell, resolves the user
//   TX.get(url)          authed JSON GET → { ok, data } | { ok:false, error }
//                        (never throws; a failure is data the page must show)
//   TX.icon(name)        Lucide-based icon (public/app/tx-icons.js)
//   TX.esc(s)            HTML escape
//
// Fixture mode (?fixture=1, or file://): no network. Pages read
// window.TX_FIXTURE instead, so the visual snapshot harness
// (scripts/visual_snapshot.js) can render real pages with no server or login.
// ============================================================================
(function () {
  'use strict';
  var FIXTURE = /[?&]fixture=1\b/.test(location.search) || location.protocol === 'file:';

  var NAV = [
    ['today', 'Today', '/app/today'],
    ['communities', 'Communities', '/app/communities'],
    ['owners', 'Owners', '/#tab=ownerar'],
    ['financial', 'Financial', '/app/financial'],
    ['operations', 'Operations', '/#tab=inspect'],
    ['projects', 'Projects', '/#tab=status'],
    ['governance', 'Governance', '/#tab=meetings'],
    ['team', 'Team', '/#tab=roster'],
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function icon(name, opts) { return window.TXIcons ? window.TXIcons.icon(name, opts) : ''; }
  function initials(name) {
    return String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0].toUpperCase(); }).join('') || '·';
  }
  function mark(size) {
    size = size || 28;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 32 32" fill="none" aria-hidden="true">' +
      '<path d="M16 2.5l11.5 6.6v13.8L16 29.5 4.5 22.9V9.1z" stroke="var(--gold)" stroke-width="1.8"/>' +
      '<path d="M11 11.5h10M16 11.5v11" stroke="var(--gold)" stroke-width="1.8"/></svg>';
  }

  var supa = null;
  async function token() {
    if (!supa) return null;
    try { var s = (await supa.auth.getSession()).data.session; return s ? s.access_token : null; } catch (_) { return null; }
  }

  async function get(url) {
    if (FIXTURE) {
      var f = (window.TX_FIXTURE || {})[url.split('?')[0]];
      return f === undefined ? { ok: false, error: 'no fixture for ' + url } : f;
    }
    try {
      var headers = { Accept: 'application/json' };
      var t = await token();
      if (t) headers.Authorization = 'Bearer ' + t;
      var r = await fetch(url, { headers: headers, credentials: 'same-origin' });
      var body = null;
      try { body = await r.json(); } catch (_) { body = null; }
      if (!r.ok) return { ok: false, status: r.status, error: (body && (body.error || body.detail)) || ('HTTP ' + r.status) };
      return { ok: true, data: body };
    } catch (e) {
      console.warn('[tx] fetch failed', url, e && e.message);
      return { ok: false, error: (e && e.message) || 'network error' };
    }
  }

  function renderShell(active, user) {
    var host = document.getElementById('tx-shell');
    var main = document.getElementById('tx-main');
    if (!host || !main) throw new Error('tx: page needs #tx-shell and #tx-main');
    var nav = NAV.map(function (n) {
      return '<a class="tx-nav' + (n[0] === active ? ' is-on' : '') + '" href="' + n[2] + '"' + (n[0] === active ? ' aria-current="page"' : '') + '>' +
        icon(n[0]) + '<span>' + n[1] + '</span></a>';
    }).join('');
    var side = document.createElement('aside');
    side.className = 'tx-side';
    side.setAttribute('aria-label', 'Main navigation');
    side.innerHTML =
      '<div class="tx-logo">' + mark() + '<span>TRUSTED</span></div>' + nav +
      // Ask Amanda opens askEd in the main app until the command palette ships.
      '<a class="tx-cmd" href="/#tab=asked" title="Ask Amanda (Ctrl K)">' + icon('sparkles', { size: 15 }) + '<span>Ask Amanda</span><span class="tx-kbd">Ctrl K</span></a>' +
      '<div class="tx-me"><div class="tx-av">' + esc(initials(user.full_name)) + '</div>' +
      '<div style="min-width:0"><div class="tx-me-name">' + esc(user.full_name || user.email || 'Signed in') + '</div>' +
      '<div class="tx-me-role">' + esc(user.role === 'admin' ? 'Owner' : 'Staff') + '</div></div></div>';
    host.insertBefore(side, main);
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); location.href = '/#tab=asked'; }
    });
    var menuBtn = document.getElementById('tx-menu-btn');
    if (menuBtn) {
      menuBtn.innerHTML = icon('menu', { size: 20 });
      menuBtn.addEventListener('click', function () { host.classList.toggle('is-menu-open'); });
    }
  }

  // Same sign-in flow as index.html bootAuth(): Supabase session → /api/me.
  async function resolveUser() {
    if (FIXTURE) return (window.TX_FIXTURE && window.TX_FIXTURE.user) || { full_name: 'Preview', role: 'admin' };
    var cfg = null;
    try { cfg = await (await fetch('/api/auth/config')).json(); } catch (_) { cfg = null; }
    if (!cfg || !cfg.enabled || !window.supabase) throw new Error('Sign-in is not configured.');
    supa = window.supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);
    var session = (await supa.auth.getSession()).data.session;
    if (!session) { location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search)); return null; }
    var r = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + session.access_token } });
    if (!r.ok) { location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search)); return null; }
    var me = (await r.json()).user || {};
    if (me.is_active === false) throw new Error('This account is inactive.');
    return me;
  }

  async function boot(opts) {
    opts = opts || {};
    var user;
    try { user = await resolveUser(); } catch (e) {
      document.getElementById('tx-main').innerHTML = '<div style="padding:40px"><div class="tx-err">' + icon('alert', { size: 16 }) + '<span>' + esc(e.message) + ' <a class="tx-src" href="/">Open the main app</a></span></div></div>';
      throw e;
    }
    if (!user) return null;
    renderShell(opts.active, user);
    return user;
  }

  window.TX = { boot: boot, get: get, icon: icon, esc: esc, fixture: FIXTURE, mark: mark };
})();
