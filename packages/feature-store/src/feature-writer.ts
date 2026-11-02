import type { FraudDecision, Transaction } from '@fraudguard/domain';
import { measure, redisDurationSeconds } from '@fraudguard/observability';
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
 * FR-002's write side — what event-worker's feature-update consumer runs
 * for every transaction.decided event. Also the replay/rebuild mechanism
 * (ADR-002): replaying a transaction's original (transaction, decision)
 * pair through this same function, in order, is what "rebuild from
 * replay" means — there is no separate replay path to drift from the live one.
 *
 * Two assumptions worth stating: failed_transactions_10m counts this
 * system's own BLOCK decisions, not a payment-gateway decline (no such
 * concept exists here); ipAddress stands in for "location" since there's
 * no geo-IP lookup in scope.
 *
 * Idempotent by construction — every write is a ZADD/HSET keyed by
 * transactionId or a SETNX, so a duplicate delivery changes nothing.
 */
export async function recordTransactionFeatures(
  redis: Redis,
  transaction: Transaction,
  decision: FraudDecision,
): Promise<void> {
  await measure(
    {
      span: 'redis.feature_write',
      histogram: redisDurationSeconds,
      labels: { operation: 'feature_write' },
    },
    async () => {
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
    },
  );
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
