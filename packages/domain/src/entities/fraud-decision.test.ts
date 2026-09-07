import { toClientSafeReasons, type RiskFactor } from './fraud-decision';

describe('toClientSafeReasons', () => {
  // What: internal detail (source, scoreContribution) is stripped from the
  //       client-facing reason list.
  // Why: FR-007 requires explanations without leaking internals; ADR-005's
  //      threat-model entry ST-LEAK-001 exists specifically because
  //      revealing the exact rule and weight that fired would let an
  //      attacker calibrate future transactions to stay under it.
  // Catches: a future change to the response serializer that accidentally
  //          spreads the full RiskFactor (internal included) into the API
  //          response.
  it('strips internal fields, keeping only the client-safe reason text', () => {
    const factors: RiskFactor[] = [
      {
        reason: 'Transaction velocity is unusually high',
        internal: { source: 'VelocityRule', scoreContribution: 0.4 },
      },
      {
        reason: 'Amount is 6.2x the account average',
        internal: { source: 'AmountDeviationRule', scoreContribution: 0.3 },
      },
    ];

    const safe = toClientSafeReasons(factors);

    expect(safe).toEqual([
      { reason: 'Transaction velocity is unusually high' },
      { reason: 'Amount is 6.2x the account average' },
    ]);
    for (const item of safe) {
      expect(item).not.toHaveProperty('internal');
    }
  });

  it('returns an empty list for an empty input', () => {
    expect(toClientSafeReasons([])).toEqual([]);
  });
});
