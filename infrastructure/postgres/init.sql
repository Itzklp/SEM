-- FraudGuard — PostgreSQL bootstrap.
--
-- Runs once, on first container start (mounted into
-- /docker-entrypoint-initdb.d/, which the postgres image executes only
-- against an empty data directory). Deliberately minimal: this is
-- infrastructure bootstrap (Phase 2), not application schema — the actual
-- tables from docs/architecture/data-model.md are owned by
-- packages/persistence's migration runner (Phase 3). Mixing the two would
-- mean two sources of truth for schema.

-- gen_random_uuid(): used for outbox_events.event_id and fraud_cases.case_id
-- generation (docs/architecture/data-model.md) without pulling a UUID
-- library into every service that needs one.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- pg_stat_statements: per-query latency/call-count visibility, feeding the
-- db_duration_seconds metric family (Phase 7) and useful on its own during
-- Phase 9 bottleneck analysis without adding an external dependency.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
