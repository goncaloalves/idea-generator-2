// Evolution autopilot: decides the next move. Pure, no DOM, no network.
//
// Not random merging: parents are picked by tournament selection on the
// judge's score, so strong ideas get more children. Now and then it "mutates"
// instead, expanding a strong idea that has not been expanded yet, which
// brings new material into the pool.

import { fitness } from './score.js';

export const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/** Ideas that can breed: judged or hand-medalled. */
export function population(ideas) {
  return ideas.filter((i) => fitness(i) != null);
}

/** Map every idea id to the Set of all its ancestor ids (parents, grandparents, ...). */
export function ancestorsOf(ideas, edges) {
  const parentsOf = new Map();
  for (const e of edges) {
    if (!parentsOf.has(e.to)) parentsOf.set(e.to, []);
    parentsOf.get(e.to).push(e.from);
  }
  const out = new Map();
  for (const i of ideas) {
    const seen = new Set();
    const queue = [...(parentsOf.get(i.id) ?? [])];
    while (queue.length) {
      const cur = queue.shift();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const p of parentsOf.get(cur) ?? []) queue.push(p);
    }
    out.set(i.id, seen);
  }
  return out;
}

/** Jaccard similarity of two ideas' lineage sets ({id} ∪ ancestors). 0 = unrelated, 1 = identical. */
export function lineageOverlap(aId, bId, ancestors) {
  const la = new Set([aId, ...(ancestors.get(aId) ?? [])]);
  const lb = new Set([bId, ...(ancestors.get(bId) ?? [])]);
  let shared = 0;
  for (const x of la) if (lb.has(x)) shared++;
  const union = la.size + lb.size - shared;
  return union ? shared / union : 0;
}

/** Pairs that must not be bred again: already combined, or any ancestor–descendant pair. */
export function usedPairs(ideas, edges) {
  const kindOf = new Map(ideas.map((i) => [i.id, i.kind]));
  const parentsOf = new Map();
  const used = new Set();
  for (const e of edges) {
    used.add(pairKey(e.from, e.to));
    if (!parentsOf.has(e.to)) parentsOf.set(e.to, []);
    parentsOf.get(e.to).push(e.from);
  }
  for (const [child, parents] of parentsOf) {
    if (kindOf.get(child) === 'combine' && parents.length === 2) used.add(pairKey(parents[0], parents[1]));
  }
  const ancestors = ancestorsOf(ideas, edges);
  for (const [id, anc] of ancestors) {
    for (const a of anc) used.add(pairKey(id, a));
  }
  return used;
}

/** Ideas that already have expand-children. */
export function expandedIds(ideas, edges) {
  const kindOf = new Map(ideas.map((i) => [i.id, i.kind]));
  const out = new Set();
  for (const e of edges) if (kindOf.get(e.to) === 'expand') out.add(e.from);
  return out;
}

/** How many combine-children each idea has already fathered. */
function combineCounts(ideas, edges) {
  const kindOf = new Map(ideas.map((i) => [i.id, i.kind]));
  const counts = new Map();
  for (const e of edges) {
    if (kindOf.get(e.to) === 'combine') counts.set(e.from, (counts.get(e.from) ?? 0) + 1);
  }
  return counts;
}

function tournament(pool, k, rng, scoreFn = fitness) {
  let best = null;
  for (let i = 0; i < k; i++) {
    const c = pool[Math.floor(rng() * pool.length)];
    if (!best || scoreFn(c) > scoreFn(best)) best = c;
  }
  return best;
}

/**
 * @param {Array} ideas  ideas on the board (with id, kind, scores)
 * @param {Array} edges  {from, to}
 * @param {object} opts  rng, busy (Set of ids being worked on), inFlight (Set of pair keys),
 *                       mutationRate, k (tournament size), maxOverlap (max lineage Jaccard overlap),
 *                       maxGenerations (highest generation autopilot may create; parents must have generation < maxGenerations),
 *                       maxIdeas (stop generating once ideas.length >= maxIdeas),
 *                       mode ('auto' | 'random')
 * @returns {{type:'combine', a, b} | {type:'expand', idea} | null}
 */
