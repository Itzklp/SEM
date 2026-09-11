/**
 * Redis key layout for the feature system (ADR-002). Centralised here so a
 * key format never drifts between the writer and the reader.
 *
 * Not prefixed with `fg:` here — that is `REDIS_KEY_PREFIX`, applied
 * automatically by ioredis's `keyPrefix` client option
 * (`redis-client.ts`), exactly once, for every command. Prefixing it again
 * here would double it.
 */

/** Per-user rolling event log: member = transactionId, score = timestamp (ms). Backs every velocity/aggregate/distinct feature. */
export function userEventLogKey(userId: string): string {
  return `feat:user:${userId}:log`;
}

/** Parallel hash: transactionId -> amount (minor units, as a string). */
export function userAmountKey(userId: string): string {
  return `feat:user:${userId}:amount`;
}

/** Parallel hash: transactionId -> merchantId. */
export function userMerchantKey(userId: string): string {
  return `feat:user:${userId}:merchant`;
}

/** Parallel hash: transactionId -> ipAddress (the "location" proxy — see feature-writer.ts). */
export function userLocationKey(userId: string): string {
  return `feat:user:${userId}:location`;
}

/** Subset of the event log: only transactions that were BLOCKed (see feature-writer.ts for why this is "failed"). */
export function userFailedLogKey(userId: string): string {
  return `feat:user:${userId}:failed`;
}

/** Per-device event log, unwindowed (trimmed to DEVICE_RETENTION_MS). */
export function deviceLogKey(deviceId: string): string {
  return `feat:device:${deviceId}:log`;
}

/** First-seen timestamp (ms) for a user — the basis for account_age_days. */
export function accountFirstSeenKey(userId: string): string {
  return `feat:account:${userId}:first_seen`;
}

/** Risk reference-data lookup: a single float score, seeded out-of-band (Phase 5). */
export function merchantRiskKey(merchantId: string): string {
  return `feat:risk:merchant:${merchantId}`;
}

/** Risk reference-data lookup: a single float score, seeded out-of-band (Phase 5). */
export function ipRiskKey(ipAddress: string): string {
  return `feat:risk:ip:${ipAddress}`;
}
