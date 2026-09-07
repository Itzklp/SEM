import { TRANSACTION_STATUSES } from '@fraudguard/domain';
import { z } from 'zod';

import { idSchema, moneySchema, timestampSchema } from '../common';

import { decisionReasonSchema, scoreResponseSchema } from './scoring.dto';

/** `GET /api/v1/transactions/:id` — full recoverable basis for a decision (FR-008). */
export const transactionDetailSchema = z
  .object({
    transactionId: idSchema,
    userId: idSchema,
    merchantId: idSchema,
    deviceId: idSchema,
    amount: moneySchema,
    paymentMethod: idSchema,
    ipAddress: z.string(),
    timestamp: timestampSchema,
    status: z.enum(TRANSACTION_STATUSES),
    decision: scoreResponseSchema
      .omit({ reasons: true })
      .extend({ reasons: z.array(decisionReasonSchema) })
      .nullable(),
    /** Feature vector as it stood at scoring time — for investigation (dashboard transaction-investigation screen, Brief §31). */
    featureSummary: z.record(z.string(), z.number()).nullable(),
  })
  .strict();

export type TransactionDetail = z.infer<typeof transactionDetailSchema>;

/** Shared pagination envelope for every list endpoint (FR-014). */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

// Return type intentionally left to inference: it is a generic Zod object
// schema whose shape depends on `T`, and spelling it out by hand would
// just restate `z.ZodObject<{...}>` less accurately than TypeScript already
// infers it — the exact "genuinely unavoidable" case CONTRIBUTING.md allows.
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function paginatedResponseSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    totalItems: z.number().int().nonnegative(),
  });
}
