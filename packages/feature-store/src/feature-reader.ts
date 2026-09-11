import { type FeatureVector } from '@fraudguard/domain';
import { measure, redisDurationSeconds } from '@fraudguard/observability';
import type { Redis } from 'ioredis';

import { FEATURE_DEFAULTS, MS } from './feature-definitions';
import {
  accountFirstSeenKey,
  deviceLogKey,
  ipRiskKey,
  merchantRiskKey,
  userAmountKey,
  userEventLogKey,
  userFailedLogKey,
  userLocationKey,
  userMerchantKey,
} from './keys';

export interface FeatureLookupInput {
  readonly userId: string;
  readonly deviceId: string;
  readonly merchantId: string;
  readonly ipAddress: string;
}

/** HMGET requires at least one field; substituted when a window has no members so the pipelined call stays well-formed. The result is never read back for this sentinel. */
const SENTINEL_FIELD = '__none__';

/**
 * FR-002's read side — the hot path's one call into the feature store.
 *
 * ADR-002 calls for "one pipelined round trip, not N" and this function
 * needs two: the amount-sum/average/distinct features require knowing
 * *which* transactions fall in a window before their details (amount,
 * merchant, IP) can be looked up, and Redis has no single command that
 * does both. Two fixed round trips — not one per feature — is still the
 * property that matters architecturally: an twelfth feature added to the
 * catalogue does not add a thirteenth round trip. Documented as two,
 * honestly, rather than claimed as the one round trip ADR-002 describes.
 *
 * `asOf` defaults to "now" for every real caller (the hot path always
 * wants the current instant). It is a parameter, not a hardcoded
 * `Date.now()`, solely so a rebuild-from-replay test can ask "what did
 * the vector look like at the moment the original run read it" — a
 * replay executed later in wall-clock time has no other way to ask that
 * question. See `feature-writer.ts`'s event-time-anchored trimming, which
 * exists for the identical reason.
 *
 * Throws on Redis failure rather than returning a default vector itself —
 * mirrors `idempotency.ts`'s documented reasoning: ADR-005's
 * cautious-open fallback is a decision the caller (`scoring.service.ts`)
 * must make explicitly, not something this package decides silently.
 */
export async function getFeatureVector(
  redis: Redis,
  input: FeatureLookupInput,
  asOf: Date = new Date(),
): Promise<FeatureVector> {
  return measure(
    {
      span: 'redis.feature_fetch',
      histogram: redisDurationSeconds,
      labels: { operation: 'feature_fetch' },
    },
    () => doGetFeatureVector(redis, input, asOf),
  );
}

async function doGetFeatureVector(
  redis: Redis,
  input: FeatureLookupInput,
  asOf: Date,
): Promise<FeatureVector> {
  const now = asOf.getTime();
  const { userId, deviceId, merchantId, ipAddress } = input;
  const logKey = userEventLogKey(userId);

  const first = redis.pipeline();
  first.zcount(logKey, now - 5 * MS.MINUTE, now);
  first.zcount(logKey, now - MS.HOUR, now);
  first.zrangebyscore(logKey, now - MS.HOUR, now);
  first.zrangebyscore(logKey, now - MS.DAY, now);
  first.zcount(userFailedLogKey(userId), now - 10 * MS.MINUTE, now);
  first.zcard(deviceLogKey(deviceId));
  first.get(accountFirstSeenKey(userId));
  first.get(merchantRiskKey(merchantId));
  first.get(ipRiskKey(ipAddress));
  const [
    count5m,
    count1h,
    ids1hRaw,
    ids24hRaw,
    failedCount,
    deviceCount,
    firstSeenRaw,
    merchantRiskRaw,
    ipRiskRaw,
  ] = unwrapPipeline(await first.exec());

  const ids1h = ids1hRaw as string[];
  const ids24h = ids24hRaw as string[];

  const second = redis.pipeline();
  second.hmget(userAmountKey(userId), ...hmgetFields(ids1h));
  second.hmget(userAmountKey(userId), ...hmgetFields(ids24h));
  second.hmget(userMerchantKey(userId), ...hmgetFields(ids1h));
  second.hmget(userLocationKey(userId), ...hmgetFields(ids24h));
  const [amounts1hRaw, amounts24hRaw, merchants1hRaw, locations24hRaw] = unwrapPipeline(
    await second.exec(),
  );

  const amounts1h = ids1h.length > 0 ? (amounts1hRaw as (string | null)[]) : [];
  const amounts24h = ids24h.length > 0 ? (amounts24hRaw as (string | null)[]) : [];
  const merchants1h = ids1h.length > 0 ? (merchants1hRaw as (string | null)[]) : [];
  const locations24h = ids24h.length > 0 ? (locations24hRaw as (string | null)[]) : [];

  const firstSeenMs = firstSeenRaw !== null ? Number(firstSeenRaw) : null;

  return {
    userId,
    computedAt: new Date(),
    source: 'live',
    features: {
      transaction_count_5m: count5m as number,
      transaction_count_1h: count1h as number,
      // Stored (and summed) as integer minor units — Money's own
      // representation, avoiding any floating-point summation — then
      // converted once, here, to major units. `Money.toMajorUnits()`'s
      // doc comment is explicit that major units are "for ... feature
      // computation only, never for storage or comparison", which is
      // exactly the line this division sits on.
      amount_sum_1h: sumNumeric(amounts1h) / 100,
      average_amount_24h: average(amounts24h) / 100,
      distinct_merchants_1h: distinctCount(merchants1h),
      distinct_locations_24h: distinctCount(locations24h),
      failed_transactions_10m: failedCount as number,
      device_transaction_count: deviceCount as number,
      account_age_days:
        firstSeenMs !== null
          ? Math.max(0, (now - firstSeenMs) / MS.DAY)
          : FEATURE_DEFAULTS.account_age_days,
      merchant_risk_score:
        merchantRiskRaw !== null ? Number(merchantRiskRaw) : FEATURE_DEFAULTS.merchant_risk_score,
      ip_risk_score: ipRiskRaw !== null ? Number(ipRiskRaw) : FEATURE_DEFAULTS.ip_risk_score,
    },
  };
}

function hmgetFields(ids: readonly string[]): string[] {
  return ids.length > 0 ? [...ids] : [SENTINEL_FIELD];
}

function sumNumeric(values: readonly (string | null)[]): number {
  return values.reduce((acc: number, v) => acc + (v !== null ? Number(v) : 0), 0);
}

function average(values: readonly (string | null)[]): number {
  return values.length > 0 ? sumNumeric(values) / values.length : 0;
}

function distinctCount(values: readonly (string | null)[]): number {
  return new Set(values.filter((v): v is string => v !== null)).size;
}

function unwrapPipeline(results: [Error | null, unknown][] | null): unknown[] {
  if (!results) {
    throw new Error('Redis pipeline returned no results (connection lost mid-flight)');
  }
  return results.map(([err, result]) => {
    if (err) throw err;
    return result;
  });
}
