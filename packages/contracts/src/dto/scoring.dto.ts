import { DECISIONS, DEGRADED_REASONS, SCORING_PROVIDERS } from '@fraudguard/domain';
import { z } from 'zod';

import { currencySchema, idSchema, timestampSchema } from '../common';

/**
 * FR-001. `POST /api/v1/fraud/score` request body — Brief §23.
 * `.strict()`: an unrecognised field is rejected outright rather than
 * silently ignored (ST-TAMPER-001 in the threat model). Note there is no
 * field anywhere in this schema capable of carrying a card number — that
 * is SECURITY.md's "no code path can receive a PAN" guarantee, enforced
 * structurally rather than by a redaction rule.
 */
export const scoreRequestSchema = z
  .object({
    transactionId: idSchema,
    userId: idSchema,
    merchantId: idSchema,
    deviceId: idSchema,
    amount: z.object({
      minorUnits: z.number().int().nonnegative(),
      currency: currencySchema,
    }),
    /** Tokenised payment reference only — e.g. "card_token_abc123". Never a PAN. */
    paymentMethod: idSchema,
    ipAddress: z.string().ip(),
    timestamp: timestampSchema,
  })
  .strict();

export type ScoreRequest = z.infer<typeof scoreRequestSchema>;

/**
 * A single client-safe explanation for the decision (FR-007). Internal
 * weights/thresholds are never part of this shape — see domain's
 * `toClientSafeReasons`. `.strict()` here is load-bearing, not stylistic:
 * without it, Zod's default behaviour is to silently STRIP unrecognised
 * keys rather than reject them, which would hide a leak rather than catch
 * one (ST-LEAK-001) — exactly the failure mode this schema exists to guard
 * against.
 */
export const decisionReasonSchema = z
  .object({
    reason: z.string(),
  })
  .strict();

/** FR-006, FR-007, FR-012, FR-016. `POST /api/v1/fraud/score` response body. */
export const scoreResponseSchema = z
  .object({
    transactionId: idSchema,
    decision: z.enum(DECISIONS),
    riskScore: z.number().min(0).max(1),
    reasons: z.array(decisionReasonSchema),
    policyVersion: z.string(),
    modelVersion: z.string(),
    scoringProvider: z.enum(SCORING_PROVIDERS),
    /** ADR-005: true whenever a dependency was unavailable and a fallback/cautious policy applied. Never silent. */
    degraded: z.boolean(),
    degradedReason: z.enum(DEGRADED_REASONS),
    processingTimeMs: z.number().nonnegative(),
  })
  .strict();

export type ScoreResponse = z.infer<typeof scoreResponseSchema>;
