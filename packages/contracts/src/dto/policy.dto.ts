import { z } from 'zod';

/**
 * FR-006: "Thresholds are configurable at runtime without redeployment."
 * Validates wire SHAPE only (ranges, required fields) — the cross-field
 * business invariant (allowMax < blockMin, degraded at least as strict
 * as healthy) is `@fraudguard/domain`'s `isValidRiskPolicy`, applied by
 * `PolicyStore` before a submitted policy is actually adopted. Same
 * division of labour as `Money`: the wire schema catches malformed
 * input, the domain layer re-checks the invariant that actually matters.
 */
export const policyUpdateRequestSchema = z
  .object({
    policyVersion: z.string().min(1),
    allowMax: z.number().min(0).max(1),
    blockMin: z.number().min(0).max(1),
    degraded: z
      .object({
        allowMax: z.number().min(0).max(1),
        blockMin: z.number().min(0).max(1),
      })
      .strict(),
  })
  .strict();

export type PolicyUpdateRequest = z.infer<typeof policyUpdateRequestSchema>;

/** `GET`/`PUT` `/api/v1/admin/policy` response — the currently active policy. */
export const policyResponseSchema = policyUpdateRequestSchema;
export type PolicyResponse = z.infer<typeof policyResponseSchema>;
