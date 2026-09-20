// ============================================================================
// lib/demo/demo_context.js  (Ed 2026-09-20)
// ----------------------------------------------------------------------------
// An ambient "we are operating on a demo organization" execution context, backed
// by AsyncLocalStorage. It is the third independent signal the outbound guard
// consults (alongside an explicit community id and the recipient pattern), so a
// send triggered deep inside a demo workflow is suppressed even when the low-level
// sender was never told which community it is acting for.
//
// Set it at the boundary where a demo community is entered (a demo-serving request
// handler, or a scheduled job while processing a demo community). If it is never
// set, the guard still has the community-id and recipient signals; this context is
// additive defense in depth, not the sole line.
// ============================================================================
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();

// Run fn with the demo flag active. Returns fn's result (sync or promise).
function runInDemoContext(fn) { return als.run({ demo: true }, fn); }

// Run fn in a demo context only when communityId is a demo community; otherwise
// run fn normally. Use at a boundary that already knows the community.
async function runForCommunity(communityId, fn) {
  let demo = false;
  try { const { isDemoCommunity } = require('./demo_guard'); demo = await isDemoCommunity(communityId); }
  catch (_) { demo = false; }
  return demo ? als.run({ demo: true }, fn) : fn();
}

function isDemoContextActive() {
  const store = als.getStore();
  return !!(store && store.demo);
}

module.exports = { runInDemoContext, runForCommunity, isDemoContextActive };
