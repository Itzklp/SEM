import type { Redis } from 'ioredis';

import { ipRiskKey, merchantRiskKey } from './keys';

/**
 * The write side of the risk-lookup feature family. `merchant_risk_score`
 * and `ip_risk_score` are reference data (ADR-002), not derived from the
 * transaction stream — something else has to populate them.
 *
 * Phase 4 builds this mechanism and its default-on-miss read path
 * (`feature-reader.ts`); seeding real merchant/IP risk reference data is
 * an explicit Phase 5 deliverable (docs/TEAM_TASK_BREAKDOWN.md: "merchant/IP
 * risk reference data seeding"). Used directly by tests until then.
 */
export async function setMerchantRiskScore(
  redis: Redis,
  merchantId: string,
  score: number,
): Promise<void> {
  await redis.set(merchantRiskKey(merchantId), String(score));
}

export async function setIpRiskScore(
  redis: Redis,
  ipAddress: string,
  score: number,
): Promise<void> {
  await redis.set(ipRiskKey(ipAddress), String(score));
}
