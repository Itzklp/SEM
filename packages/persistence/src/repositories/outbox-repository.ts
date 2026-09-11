import { dbDurationSeconds, measure } from '@fraudguard/observability';
import { asc, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { outboxEvents, type OutboxEventRow } from '../schema';

/** What `TransactionRepository.insertScored` (and any future producer) writes, alongside its domain row, in the SAME transaction (ADR-006). */
export interface OutboxEventInput {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly topic: string;
  readonly partitionKey: string;
  readonly payload: unknown;
  /** Captured via `captureTraceparent()` at the moment this event is built — see migration 0003's note. Optional: a caller with tracing disabled, or one that hasn't adopted it yet, simply omits it. */
  readonly traceContext?: string;
}

export type PublishOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface BatchResult {
  readonly publishedCount: number;
  readonly failedCount: number;
}

/**
 * The relay's (`apps/event-worker`) one real operation. Deliberately a
 * single method that takes the Kafka-publishing callback, rather than a
 * "claim" method and a separate "mark published" method called later:
 * `FOR UPDATE SKIP LOCKED`'s row lock is held only for the lifetime of
 * the enclosing transaction (ADR-006) — claiming rows in one transaction
 * and marking them published in a second, later one would release the
 * lock in between, and a second relay instance's next poll could claim
 * the same rows before the first finished publishing them. Keeping
 * "claim, publish, mark" inside one transaction is what actually makes
 * `SKIP LOCKED` safe for concurrent relay instances — a real correctness
 * requirement, not a style preference, caught by reasoning through the
 * failure mode before writing the obviously-simpler two-method version.
 */
export class OutboxRepository {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  /**
   * Timed as ONE operation, `publish` callback included — deliberately,
   * not an oversight: `publish` runs WHILE this transaction still holds
   * `FOR UPDATE SKIP LOCKED`'s row locks, so "how long did a Kafka
   * publish take" and "how long were these rows locked" are the same
   * question here. A slow broker shows up directly in
   * `db_duration_seconds{operation="outbox_process_batch"}` — exactly the
   * signal that matters for this method, even though the number also
   * includes non-database time.
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
              // Recorded, not dead-lettered — see this class's doc comment
              // and the migration file's note: a sustained Kafka outage must
              // drain fully on recovery (Phase 6 exit criterion), so a
              // publish failure is always retried on the next poll, never
              // given up on.
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

  /** Cold-path health signal (ADR-006: "backlog depth is a directly measurable health signal") — polled by `apps/event-worker`'s `outbox-gauge-poller.ts` into `outbox_pending_total`. */
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
