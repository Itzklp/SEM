/**
 * Mulberry32 — a small, dependency-free, deterministic PRNG. Not
 * cryptographically secure and not meant to be: FR-018 needs *reproducible*
 * randomness (same seed → identical sequence), which is the opposite
 * property of what a CSPRNG guarantees.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic integer in [min, max]. */
export function randomInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[randomInt(rng, 0, items.length - 1)];
  if (item === undefined) {
    throw new Error('pick() called with an empty array');
  }
  return item;
}
