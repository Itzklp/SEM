import {
  RiskScore,
  createTransaction,
  Money,
  type FeatureVector,
  type FraudScoringProvider,
  type ScoringInput,
  type ScoringResult,
} from '@fraudguard/domain';

/**
 * CT-SCORE-001 (traceability matrix). Verifies the single most important
 * property in this codebase (CON-005, ADR-004): any `FraudScoringProvider`
 * implementation is usable identically by a consumer written only against
 * the interface.
 *
 * Real implementations (`StubFraudScoringProvider`, `RuleBasedScoringProvider`,
 * and eventually `MLScoringProvider`) don't exist until Phase 5 / Phase 10.
 * This test uses two minimal fakes to prove the *contract* holds now, so
 * the interface is settled before three developers build against it in
 * parallel, and so a regression that breaks substitutability (e.g. a
 * provider-specific method creeping onto the interface) is caught the
 * moment it's introduced rather than discovered in Phase 10.
 */
describe('FraudScoringProvider contract', () => {
  function buildInput(): ScoringInput {
    const transaction = createTransaction({
      transactionId: 'txn_1',
      userId: 'user_1',
      merchantId: 'merchant_1',
      deviceId: 'device_1',
      amount: Money.of(1000, 'USD'),
      ipAddress: '203.0.113.7',
      paymentMethod: 'card_token_abc',
      timestamp: new Date('2026-09-07T12:00:00Z'),
    });
    const features: FeatureVector = {
      userId: 'user_1',
      computedAt: new Date(),
      source: 'live',
      features: {},
    };
    return { transaction, features };
  }

  class AlwaysAllowProvider implements FraudScoringProvider {
    readonly name = 'stub' as const;
    // eslint-disable-next-line @typescript-eslint/require-await
    async score(): Promise<ScoringResult> {
      return {
        score: RiskScore.zero(),
        riskFactors: [],
        provider: this.name,
        modelVersion: 'model-v0-stub',
      };
    }
  }

  class AlwaysBlockProvider implements FraudScoringProvider {
    readonly name = 'rules' as const;
    // eslint-disable-next-line @typescript-eslint/require-await
    async score(): Promise<ScoringResult> {
      return {
        score: RiskScore.of(1),
        riskFactors: [
          { reason: 'Always blocks', internal: { source: 'test', scoreContribution: 1 } },
        ],
        provider: this.name,
        modelVersion: 'model-v0-rules',
      };
    }
  }

  // A function written against the interface ONLY — this is the shape every
  // real consumer (the future decision engine) will have.
  async function decide(provider: FraudScoringProvider, input: ScoringInput) {
    const result = await provider.score(input);
    return result.score.isAtLeast(0.5) ? 'BLOCK' : 'ALLOW';
  }

  it.each([
    ['stub-like provider', new AlwaysAllowProvider(), 'ALLOW'],
    ['rules-like provider', new AlwaysBlockProvider(), 'BLOCK'],
  ] as const)(
    '%s satisfies the interface and produces a usable result',
    async (_label, provider, expected) => {
      const outcome = await decide(provider, buildInput());
      expect(outcome).toBe(expected);
    },
  );

  it('every provider result records a provider name and model version for audit (FR-012)', async () => {
    const providers: FraudScoringProvider[] = [
      new AlwaysAllowProvider(),
      new AlwaysBlockProvider(),
    ];
    for (const provider of providers) {
      const result = await provider.score(buildInput());
      expect(result.provider).toBe(provider.name);
      expect(result.modelVersion.length).toBeGreaterThan(0);
    }
  });
});
