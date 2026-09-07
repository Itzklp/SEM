/**
 * Core domain vocabulary. These are the enums every other layer — API DTOs,
 * Kafka event payloads, database columns — is defined in terms of.
 *
 * Deliberately plain string unions rather than TypeScript `enum`: they are
 * structurally identical to what arrives over JSON (no numeric-enum surprise
 * at a Kafka/HTTP boundary), and they satisfy ADR-004's "zero framework,
 * minimal dependency" rule for this package trivially — no runtime construct
 * at all, just a type.
 */

/** FR-006. The three possible outcomes of a fraud decision. */
export const DECISIONS = ['ALLOW', 'REVIEW', 'BLOCK'] as const;
export type Decision = (typeof DECISIONS)[number];

/**
 * FR-001, §10 of the brief. A transaction's position in its lifecycle.
 * See `lifecycle/transaction-lifecycle.ts` for the legal transition graph —
 * this list is the set of states, not the rules for moving between them.
 */
export const TRANSACTION_STATUSES = [
  'RECEIVED',
  'VALIDATED',
  'REJECTED', // terminal — malformed input, never scored
  'DUPLICATE', // terminal — idempotent replay of a prior transactionId
  'FEATURES_LOADED',
  'SCORED',
  'DECIDED', // terminal — carries a Decision
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

/** FR-011. A fraud case's review state. */
export const CASE_STATUSES = ['OPEN', 'APPROVED', 'BLOCKED', 'ESCALATED'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** FR-011. The action a reviewer takes on an open case. */
export const CASE_ACTIONS = ['APPROVE', 'BLOCK', 'ESCALATE'] as const;
export type CaseAction = (typeof CASE_ACTIONS)[number];

/**
 * ADR-005. Which per-dependency degradation policy produced a decision, if
 * any. `NONE` means the decision was made with full signal available —
 * this is what makes the degraded proportion a countable metric (NFR-011)
 * rather than an inference from logs.
 */
export const DEGRADED_REASONS = [
  'NONE',
  'FEATURES_UNAVAILABLE', // Redis down — ADR-005 cautious-open
  'ML_UNAVAILABLE', // ML provider circuit open — ADR-005 fallback
] as const;
export type DegradedReason = (typeof DEGRADED_REASONS)[number];

/**
 * CON-005 / ADR-004 Strategy pattern. Identifies which `FraudScoringProvider`
 * implementation produced a score — persisted on every decision (FR-012)
 * so ML-vs-baseline comparison (Phase 10) can be done from stored data.
 */
export const SCORING_PROVIDERS = ['stub', 'rules', 'ml'] as const;
export type ScoringProviderName = (typeof SCORING_PROVIDERS)[number];

/** FR-003. Severity of a triggered fraud rule, feeding score contribution. */
export const RULE_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RuleSeverity = (typeof RULE_SEVERITIES)[number];
