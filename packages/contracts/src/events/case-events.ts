import { CASE_ACTIONS, CASE_STATUSES } from '@fraudguard/domain';
import { z } from 'zod';

import { idSchema } from '../common';

import { defineEvent } from './envelope';

/**
 * Topic: `review.created` · Partition key: transactionId
 * Producer: event-worker (case-creation consumer, on transaction.decided = REVIEW)
 * Consumers: review-api (case queue), analytics
 * Idempotent by construction: consumer does a conditional insert on transactionId (FR-010).
 */
export const caseCreatedEvent = defineEvent(
  'fraud.case.created',
  z.object({
    caseId: idSchema,
    transactionId: idSchema,
  }),
);
export type CaseCreatedEvent = z.infer<typeof caseCreatedEvent>;

/**
 * Topic: `review.completed` · Partition key: transactionId
 * Producer: review-api (on reviewer action)
 * Consumers: audit, analytics
 */
export const caseReviewedEvent = defineEvent(
  'fraud.case.reviewed',
  z.object({
    caseId: idSchema,
    transactionId: idSchema,
    action: z.enum(CASE_ACTIONS),
    resultingStatus: z.enum(CASE_STATUSES),
    reviewerId: idSchema,
    reason: z.string(),
  }),
);
export type CaseReviewedEvent = z.infer<typeof caseReviewedEvent>;
