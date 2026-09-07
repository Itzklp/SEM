import { scoreRequestSchema, scoreResponseSchema } from './scoring.dto';

function validRequest() {
  return {
    transactionId: 'txn_123',
    userId: 'user_123',
    merchantId: 'merchant_456',
    deviceId: 'device_789',
    amount: { minorUnits: 1999, currency: 'USD' },
    paymentMethod: 'card_token_abc',
    ipAddress: '203.0.113.7',
    timestamp: '2026-09-07T12:00:00Z',
  };
}

describe('scoreRequestSchema', () => {
  it('accepts a well-formed request', () => {
    expect(scoreRequestSchema.safeParse(validRequest()).success).toBe(true);
  });

  // What: an unrecognised field is rejected, not silently dropped.
  // Why: ST-TAMPER-001. A tampering attempt or a client bug that adds an
  //      unexpected field (e.g. a client-supplied "riskScore" override)
  //      must fail loudly, not be quietly ignored and processed anyway.
  it('rejects an unrecognised field', () => {
    const result = scoreRequestSchema.safeParse({ ...validRequest(), riskScoreOverride: 0 });
    expect(result.success).toBe(false);
  });

  // What: no field in this schema can carry a card number.
  // Why: this IS the "PAN cannot be accepted" guarantee from SECURITY.md —
  //      demonstrated by trying to smuggle one in and confirming there is
  //      no field for it to land in.
  it('has no schema field capable of accepting a PAN (extra fields rejected)', () => {
    const withPan = { ...validRequest(), cardNumber: '4111111111111111' };
    expect(scoreRequestSchema.safeParse(withPan).success).toBe(false);
  });

  it.each(['transactionId', 'userId', 'merchantId', 'deviceId'] as const)(
    'rejects a malformed %s',
    (field) => {
      const result = scoreRequestSchema.safeParse({ ...validRequest(), [field]: 'has spaces!' });
      expect(result.success).toBe(false);
    },
  );

  it('rejects a non-integer amount', () => {
    const result = scoreRequestSchema.safeParse({
      ...validRequest(),
      amount: { minorUnits: 19.99, currency: 'USD' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid IP address', () => {
    const result = scoreRequestSchema.safeParse({ ...validRequest(), ipAddress: 'not-an-ip' });
    expect(result.success).toBe(false);
  });
});

describe('scoreResponseSchema', () => {
  function validResponse() {
    return {
      transactionId: 'txn_123',
      decision: 'ALLOW' as const,
      riskScore: 0.12,
      reasons: [],
      policyVersion: 'policy-v1',
      modelVersion: 'model-v0-stub',
      scoringProvider: 'stub' as const,
      degraded: false,
      degradedReason: 'NONE' as const,
      processingTimeMs: 8.4,
    };
  }

  it('accepts a well-formed response', () => {
    expect(scoreResponseSchema.safeParse(validResponse()).success).toBe(true);
  });

  // What: `reasons` may only contain the client-safe shape.
  // Why: guards the wire contract half of the ST-LEAK-001 protection —
  //      the domain-side half is `toClientSafeReasons` (packages/domain).
  it('rejects a reason carrying internal detail', () => {
    const result = scoreResponseSchema.safeParse({
      ...validResponse(),
      reasons: [
        { reason: 'High velocity', internal: { source: 'VelocityRule', scoreContribution: 0.4 } },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a risk score outside [0, 1]', () => {
    expect(scoreResponseSchema.safeParse({ ...validResponse(), riskScore: 1.5 }).success).toBe(
      false,
    );
  });

  it('rejects an unrecognised decision value', () => {
    expect(scoreResponseSchema.safeParse({ ...validResponse(), decision: 'MAYBE' }).success).toBe(
      false,
    );
  });
});
