import type { FraudCaseDto } from '@fraudguard/contracts';
import type { FraudCaseRow } from '@fraudguard/persistence';

/** `timestamptz` columns come back from `pg` as JS `Date`s; the wire schema (`fraudCaseSchema`) wants ISO strings. */
export function toFraudCaseDto(row: FraudCaseRow): FraudCaseDto {
  return {
    caseId: row.caseId,
    transactionId: row.transactionId,
    status: row.status as FraudCaseDto['status'],
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    reviewerId: row.reviewerId,
    reviewReason: row.reviewReason,
  };
}
