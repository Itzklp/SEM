import { measure, redisDurationSeconds } from '@fraudguard/observability';
import type { Redis } from 'ioredis';

/**
 * FR-017 fast path: has this `transactionId` already been scored?
 *
 * Deliberately generic over the cached payload shape rather than importing
 * a DTO type — this package sits below `packages/contracts` in the
 * dependency graph (ADR-004), and the caller (fraud-api) is the one that
 * knows what shape a "cached decision" actually is.
 *
 * Throws on any Redis failure rather than swallowing it — ADR-005's
 * cautious-open policy is a decision the caller must make explicitly
 * (flip to degraded mode, record the reason), not something this package
 * should decide silently. The `TransactionRepository`'s unique-violation
 * backstop (packages/persistence) is what keeps FR-017 correct even when
 * the caller can't check this at all.
 */

export async function getIdempotentResult<T>(
  redis: Redis,
  transactionId: string,
): Promise<T | null> {
  return measure(
    {
      span: 'redis.idempotency_get',
      histogram: redisDurationSeconds,
      labels: { operation: 'idempotency_get' },
    },
    async () => {
      const raw = await redis.get(idempotencyKey(transactionId));
      return raw === null ? null : (JSON.parse(raw) as T);
    },
  );
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- symmetry with getIdempotentResult<T> above; T documents "this is the same shape you'll read back", not just `unknown`.
export async function storeIdempotentResult<T>(
  redis: Redis,
  transactionId: string,
  result: T,
  ttlSeconds: number,
): Promise<void> {
  await measure(
    {
      span: 'redis.idempotency_set',
      histogram: redisDurationSeconds,
      labels: { operation: 'idempotency_set' },
    },
    () => redis.set(idempotencyKey(transactionId), JSON.stringify(result), 'EX', ttlSeconds),
  );
}

function idempotencyKey(transactionId: string): string {
  return `idem:${transactionId}`;
}
