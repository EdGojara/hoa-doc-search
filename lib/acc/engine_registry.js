// ============================================================================
// lib/acc/engine_registry.js  (Ed 2026-07-13)
// ----------------------------------------------------------------------------
// The ACC decision engine (assessAndDraftAcc) lives in server.js so it keeps
// all its in-scope deps untouched. This tiny registry lets lib-side intake
// modules (email, portal) call that exact engine without importing server.js
// (which would be circular) and without going back through the HTTP route +
// auth gate. server.js registers the engine at startup; callers use runEngine.
// ============================================================================
let _engine = null;

function setEngine(fn) { _engine = fn; }
function isReady() { return typeof _engine === 'function'; }

// Run the shared engine. Throws a clear error if it hasn't been registered yet
// (server not booted) rather than a confusing "not a function".
async function runEngine(params) {
  if (typeof _engine !== 'function') {
    const e = new Error('acc_engine_unavailable'); e.detail = 'The ACC decision engine is not registered yet (server not booted).';
    throw e;
  }
  return _engine(params);
}

module.exports = { setEngine, isReady, runEngine };
