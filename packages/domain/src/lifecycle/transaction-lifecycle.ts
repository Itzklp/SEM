import type { TransactionStatus } from '../enums';
import { IllegalTransitionError } from '../errors';

/**
 * The transaction lifecycle graph from ARCHITECTURE.md §9. Encoded as an
 * explicit adjacency map — rather than scattered `if` checks at each call
 * site — so the legal graph exists in exactly one place and is itself
 * unit-testable as data.
 *
 * RECEIVED --> VALIDATED --> FEATURES_LOADED --> SCORED --> DECIDED
 *    |            |
 *    v            v
 * DUPLICATE    REJECTED
 *
 * DECIDED, REJECTED and DUPLICATE are terminal: no outgoing edges.
 */
const TRANSITIONS: Readonly<Record<TransactionStatus, readonly TransactionStatus[]>> = {
  RECEIVED: ['VALIDATED', 'DUPLICATE'],
  VALIDATED: ['FEATURES_LOADED', 'REJECTED'],
  FEATURES_LOADED: ['SCORED'],
  SCORED: ['DECIDED'],
  DECIDED: [],
  REJECTED: [],
  DUPLICATE: [],
} as const;

export function canTransition(from: TransactionStatus, to: TransactionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: TransactionStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/**
 * Validates a transition and returns the new status. Throws
 * `IllegalTransitionError` rather than returning a boolean, because a
 * caller that ignores a false return would silently proceed with an
 * inconsistent transaction state — exactly the class of bug a state
 * machine exists to prevent.
 */
export function transitionTransaction(
  from: TransactionStatus,
  to: TransactionStatus,
): TransactionStatus {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to, 'Transaction');
  }
  return to;
}
