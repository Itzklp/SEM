import { z } from 'zod';

import { modelMetricsSchema } from '../dto/model.dto';

import { defineEvent } from './envelope';

/**
 * Topic: `model.updated` · Partition key: modelVersion
 * Producer: ml-service model registry (Phase 10), or an admin action for stub/rules
 * Consumers: audit, dashboard
 */
export const modelUpdatedEvent = defineEvent(
  'model.updated',
  z.object({
    modelVersion: z.string(),
    providerName: z.string(),
    active: z.boolean(),
    metrics: modelMetricsSchema.nullable(),
  }),
);
export type ModelUpdatedEvent = z.infer<typeof modelUpdatedEvent>;
