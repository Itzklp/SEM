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
