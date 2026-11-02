import { dbDurationSeconds, measure } from '@fraudguard/observability';
import { asc, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { outboxEvents, type OutboxEventRow } from '../schema';

/** What insertScored writes alongside its domain row, in the same transaction (ADR-006). */
export interface OutboxEventInput {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly topic: string;
  readonly partitionKey: string;
  readonly payload: unknown;
  /** Captured via captureTraceparent() when the event is built; omitted if tracing is disabled. */
  readonly traceContext?: string;
}

export type PublishOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface BatchResult {
  readonly publishedCount: number;
  readonly failedCount: number;
}

/**
 * The relay's one real operation. Takes the publish callback directly
 * rather than separate claim/mark-published methods: FOR UPDATE SKIP
 * LOCKED only holds its row lock for the enclosing transaction, so a
 * second relay instance could claim the same rows in the gap between two
 * separate transactions. Claim, publish, and mark must stay in one transaction.
 */
export class OutboxRepository {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  /**
   * Timed as one operation including the publish callback — publish runs
   * while this transaction still holds the row locks, so a slow broker
   * shows up directly in db_duration_seconds{operation="outbox_process_batch"}.
   */
  async processUnpublishedBatch(
    limit: number,
    publish: (row: OutboxEventRow) => Promise<PublishOutcome>,
  ): Promise<BatchResult> {
    return measure(
      {
        span: 'db.outbox_process_batch',
        histogram: dbDurationSeconds,
        labels: { operation: 'outbox_process_batch' },
      },
      () =>
        this.db.transaction(async (tx) => {
          const rows = await tx
            .select()
            .from(outboxEvents)
            .where(isNull(outboxEvents.publishedAt))
            .orderBy(asc(outboxEvents.createdAt))
            .limit(limit)
            .for('update', { skipLocked: true });

          let publishedCount = 0;
          let failedCount = 0;
          for (const row of rows) {
            const outcome = await publish(row);
            if (outcome.ok) {
              await tx
                .update(outboxEvents)
                .set({ publishedAt: new Date() })
                .where(eq(outboxEvents.id, row.id));
              publishedCount += 1;
            } else {
              // Recorded, not dead-lettered: a publish failure is always
              // retried on the next poll, so a sustained outage still drains fully.
              await tx
                .update(outboxEvents)
                .set({ attempts: sql`${outboxEvents.attempts} + 1`, lastError: outcome.error })
                .where(eq(outboxEvents.id, row.id));
              failedCount += 1;
            }
          }
          return { publishedCount, failedCount };
        }),
    );
  }

  /** Cold-path health signal (ADR-006) — polled into outbox_pending_total. */
  async countUnpublished(): Promise<number> {
    return measure(
      {
        span: 'db.outbox_count_unpublished',
        histogram: dbDurationSeconds,
        labels: { operation: 'outbox_count_unpublished' },
      },
      async () => {
        const [row] = await this.db
          .select({ count: sql<string>`count(*)` })
          .from(outboxEvents)
          .where(isNull(outboxEvents.publishedAt));
        return Number(row?.count ?? 0);
      },
    );
  }
}
