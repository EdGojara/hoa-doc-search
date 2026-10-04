// ============================================================================
// lib/onboarding/write_gate.js  (Issue #15) — hard write gate
// ----------------------------------------------------------------------------
// Every onboarding stage before EXECUTE receives a READ-ONLY database client.
// The wrapper refuses insert / update / upsert / delete, every rpc() not on an
// explicit read-only allowlist, and every storage mutation, by throwing before
// any request leaves the process. So a stage (or an agent driving it) cannot
// mutate production even if its code tries to.
//
// The only way to get a writable client is writeClientFor(), which checks the
// batch is IN execute, the write lock is open, and the approval matches the
// exact preflight hash being executed. EXECUTE itself (M6) uses no JS write client:
// its writes happen inside one database transaction, onboarding_execute (migration 488).
// ============================================================================
const { GateError } = require('./stages');

const TABLE_MUTATORS = new Set(['insert', 'update', 'upsert', 'delete']);
const STORAGE_MUTATORS = new Set(['upload', 'update', 'remove', 'move', 'copy', 'createSignedUploadUrl', 'uploadToSignedUrl']);
const READ_RPCS = new Set([]);   // add read-only RPCs here explicitly if a stage ever needs one

const refuse = (what) => () => { throw new GateError('WRITE_BLOCKED', `read-only onboarding stage: ${what} refused`); };

function wrapBuilder(builder, table) {
  return new Proxy(builder, {
    get(target, prop) {
      if (TABLE_MUTATORS.has(prop)) return refuse(`${String(prop)} on ${table}`);
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

function readOnlyClient(client) {
  if (!client) throw new Error('client required');
  return Object.freeze({
    __readOnly: true,
    from: (table) => wrapBuilder(client.from(table), table),
    rpc: (name, args, opts) => { if (!READ_RPCS.has(name)) return refuse(`rpc ${name}`)(); return client.rpc(name, args, opts); },
    storage: Object.freeze({
      from: (bucket) => {
        const b = client.storage.from(bucket);
        return new Proxy(b, { get(t, p) { if (STORAGE_MUTATORS.has(p)) return refuse(`storage.${String(p)} on ${bucket}`); const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; } });
      },
    }),
    schema: refuse('schema switch'),
  });
}

function writeClientFor(state, client, { preflight_sha256 } = {}) {
  if (state.stage !== 'execute') throw new GateError('WRITE_LOCKED', `writes are locked in stage ${state.stage}`);
  if (state.write_lock) throw new GateError('WRITE_LOCKED');
  if (!state.approval || state.approval.preflight_sha256 !== preflight_sha256) throw new GateError('APPROVAL_DOES_NOT_MATCH_PREFLIGHT');
  return client;
}

module.exports = { readOnlyClient, writeClientFor, TABLE_MUTATORS };
