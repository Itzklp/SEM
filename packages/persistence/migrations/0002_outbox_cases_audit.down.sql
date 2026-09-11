-- Rollback for 0002_outbox_cases_audit.sql
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS fraud_cases;
DROP TABLE IF EXISTS outbox_events;
