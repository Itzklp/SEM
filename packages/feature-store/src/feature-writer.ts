import type { FraudDecision, Transaction } from '@fraudguard/domain';
import type { Redis } from 'ioredis';

import { DEVICE_RETENTION_MS, MAX_USER_WINDOW_MS } from './feature-definitions';
import {
  accountFirstSeenKey,
  deviceLogKey,
  userAmountKey,
  userEventLogKey,
  userFailedLogKey,
  userLocationKey,
  userMerchantKey,
} from './keys';

/**
 * FR-002's write side — the logic an `event-worker` "feature-update"
 * consumer runs for every `transaction.decided` event
 * (docs/architecture/kafka-topics.md). Phase 6 owns the actual Kafka
 * consumer and the outbox that feeds it; this function is that
 * consumer's entire body, built and proven now so Phase 6's job is
 * "call this from a Kafka handler", not "design this". It is also,
 * unmodified, the replay mechanism (docs/adr/ADR-002-redis-feature-store.md's
 * "that rebuild path must actually be implemented and tested"): replaying
 * a transaction's original (transaction, decision) pair through this same
 * function, in original order, is what "rebuild from replay" means here —
 * there is no separate replay code path that could drift from the live
 * one. See `feature-reader.test.ts`'s rebuild-from-replay test.
 *
 * ASSUMED: `failed_transactions_10m` counts transactions this system
 * BLOCKed, not a payment-gateway decline — FraudGuard has no concept of a
 * card-issuer decline, only a fraud decision. Recorded as an explicit
 * assumption rather than a silent guess.
 *
 * ASSUMED: `ipAddress` stands in for "location" (`distinct_locations_24h`)
 * — there is no geo-IP lookup in this system's scope, so "a distinct IP"
 * is the closest available proxy for "a distinct location".
 *
 * Idempotent by construction, which is what makes this safe to call twice
 * for the same event (at-least-once delivery, FR-017-adjacent): every
 * write is a `ZADD`/`HSET` keyed by `transactionId` (re-applying the same
 * member updates it in place rather than duplicating it) or a `SETNX`
 * (a no-op once set). A duplicate delivery changes nothing.
 */
export async function recordTransactionFeatures(
  redis: Redis,
  transaction: Transaction,
  decision: FraudDecision,
): Promise<void> {
  const { userId, deviceId, transactionId } = transaction;
  const ts = transaction.timestamp.getTime();

  const write = redis.pipeline();
  write.zadd(userEventLogKey(userId), ts, transactionId);
  write.hset(userAmountKey(userId), transactionId, String(transaction.amount.minorUnits));
  write.hset(userMerchantKey(userId), transactionId, transaction.merchantId);
  write.hset(userLocationKey(userId), transactionId, transaction.ipAddress);
  write.zadd(deviceLogKey(deviceId), ts, transactionId);
  write.setnx(accountFirstSeenKey(userId), String(ts));
  if (decision.decision === 'BLOCK') {
    write.zadd(userFailedLogKey(userId), ts, transactionId);
  }
  await write.exec();

  // Trimming is anchored to the *event's own* timestamp, not wall-clock
  // "now" — deliberately. A replay run happens later in wall-clock time
  // than the events it replays; trimming against `Date.now()` would then
  // discard more than the live run did, and the rebuild would NOT
  // reproduce the same state. Anchoring to `ts` makes trimming a pure
  // function of the event stream, which is what "replayable" requires.
  await trimUserWindow(redis, userId, ts);
  await trimDeviceWindow(redis, deviceId, ts);
}

/** Drops event-log entries (and their parallel hash fields) older than the longest feature window — nothing further back is ever read. */
async function trimUserWindow(redis: Redis, userId: string, referenceTs: number): Promise<void> {
  const cutoff = referenceTs - MAX_USER_WINDOW_MS;
  const logKey = userEventLogKey(userId);
  const expired = await redis.zrangebyscore(logKey, '-inf', cutoff);

  const write = redis.pipeline();
  if (expired.length > 0) {
    write.hdel(userAmountKey(userId), ...expired);
    write.hdel(userMerchantKey(userId), ...expired);
    write.hdel(userLocationKey(userId), ...expired);
    write.zremrangebyscore(logKey, '-inf', cutoff);
  }
  write.zremrangebyscore(userFailedLogKey(userId), '-inf', cutoff);
  await write.exec();
}

/** `device_transaction_count` has no catalogue window (ASSUMED retention — see DEVICE_RETENTION_MS). */
async function trimDeviceWindow(
  redis: Redis,
  deviceId: string,
  referenceTs: number,
): Promise<void> {
  await redis.zremrangebyscore(deviceLogKey(deviceId), '-inf', referenceTs - DEVICE_RETENTION_MS);
}
