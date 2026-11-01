-- Store minimized inputs and analyst labels on the cold path. No user,
-- device, IP, or merchant identifiers are retained. Escalations stay unlabeled.
CREATE TABLE model_training_examples (
  transaction_id TEXT PRIMARY KEY,
  features JSONB,
  amount_major_units REAL,
  predicted_decision TEXT,
  model_version TEXT,
  label BOOLEAN,
  label_source TEXT,
  labeled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT model_training_examples_label_source_check
    CHECK (label_source IS NULL OR label_source = 'analyst_review')
);
CREATE INDEX model_training_examples_labeled_idx
  ON model_training_examples (labeled_at) WHERE label IS NOT NULL;

CREATE TABLE model_versions (
  model_version TEXT PRIMARY KEY,
  provider_name TEXT NOT NULL,
  description TEXT NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  metrics JSONB,
  CONSTRAINT model_versions_metrics_object_check
    CHECK (metrics IS NULL OR jsonb_typeof(metrics) = 'object')
);
CREATE UNIQUE INDEX model_versions_one_active_idx ON model_versions (active) WHERE active = TRUE;
