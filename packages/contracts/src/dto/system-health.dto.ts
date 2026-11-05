import { z } from 'zod';

const componentHealthSchema = z.object({
  status: z.enum(['up', 'down']),
  latencyMs: z.number().nonnegative().nullable(),
});

/** `GET /api/v1/admin/system-health` — one call, every deployable's own health check fanned out server-side. */
export const systemHealthSchema = z
  .object({
    checkedAt: z.string(),
    components: z.record(z.string(), componentHealthSchema),
  })
  .strict();

export type SystemHealthDto = z.infer<typeof systemHealthSchema>;
