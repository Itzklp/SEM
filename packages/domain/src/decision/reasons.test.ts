import { toClientSafeReasons, type RiskFactor } from '../entities/fraud-decision';

import { buildReasons } from './reasons';

const FACTOR: RiskFactor = {
  reason: 'Unusually high transaction velocity',
  internal: { source: 'velocity', scoreContribution: 0.6 },
};

// UT-EXPL-001. What: every non-ALLOW decision carries at least one reason.
describe('buildReasons', () => {
  it('passes through real reasons unchanged when present', () => {
    expect(buildReasons([FACTOR], 'BLOCK')).toEqual([FACTOR]);
  });

  it('synthesises a fallback reason for a non-ALLOW decision with no triggered rules', () => {
    // FR-005: the model or behavioural signal alone can push the
    // combined score past a threshold with zero rules firing — FR-007's
    // guarantee must not depend on a rule having triggered.
    const reasons = buildReasons([], 'REVIEW');
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons[0]?.reason).toBeTruthy();
  });

  it('synthesises a fallback reason for BLOCK with no triggered rules too', () => {
    expect(buildReasons([], 'BLOCK').length).toBeGreaterThan(0);
  });

  it('does NOT synthesise a reason for ALLOW, even with an empty list', () => {
    expect(buildReasons([], 'ALLOW')).toEqual([]);
  });

  it('does not suppress real reasons on ALLOW either (a provider choosing to report one is respected)', () => {
    expect(buildReasons([FACTOR], 'ALLOW')).toEqual([FACTOR]);
  });
});

// UT-EXPL-002. What: reasons never leak internal weights, thresholds, or model internals to the client.
describe('toClientSafeReasons + buildReasons, together', () => {
  it('strips every internal field from the fallback reason too', () => {
    const reasons = buildReasons([], 'REVIEW');
    const clientSafe = toClientSafeReasons(reasons);
    for (const r of clientSafe) {
      expect(Object.keys(r)).toEqual(['reason']);
    }
  });

  it('strips internal rule detail (source, scoreContribution) from a real triggered reason', () => {
    const clientSafe = toClientSafeReasons(buildReasons([FACTOR], 'BLOCK'));
    expect(clientSafe).toEqual([{ reason: FACTOR.reason }]);
    // @ts-expect-error -- asserting the internal field is genuinely absent at runtime, not just unused at the type level
    expect(clientSafe[0]?.internal).toBeUndefined();
  });
});
