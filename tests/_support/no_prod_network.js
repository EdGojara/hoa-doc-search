// ============================================================================
// tests/_support/no_prod_network.js  (Ed 2026-10-04, Issue #27 follow-up)
// ----------------------------------------------------------------------------
// THE SCAR. On 2026-10-04 a local unit test wrote 8 rows to PRODUCTION
// system_errors. tests/test_ap_commit_review_flag.js loads dotenv (real
// SUPABASE_URL/KEY) and fakes @supabase/supabase-js only while the module under
// test loads; lib/capture_error.js builds its own client and talked to prod.
// The write was swallowed (capture_error never throws), so the test passed.
// system_errors is append-only (mig 264), so those rows are permanent.
//
// THE CONTROL. Preloaded into every check by scripts/run_all_tests.js (via
// NODE_OPTIONS, so child node processes inherit it) and required directly at
// the top of any test that fakes a client (enforced by
// scripts/check_test_network_guard.js). It works at the socket, so it holds no
// matter which of the ~94 lib modules builds its own Supabase / Graph / Resend /
// Twilio / Anthropic client, or when.
//
//   TEST_NO_PROD=1         (default for every check) loopback only. Any other
//                          TCP connect, fetch or http(s) request is refused.
//   TEST_NO_PROD=readonly  (LIVE_CHECKS in run_all_tests.js only) GET/HEAD to
//                          the SUPABASE_URL host are allowed; every write method
//                          and every other host is refused.
//   TEST_NO_PROD=0         off (an explicit, visible opt-out).
//
// A refusal THROWS (so the call fails like a dead network) AND is recorded, and
// the process exits non-zero even if the code under test swallowed the error.
// A swallowed prod write is exactly what got through last time, so it must
// fail the test by itself.
// ============================================================================
'use strict';

if (!global.__TEST_NO_PROD_INSTALLED__) {
  global.__TEST_NO_PROD_INSTALLED__ = true;
  // Required directly (not preloaded)? Default ON. Only the runner may relax it.
  if (process.env.TEST_NO_PROD === undefined) process.env.TEST_NO_PROD = '1';
  install();
}

