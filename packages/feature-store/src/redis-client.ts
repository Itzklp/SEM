import type { AppConfig } from '@fraudguard/config';
import { Redis } from 'ioredis';

/**
 * The one Redis client every hot-path consumer of this package shares.
 * `maxRetriesPerRequest: 0`-equivalent behaviour (ADR-005: NO hot-path
 * retries — a retry inside a bounded budget just consumes it, and retrying
 * into a struggling dependency is how a slowdown becomes an outage). A
 * command that doesn't complete within `REDIS_TIMEOUT_MS` fails fast; the
 * caller is responsible for the ADR-005 fallback (cautious-open), not this
 * client.
 */
/**
 * Initial TCP connection + handshake is a one-time startup cost, not a
 * per-request hot-path operation — it has no business sharing a budget
 * with `REDIS_TIMEOUT_MS` (ADR-003's steady-state command budget).
 * Originally derived as `timeoutMs * 10` (200ms): too tight for a cold
 * connection through Docker Desktop's WSL2 port-forwarding while the rest
 * of the process is also bootstrapping (Postgres pool, Nest DI graph) —
 * found via a genuinely failing integration test (`connect ETIMEDOUT`
 * against a `redis-cli ping`-healthy server), not a hypothetical.
 */
const CONNECT_TIMEOUT_MS = 5000;

export function createRedisClient(config: AppConfig): Redis {
  return new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password || undefined,
    db: config.redis.db,
    keyPrefix: config.redis.keyPrefix,
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout: config.redis.timeoutMs,
    maxRetriesPerRequest: config.redis.maxRetries,
    // Fail fast rather than queueing commands while disconnected — a
    // queued command that eventually runs is worse on the hot path than
    // one that fails immediately and hits the ADR-005 fallback.
    enableOfflineQueue: false,
    lazyConnect: false,
  });
}
