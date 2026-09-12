import { loadConfig } from '@fraudguard/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema';

/**
 * Two pools, not one — the bulkhead from ADR-004. `hotPool` serves
 * `fraud-api`'s write path (small, bounded, latency-sensitive: the write
 * budget is 7ms per ADR-003). `coldPool` serves `review-api`'s query load
 * (Phase 6+) — larger, slower, unbounded query shapes. Sharing one pool
 * would let one expensive analyst query exhaust the connections an
 * authorization needs (NFR-007), which is exactly the failure this
 * separation exists to prevent.
 */
export function createPools(config = loadConfig()): { hotPool: Pool; coldPool: Pool } {
  const hotPool = new Pool({
    host: config.postgres.host,
    port: config.postgres.port,
    database: config.postgres.database,
    user: config.postgres.user,
    password: config.postgres.password,
    ssl: config.postgres.ssl,
    max: config.postgres.poolHotMax,
    statement_timeout: config.postgres.statementTimeoutMs,
  });

  const coldPool = new Pool({
    host: config.postgres.host,
    port: config.postgres.port,
    database: config.postgres.database,
    user: config.postgres.user,
    password: config.postgres.password,
    ssl: config.postgres.ssl,
    max: config.postgres.poolColdMax,
    // Cold-path queries are allowed to run longer than the hot-path budget
    // — this is a query-safety ceiling, not a latency target.
    statement_timeout: 5000,
  });

  // node-postgres's documented gotcha, found live by Phase 8's PostgreSQL
  // resilience test before it was added here: a `Pool` emits its own
  // `'error'` event when an IDLE pooled client errors (e.g. the server
  // going away) — not the same thing as a `.query()` call rejecting. An
  // EventEmitter's `'error'` event with no listener is fatal in Node
  // (it rethrows, crashing the process). Without this handler, stopping
  // Postgres with an idle connection sitting in the pool would crash
  // `fraud-api` outright — the opposite of ADR-005's "fail closed with a
  // 503", which requires the PROCESS to stay up to return that 503 at
  // all. Deliberately a no-op beyond not crashing: there is no in-flight
  // query to fail here (that error surfaces separately, to whichever
  // `.query()` call was actually pending, and IS handled there —
  // `ScoringService.persistOrFailClosed`); the pool itself already
  // removes the dead client and opens a new one on the next checkout.
  hotPool.on('error', () => undefined);
  coldPool.on('error', () => undefined);

  return { hotPool, coldPool };
}

export interface PersistenceContext {
  readonly hotPool: Pool;
  readonly coldPool: Pool;
  readonly hotDb: NodePgDatabase<typeof schema>;
  readonly coldDb: NodePgDatabase<typeof schema>;
}

export function createPersistenceContext(config = loadConfig()): PersistenceContext {
  const { hotPool, coldPool } = createPools(config);
  return {
    hotPool,
    coldPool,
    hotDb: drizzle(hotPool, { schema }),
    coldDb: drizzle(coldPool, { schema }),
  };
}

export async function closePersistenceContext(ctx: PersistenceContext): Promise<void> {
  await Promise.all([ctx.hotPool.end(), ctx.coldPool.end()]);
}
