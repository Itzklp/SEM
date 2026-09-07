# ADR-006 — Transactional outbox for decision events

**Status:** Accepted
**Date:** 2026-09-07
**Deciders:** Team 04
**Related:** ADR-001, ADR-003, FR-009, NFR-013, RISK-005

---

## Context

Every fraud decision must do two things: be **durably recorded** (FR-008) and be
**published** to downstream consumers (FR-009). These touch two different systems —
PostgreSQL and Kafka — and there is no transaction spanning both.

That produces the classic dual-write problem. Naively:

```ts
await db.insert(decision); // (1)
await kafka.produce(event); // (2)
```

If (1) succeeds and (2) fails, the decision exists but no consumer ever learns of it: no
audit event, no feature update, and for a `REVIEW` decision, **no case is ever created**
— a transaction is held for review that no analyst will ever see. If the order is
reversed, a crash between them publishes an event for a decision that does not exist.

Additionally, ADR-003 forbids awaiting Kafka on the hot path at all.

## Decision

**Use the transactional outbox pattern.** The decision and its outgoing event are written
in a single PostgreSQL transaction; a separate relay publishes to Kafka afterwards.

### Hot path (inside the request)

```sql
BEGIN;
  INSERT INTO decisions      (...);   -- the decision itself
  INSERT INTO outbox_events  (...);   -- the intent to publish
COMMIT;
```

One transaction, one round trip, atomic. Either both rows exist or neither does. The
response is returned immediately after commit — Kafka has not been contacted.

### Cold path (the relay, in `event-worker`)

1. Poll for unpublished outbox rows, ordered by `created_at`, batched, using
   `FOR UPDATE SKIP LOCKED` so multiple relay instances can run without contending.
2. Produce to Kafka, keyed for ordering (see below).
3. Mark rows published on broker acknowledgement.
4. On failure, leave them unpublished; retry with jittered exponential backoff.
5. Move rows exceeding the retry limit to a dead-letter state with the error recorded.

### Consequences for delivery semantics

This gives **at-least-once** delivery. A crash between step 2 and step 3 republishes on
recovery. We do **not** claim exactly-once — that would require idempotent producers plus
transactional consumer offsets, and claiming it without implementing it is exactly the
kind of unverified assertion this project forbids (Brief §19, §45).

Therefore **all consumers must be idempotent.** Enforced by:

- Every event carries a stable `eventId` (deterministic from transaction + event type).
- Consumers record processed `eventId`s and skip duplicates.
- State updates are idempotent by construction where possible — case creation is a
  conditional insert on the transaction ID; feature aggregation deduplicates by event ID
  before applying counter increments.
- The resilience suite includes a **deliberate duplicate-delivery test** (RISK-005), so
  idempotency is verified rather than assumed.

### Ordering

Events are keyed by the entity whose ordering matters: transaction events by
`transactionId`, feature-relevant events by `userId`. Kafka guarantees order within a
partition, so per-key ordering holds. There is no global ordering guarantee across keys
and none is needed.

### Outbox table sketch

```sql
CREATE TABLE outbox_events (
  id             BIGSERIAL PRIMARY KEY,
  event_id       UUID        NOT NULL UNIQUE,   -- consumer-side dedupe key
  aggregate_id   TEXT        NOT NULL,          -- transactionId / caseId
  event_type     TEXT        NOT NULL,
  topic          TEXT        NOT NULL,
  partition_key  TEXT        NOT NULL,
  payload        JSONB       NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at   TIMESTAMPTZ,
  attempts       INT         NOT NULL DEFAULT 0,
  last_error     TEXT
);

-- Serves the relay's only query: unpublished rows, oldest first.
-- Partial index keeps it small: published rows are excluded entirely, so the
-- index size tracks backlog depth rather than total event volume.
CREATE INDEX idx_outbox_unpublished
  ON outbox_events (created_at)
  WHERE published_at IS NULL;
```

Published rows are pruned by a retention job; the durable history lives in
`audit_events`, not in the outbox.

## Alternatives considered

### A. Direct produce inside the request handler, awaiting acknowledgement

- **Rejected.** Violates ADR-003 (Kafka in the hot path). Adds broker latency to every
  authorization and makes broker health a hot-path dependency — the exact coupling
  ADR-001 exists to prevent.

### B. Fire-and-forget produce (no await)

- **Rejected.** Superficially attractive: no latency cost, no blocking. But events are
  silently lost whenever the broker is unavailable or the process dies with a full
  producer buffer. Silent loss of audit and case-creation events is unacceptable for a
  financial system (FR-008), and the failure is invisible — the worst property a failure
  can have.

### C. Change Data Capture (Debezium reading the WAL)

- **Genuinely good**, and the industry-standard answer at scale. **Rejected on capacity
  and complexity**: Debezium needs Kafka Connect, another JVM of 500 MB–1 GB, on a machine
  with 7.86 GB (CON-002). It also requires logical replication configuration and adds a
  substantial operational component for three developers to learn and operate (CON-001).
  The polling relay achieves the same guarantee with materially less machinery.

### D. Two-phase commit across PostgreSQL and Kafka

- **Rejected.** Kafka does not participate in XA. Even where 2PC is available it
  introduces blocking and coordinator-failure recovery that is far worse than
  at-least-once plus idempotent consumers.

### E. Accept the dual write and reconcile periodically

- **Rejected.** Reconciliation is a second correctness mechanism to build, test and
  operate, and it leaves a window during which cases genuinely do not exist. The outbox
  removes the window entirely.

## Consequences

### Positive

- No lost events. If a decision was committed, its event _will_ be published.
- The hot path is untouched by broker health — Kafka can be down for the entire
  authorization and nothing observable changes.
- The extra hot-path cost is one `INSERT` in a transaction already being performed —
  well inside the 7 ms write budget.
- Relay instances scale horizontally via `SKIP LOCKED` without coordination.
- Backlog depth is a directly measurable health signal (`outbox_pending_total`).

### Negative

- Publication latency equals the relay poll interval. Target: sub-second. Tuning it trades
  freshness against database polling load.
- The outbox table grows and needs a retention job — an operational task that must
  actually exist, not be assumed.
- **At-least-once means duplicates are normal.** Every consumer must be idempotent; this
  is real, ongoing implementation discipline, and is the reason RISK-005 has an explicit
  test.
- The relay is a component that can itself fail. Mitigated by making it stateless and
  restart-safe — unpublished rows are simply picked up again.

### Neutral

- The relay's home (inside `event-worker` versus its own process) is deliberately left
  open — ARCHITECTURE.md §12 question 1, to be decided in Phase 6 with the pattern
  already in place either way.
