import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampScore, fitness, medal, medalFromSum, scoreSum } from '../public/js/score.js';
import { ancestorsOf, evolutionStats, expandedIds, lineageOverlap, nextMove, pairKey, usedPairs } from '../public/js/evolve.js';
import { saturatedTerms } from '../server/llm.ts';

const idea = (id: number, sum: number | null, extra: any = {}) => {
  const base: any = { id, kind: 'expand', generation: 1, medalOverride: null, ...extra };
  if (sum != null) {
    // spread the sum over three 1–5 scores
    const o = Math.min(5, sum - 2), f = Math.min(5, sum - o - 1), i = sum - o - f;
    Object.assign(base, { originality: o, feasibility: f, impact: i });
  }
  return base;
};

// Deterministic PRNG (mulberry32) so statistical tests are stable.
const rngFrom = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

test('medal thresholds on the 3–15 sum', () => {
  assert.equal(medalFromSum(null), null);
  assert.deepEqual([3, 8, 9, 10, 11, 12, 13, 15].map(medalFromSum), [0, 0, 1, 1, 2, 2, 3, 3]);
});

test('scores are clamped to whole numbers 1–5', () => {
  assert.deepEqual([0, 1, 2.6, 5, 9, 'x', null].map(clampScore), [1, 1, 3, 5, 5, 1, 1]);
});

test('the helper builds the sum it was asked for', () => {
  for (let s = 3; s <= 15; s++) assert.equal(scoreSum(idea(1, s)), s);
});

test('a hand-set medal beats the judge, for display and for breeding', () => {
  const i = idea(1, 6, { medalOverride: 3 });
  assert.equal(medal(i), 3);
  assert.equal(fitness(i), 14);
  assert.equal(medal(idea(2, null)), null);
  assert.equal(fitness(idea(2, null)), null);
});

test('pairs already combined, and parent–child pairs, are not bred again', () => {
  const ideas = [idea(1, 9), idea(2, 9), idea(3, 12, { kind: 'combine' })];
  const edges = [{ from: 1, to: 3 }, { from: 2, to: 3 }];
  const used = usedPairs(ideas, edges);
  assert.ok(used.has(pairKey(1, 2)), 'parents of a combination');
  assert.ok(used.has(pairKey(1, 3)), 'parent and child');
  for (let s = 0; s < 200; s++) {
    const m = nextMove(ideas, edges, { rng: rngFrom(s), mutationRate: 0 });
    if (m?.type === 'combine') {
      assert.ok(!used.has(pairKey(m.a.id, m.b.id)), `bred a used pair ${m.a.id}-${m.b.id}`);
    }
  }
});

test('never combines an idea with itself and skips busy ideas and in-flight pairs', () => {
  const ideas = [idea(1, 10), idea(2, 11), idea(3, 12), idea(4, 13)];
  for (let s = 0; s < 300; s++) {
    const m = nextMove(ideas, [], {
      rng: rngFrom(s), mutationRate: 0, busy: new Set([4]), inFlight: new Set([pairKey(2, 3)]),
    });
    assert.equal(m?.type, 'combine');
    assert.notEqual(m.a.id, m.b.id);
    assert.ok(m.a.id !== 4 && m.b.id !== 4, 'used a busy idea');
    assert.notEqual(pairKey(m.a.id, m.b.id), pairKey(2, 3));
  }
});

test('selection favours fitter parents', () => {
  const ideas = Array.from({ length: 10 }, (_, n) => idea(n + 1, 4 + n)); // sums 4..13
  const count = new Map<number, number>();
  const rng = rngFrom(42);
  for (let n = 0; n < 4000; n++) {
    const m = nextMove(ideas, [], { rng, mutationRate: 0 });
    for (const p of [m.a, m.b]) count.set(p.id, (count.get(p.id) ?? 0) + 1);
  }
  const best = count.get(10) ?? 0;
  const worst = count.get(1) ?? 0;
  assert.ok(best > worst * 5, `best ${best} vs worst ${worst}`);
});

