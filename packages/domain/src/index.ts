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
