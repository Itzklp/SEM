// Enums — the shared domain vocabulary.
export * from './enums';

// Errors — the typed failure taxonomy.
export * from './errors';

// Value objects.
export * from './value-objects/money';
export * from './value-objects/risk-score';

// Entities.
export * from './entities/transaction';
export * from './entities/fraud-decision';
export * from './entities/fraud-case';
export * from './entities/model-version';
export * from './entities/risk-policy';
export * from './entities/feature-vector';

// Lifecycle state machines.
export * from './lifecycle/transaction-lifecycle';
export * from './lifecycle/case-lifecycle';

// The two load-bearing abstractions — CON-005.
export * from './scoring/fraud-scoring-provider';
export * from './rules/fraud-rule';

// Phase 5: the rule engine and its six rules.
export * from './rules/rule-thresholds';
export * from './rules/ratio-severity';
export * from './rules/velocity-rule';
export * from './rules/amount-deviation-rule';
export * from './rules/device-risk-rule';
export * from './rules/geographic-anomaly-rule';
export * from './rules/failed-attempt-rule';
export * from './rules/merchant-risk-rule';
export * from './rules/rule-engine';

// Phase 5: scoring providers and combination.
export * from './scoring/behavioural-score';
export * from './scoring/combiner';
export * from './scoring/stub-scoring-provider';
export * from './scoring/rule-based-scoring-provider';

// Phase 5: the real decision engine and explainability.
export * from './decision/decision-engine';
export * from './decision/reasons';
