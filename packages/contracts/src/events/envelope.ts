import { z } from 'zod';

/**
 * Every event on every topic wraps its payload in this envelope
 * (ADR-006). `eventId` is the consumer-side deduplication key — at-least-
 * once delivery means every consumer WILL see duplicates, and this is the
 * field that makes catching them possible (RISK-005, RT-DUP-001).
 *
 * `eventId` is deterministic from (aggregateId, eventType) at the
 * producer, NOT random — so republishing the same logical event after a
 * relay crash produces the same id, and consumer-side dedup actually
 * dedups instead of admitting every retry as "new".
 */
export const eventEnvelopeSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.string(),
  aggregateId: z.string(),
  occurredAt: z.string().datetime({ offset: true }),
  /** Correlates back to the originating HTTP request — NFR-010 traceability. */
  traceId: z.string(),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/**
 * Builds a full event schema by intersecting the envelope with a payload
 * shape, and stamps `eventType` as a literal so a consumer can discriminate
 * on it. Return type left to inference (see paginatedResponseSchema for the
 * same reasoning) — it is `typeof eventEnvelopeSchema` extended with a
 * literal + the caller's own payload schema, which TypeScript expresses
 * more precisely than a hand-written annotation could.
 */
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function defineEvent<Type extends string, PayloadSchema extends z.ZodTypeAny>(
  eventType: Type,
  payloadSchema: PayloadSchema,
) {
  return eventEnvelopeSchema.extend({
    eventType: z.literal(eventType),
    payload: payloadSchema,
  });
}
