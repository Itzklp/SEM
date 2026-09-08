-- FraudGuard migration 0001 — transactions and decisions.
--
-- Phase 3 scope only. Full rationale for every column, constraint and
-- index: docs/architecture/data-model.md. Applied by src/migrate.ts's
-- runner, tracked in schema_migrations (created automatically on first run).

CREATE TABLE transactions (
  transaction_id      TEXT NOT NULL PRIMARY KEY,
  user_id              TEXT NOT NULL,
  merchant_id           TEXT NOT NULL,
  device_id            TEXT NOT NULL,
  amount_minor_units   BIGINT NOT NULL CHECK (amount_minor_units >= 0),
  currency             CHAR(3) NOT NULL,
  payment_method        TEXT NOT NULL,
  ip_address           INET NOT NULL,
  status                TEXT NOT NULL CHECK (
    status IN ('RECEIVED', 'VALIDATED', 'REJECTED', 'DUPLICATE', 'FEATURES_LOADED', 'SCORED', 'DECIDED')
  ),
  received_at          TIMESTAMPTZ NOT NULL
);

-- "This user's transaction history" queries (review-api investigation
-- screen) and cold-path feature-window recomputation from durable history.
CREATE INDEX idx_transactions_user_received ON transactions (user_id, received_at);
CREATE INDEX idx_transactions_merchant_received ON transactions (merchant_id, received_at);

CREATE TABLE decisions (
  transaction_id     TEXT NOT NULL PRIMARY KEY REFERENCES transactions (transaction_id),
  decision           TEXT NOT NULL CHECK (decision IN ('ALLOW', 'REVIEW', 'BLOCK')),
  risk_score         NUMERIC(5, 4) NOT NULL CHECK (risk_score >= 0 AND risk_score <= 1),
  reasons            JSONB NOT NULL,
  policy_version     TEXT NOT NULL,
  model_version      TEXT NOT NULL,
  scoring_provider   TEXT NOT NULL CHECK (scoring_provider IN ('stub', 'rules', 'ml')),
  degraded           BOOLEAN NOT NULL,
  degraded_reason    TEXT NOT NULL CHECK (degraded_reason IN ('NONE', 'FEATURES_UNAVAILABLE', 'ML_UNAVAILABLE')),
  decided_at         TIMESTAMPTZ NOT NULL,
  processing_time_ms REAL NOT NULL CHECK (processing_time_ms >= 0)
);

-- Time-range queries for reporting and the Phase 9 performance report.
CREATE INDEX idx_decisions_decided_at ON decisions (decided_at);

-- ADR-005 visibility requirement: the degraded-decision ratio is a small,
-- frequently-queried subset regardless of total decision volume — a
-- partial index keeps that query cheap forever, not just today.
CREATE INDEX idx_decisions_degraded ON decisions (degraded) WHERE degraded = true;
