import { dbDurationSeconds, measure } from '@fraudguard/observability';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { hasPgErrorCode, UNIQUE_VIOLATION } from '../pg-errors';
import { fraudCases, outboxEvents, type FraudCaseRow } from '../schema';

import type { OutboxEventInput } from './outbox-repository';

export interface CreateCaseResult {
  readonly fraudCase: FraudCaseRow;
  /** True if a case for this transaction already existed — RISK-005's idempotency guarantee made concrete: a duplicate `transaction.decided`=REVIEW delivery creates no second case. */
  readonly wasExisting: boolean;
}

export interface PagedResult<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
}

/**
 * FR-010, FR-011. `fraud_cases.transaction_id`'s UNIQUE constraint
 * (migration 0002) is what makes `createIfAbsent` genuinely idempotent at
 * the database level — the same backstop pattern `TransactionRepository`
 * uses for FR-017. Reviewer actions are validated by
 * `packages/domain`'s `applyCaseAction` BEFORE this class is ever called
 * (the illegal-transition check belongs to the domain, not the
 * repository) — `applyReview`'s own `WHERE status = 'OPEN'` guard is the
 * race-safe backstop beneath that: two concurrent review requests for
 * the same case can both pass the in-memory domain check against a
 * stale read, but only one UPDATE can match the guard.
 *
 * Both mutating methods accept an optional `outboxEvent` — the same
 * ADR-006 pattern `TransactionRepository.insertScored` uses: the domain
 * row and its outgoing event are written in ONE transaction, so a case
 * (or a review outcome) can never exist without event-worker's shared
 * outbox relay eventually learning about it. `event-worker`'s
 * case-creation consumer and `review-api`'s review endpoint are this
 * class's two callers, and both write through the same outbox table the
 * relay already polls — no second relay needed for these events.
 */
export class CaseRepository {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  async createIfAbsent(
    caseId: string,
    transactionId: string,
    createdAt: Date,
    outboxEvent?: OutboxEventInput,
  ): Promise<CreateCaseResult> {
    return measure(
      {
        span: 'db.case_create_if_absent',
        histogram: dbDurationSeconds,
        labels: { operation: 'case_create_if_absent' },
      },
      async () => {
        try {
          const row = await this.db.transaction(async (tx) => {
            const [inserted] = await tx
              .insert(fraudCases)
              .values({ caseId, transactionId, status: 'OPEN', createdAt })
              .returning();
            if (!inserted) {
              throw new Error('Insert returned no row — should be unreachable');
            }
            if (outboxEvent) {
              await tx.insert(outboxEvents).values({
                eventId: outboxEvent.eventId,
                aggregateId: outboxEvent.aggregateId,
                eventType: outboxEvent.eventType,
                topic: outboxEvent.topic,
                partitionKey: outboxEvent.partitionKey,
                payload: outboxEvent.payload,
                traceContext: outboxEvent.traceContext ?? null,
              });
            }
            return inserted;
          });
          return { fraudCase: row, wasExisting: false };
        } catch (error) {
          if (hasPgErrorCode(error) && error.code === UNIQUE_VIOLATION) {
            const existing = await this.findByTransactionId(transactionId);
            if (existing) {
              return { fraudCase: existing, wasExisting: true };
            }
          }
          throw error;
        }
      },
    );
  }

  async findById(caseId: string): Promise<FraudCaseRow | null> {
    return measure(
      {
        span: 'db.case_find_by_id',
        histogram: dbDurationSeconds,
        labels: { operation: 'case_find_by_id' },
      },
      async () => {
        const [row] = await this.db
          .select()
          .from(fraudCases)
          .where(eq(fraudCases.caseId, caseId))
          .limit(1);
        return row ?? null;
      },
    );
  }

  async findByTransactionId(transactionId: string): Promise<FraudCaseRow | null> {
    return measure(
      {
        span: 'db.case_find_by_transaction_id',
        histogram: dbDurationSeconds,
        labels: { operation: 'case_find_by_transaction_id' },
      },
      async () => {
        const [row] = await this.db
          .select()
          .from(fraudCases)
          .where(eq(fraudCases.transactionId, transactionId))
          .limit(1);
        return row ?? null;
      },
    );
  }

  async listByStatus(
    status: string,
    page: number,
    pageSize: number,
  ): Promise<PagedResult<FraudCaseRow>> {
    return measure(
      {
        span: 'db.case_list_by_status',
        histogram: dbDurationSeconds,
        labels: { operation: 'case_list_by_status' },
      },
      async () => {
        const offset = (page - 1) * pageSize;
        const [items, countRows] = await Promise.all([
          this.db
            .select()
            .from(fraudCases)
            .where(eq(fraudCases.status, status))
            .orderBy(desc(fraudCases.createdAt))
            .limit(pageSize)
            .offset(offset),
          this.db
            .select({ count: sql<string>`count(*)` })
            .from(fraudCases)
            .where(eq(fraudCases.status, status)),
        ]);
        return { items, page, pageSize, totalItems: Number(countRows[0]?.count ?? 0) };
      },
    );
  }

  /** `review_queue_depth`'s source query (`apps/review-api/src/cases/queue-depth-poller.ts`) — a plain count, not `listByStatus`'s paginated query, since a poller needs only the number, not a page of rows. */
  async countByStatus(status: string): Promise<number> {
    return measure(
      {
        span: 'db.case_count_by_status',
        histogram: dbDurationSeconds,
        labels: { operation: 'case_count_by_status' },
      },
      async () => {
        const [row] = await this.db
          .select({ count: sql<string>`count(*)` })
          .from(fraudCases)
          .where(eq(fraudCases.status, status));
        return Number(row?.count ?? 0);
      },
    );
  }

  /** Returns `null` if the case was not OPEN at update time (already reviewed) — the race-safe backstop described in this class's doc comment. The outbox event is written only when the update actually applies — a no-op review (case already closed) publishes nothing. */
  async applyReview(
    caseId: string,
    targetStatus: string,
    reviewerId: string,
    reason: string,
    reviewedAt: Date,
    outboxEvent?: OutboxEventInput,
  ): Promise<FraudCaseRow | null> {
    return measure(
      {
        span: 'db.case_apply_review',
        histogram: dbDurationSeconds,
        labels: { operation: 'case_apply_review' },
      },
      () =>
        this.db.transaction(async (tx) => {
          const [row] = await tx
            .update(fraudCases)
            .set({ status: targetStatus, reviewedAt, reviewerId, reviewReason: reason })
            .where(and(eq(fraudCases.caseId, caseId), eq(fraudCases.status, 'OPEN')))
            .returning();
          if (row && outboxEvent) {
            await tx.insert(outboxEvents).values({
              eventId: outboxEvent.eventId,
              aggregateId: outboxEvent.aggregateId,
              eventType: outboxEvent.eventType,
              topic: outboxEvent.topic,
              partitionKey: outboxEvent.partitionKey,
              payload: outboxEvent.payload,
              traceContext: outboxEvent.traceContext ?? null,
            });
          }
          return row ?? null;
        }),
    );
  }
}