test('a small population is grown by expanding its best unexpanded idea', () => {
  const ideas = [idea(1, 5, { kind: 'seed' }), idea(2, 9, { kind: 'seed' })];
  const m = nextMove(ideas, [], { rng: rngFrom(1) });
  assert.equal(m?.type, 'expand');
  assert.equal(m.idea.id, 2);
  const ideas2 = [...ideas, idea(3, 7), idea(4, 7), idea(5, 7)];
  const edges = [3, 4, 5].map((to) => ({ from: 2, to }));
  assert.deepEqual([...expandedIds(ideas2, edges)], [2]);
});

test('nothing to do on an empty board', () => {
  assert.equal(nextMove([], []), null);
  assert.equal(nextMove([idea(1, null)], []), null);
});

test('evolution stats leave seeds out and compare first and latest windows', () => {
  const ideas = [
    idea(1, 3, { kind: 'seed', generation: 0 }),
    ...Array.from({ length: 8 }, (_, n) => idea(n + 2, 8)),
    ...Array.from({ length: 8 }, (_, n) => idea(n + 10, 12, { generation: 5 })),
  ];
  const s = evolutionStats(ideas);
  assert.equal(s.count, 16);
  assert.equal(s.first, 8);
  assert.equal(s.latest, 12);
  assert.equal(s.best, 12);
  assert.equal(s.generation, 5);
  assert.equal(evolutionStats(ideas.slice(0, 5)).latest, null, 'no "latest" until there is more than one window');
});

test('inbreeding protection: blocks grandparents, prefers unrelated lineages, and expands seeds before deep hybrids', () => {
  // Seed 1 -> expand 2 -> expand 3 (grandchild of 1); Seed 10 -> expand 11
  const ideas = [
    idea(1, 9, { kind: 'seed', generation: 0 }),
    idea(2, 11, { kind: 'expand', generation: 1 }),
    idea(3, 12, { kind: 'expand', generation: 2 }),
    idea(4, 11, { kind: 'expand', generation: 1 }),
    idea(10, 8, { kind: 'seed', generation: 0 }),
    idea(11, 10, { kind: 'expand', generation: 1 }),
  ];
  const edges = [
    { from: 1, to: 2 },
    { from: 1, to: 4 },
    { from: 2, to: 3 },
    { from: 10, to: 11 },
  ];
  const used = usedPairs(ideas, edges);
  assert.ok(used.has(pairKey(1, 3)), 'grandparent and grandchild are never combined');

  const anc = ancestorsOf(ideas, edges);
  assert.equal(lineageOverlap(3, 11, anc), 0, 'separate seed trees have 0 overlap');
  assert.ok(lineageOverlap(2, 4, anc) > 0, 'siblings share lineage overlap');

  // When combining with mutationRate=0, unrelated cross-tree pairs win over sibling/cousin pairs.
  const rng = rngFrom(7);
  for (let i = 0; i < 50; i++) {
    const m = nextMove(ideas, edges, { rng, mutationRate: 0 });
    assert.equal(m?.type, 'combine');
    assert.equal(lineageOverlap(m.a.id, m.b.id, anc), 0, `expected cross-tree pair, got ${m.a.id}-${m.b.id}`);
  }

  // Unexpanded seed (id 5, score 9, gen 0) beats a high-generation combine hybrid (id 6, score 10, gen 5) for expansion.
  const expPool = [
    idea(5, 9, { kind: 'seed', generation: 0 }),
    idea(6, 10, { kind: 'combine', generation: 5 }),
  ];
  const em = nextMove(expPool, [], { rng: rngFrom(1), mutationRate: 1 });
  assert.equal(em?.type, 'expand');
  assert.equal(em.idea.id, 5, 'unexpanded seed is expanded before a deep hybrid');
});

test('saturatedTerms flags words overused across board titles', () => {
  assert.deepEqual(saturatedTerms(['A', 'B', 'C']), [], 'too few titles');
  const titles = [
    'Exact Timer Loop',
    'Preset Timer Loop',
    'Embed Timer Loop',
    'Ambient Timer Flywheel',
    'Study Timer Loop',
    'Focus Widget',
    'Offline Clock',
    'Kitchen Bell',
  ];
  const sat = saturatedTerms(titles);
  assert.ok(sat.includes('timer') && sat.includes('loop'), `expected timer & loop in ${sat.join(',')}`);
  assert.ok(!sat.includes('kitchen'), 'rare words are not flagged');
});

