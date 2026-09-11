import { dbDurationSeconds, measure } from '@fraudguard/observability';
import { and, asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { hasPgErrorCode, UNIQUE_VIOLATION } from '../pg-errors';
import { auditEvents, type AuditEventRow } from '../schema';

export interface AuditEventInput {
  readonly eventId: string;
  readonly aggregateType: 'transaction' | 'case' | 'model' | 'policy';
  readonly aggregateId: string;
  readonly action: string;
  readonly actorId: string | null;
  readonly detail: Record<string, unknown>;
  readonly occurredAt: Date;
}

/**
 * FR-008's immutable audit trail. Deliberately exposes no update or
 * delete method — see the migration file's note on why "append-only" is
 * enforced at this layer, not the database-role layer, in this
 * prototype. `append` is the dedup backstop named in
 * `docs/architecture/kafka-topics.md` ("a unique constraint violation on
 * replay is the final line of defence beneath application-level eventId
 * checks") — the consumer that calls this has already checked upstream,
 * but trusting that alone is how a duplicate eventually gets through.
 */
export class AuditRepository {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  async append(input: AuditEventInput): Promise<{ inserted: boolean }> {
    return measure(
      {
        span: 'db.audit_append',
        histogram: dbDurationSeconds,
        labels: { operation: 'audit_append' },
      },
      async () => {
        try {
          await this.db.insert(auditEvents).values({
            eventId: input.eventId,
            aggregateType: input.aggregateType,
            aggregateId: input.aggregateId,
            action: input.action,
            actorId: input.actorId,
            detail: input.detail,
            occurredAt: input.occurredAt,
          });
          return { inserted: true };
        } catch (error) {
          if (hasPgErrorCode(error) && error.code === UNIQUE_VIOLATION) {
            return { inserted: false };
          }
          throw error;
        }
      },
    );
  }

  /** The investigation-screen query: "everything that happened to transaction X, in order" (data-model.md). */
  async findByAggregate(
    aggregateType: AuditEventInput['aggregateType'],
    aggregateId: string,
  ): Promise<readonly AuditEventRow[]> {
    return measure(
      {
        span: 'db.audit_find_by_aggregate',
        histogram: dbDurationSeconds,
        labels: { operation: 'audit_find_by_aggregate' },
      },
      () =>
        this.db
          .select()
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.aggregateType, aggregateType),
              eq(auditEvents.aggregateId, aggregateId),
            ),
          )
          .orderBy(asc(auditEvents.occurredAt)),
    );
  }
}
