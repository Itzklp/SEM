import { z } from 'zod';

/**
 * Identifiers, shared across every DTO. Deliberately strict: these values
 * flow into Redis keys, SQL parameters and Kafka partition keys downstream,
 * so validating the character set once, at the wire boundary, is what lets
 * every downstream layer trust the value without re-checking it.
 */
export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/, 'must contain only letters, digits, underscore and hyphen');

/** ISO 4217. Validated as a shape here; Money (domain) validates it again at construction — belt and suspenders across the trust boundary. */
export const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'must be a 3-letter ISO 4217 currency code');

/**
 * Money on the wire: integer minor units, never a float. See
 * packages/domain Money for the rationale — this schema is what stops a
 * malformed request (e.g. `19.99`) from ever reaching that value object.
 */
export const moneySchema = z.object({
  minorUnits: z.number().int().nonnegative(),
  currency: currencySchema,
});

/** FR-001. Deliberately closed (`.strict()`) — an unknown field is rejected, not ignored, so a client's typo or a tampering attempt surfaces immediately. */
export const timestampSchema = z.string().datetime({ offset: true });

/** Standard error shape returned by every FraudGuard API (§23 of the brief). */
export const errorResponseSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      /** Present on validation failures — names the offending field(s). Never present on 5xx responses (no internals leaked — NFR-008). */
      details: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
      requestId: z.string(),
    }),
  })
  .strict();

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export type Money = z.infer<typeof moneySchema>;
