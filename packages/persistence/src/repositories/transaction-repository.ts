import type { FraudDecision } from '@fraudguard/domain';
import type { Transaction } from '@fraudguard/domain';
import { dbDurationSeconds, measure } from '@fraudguard/observability';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { hasPgErrorCode, UNIQUE_VIOLATION } from '../pg-errors';
import {
  decisions,
  outboxEvents,
  transactions,
  type DecisionRow,
  type TransactionRow,
} from '../schema';

import type { OutboxEventInput } from './outbox-repository';

export interface ScoredTransactionResult {
  readonly transaction: TransactionRow;
  readonly decision: DecisionRow;
  /** True if this call found an existing row rather than inserting a new one — the DB-level idempotency backstop (FR-017) beneath the Redis fast path (ADR-005: still correct if Redis is degraded). */
  readonly wasExisting: boolean;
}

/**
 * Persists a scored transaction and its decision atomically — the "decision
 * write, one transaction" step from ADR-003/ADR-006's hot-path budget.
 *
 * Idempotency backstop: `transactions.transaction_id` is the primary key,
 * so a duplicate insert attempt raises a unique_violation rather than
 * silently succeeding twice. Rather than letting that surface as a 500,
 * this method catches it and returns the *existing* row — meaning FR-017's
 * "duplicate returns the original decision" guarantee holds even if the
 * Redis-based fast-path idempotency check (packages/feature-store) was
 * bypassed or degraded (ADR-005).
 */
export class TransactionRepository {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  /**
   * `outboxEventInputs`: the `transaction.received`/`transaction.decided`
   * event payloads, already built by the caller (`apps/fraud-api`, which
   * knows `@fraudguard/contracts`' event schemas — this package
   * deliberately does not, per ADR-004's layering). Written in the SAME
   * transaction as the decision, per ADR-006 — either all three rows
   * exist or none do, so a decision can never exist without its outbox
   * event ever being written at all.
   */
  async insertScored(
    transaction: Transaction,
    decision: FraudDecision,
    outboxEventInputs: readonly OutboxEventInput[] = [],
  ): Promise<ScoredTransactionResult> {
    return measure(
      {
        span: 'db.insert_scored',
        histogram: dbDurationSeconds,
        labels: { operation: 'insert_scored' },
      },
      () => this.doInsertScored(transaction, decision, outboxEventInputs),
    );
  }

  private async doInsertScored(
    transaction: Transaction,
    decision: FraudDecision,
    outboxEventInputs: readonly OutboxEventInput[],
  ): Promise<ScoredTransactionResult> {
    try {
      return await this.db.transaction(async (tx) => {
        const [transactionRow] = await tx
          .insert(transactions)
          .values({
            transactionId: transaction.transactionId,
            userId: transaction.userId,
            merchantId: transaction.merchantId,
            deviceId: transaction.deviceId,
            amountMinorUnits: transaction.amount.minorUnits,
            currency: transaction.amount.currency,
            paymentMethod: transaction.paymentMethod,
            ipAddress: transaction.ipAddress,
            status: transaction.status,
            receivedAt: transaction.timestamp,
          })
          .returning();

        const [decisionRow] = await tx
          .insert(decisions)
          .values({
            transactionId: decision.transactionId,
            decision: decision.decision,
            riskScore: decision.riskScore.value.toFixed(4),
            reasons: decision.reasons.map((r) => ({ reason: r.reason })),
            policyVersion: decision.policyVersion,
            modelVersion: decision.modelVersion,
            scoringProvider: decision.scoringProvider,
            degraded: decision.degraded,
            degradedReason: decision.degradedReason,
            decidedAt: decision.decidedAt,
            processingTimeMs: decision.processingTimeMs,
          })
          .returning();

        if (!transactionRow || !decisionRow) {
          throw new Error('Insert returned no row — should be unreachable');
        }

        if (outboxEventInputs.length > 0) {
          await tx.insert(outboxEvents).values(
            outboxEventInputs.map((event) => ({
              eventId: event.eventId,
              aggregateId: event.aggregateId,
              eventType: event.eventType,
              topic: event.topic,
              partitionKey: event.partitionKey,
              payload: event.payload,
              traceContext: event.traceContext ?? null,
            })),
          );
        }

        return { transaction: transactionRow, decision: decisionRow, wasExisting: false };
      });
    } catch (error) {
      if (hasPgErrorCode(error) && error.code === UNIQUE_VIOLATION) {
        const existing = await this.findByTransactionId(transaction.transactionId);
        if (existing) {
          return { ...existing, wasExisting: true };
        }
      }
      throw error;
    }
  }

  async findByTransactionId(
    transactionId: string,
  ): Promise<{ transaction: TransactionRow; decision: DecisionRow } | null> {
    return measure(
      {
        span: 'db.find_transaction_by_id',
        histogram: dbDurationSeconds,
        labels: { operation: 'find_transaction_by_id' },
      },
      async () => {
        const [transactionRow] = await this.db
          .select()
          .from(transactions)
          .where(eq(transactions.transactionId, transactionId))
          .limit(1);
        if (!transactionRow) {
          return null;
        }
        const [decisionRow] = await this.db
          .select()
          .from(decisions)
          .where(eq(decisions.transactionId, transactionId))
          .limit(1);
        if (!decisionRow) {
          return null;
        }
        return { transaction: transactionRow, decision: decisionRow };
      },
    );
  }
}
