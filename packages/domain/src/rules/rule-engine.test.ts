import type { FeatureVector } from '../entities/feature-vector';
import { createTransaction, type CreateTransactionInput } from '../entities/transaction';
import { Money } from '../value-objects/money';

import type { FraudRule, RuleInput, RuleResult } from './fraud-rule';
import { evaluateRules } from './rule-engine';

function buildInput(): RuleInput {
  const transaction = createTransaction({
    transactionId: 'txn_1',
    userId: 'user_1',
    merchantId: 'merchant_1',
    deviceId: 'device_1',
    amount: Money.of(1_000, 'USD'),
    ipAddress: '203.0.113.1',
    paymentMethod: 'card_token_1',
    timestamp: new Date('2026-06-01T00:00:00Z'),
  } satisfies CreateTransactionInput);
  const features: FeatureVector = {
    userId: 'user_1',
    computedAt: new Date(),
    source: 'live',
    features: {},
  };
  return { transaction, features };
}

function fixedRule(name: string, triggered: boolean, scoreContribution: number): FraudRule {
  return {
    name,
    evaluate: (): RuleResult => ({
      ruleName: name,
      triggered,
      severity: 'MEDIUM',
      reason: triggered ? `${name} fired` : '',
      scoreContribution,
    }),
  };
}

describe('evaluateRules', () => {
  it('returns every rule result, triggered or not', () => {
    const rules = [fixedRule('a', false, 0), fixedRule('b', true, 0.5)];
    const result = evaluateRules(rules, buildInput());
    expect(result.results).toHaveLength(2);
    expect(result.triggered).toHaveLength(1);
    expect(result.triggered[0]?.ruleName).toBe('b');
  });

  it('combines via MAX across triggered rules, not an average', () => {
    // One CRITICAL-equivalent hit among several quiet rules must not be
    // diluted toward zero by averaging across all of them.
    const rules = [
      fixedRule('a', false, 0),
      fixedRule('b', false, 0),
      fixedRule('c', true, 1.0),
      fixedRule('d', false, 0),
    ];
    const result = evaluateRules(rules, buildInput());
    expect(result.combinedScore.value).toBe(1.0);
  });

  it('produces a zero combined score when nothing triggers', () => {
    const rules = [fixedRule('a', false, 0), fixedRule('b', false, 0)];
    const result = evaluateRules(rules, buildInput());
    expect(result.combinedScore.value).toBe(0);
  });

  it('is deterministic for identical input', () => {
    const rules = [fixedRule('a', true, 0.4), fixedRule('b', true, 0.6)];
    const once = evaluateRules(rules, buildInput());
    const again = evaluateRules(rules, buildInput());
    expect(once.combinedScore.value).toBe(again.combinedScore.value);
  });

  // UT-RULE-031. What: adding a rule requires no change to this engine.
  // Why: this is the exit-criterion claim itself, proved directly — an
  // ad hoc rule never seen by rule-engine.ts, defined only in this test,
  // participates correctly with zero changes to evaluateRules().
  it('integrates a brand-new, ad hoc rule with no change to the engine', () => {
    const builtIn = fixedRule('velocity', false, 0);
    const newRule: FraudRule = {
      name: 'a-rule-invented-just-for-this-test',
      evaluate: (): RuleResult => ({
        ruleName: 'a-rule-invented-just-for-this-test',
        triggered: true,
        severity: 'HIGH',
        reason: 'invented for this test',
        scoreContribution: 0.8,
      }),
    };

    const result = evaluateRules([builtIn, newRule], buildInput());
    expect(result.triggered).toHaveLength(1);
    expect(result.triggered[0]?.ruleName).toBe('a-rule-invented-just-for-this-test');
    expect(result.combinedScore.value).toBe(0.8);
  });
});
