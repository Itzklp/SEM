import type { CaseStatus } from '../enums';

/**
 * A human-review case, created for every REVIEW decision (FR-010, FR-011).
 * State transitions are governed by `lifecycle/case-lifecycle.ts` — this
 * file defines the shape only.
 */
export interface FraudCase {
  readonly caseId: string;
  readonly transactionId: string;
  readonly status: CaseStatus;
  readonly createdAt: Date;
  readonly reviewedAt: Date | null;
  readonly reviewerId: string | null;
  readonly reviewReason: string | null;
}

export function openCase(caseId: string, transactionId: string, createdAt: Date): FraudCase {
  return {
    caseId,
    transactionId,
    status: 'OPEN',
    createdAt,
    reviewedAt: null,
    reviewerId: null,
    reviewReason: null,
  };
}
