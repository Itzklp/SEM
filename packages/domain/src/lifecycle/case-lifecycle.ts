import type { CaseAction, CaseStatus } from '../enums';
import { IllegalTransitionError } from '../errors';

/**
 * FR-011's case workflow. OPEN is the only non-terminal state — every
 * action closes the case. Re-reviewing a closed case (e.g. a duplicate
 * `review.completed` Kafka event, RISK-005) must be rejected here, not
 * merely discouraged by the UI.
 */
const TRANSITIONS: Readonly<Record<CaseStatus, readonly CaseStatus[]>> = {
  OPEN: ['APPROVED', 'BLOCKED', 'ESCALATED'],
  APPROVED: [],
  BLOCKED: [],
  ESCALATED: [],
} as const;

const ACTION_TARGET: Readonly<Record<CaseAction, CaseStatus>> = {
  APPROVE: 'APPROVED',
  BLOCK: 'BLOCKED',
  ESCALATE: 'ESCALATED',
} as const;

export function canApplyCaseAction(current: CaseStatus, action: CaseAction): boolean {
  return TRANSITIONS[current].includes(ACTION_TARGET[action]);
}

export function isCaseTerminal(status: CaseStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Throws `IllegalTransitionError` on an already-closed case — the mechanism behind FR-011's "illegal transitions are rejected". */
export function applyCaseAction(current: CaseStatus, action: CaseAction): CaseStatus {
  const target = ACTION_TARGET[action];
  if (!canApplyCaseAction(current, action)) {
    throw new IllegalTransitionError(current, target, 'FraudCase');
  }
  return target;
}
