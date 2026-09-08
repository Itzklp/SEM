import type { FraudDecision } from '@fraudguard/domain';
import type { Transaction } from '@fraudguard/domain';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { decisions, transactions, type DecisionRow, type TransactionRow } from '../schema';

/** Postgres error code for a unique_violation — https://www.postgresql.org/docs/current/errcodes-appendix.html */
const UNIQUE_VIOLATION = '23505';

function hasPgErrorCode(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
  );
}

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

  async insertScored(
    transaction: Transaction,
    decision: FraudDecision,
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
  }
}
