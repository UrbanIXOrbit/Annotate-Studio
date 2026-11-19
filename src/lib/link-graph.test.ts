import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLinkIndex,
  countDegrees,
  extractLinks,
  graphLayout,
  lineForLink,
  resolveLinks,
  type LayoutEdge,
  type LayoutNode,
  type LinkDoc,
} from './link-graph.ts';

test('extractLinks collects wiki-link targets, ignoring markdown links', () => {
  const md = [
    'Start [[Alpha]] then [[Beta|a pretty label]].',
    'A [regular link](https://example.com) is not a wiki link.',
    'Wrap [[Gamma]] in **bold [[Delta]]** and *em [[Epsilon]]*.',
    'Fragment [[Zeta#Section]] is kept verbatim (resolution strips it).',
    'Broken line [[ ]]\n[[Omega]]',
  ].join('\n');
  assert.deepEqual(extractLinks(md), ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta#Section', 'Omega']);
});

test('extractLinks returns duplicates (one row per mention)', () => {
  assert.deepEqual(extractLinks('[[Alpha]] and [[Alpha]]'), ['Alpha', 'Alpha']);
});

test('buildLinkIndex indexes every mention from every doc', () => {
  const docs: LinkDoc[] = [
    { path: '/a.md', title: 'A', markdown: 'see [[B]] and [[C]]' },
    { path: '/b.md', title: 'B', markdown: 'back to [[a]]' },
  ];
  const index = buildLinkIndex(docs);
  assert.equal(index.docs.size, 2);
  assert.deepEqual(index.raw, [
    { from: '/a.md', target: 'B' },
    { from: '/a.md', target: 'C' },
    { from: '/b.md', target: 'a' },
  ]);
});

test('resolveLinks resolves at query time and builds backlinks', () => {
  const docs: LinkDoc[] = [
    { path: '/a.md', title: 'A', markdown: 'see [[B]] and [[Ghost]]' },
    { path: '/b.md', title: 'B', markdown: 'back to [[a]] and [[a]]' },
  ];
  const index = buildLinkIndex(docs);
  const resolve = (target: string) => {
    const name = target.toLowerCase();
    if (name === 'b') return '/b.md';
    if (name === 'a') return '/a.md';
    return null;
  };
  const { outgoing, backlinks, unresolved } = resolveLinks(index, resolve);

  assert.equal(outgoing.get('/a.md')!.length, 2);
  assert.equal(outgoing.get('/a.md')![0].resolved, true);
  assert.equal(outgoing.get('/a.md')![1].resolved, false);

  // Backlinks are case-insensitive at resolution time: [[a]] hits /a.md.
  assert.deepEqual(backlinks.get('/a.md')!.map((link) => link.from), ['/b.md', '/b.md']);
  assert.deepEqual(backlinks.get('/b.md')!.map((link) => link.from), ['/a.md']);

  // Unresolved targets are deduped case-insensitively, display-cased.
  assert.deepEqual(unresolved, ['Ghost']);
});

test('resolveLinks ignores self-links as backlinks', () => {
  const index = buildLinkIndex([{ path: '/a.md', title: 'A', markdown: 'self [[a]] and [[B]]' }]);
  const { backlinks } = resolveLinks(index, (target) => (target.toLowerCase() === 'b' ? '/a.md' : null));
  assert.equal(backlinks.has('/a.md'), false);
});

test('lineForLink finds the line containing the mention', () => {
  const md = 'intro\n\nsome line with [[Target|label]] in it\n\ntrailing';
  assert.equal(lineForLink(md, 'Target'), 'some line with [[Target|label]] in it');
  // Fragments match on the target part only.
  assert.equal(lineForLink('go [[Other#Section]] now', 'Other#Section'), 'go [[Other#Section]] now');
  assert.equal(lineForLink('nothing here', 'Missing'), '');
});

test('graphLayout is deterministic, places every node in bounds', () => {
  const nodes: LayoutNode[] = Array.from({ length: 12 }, (_, i) => ({ id: `/n${i}.md`, weight: (i % 3) + 1 }));
  const edges: LayoutEdge[] = [
    { from: '/n0.md', to: '/n1.md' },
    { from: '/n0.md', to: '/n2.md' },
    { from: '/n1.md', to: '/n3.md' },
    { from: '/n3.md', to: '/n4.md' },
    { from: '/n5.md', to: '/n2.md' },
  ];
  const first = graphLayout(nodes, edges, { width: 800, height: 560 });
  const second = graphLayout(nodes, edges, { width: 800, height: 560 });
  assert.equal(first.size, nodes.length);
  for (const [id, point] of first) {
    assert.deepEqual(second.get(id), point);
    assert.ok(point.x >= 0 && point.x <= 800, `x in bounds for ${id}`);
    assert.ok(point.y >= 0 && point.y <= 560, `y in bounds for ${id}`);
  }
  // Connected pairs end up closer than random unconnected ones on average.
  const dist = (a: string, b: string) => Math.hypot(first.get(a)!.x - first.get(b)!.x, first.get(a)!.y - first.get(b)!.y);
  const edgeDist = (dist('/n0.md', '/n1.md') + dist('/n0.md', '/n2.md') + dist('/n3.md', '/n4.md')) / 3;
  const farDist = (dist('/n1.md', '/n5.md') + dist('/n4.md', '/n6.md')) / 2;
  assert.ok(edgeDist < farDist, `edge distance ${edgeDist} should beat non-edge ${farDist}`);
});

test('graphLayout handles empty and disconnected input', () => {
  assert.equal(graphLayout([], []).size, 0);
  const single = graphLayout([{ id: 'only' }], []);
  assert.equal(single.size, 1);
  assert.ok(single.get('only')!.x >= 0 && single.get('only')!.x <= 800);
});

test('countDegrees counts both endpoints of resolved links', () => {
  const degrees = countDegrees([
    { from: '/a.md', to: '/b.md', target: 'B', resolved: true },
    { from: '/a.md', to: 'Ghost', target: 'Ghost', resolved: false },
  ]);
  // Unresolved mentions don't contribute degree; the ghost edge is drawn by
  // the graph view itself.
  assert.deepEqual([...degrees.entries()], [
    ['/a.md', 1],
    ['/b.md', 1],
  ]);
});

test('extractLinks ignores wiki links inside tilde code fences', () => {
  const md = `Real [[Chapter One]] link.

~~~markdown
Not a link: [[Phantom Target]]
~~~
`;
  assert.deepEqual(extractLinks(md), ['Chapter One']);
});
