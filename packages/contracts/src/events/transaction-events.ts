import { DECISIONS, DEGRADED_REASONS, SCORING_PROVIDERS } from '@fraudguard/domain';
import { z } from 'zod';

import { idSchema, moneySchema, timestampSchema } from '../common';

import { defineEvent } from './envelope';

/**
 * Kafka topic catalogue entry: `transaction.received`
 * Producer: fraud-api (via outbox relay) · Partition key: transactionId
 * Consumers: audit, analytics
 * Full catalogue: docs/architecture/kafka-topics.md
 */
export const transactionReceivedEvent = defineEvent(
  'transaction.received',
  z.object({
    transactionId: idSchema,
    userId: idSchema,
    merchantId: idSchema,
    deviceId: idSchema,
    amount: moneySchema,
    ipAddress: z.string(),
    timestamp: timestampSchema,
  }),
);
export type TransactionReceivedEvent = z.infer<typeof transactionReceivedEvent>;

/**
 * Topic: `transaction.decided` · Partition key: transactionId
 * Producer: fraud-api (via outbox relay)
 * Consumers: audit, feature-update, case-creation (when decision=REVIEW), analytics
 *
 * Carries the full transaction detail (`merchantId`, `deviceId`, `amount`,
 * `ipAddress`, `timestamp`), not just the decision — Phase 6's
 * feature-update consumer (`recordTransactionFeatures`,
 * `packages/feature-store`) needs both the transaction AND its decision
 * in one place, and `transaction.received` alone does not carry the
 * decision. A deliberately "fat" event rather than making every consumer
 * correlate two separate topics by `transactionId` to reconstruct one
 * logical fact.
 */
export const transactionDecidedEvent = defineEvent(
  'transaction.decided',
  z.object({
    transactionId: idSchema,
    userId: idSchema,
    merchantId: idSchema,
    deviceId: idSchema,
    amount: moneySchema,
    ipAddress: z.string(),
    timestamp: timestampSchema,
    decision: z.enum(DECISIONS),
    riskScore: z.number().min(0).max(1),
    policyVersion: z.string(),
    modelVersion: z.string(),
    scoringProvider: z.enum(SCORING_PROVIDERS),
    degraded: z.boolean(),
    degradedReason: z.enum(DEGRADED_REASONS),
  }),
);
export type TransactionDecidedEvent = z.infer<typeof transactionDecidedEvent>;
