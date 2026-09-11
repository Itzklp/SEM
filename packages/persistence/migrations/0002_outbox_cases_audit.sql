-- FraudGuard migration 0002 — outbox, fraud cases, audit trail.
--
-- Phase 6 scope. Full rationale: docs/adr/ADR-006-transactional-outbox.md
-- (outbox_events) and docs/architecture/data-model.md (fraud_cases,
-- audit_events). Applied by src/migrate.ts's runner.

-- Work queue drained by apps/event-worker's relay — NOT durable history
-- (audit_events is). One row per outgoing event, written in the same
-- transaction as the domain row it describes (ADR-006's whole point).
CREATE TABLE outbox_events (
  id             BIGSERIAL PRIMARY KEY,
  event_id       UUID NOT NULL UNIQUE,
  aggregate_id   TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  topic          TEXT NOT NULL,
  partition_key  TEXT NOT NULL,
  payload        JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at   TIMESTAMPTZ,
  attempts       INT NOT NULL DEFAULT 0,
  last_error     TEXT
);

-- Serves the relay's only query: unpublished rows, oldest first. Partial
-- index keeps it small — published rows are excluded entirely, so size
-- tracks backlog depth, not total event volume ever produced.
CREATE INDEX idx_outbox_unpublished ON outbox_events (created_at) WHERE published_at IS NULL;

CREATE TABLE fraud_cases (
  case_id         UUID NOT NULL PRIMARY KEY,
  transaction_id  TEXT NOT NULL UNIQUE REFERENCES transactions (transaction_id),
  status          TEXT NOT NULL CHECK (status IN ('OPEN', 'APPROVED', 'BLOCKED', 'ESCALATED')),
  created_at      TIMESTAMPTZ NOT NULL,
  reviewed_at     TIMESTAMPTZ,
  reviewer_id     TEXT,
  review_reason   TEXT
);

-- UNIQUE (transaction_id) above is the idempotency backstop (RISK-005):
-- a duplicate case-creation attempt for the same transaction fails the
-- constraint rather than creating a second case.
--
-- This IS the review queue query (GET /fraud/cases?status=OPEN) — a
-- partial index keeps it small regardless of how many cases have
-- accumulated historically.
CREATE INDEX idx_fraud_cases_open ON fraud_cases (created_at) WHERE status = 'OPEN';

-- Append-only (FR-008). NOT durable via a foreign key to aggregate_id —
-- deliberately: an audit log must stay valid and queryable independent
-- of the schema of whatever it describes (data-model.md's rationale).
CREATE TABLE audit_events (
  id              BIGSERIAL PRIMARY KEY,
  event_id        UUID NOT NULL UNIQUE,
  aggregate_type  TEXT NOT NULL CHECK (aggregate_type IN ('transaction', 'case', 'model', 'policy')),
  aggregate_id    TEXT NOT NULL,
  action          TEXT NOT NULL,
  actor_id        TEXT,
  detail          JSONB NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL
);

-- The investigation-screen query: "everything that happened to
-- transaction X, in order."
CREATE INDEX idx_audit_events_aggregate ON audit_events (aggregate_type, aggregate_id, occurred_at);

-- NOTE (honestly scoped, not silently skipped): data-model.md calls for
-- REVOKE UPDATE, DELETE at the database-privilege level, enforced
-- against a role distinct from the one the migration itself runs as.
-- This prototype connects as a single Postgres role (POSTGRES_USER) for
-- every service, including migrations — revoking privileges from that
-- role would revoke them from the migration runner too, and if that role
-- is the database owner/superuser (it is, in local/dev setup), a REVOKE
-- has no effect regardless. Real least-privilege roles are a Phase 11
-- hardening concern (docs/security/threat-model.md), not fabricated
-- here as a REVOKE statement that would not actually enforce anything.
-- "Append-only" is enforced today at the application layer only:
-- AuditRepository (packages/persistence) exposes no update/delete method.
