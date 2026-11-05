-- Backs the web dashboard (apps/web): real accounts instead of hand-signed
-- test tokens, and a durable record of admin-triggered test runs.
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('customer', 'admin')),
  privileges    JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Two seeded accounts so the login screen works out of the box. Password
-- for both is "fraudguard-demo" — bcrypt hash below, cost factor 10.
-- Fine for a local practice sandbox; never reused for anything real.
INSERT INTO users (email, password_hash, display_name, role, privileges) VALUES
  ('customer@fraudguard.dev', '$2a$10$AUYQAOOlSW.rvjTCdOoQseE07/JzU//h5uK91x9uJ/zFvP5a3a7c6', 'Jordan Casey', 'customer', '["score"]'::jsonb),
  ('admin@fraudguard.dev',    '$2a$10$AUYQAOOlSW.rvjTCdOoQseE07/JzU//h5uK91x9uJ/zFvP5a3a7c6', 'Priya Natarajan', 'admin', '["score", "review", "admin"]'::jsonb);

CREATE TABLE test_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  suite         TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed', 'errored')),
  triggered_by  TEXT NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  passed_count  INTEGER,
  failed_count  INTEGER,
  total_count   INTEGER,
  log           TEXT NOT NULL DEFAULT ''
);
CREATE INDEX test_runs_started_at_idx ON test_runs (started_at DESC);
