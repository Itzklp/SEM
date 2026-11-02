import type { ScoreResponse, TransactionDetail } from '@fraudguard/contracts';
import type { DecisionRow, TransactionRow } from '@fraudguard/persistence';

/** FR-008/FR-014's full recoverable-basis response. decision is never actually absent here since insertScored writes transaction + decision atomically, though the wire schema allows null. */
export function toTransactionDetailDto(row: {
  transaction: TransactionRow;
  decision: DecisionRow;
}): TransactionDetail {
  const { transaction, decision } = row;
  const decisionDto: ScoreResponse = {
    transactionId: decision.transactionId,
    decision: decision.decision as ScoreResponse['decision'],
    // numeric() round-trips through drizzle as a string — see packages/persistence/src/schema.ts.
    riskScore: Number(decision.riskScore),
    reasons: decision.reasons,
    policyVersion: decision.policyVersion,
    modelVersion: decision.modelVersion,
    scoringProvider: decision.scoringProvider as ScoreResponse['scoringProvider'],
    degraded: decision.degraded,
    degradedReason: decision.degradedReason as ScoreResponse['degradedReason'],
    processingTimeMs: decision.processingTimeMs,
  };

  return {
    transactionId: transaction.transactionId,
    userId: transaction.userId,
    merchantId: transaction.merchantId,
    deviceId: transaction.deviceId,
    amount: { minorUnits: transaction.amountMinorUnits, currency: transaction.currency },
    paymentMethod: transaction.paymentMethod,
    ipAddress: transaction.ipAddress,
    timestamp: transaction.receivedAt.toISOString(),
    status: transaction.status as TransactionDetail['status'],
    decision: decisionDto,
    featureSummary: null, // not yet populated; honestly null rather than faked
  };
}
