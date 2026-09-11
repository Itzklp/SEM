import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';

/**
 * The "in-memory feature store for unit tests" deliverable (Phase 4,
 * docs/ROADMAP.md) — realised as a shared helper rather than a hand-rolled
 * fake, so `packages/feature-store` and every later package that needs a
 * Redis double (Phase 5's rule engine, most likely) use the same one.
 *
 * `ioredis-mock` emulates ioredis's command surface (including
 * `.pipeline()`) against an in-process store, so the exact same
 * `getFeatureVector`/`recordTransactionFeatures` code under test runs
 * unmodified against this as it does against a real Redis — only the
 * transport is swapped. It does NOT implement every ioredis command (no
 * HyperLogLog, notably — part of why `packages/feature-store` uses exact
 * Set-based distinct counts rather than PFADD/PFCOUNT; see
 * `feature-definitions.ts`). `@types/ioredis-mock` types its constructor
 * loosely enough that this function's `Redis` return annotation is what
 * actually pins the type down for every caller — true for every command
 * this package calls, which is what the co-located tests exercise.
 *
 * Each call returns an independently-isolated store. `ioredis-mock`
 * otherwise keys its in-memory state by `host:port/db` (to emulate
 * multiple real clients sharing one real Redis server) — meaning two
 * bare `new RedisMock()` calls with no options **share state**, not
 * isolate it. Caught live: every test using this helper passed in
 * isolation but failed when run as a suite, because every test's
 * "fresh" mock was secretly the previous test's mock. A unique `host`
 * per instance forces a distinct key, which is what every caller of a
 * function named `createInMemoryRedis` actually wants.
 */
let instanceCounter = 0;

export function createInMemoryRedis(): Redis {
  instanceCounter += 1;
  return new RedisMock({ data: {}, host: `in-memory-${instanceCounter}`, port: 6379 });
}
