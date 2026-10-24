// ============================================================================
// lib/audit/record_event.js  (Ed 2026-10-24, migration 545)
// ----------------------------------------------------------------------------
// The ONE way application code appends to the canonical audit trail
// (audit_events: append-only, insert-only grants, a trigger rejects UPDATE and
// DELETE). Every event names the signed-in employee (actor_user_id is required;
// the name is a snapshot for reading), what changed (entity, field, before,
// after) and why (reason, required and not blank).
//
// recordAuditEvent THROWS on any failure (bad input, missing reason, database
// error) so the caller can fail closed: undo its change, or refuse it, rather
// than leave a change with no record of who made it. Never wrap it in a
// try/catch that swallows the error.
//
// Existing per-domain logs (timeline notes, property_enforcement_state_audit,
// record_finalization_log, invoice_events, ...) keep being written as before;
// this is the canonical trail new code writes alongside them.
// ============================================================================

class AuditEventError extends Error {
  constructor(code, message) { super(message); this.name = 'AuditEventError'; this.code = code; }
}

const MAX = { actor_name: 200, entity_type: 80, entity_id: 200, action: 120, field: 120, reason: 2000, route: 300 };
const clip = (s, n) => (s == null ? null : String(s).slice(0, n));
const blank = (s) => s == null || !String(s).trim();

// Validate + shape one event into an audit_events row. Pure (no database), so the
// rules are unit-testable and shared by every writer.
function buildAuditEvent(ev) {
  const e = ev || {};
  if (blank(e.actor_user_id)) throw new AuditEventError('actor_required', 'An audit event needs the signed-in employee (actor_user_id).');
  if (blank(e.reason)) throw new AuditEventError('reason_required', 'An audit event needs a reason.');
  for (const k of ['entity_type', 'entity_id', 'action']) {
    if (blank(e[k])) throw new AuditEventError(`${k}_required`, `An audit event needs ${k}.`);
  }
  return {
    community_id: e.community_id || null,
    actor_user_id: String(e.actor_user_id),
    actor_name: clip(e.actor_name, MAX.actor_name),
    entity_type: clip(String(e.entity_type).trim(), MAX.entity_type),
    entity_id: clip(String(e.entity_id).trim(), MAX.entity_id),
    action: clip(String(e.action).trim(), MAX.action),
    field: e.field ? clip(e.field, MAX.field) : null,
    previous_value: e.previous_value === undefined ? null : e.previous_value,
    new_value: e.new_value === undefined ? null : e.new_value,
    reason: clip(String(e.reason).trim(), MAX.reason),
    route: clip(e.route, MAX.route),
  };
}

// Append one event. Returns { id, created_at }. Throws on any failure.
async function recordAuditEvent(db, ev) {
  if (!db || typeof db.from !== 'function') throw new AuditEventError('no_db', 'recordAuditEvent needs a database client.');
  const row = buildAuditEvent(ev);
  let res;
  try {
    res = await db.from('audit_events').insert(row).select('id, created_at').single();
  } catch (err) {
    throw new AuditEventError('insert_failed', `audit event could not be saved: ${err && err.message ? err.message : err}`);
  }
  const { data, error } = res || {};
  if (error) throw new AuditEventError('insert_failed', `audit event could not be saved: ${error.message}`);
  if (!data || !data.id) throw new AuditEventError('insert_failed', 'audit event could not be saved: no row returned');
  return data;
}

// "METHOD /base/path" for the route column, from an Express request.
function routeOf(req) {
  if (!req) return null;
  const p = req.route && req.route.path ? req.route.path : req.path;
  return `${req.method || ''} ${req.baseUrl || ''}${p || ''}`.trim();
}

module.exports = { recordAuditEvent, buildAuditEvent, routeOf, AuditEventError };
