import { z } from 'zod';

import { timestampSchema } from '../common';

/** Phase 10 metric set — accuracy alone is meaningless on imbalanced fraud data (Brief §29). */
export const modelMetricsSchema = z.object({
  precision: z.number().min(0).max(1),
  recall: z.number().min(0).max(1),
  f1: z.number().min(0).max(1),
  rocAuc: z.number().min(0).max(1),
  prAuc: z.number().min(0).max(1),
  falsePositiveRate: z.number().min(0).max(1),
  falseNegativeRate: z.number().min(0).max(1),
  inferenceLatencyP99Ms: z.number().nonnegative(),
});

/** `GET /api/v1/models` — FR-012. */
export const modelVersionSchema = z
  .object({
    modelVersion: z.string(),
    providerName: z.string(),
    description: z.string(),
    registeredAt: timestampSchema,
    active: z.boolean(),
    metrics: modelMetricsSchema.nullable(),
  })
  .strict();

export type ModelVersionDto = z.infer<typeof modelVersionSchema>;
