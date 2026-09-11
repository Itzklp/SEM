import {
  customType,
  pgTable,
  text,
  bigint,
  bigserial,
  char,
  timestamp,
  boolean,
  numeric,
  real,
  integer,
  jsonb,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Typed schema definitions for query building. The actual DDL — including
 * CHECK constraints, foreign keys, and partial indexes — lives in
 * `migrations/*.sql` (hand-written, applied by `migrate.ts`'s own runner
 * rather than drizzle-kit's). The two are related but deliberately
 * decoupled: this file exists so repositories get compile-time-checked
 * `db.insert(transactions).values({...})` calls; the migration is the
 * single source of truth for the real schema. Keep them in sync manually
 * when either changes — full rationale for every column and index:
 * docs/architecture/data-model.md.
 *
 * Phase 3: `transactions`, `decisions`. Phase 6: `outbox_events`,
 * `fraud_cases`, `audit_events`. `risk_policies` (FR-006's persisted
 * policy history) and `model_versions` (FR-012, Phase 10) remain
 * deferred — FR-006 is satisfied today by Phase 5's in-memory
 * `PolicyStore`, a deliberately simpler choice than a DB-backed table
 * (documented there); `model_versions` has no real model to register yet.
 */

/** No first-class `inet` builder in drizzle's pg-core — a thin custom type gets the real Postgres column type from data-model.md's rationale (range/subnet queries) without pulling in a heavier dependency. */
const inet = customType<{ data: string }>({
  dataType() {
    return 'inet';
  },
});

export const transactions = pgTable('transactions', {
  transactionId: text('transaction_id').primaryKey(),
  userId: text('user_id').notNull(),
  merchantId: text('merchant_id').notNull(),
  deviceId: text('device_id').notNull(),
  amountMinorUnits: bigint('amount_minor_units', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  paymentMethod: text('payment_method').notNull(),
  ipAddress: inet('ip_address').notNull(),
  status: text('status').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
});

export const decisions = pgTable('decisions', {
  transactionId: text('transaction_id')
    .primaryKey()
    .references(() => transactions.transactionId),
  decision: text('decision').notNull(),
  // No `mode` option in this drizzle-orm version — numeric always
  // round-trips as a string (avoids silent float-precision loss on a
  // column CHECK-constrained to [0,1] at 4 decimal places). Repositories
  // convert explicitly at the boundary — see TransactionRepository.
  riskScore: numeric('risk_score', { precision: 5, scale: 4 }).notNull(),
  /** Client-safe reasons only (`toClientSafeReasons` output) — see data-model.md's rationale for why internal rule detail never lands here. */
  reasons: jsonb('reasons').notNull().$type<{ reason: string }[]>(),
  policyVersion: text('policy_version').notNull(),
  modelVersion: text('model_version').notNull(),
  scoringProvider: text('scoring_provider').notNull(),
  degraded: boolean('degraded').notNull(),
  degradedReason: text('degraded_reason').notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
  processingTimeMs: real('processing_time_ms').notNull(),
});

export type TransactionRow = typeof transactions.$inferSelect;
export type NewTransactionRow = typeof transactions.$inferInsert;
export type DecisionRow = typeof decisions.$inferSelect;
export type NewDecisionRow = typeof decisions.$inferInsert;

/**
 * ADR-006's work queue — not durable history (`audit_events` is). One row
 * per outgoing event; `payload` is whatever `@fraudguard/contracts`'
 * event schemas produced, kept as `unknown` here since `packages/persistence`
 * does not depend on `packages/contracts` (ADR-004 layering) — the caller
 * (`apps/fraud-api`) is the one that knows the real shape.
 */
export const outboxEvents = pgTable('outbox_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  eventId: uuid('event_id').notNull(),
  aggregateId: text('aggregate_id').notNull(),
  eventType: text('event_type').notNull(),
  topic: text('topic').notNull(),
  partitionKey: text('partition_key').notNull(),
  payload: jsonb('payload').notNull().$type<unknown>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
});

export type OutboxEventRow = typeof outboxEvents.$inferSelect;
export type NewOutboxEventRow = typeof outboxEvents.$inferInsert;

/** FR-010, FR-011. One row per REVIEW decision — `lifecycle/case-lifecycle.ts` (packages/domain) governs the legal `status` transitions; this table just stores the current state. */
export const fraudCases = pgTable('fraud_cases', {
  caseId: uuid('case_id').primaryKey(),
  transactionId: text('transaction_id')
    .notNull()
    .unique()
    .references(() => transactions.transactionId),
  status: text('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewerId: text('reviewer_id'),
  reviewReason: text('review_reason'),
});

export type FraudCaseRow = typeof fraudCases.$inferSelect;
export type NewFraudCaseRow = typeof fraudCases.$inferInsert;

/** FR-008. Append-only — `AuditRepository` (repositories/audit-repository.ts) exposes no update/delete method; see the migration's note on why that is application-level, not database-role-level, enforcement here. */
export const auditEvents = pgTable('audit_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  eventId: uuid('event_id').notNull(),
  aggregateType: text('aggregate_type').notNull(),
  aggregateId: text('aggregate_id').notNull(),
  action: text('action').notNull(),
  actorId: text('actor_id'),
  detail: jsonb('detail').notNull().$type<Record<string, unknown>>(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
});

export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEventRow = typeof auditEvents.$inferInsert;
