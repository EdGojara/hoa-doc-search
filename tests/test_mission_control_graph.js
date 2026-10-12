// Mission Control dependency graph (lib/mission_control/graph.js): pure tests.
'use strict';
const G = require('../lib/mission_control/graph');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };

// The Canyon Gate chain: missing statement -> investment rec -> close -> board package.
const nodes = [
  { key: 'task:ej-stmt', kind: 'task', title: 'Upload September Edward Jones statement', owner: 'Ed', blocks: ['task:inv-rec'], state: 'needs_action' },
  { key: 'task:inv-rec', kind: 'task', title: 'Reserve investment reconciliation', owner: 'Kat', blocks: ['close:sep'] },
  { key: 'task:run-5313', kind: 'task', title: 'Approve NewFirst September reconciliation', owner: 'Ed', blocks: ['close:sep'], state: 'needs_action' },
  { key: 'close:sep', kind: 'deliverable', title: 'September financial close', blocks: ['pkg:sep'] },
  { key: 'pkg:sep', kind: 'deliverable', title: 'September board financial package', weight: 5, blocks: [] },
  { key: 'task:interest', kind: 'task', title: 'Review 10/1 interest', owner: 'Ed', blocking: false, blocks: ['close:sep'], state: 'needs_action' },
  { key: 'task:minor', kind: 'task', title: 'Minor', owner: 'Kat', blocks: ['task:leaf'] },
  { key: 'task:leaf', kind: 'task', title: 'Leaf', owner: 'Kat', blocks: [] },
  { key: 'task:done', kind: 'task', title: 'Done thing', owner: 'Kat', blocks: ['close:sep'], state: 'done' },
  { key: 'task:dangle', kind: 'task', title: 'Points nowhere', blocks: ['nope'] },
];
const g = G.buildGraph(nodes);

console.log('graph');
check('dangling references are reported, not silently kept', g.dangling.length === 1 && g.dangling[0].to === 'nope');
const down = G.downstream(g, 'task:ej-stmt').map((n) => n.key);
check('downstream of the missing statement is the rec, the close and the board package', down.sort().join(',') === 'close:sep,pkg:sep,task:inv-rec', down.join(','));
check('a non-blocking (ordinary) task holds nothing up', G.downstream(g, 'task:interest').length === 0 && G.impactOf(g, 'task:interest').score === 0);
const up = G.upstream(g, 'pkg:sep').map((n) => n.key).sort();
check('upstream of the package lists every open blocker (not the done or non-blocking ones)', !up.includes('task:interest') && up.includes('task:ej-stmt') && up.includes('task:run-5313') && up.includes('close:sep'), up.join(','));

console.log('impact and ranking');
const ej = G.impactOf(g, 'task:ej-stmt'), run = G.impactOf(g, 'task:run-5313'), minor = G.impactOf(g, 'task:minor');
check('the statement unlocks more than the run approval (longer chain), which unlocks more than a minor task', ej.score > run.score && run.score > minor.score, `${ej.score} ${run.score} ${minor.score}`);
check('impact names the deliverables it unlocks', ej.deliverables.map((d) => d.key).sort().join(',') === 'close:sep,pkg:sep');
check('a done task has no impact', G.impactOf(g, 'task:done').score === 0);
const order = G.rank(g, nodes.filter((n) => n.kind === 'task')).map((r) => r.n.key);
check('ranking puts the highest-impact action first', order[0] === 'task:ej-stmt', order.join(','));
const cp = G.criticalPath(g, 'pkg:sep').map((n) => n.key);
check('critical path to the package runs statement -> rec -> close', cp.join(',') === 'task:ej-stmt,task:inv-rec,close:sep', cp.join(','));

console.log('states');
check('a deliverable with an open blocker is BLOCKED', G.effectiveState(g, g.byKey.get('close:sep')) === 'blocked');
check('a task waiting on another task is BLOCKED', G.effectiveState(g, g.byKey.get('task:inv-rec')) === 'blocked');
check('a task that needs an action keeps that state', G.effectiveState(g, g.byKey.get('task:ej-stmt')) === 'needs_action');
const g2 = G.buildGraph(nodes.map((n) => (n.key === 'task:ej-stmt' || n.key === 'task:inv-rec' || n.key === 'task:run-5313' ? { ...n, state: 'done' } : n)));
check('when every blocker is done the close is no longer blocked', G.effectiveState(g2, g2.byKey.get('close:sep')) !== 'blocked');
const ann = G.annotate(g);
check('annotate returns every node with impact, downstream and upstream', ann.length === nodes.length && ann.every((a) => a.impact && Array.isArray(a.downstream) && Array.isArray(a.upstream)));
check('a cycle does not hang', (() => { const c = G.buildGraph([{ key: 'a', kind: 'task', blocks: ['b'] }, { key: 'b', kind: 'task', blocks: ['a'] }]); return G.downstream(c, 'a').length === 1 && Array.isArray(G.criticalPath(c, 'a')); })());
check('empty input is safe', G.annotate(G.buildGraph([])).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
