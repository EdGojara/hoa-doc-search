// ============================================================================
// lib/mission_control/graph.js — Mission Control dependency graph (pure)
// ----------------------------------------------------------------------------
// Nodes are tasks (an action someone owns), deliverables (a business result such
// as "Canyon Gate September financial close") and, in Platform Buildout, modules
// and their components. A node's `blocks` lists the keys it holds up. A blocking
// edge means the target cannot finish until this node is done; an ordinary
// pending task (blocking: false) is shown but never holds anything up.
//
// Ranking is by downstream impact, not a manual label: an action that unlocks
// five deliverables comes before one that unlocks a minor task.
// ============================================================================
'use strict';

const OPEN = new Set(['open', 'blocked', 'waiting', 'in_progress', 'needs_action']);
const isOpen = (n) => !!n && OPEN.has(n.state || 'open');
const DEFAULT_WEIGHT = { deliverable: 3, task: 1, module: 3, component: 1 };

function buildGraph(nodes) {
  const byKey = new Map();
  for (const n of nodes || []) if (n && n.key && !byKey.has(n.key)) byKey.set(n.key, { blocks: [], ...n, blocks: [...new Set(n.blocks || [])] });
  const dangling = [];
  const blockedBy = new Map([...byKey.keys()].map((k) => [k, []]));
  for (const n of byKey.values()) {
    n.blocks = n.blocks.filter((k) => {
      if (k === n.key) return false;
      if (!byKey.has(k)) { dangling.push({ from: n.key, to: k }); return false; }
      blockedBy.get(k).push(n.key);
      return true;
    });
  }
  return { byKey, blockedBy, dangling };
}

// Every node this one holds up, transitively (only through a blocking node).
function downstream(g, key) {
  const seen = new Set(); const out = [];
  const start = g.byKey.get(key);
  if (!start || start.blocking === false) return out;
  const stack = [...start.blocks];
  while (stack.length) {
    const k = stack.pop();
    if (seen.has(k) || k === key) continue;
    seen.add(k);
    const n = g.byKey.get(k); if (!n) continue;
    out.push(n);
    if (n.blocking !== false) stack.push(...n.blocks);
  }
  return out;
}

// Every open node that (transitively) holds this one up.
function upstream(g, key) {
  const seen = new Set(); const out = [];
  const stack = [...(g.blockedBy.get(key) || [])];
  while (stack.length) {
    const k = stack.pop();
    if (seen.has(k) || k === key) continue;
    seen.add(k);
    const n = g.byKey.get(k); if (!n || n.blocking === false) continue;
    out.push(n);
    stack.push(...(g.blockedBy.get(k) || []));
  }
  return out;
}

// Impact = the weight of the OPEN work this node holds up, downstream.
function impactOf(g, key) {
  const n = g.byKey.get(key);
  if (!n || !isOpen(n) || n.blocking === false) return { score: 0, deliverables: [], count: 0 };
  const down = downstream(g, key).filter(isOpen);
  const deliverables = down.filter((d) => d.kind === 'deliverable' || d.kind === 'module');
  const score = down.reduce((t, d) => t + (d.weight != null ? d.weight : DEFAULT_WEIGHT[d.kind] || 1), 0);
  return { score, deliverables, count: down.length };
}

// The longest chain of open blocking nodes ending at `key` (the critical path to it).
function criticalPath(g, key, seen = new Set()) {
  if (seen.has(key)) return [];
  seen.add(key);
  let best = [];
  for (const k of g.blockedBy.get(key) || []) {
    const n = g.byKey.get(k);
    if (!isOpen(n) || n.blocking === false) continue;
    const p = criticalPath(g, k, new Set(seen));
    if (p.length + 1 > best.length) best = [...p, n];
  }
  return best;
}

// A node is BLOCKED when an open blocking node holds it up; its own state wins
// when it is already done.
function effectiveState(g, n) {
  if (!isOpen(n)) return n.state || 'done';
  const holders = (g.blockedBy.get(n.key) || []).map((k) => g.byKey.get(k)).filter((x) => isOpen(x) && x.blocking !== false);
  if (holders.length && n.kind !== 'task') return 'blocked';
  if (holders.length && n.state !== 'needs_action') return 'blocked';
  return n.state || 'open';
}

const PRIORITY = { critical: 3, high: 2, normal: 1, low: 0 };
function rank(g, nodes, now = new Date()) {
  const t = now.getTime();
  return nodes.map((n) => {
    const imp = impactOf(g, n.key);
    const overdue = !!(n.due && isOpen(n) && new Date(n.due).getTime() < t);
    return { n, imp, overdue };
  }).sort((a, b) => (b.imp.score - a.imp.score) || (Number(b.overdue) - Number(a.overdue))
    || ((a.n.due ? new Date(a.n.due).getTime() : Infinity) - (b.n.due ? new Date(b.n.due).getTime() : Infinity))
    || ((PRIORITY[b.n.priority] || 1) - (PRIORITY[a.n.priority] || 1))
    || String(a.n.title).localeCompare(String(b.n.title)));
}

// Serialize for the API: every node with its impact, downstream and upstream keys.
function annotate(g, now = new Date()) {
  const out = [];
  for (const { n, imp, overdue } of rank(g, [...g.byKey.values()], now)) {
    out.push({
      ...n,
      effective_state: effectiveState(g, n),
      overdue,
      impact: { score: imp.score, count: imp.count, deliverables: imp.deliverables.map((d) => ({ key: d.key, title: d.title })) },
      downstream: downstream(g, n.key).map((d) => d.key),
      upstream: upstream(g, n.key).filter(isOpen).map((d) => d.key),
      critical_path: n.kind === 'deliverable' || n.kind === 'module' ? criticalPath(g, n.key).map((x) => x.key) : undefined,
    });
  }
  return out;
}

module.exports = { buildGraph, downstream, upstream, impactOf, criticalPath, effectiveState, rank, annotate, isOpen };
