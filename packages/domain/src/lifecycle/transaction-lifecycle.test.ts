import { TRANSACTION_STATUSES, type TransactionStatus } from '../enums';
import { IllegalTransitionError } from '../errors';

import { canTransition, isTerminal, transitionTransaction } from './transaction-lifecycle';

describe('transaction lifecycle', () => {
  // What: every legal edge in ARCHITECTURE.md §9 is actually permitted.
  // Why: this table IS the lifecycle contract — if it drifts from the
  //      architecture diagram, the diagram is lying.
  // Catches: a typo or accidental edge removal when the graph is edited.
  it.each([
    ['RECEIVED', 'VALIDATED'],
    ['RECEIVED', 'DUPLICATE'],
    ['VALIDATED', 'FEATURES_LOADED'],
    ['VALIDATED', 'REJECTED'],
    ['FEATURES_LOADED', 'SCORED'],
    ['SCORED', 'DECIDED'],
  ] satisfies [TransactionStatus, TransactionStatus][])('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(transitionTransaction(from, to)).toBe(to);
  });

  // What: a representative set of illegal edges (skipping stages, reversing direction).
  // Why: FR-001's acceptance criteria require no partial side effects on
  //      invalid input — an unchecked transition is exactly how a
  //      transaction could end up DECIDED without ever being scored.
  // Catches: a caller skipping FEATURES_LOADED/SCORED and calling the
  //          decision engine directly on a merely-VALIDATED transaction.
  it.each([
    ['RECEIVED', 'SCORED'],
    ['RECEIVED', 'DECIDED'],
    ['VALIDATED', 'SCORED'],
    ['FEATURES_LOADED', 'DECIDED'],
    ['DECIDED', 'SCORED'],
    ['REJECTED', 'VALIDATED'],
    ['DUPLICATE', 'VALIDATED'],
  ] satisfies [TransactionStatus, TransactionStatus][])('rejects %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => transitionTransaction(from, to)).toThrow(IllegalTransitionError);
  });

  // What: DECIDED, REJECTED and DUPLICATE have no outgoing edges.
  // Why: these are the audit trail's terminal states (FR-008) — if any of
  //      them had an outgoing edge, "final decision" would not be final.
  it.each(['DECIDED', 'REJECTED', 'DUPLICATE'] satisfies TransactionStatus[])(
    '%s is terminal',
    (status) => {
      expect(isTerminal(status)).toBe(true);
    },
  );

  it('every declared status is covered by the transition table', () => {
    // Guards against a status being added to the enum and silently
    // forgotten in the lifecycle graph.
    for (const status of TRANSACTION_STATUSES) {
      expect(() => canTransition(status, status)).not.toThrow();
    }
  });
});
