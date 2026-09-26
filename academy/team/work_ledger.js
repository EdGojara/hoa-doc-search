// academy/team/work_ledger.js  (sandbox; not loaded by production)
// ----------------------------------------------------------------------------
// Tracked work items (Ed 2026-09-26: "a handoff requires a persisted tracked
// work item, not only a handoff package"). The agent proposes items in a
// ---WORK_ITEMS--- block; this ledger validates and PERSISTS them, and only
// persisted items count for the release gate and the vendor-termination guard.
//
// Sandbox: persisted to an in-memory ledger per run (ids SBX-WI-n), saved in
// the report. Production home: work_items (migration 256; owner via
// assigned_to, sla_due_at) or objectives (migration 399; owner_persona,
// next_action_due), both watched for overdue items (objectives.findStalled).
// ----------------------------------------------------------------------------
const { directory } = require('./directory');

const EXTRA_OWNERS = ['ed', 'board', 'legal', 'community_manager', 'info@', 'accounting@'];

function validOwner(o) {
  const k = String(o || '').toLowerCase();
  return EXTRA_OWNERS.includes(k) || directory().some((m) => m.key === k);
}

function createLedger() {
  const items = [];
  let n = 0;
  return {
    items,
    // Validate, then persist. Invalid items are returned with a reason and are
    // NOT persisted (a malformed work item must not look like tracked work).
    persist(proposed = [], meta = {}) {
      const out = [];
      for (const w of [].concat(proposed || [])) {
        const problems = [];
        if (!w || typeof w !== 'object') { out.push({ persisted: false, problems: ['not an object'] }); continue; }
        if (!validOwner(w.owner)) problems.push(`owner "${w.owner}" is not a teammate, role, or queue in the directory`);
        if (!w.title || !String(w.title).trim()) problems.push('missing title');
        if (!w.due || !String(w.due).trim()) problems.push('missing due');
        for (const x of [].concat(w.notify || [])) if (!validOwner(x)) problems.push(`notify "${x}" is not in the directory`);
        if (problems.length) { out.push({ ...w, persisted: false, problems }); continue; }
        const rec = { id: `SBX-WI-${++n}`, owner: String(w.owner).toLowerCase(), title: String(w.title), due: String(w.due), notify: [].concat(w.notify || []).map((x) => String(x).toLowerCase()), status: 'open', persisted: true, created_at: new Date().toISOString(), ...meta };
        items.push(rec); out.push(rec);
      }
      return out;
    },
  };
}

module.exports = { createLedger, validOwner };
