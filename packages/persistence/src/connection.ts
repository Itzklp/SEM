import { loadConfig } from '@fraudguard/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema';

/**
 * Two pools, not one — ADR-004's bulkhead. hotPool serves fraud-api's
 * small, latency-sensitive write path (ADR-003's 7ms budget); coldPool
 * serves review-api's larger, slower query load. Sharing one pool would
 * let an expensive analyst query exhaust the connections an authorization
 * needs (NFR-007).
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

  // A Pool emits its own 'error' when an idle client errors (e.g. the server
  // going away); an unhandled EventEmitter 'error' is fatal in Node, which
  // would crash the process instead of letting it fail closed with a 503.
  // Deliberately a no-op beyond that — any in-flight query's own error is
  // handled separately where it's awaited.
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
