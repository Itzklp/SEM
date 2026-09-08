import {
  customType,
  pgTable,
  text,
  bigint,
  char,
  timestamp,
  boolean,
  numeric,
  real,
  jsonb,
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
 * Phase 3 scope only: `transactions` and `decisions`. `fraud_cases`,
 * `outbox_events`, `audit_events`, `risk_policies`, `model_versions` are
 * Phase 6+ deliverables per docs/ROADMAP.md — not pulled forward.
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