test('maxGenerations caps which ideas can be expanded or combined', () => {
  const ideas = [
    idea(1, 10, { kind: 'seed', generation: 0 }),
    idea(2, 12, { kind: 'expand', generation: 2 }),
    idea(3, 13, { kind: 'combine', generation: 3 }),
  ];
  // With maxGenerations: 2, only generation 0 and 1 are eligible parents; gen 2 and 3 are excluded.
  const m = nextMove(ideas, [], { rng: rngFrom(1), maxGenerations: 2 });
  assert.equal(m?.type, 'expand');
  assert.equal(m.idea.id, 1, 'only generation < 2 can be expanded');

  // Once idea 1 is also expanded and no other idea is below generation 2, nextMove returns null.
  const edges = [{ from: 1, to: 2 }];
  assert.equal(nextMove(ideas, edges, { rng: rngFrom(1), maxGenerations: 2 }), null);
});

test('maxIdeas stops nextMove once the board has reached the idea limit', () => {
  const ideas = [
    idea(1, 10, { kind: 'seed', generation: 0 }),
    idea(2, 11, { kind: 'seed', generation: 0 }),
    idea(3, 12, { kind: 'expand', generation: 1 }),
  ];
  assert.equal(nextMove(ideas, [], { rng: rngFrom(1), maxIdeas: 3 }), null, 'at maxIdeas limit');
  assert.equal(nextMove(ideas, [], { rng: rngFrom(1), maxIdeas: 2 }), null, 'above maxIdeas limit');
  assert.notEqual(nextMove(ideas, [], { rng: rngFrom(1), maxIdeas: 4 }), null, 'below maxIdeas limit');
});

test('random mode branches all base ideas first, then crosses all ideas uniformly at random', () => {
  const seeds = [
    idea(1, 5, { kind: 'seed', generation: 0 }),
    idea(2, 14, { kind: 'seed', generation: 0 }),
    idea(3, 8, { kind: 'guest', generation: 0 }),
    idea(4, 15, { kind: 'expand', generation: 1 }),
  ];
  // When only seed 2 is expanded so far, random mode must expand seeds 1 and 3 before doing any combine
  const edges = [{ from: 2, to: 4 }];
  for (let s = 0; s < 50; s++) {
    const m = nextMove(seeds, edges, { rng: rngFrom(s), mode: 'random' });
    assert.equal(m?.type, 'expand', 'must expand unexpanded base ideas first');
    assert.ok(m.idea.id === 1 || m.idea.id === 3, `expected base idea 1 or 3, got ${m.idea.id}`);
  }

  // Once all base ideas (1, 2, 3) have expand children, random mode crosses all eligible pairs uniformly
  const allExpandedIdeas = [
    ...seeds,
    idea(5, 6, { kind: 'expand', generation: 1 }),
    idea(6, 7, { kind: 'expand', generation: 1 }),
  ];
  const allExpandedEdges = [
    { from: 2, to: 4 },
    { from: 1, to: 5 },
    { from: 3, to: 6 },
  ];
  const pairCounts = new Map<string, number>();
  const rng = rngFrom(99);
  for (let n = 0; n < 1200; n++) {
    const m = nextMove(allExpandedIdeas, allExpandedEdges, { rng, mode: 'random' });
    assert.equal(m?.type, 'combine', 'once all base ideas are expanded, random mode crosses ideas');
    const k = pairKey(m.a.id, m.b.id);
    pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1);
  }
  // Low-scoring seed 1 (sum 5) and guest 3 (sum 8) should be crossed just as often as high-scoring ideas
  assert.ok((pairCounts.get(pairKey(1, 3)) ?? 0) > 50, 'low-score base pair 1-3 is crossed frequently in random mode');
  assert.ok((pairCounts.get(pairKey(5, 6)) ?? 0) > 50, 'branch children 5-6 are crossed with each other');
  assert.equal(pairCounts.get(pairKey(1, 5)) ?? 0, 0, 'parent-child pair 1-5 is never crossed');
});
