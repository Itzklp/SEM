import { CASE_ACTIONS, CASE_STATUSES } from '@fraudguard/domain';
import { z } from 'zod';

import { idSchema, timestampSchema } from '../common';

/** FR-010, FR-011. A fraud case as returned by `GET /api/v1/fraud/cases[/:id]`. */
export const fraudCaseSchema = z
  .object({
    caseId: idSchema,
    transactionId: idSchema,
    status: z.enum(CASE_STATUSES),
    createdAt: timestampSchema,
    reviewedAt: timestampSchema.nullable(),
    reviewerId: idSchema.nullable(),
    reviewReason: z.string().nullable(),
  })
  .strict();

export type FraudCaseDto = z.infer<typeof fraudCaseSchema>;

/**
 * `POST /api/v1/fraud/cases/:id/review` request body. `reviewerId` is
 * deliberately NOT part of this body — it comes from the authenticated
 * caller's identity (ASM-006), never from client-supplied input, so a
 * caller cannot attribute their review action to someone else.
 */
export const reviewCaseRequestSchema = z
  .object({
    action: z.enum(CASE_ACTIONS),
    reason: z.string().min(1).max(1000),
  })
  .strict();

export type ReviewCaseRequest = z.infer<typeof reviewCaseRequestSchema>;