function install() {
  const fs = require('fs');
  const net = require('net');
  const http = require('http');
  const https = require('https');

  const mode = () => String(process.env.TEST_NO_PROD || '').toLowerCase();
  if (mode() === '0' || mode() === 'off') return;

  // Loopback-only: give the ~94 modules that build a client at load a URL that
  // can never be production, so a unit test needs no real keys to load them.
  // dotenv never overrides a set variable, so the real ones stay out entirely.
  if (mode() === '1') {
    if (!process.env.SUPABASE_URL) process.env.SUPABASE_URL = 'https://supabase.test-no-prod.invalid';
    if (!process.env.SUPABASE_KEY) process.env.SUPABASE_KEY = 'test-no-prod-placeholder';
  }

  const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
  const isLoopback = (h) => !h || LOOPBACK.has(h) || h.endsWith('.localhost');
  // Read lazily: dotenv runs after this preload.
  const supabaseHost = () => {
    try { return new URL(process.env.SUPABASE_URL).hostname.toLowerCase(); } catch (_) { return null; }
  };
  const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

  const blocked = [];
  function refuse(layer, host, method, path) {
    // Never record query strings or headers: they can carry keys/tokens.
    const entry = { layer, host, method: method || null, path: (path || '').split('?')[0].slice(0, 120), mode: mode() };
    blocked.push(entry);
    if (process.env.TEST_NO_PROD_REPORT) {
      try { fs.appendFileSync(process.env.TEST_NO_PROD_REPORT, JSON.stringify(entry) + '\n'); } catch (_) {}
    }
    const err = new Error(`TEST_NO_PROD: refused ${method || 'connect'} ${host}${entry.path} from a test (${layer}). ` +
      'Tests must not reach production. Inject a fake client, or list the check in LIVE_CHECKS if it is a read-only live-data check.');
    err.code = 'ETEST_NO_PROD';
    return err;
  }

  // Decision at the request layer, where the method is known.
  function allowRequest(host, method) {
    host = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (isLoopback(host)) return true;
    if (mode() === 'readonly' && host === supabaseHost() && READ_METHODS.has(String(method || 'GET').toUpperCase())) return true;
    return false;
  }
  // Decision at the socket layer (backstop; no method visible). In readonly the
  // Supabase host must connect so its GETs work; writes are refused above it.
  function allowSocket(host) {
    host = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (isLoopback(host)) return true;
    return mode() === 'readonly' && host === supabaseHost();
  }

  // ---- fetch (supabase-js 2.x, Resend, Anthropic SDK) ----
  if (typeof globalThis.fetch === 'function') {
    const realFetch = globalThis.fetch;
    globalThis.fetch = function guardedFetch(input, init) {
      let url, method;
      try {
        const req = (typeof Request !== 'undefined' && input instanceof Request) ? input : null;
        url = new URL(req ? req.url : String(input && input.href ? input.href : input));
        method = (init && init.method) || (req && req.method) || 'GET';
      } catch (_) { return realFetch.apply(this, arguments); }
      if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'file:') return realFetch.apply(this, arguments);
      if (!allowRequest(url.hostname, method)) return Promise.reject(refuse('fetch', url.hostname, String(method).toUpperCase(), url.pathname));
      return realFetch.apply(this, arguments);
    };
  }

  // ---- http / https (node-fetch, axios -> Twilio, Graph helpers, ws) ----
  function wrapRequest(mod, name, proto) {
    const real = mod[name];
    mod[name] = function guardedRequest(a, b, c) {
      let host, method, path;
      try {
        if (typeof a === 'string' || a instanceof URL) {
          const u = new URL(String(a));
          host = u.hostname; path = u.pathname;
          const o = (b && typeof b === 'object') ? b : {};
          method = o.method || 'GET';
          if (o.hostname || o.host) host = o.hostname || o.host;
        } else {
          const o = a || {};
          host = o.hostname || o.host || 'localhost';
          method = o.method || 'GET'; path = o.path || '/';
        }
        host = String(host).replace(/:\d+$/, '');
      } catch (_) { return real.apply(this, arguments); }
      if (!allowRequest(host, method)) throw refuse(proto, host, String(method).toUpperCase(), path);
      return real.apply(this, arguments);
    };
  }
  wrapRequest(http, 'request', 'http'); wrapRequest(http, 'get', 'http');
  wrapRequest(https, 'request', 'https'); wrapRequest(https, 'get', 'https');

  // ---- raw TCP backstop: net.connect, tls.connect and undici all land here ----
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    let opts = args[0];
    if (Array.isArray(opts)) opts = opts[0]; // internal normalized-args form
    let host;
    if (opts && typeof opts === 'object') {
      if (opts.path) return realConnect.apply(this, args); // unix socket / named pipe
      host = opts.host || opts.hostname || 'localhost';
    } else if (typeof opts === 'number' || /^\d+$/.test(String(opts))) {
      host = typeof args[1] === 'string' ? args[1] : 'localhost';
    } else if (typeof opts === 'string') {
      return realConnect.apply(this, args); // pipe path
    }
    if (!allowSocket(host)) {
      const err = refuse('tcp', host, null, '');
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return realConnect.apply(this, args);
  };

  process.on('exit', () => {
    if (!blocked.length) return;
    const hosts = [...new Set(blocked.map((b) => `${b.method || 'connect'} ${b.host}${b.path}`))];
    process.stderr.write(`\n✗ TEST_NO_PROD: this test tried to reach the network ${blocked.length} time(s) ` +
      `(refused, nothing was sent):\n${hosts.slice(0, 10).map((h) => '    ' + h).join('\n')}\n` +
      '  A unit test that reaches production is a failure even if the code swallowed the error.\n');
    process.exitCode = 1;
  });
}