export function nextMove(ideas, edges, opts = {}) {
  const {
    rng = Math.random,
    busy = new Set(),
    inFlight = new Set(),
    mutationRate = 0.35,
    k = 3,
    maxOverlap = 0.45,
    maxGenerations = Infinity,
    maxIdeas = Infinity,
    mode = 'auto',
  } = opts;
  if (Number.isFinite(maxIdeas) && maxIdeas > 0 && ideas.length >= maxIdeas) return null;
  const genCap = Number.isFinite(maxGenerations) && maxGenerations > 0 ? maxGenerations : Infinity;
  const pool = population(ideas).filter((i) => !busy.has(i.id) && (i.generation || 0) < genCap);
  const expanded = expandedIds(ideas, edges);
  const used = usedPairs(ideas, edges);

  if (mode === 'random' || opts.strategy === 'random') {
    // 1. Branch out all base ideas (seed / guest / generation 0) first.
    const baseUnexpanded = pool.filter(
      (i) => (i.kind === 'seed' || i.kind === 'guest' || (i.generation || 0) === 0) && !expanded.has(i.id),
    );
    if (baseUnexpanded.length > 0) {
      const idea = baseUnexpanded[Math.floor(rng() * baseUnexpanded.length)];
      return { type: 'expand', idea };
    }
    // 2. Cross all ideas with each other uniformly at random (excluding already-used or ancestor-descendant pairs).
    const validPairs = [];
    for (let idxA = 0; idxA < pool.length; idxA++) {
      for (let idxB = idxA + 1; idxB < pool.length; idxB++) {
        const a = pool[idxA];
        const b = pool[idxB];
        const key = pairKey(a.id, b.id);
        if (!used.has(key) && !inFlight.has(key)) validPairs.push({ type: 'combine', a, b });
      }
    }
    if (validPairs.length > 0) {
      return validPairs[Math.floor(rng() * validPairs.length)];
    }
    // 3. Fallback: if any unexpanded idea remains within the generation cap, branch it out randomly.
    const unexpanded = pool.filter((i) => !expanded.has(i.id));
    if (unexpanded.length > 0) {
      return { type: 'expand', idea: unexpanded[Math.floor(rng() * unexpanded.length)] };
    }
    return null;
  }

  const ancestors = ancestorsOf(ideas, edges);
  const bredCount = combineCounts(ideas, edges);

  // Discount fitness for ideas that have already been heavily combined so one
  // early winner does not dominate 80% of the board's genealogy.
  const selectScore = (i) => fitness(i) - (bredCount.get(i.id) ?? 0) * 1.5;

  // Prefer expanding unexpanded seeds/guests and lower-generation ideas before
  // mutating deep combine hybrids.
  const expandPriority = (i) =>
    fitness(i) + (i.kind === 'seed' || i.kind === 'guest' ? 2.5 : 0) - (i.generation || 0) * 0.6;

  const bestUnexpanded = () =>
    [...pool].sort((a, b) => expandPriority(b) - expandPriority(a) || fitness(b) - fitness(a)).find((i) => !expanded.has(i.id));

  if (pool.length < 3 || rng() < mutationRate) {
    const idea = bestUnexpanded();
    if (idea) return { type: 'expand', idea };
  }

  if (pool.length >= 2) {
    let bestPair = null;
    let bestOverlap = Infinity;
    for (let attempt = 0; attempt < 40; attempt++) {
      const a = tournament(pool, k, rng, selectScore);
      const rest = pool.filter((i) => i.id !== a.id);
      const b = tournament(rest, k, rng, selectScore);
      const key = pairKey(a.id, b.id);
      if (used.has(key) || inFlight.has(key)) continue;
      const ov = lineageOverlap(a.id, b.id, ancestors);
      if (ov === 0) return { type: 'combine', a, b };
      if (ov < bestOverlap) {
        bestOverlap = ov;
        bestPair = { type: 'combine', a, b };
      }
    }
    // If the only available pairs are heavily inbred, prefer expanding an unexpanded idea first.
    if (bestPair && bestOverlap <= maxOverlap) return bestPair;
    const fallbackExpand = bestUnexpanded();
    if (fallbackExpand) return { type: 'expand', idea: fallbackExpand };
    if (bestPair) return bestPair;
  }

  const idea = bestUnexpanded();
  return idea ? { type: 'expand', idea } : null;
}

/**
 * Has quality moved? Mean fitness of the first and the latest `window` bred
 * ideas (seeds and guests excluded: a bare topic scores low by design and
 * would flatter the climb, and guests were bred on another board), plus the best so far.
 */
export function evolutionStats(ideas, window = 8) {
  const bred = ideas
    .filter((i) => i.kind !== 'seed' && i.kind !== 'guest' && fitness(i) != null)
    .sort((a, b) => a.id - b.id);
  const mean = (xs) => (xs.length ? xs.reduce((s, i) => s + fitness(i), 0) / xs.length : null);
  const generation = ideas.reduce((g, i) => Math.max(g, i.generation || 0), 0);
  return {
    count: bred.length,
    generation,
    first: mean(bred.slice(0, window)),
    latest: bred.length > window ? mean(bred.slice(-window)) : null,
    best: bred.length ? Math.max(...bred.map(fitness)) : null,
  };
}
