import type { CaseAction, CaseStatus } from '../enums';
import { IllegalTransitionError } from '../errors';

import { applyCaseAction, canApplyCaseAction, isCaseTerminal } from './case-lifecycle';

describe('fraud case lifecycle', () => {
  // What: each reviewer action from OPEN reaches its correct terminal state.
  // Why: FR-011 requires reviewer actions to produce the right case outcome.
  it.each([
    ['APPROVE', 'APPROVED'],
    ['BLOCK', 'BLOCKED'],
    ['ESCALATE', 'ESCALATED'],
  ] satisfies [CaseAction, CaseStatus][])('OPEN + %s -> %s', (action, expected) => {
    expect(canApplyCaseAction('OPEN', action)).toBe(true);
    expect(applyCaseAction('OPEN', action)).toBe(expected);
  });

  // What: acting on an already-closed case is rejected.
  // Why: this is the exact mechanism that stops a duplicate
  //      `review.completed` Kafka event (RISK-005 / RT-DUP-001) from
  //      silently re-reviewing a case, or overturning its outcome.
  // Catches: a consumer applying the same event twice without an
  //          idempotency check upstream — the lifecycle itself is the
  //          second line of defence.
  it.each(['APPROVED', 'BLOCKED', 'ESCALATED'] satisfies CaseStatus[])(
    'rejects any action on an already-%s case',
    (closedStatus) => {
      expect(canApplyCaseAction(closedStatus, 'APPROVE')).toBe(false);
      expect(() => applyCaseAction(closedStatus, 'APPROVE')).toThrow(IllegalTransitionError);
    },
  );

  it('OPEN is the only non-terminal status', () => {
    expect(isCaseTerminal('OPEN')).toBe(false);
    expect(isCaseTerminal('APPROVED')).toBe(true);
    expect(isCaseTerminal('BLOCKED')).toBe(true);
    expect(isCaseTerminal('ESCALATED')).toBe(true);
  });
});
