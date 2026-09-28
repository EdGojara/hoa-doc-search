// tests/_fake_supabase_deposits.js — shared in-memory PostgREST-ish fake (+ an
// emulation of the migration-471 functions) for the AP deposit tests. The real
// SQL semantics are rehearsed in tests/sql/471_deposit_followups_rehearsal.mjs.
function fakeDb(seed = {}) {
  const db = JSON.parse(JSON.stringify(seed));
  const writes = [];
  const rpcCalls = [];
  const missing = new Set(seed._missing || []);
  delete db._missing;
  const table = (n) => (db[n] = db[n] || []);
  let seq = 0;
  const nowIso = () => new Date(Date.UTC(2026, 8, 28, 12, 0, 0) + (++seq) * 1000).toISOString();
  function q(name) {
    const st = { filters: [], op: 'select', payload: null, one: false, maybe: false, order: null, lim: null, rng: null, cols: null };
    const rows = () => table(name).filter((r) => st.filters.every((f) => f(r)));
    const api = {
      // Honor the column list like PostgREST does, so a route that selects too few
      // columns is caught (the approval-route bypass class). '*' = all columns;
      // embedded relations (name(...)) are ignored.
      select(c) {
        if (st.op === 'select' && c && !String(c).includes('*')) {
          st.cols = String(c).split(',').map((x) => x.trim()).filter((x) => x && !x.includes('('));
        }
        return api;
      },
      eq(c, v) { st.filters.push((r) => r[c] === v); return api; },
      neq(c, v) { st.filters.push((r) => r[c] !== v); return api; },
      in(c, vs) { st.filters.push((r) => vs.includes(r[c])); return api; },
      is(c, v) { st.filters.push((r) => (r[c] ?? null) === v); return api; },
      ilike(c, pat) { const re = new RegExp('^' + String(pat).replace(/%/g, '.*') + '$', 'i'); st.filters.push((r) => re.test(r[c] || '')); return api; },
      or(expr) { const m = String(expr).match(/account_number\.eq\.(\d+)/); if (m) st.filters.push((r) => r.account_number === m[1]); return api; },
      order(c, o = {}) { st.order = { c, asc: o.ascending !== false }; return api; },
      range(a, b) { st.rng = [a, b]; return api; },
      limit(n) { st.lim = n; return api; },
      maybeSingle() { st.maybe = true; return api; },
      single() { st.one = true; return api; },
      insert(p) { st.op = 'insert'; st.payload = p; return api; },
      update(p) { st.op = 'update'; st.payload = p; return api; },
      then(res) {
        if (missing.has(name)) return res({ data: null, error: { message: `relation "${name}" does not exist` } });
        if (st.op === 'insert') {
          const arr = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((r) => ({ id: `${name}-${++seq}`, created_at: nowIso(), ...r }));
          table(name).push(...arr); writes.push({ op: 'insert', table: name, rows: arr });
          return res({ data: st.one ? arr[0] : arr, error: null });
        }
        if (st.op === 'update') {
          const hit = rows(); hit.forEach((r) => Object.assign(r, st.payload)); writes.push({ op: 'update', table: name, patch: st.payload, n: hit.length });
          return res({ data: hit, error: null });
        }
        let out = rows();
        if (st.order) out = [...out].sort((a, b) => (String(a[st.order.c]) < String(b[st.order.c]) ? -1 : String(a[st.order.c]) > String(b[st.order.c]) ? 1 : 0) * (st.order.asc ? 1 : -1));
        if (st.rng) out = out.slice(st.rng[0], st.rng[1] + 1);
        if (st.lim != null) out = out.slice(0, st.lim);
        out = out.map((r) => (st.cols ? Object.fromEntries(st.cols.filter((k) => k in r).map((k) => [k, r[k]])) : { ...r }));
        return res({ data: st.maybe || st.one ? (out[0] || null) : out, error: null });
      },
    };
    return api;
  }
  // Minimal emulation of the 471 functions (their real semantics are rehearsed in SQL).
  async function rpc(fn, args) {
    rpcCalls.push({ fn, args });
    if (missing.has('vendor_deposit_reconciliations')) return { data: null, error: { message: `Could not find the function public.${fn}` } };
    if (fn === 'vendor_deposit_propose') {
      const d = table('vendor_deposits').find((x) => x.id === args.p_row.deposit_id);
      const row = { id: `rec-${++seq}`, created_at: nowIso(), community_id: d.community_id, vendor_id: d.vendor_id, ...args.p_row };
      table('vendor_deposit_reconciliations').push(row); table('vendor_deposit_events').push({ deposit_id: d.id, event_type: 'reconciliation_proposed' });
      return { data: row.id, error: null };
    }
    if (fn === 'vendor_deposit_decide') {
      const row = { id: `dec-${++seq}`, created_at: nowIso(), reconciliation_id: args.p_reconciliation_id, decision: args.p_decision, decided_by_user_id: args.p_actor_user_id,
        decided_by_name: args.p_actor, note: args.p_note, accounting_je_id: args.p_accounting_je_id, verified_invoice_total_cents: args.p_expected_net_cents, verified_deposit_paid_cents: args.p_live_deposit_paid_cents };
      table('vendor_deposit_reconciliation_decisions').push(row);
      return { data: row.id, error: null };
    }
    if (fn === 'vendor_deposit_set_followup') {
      const d = table('vendor_deposits').find((x) => x.id === args.p_deposit_id);
      Object.assign(d, args.p_patch); table('vendor_deposit_events').push({ deposit_id: d.id, event_type: 'followup_set' });
      return { data: args.p_patch, error: null };
    }
    return { data: null, error: { message: 'unknown function' } };
  }
  return { from: q, rpc, _db: db, _writes: writes, _rpc: rpcCalls };
}
module.exports = { fakeDb };
