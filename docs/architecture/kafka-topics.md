# FraudGuard — Kafka Topic Catalogue

**Version:** 1.0 (baseline) · **Date:** 2026-09-07

Every topic FraudGuard uses, why it exists, and its operational contract. The schemas
themselves live in `packages/contracts/src/events/` — this document is the catalogue
entry each schema file's header comment points back to.

All topics carry the common envelope (`eventEnvelopeSchema`): `eventId`, `eventType`,
`aggregateId`, `occurredAt`, `traceId`. See [ADR-006](../adr/ADR-006-transactional-outbox.md)
for why `eventId` is deterministic rather than random, and why every consumer below is
required to be idempotent.

---

## Topic summary

| Topic                  | Producer                              | Consumers                                       | Partition key   | Retention |
| ---------------------- | ------------------------------------- | ----------------------------------------------- | --------------- | --------- |
| `transaction.received` | fraud-api (via outbox relay)          | audit, analytics                                | `transactionId` | 7 days    |
| `transaction.decided`  | fraud-api (via outbox relay)          | audit, feature-update, case-creation, analytics | `transactionId` | 7 days    |
| `review.created`       | event-worker (case-creation consumer) | review-api, analytics                           | `transactionId` | 30 days   |
| `review.completed`     | review-api                            | audit, analytics                                | `transactionId` | 30 days   |
| `audit.events`         | every service, via outbox relay       | audit-persistence (event-worker)                | `aggregateId`   | 90 days   |
| `model.updated`        | ml-service registry / admin action    | audit, dashboard                                | `modelVersion`  | 90 days   |

Partitions: `KAFKA_TOPIC_PARTITIONS` (default 3 locally). Replication factor:
`KAFKA_TOPIC_REPLICATION_FACTOR` (1 locally — single KRaft broker, ADR-001; must be
raised to 3 on any multi-broker deployment, which is why it is a config value and not a
hardcoded constant).

---

## `transaction.received`

|                          |                                                                                                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**              | Records that a transaction entered the system, before scoring. Feeds audit and early analytics.                                                                                                                        |
| **Producer**             | `fraud-api`, via the transactional outbox — written in the same transaction as the `RECEIVED` state, published after the response returns (ADR-006).                                                                   |
| **Consumers**            | `audit` (persists to `audit_events`) · `analytics` (volume/throughput projections)                                                                                                                                     |
| **Partition key**        | `transactionId` — no ordering requirement across transactions; per-transaction events (received → decided) land on the same partition only incidentally, since each transaction produces at most one `received` event. |
| **Ordering requirement** | None beyond per-key.                                                                                                                                                                                                   |
| **Retention**            | 7 days. Short: this event's only downstream use is near-term audit and analytics; the durable record is `audit_events` in Postgres, not the topic itself.                                                              |
| **Retry strategy**       | Consumer-side: exponential backoff, 3 attempts (cold path only — ADR-005 forbids hot-path retries).                                                                                                                    |
| **Dead-letter strategy** | A message that fails all retries moves to `transaction.received.dlq` with the error attached; alerted, inspected manually.                                                                                             |
| **Idempotency**          | `audit` consumer inserts audit rows keyed by `eventId`; a duplicate delivery is a no-op insert-if-absent.                                                                                                              |

## `transaction.decided`

|                          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**              | The outcome of fraud scoring — the single most important event in the system. Drives feature updates, case creation and audit.                                                                                                                                                                                                                                                                                                                                        |
| **Producer**             | `fraud-api`, via the outbox, in the same transaction as the decision write.                                                                                                                                                                                                                                                                                                                                                                                           |
| **Consumers**            | `audit` · `feature-update` (folds the outcome into rolling aggregates) · `case-creation` (creates a `FraudCase` when `decision = REVIEW`) · `analytics` (decision-mix dashboards)                                                                                                                                                                                                                                                                                     |
| **Partition key**        | `transactionId`. Considered keying by `userId` instead, to guarantee per-user ordering for the feature-update consumer — rejected because it would concentrate a high-velocity user's events on one partition, working against the very velocity signal being computed. Per-user ordering is not actually required: feature aggregation uses associative, commutative operations (counters, sums), so arrival order within a short window does not change the result. |
| **Ordering requirement** | None across users. Within a single `transactionId` there is exactly one `decided` event, so ordering is moot for that key.                                                                                                                                                                                                                                                                                                                                            |
| **Retention**            | 7 days.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Retry strategy**       | Exponential backoff, 3 attempts, per consumer group (each consumer group retries independently — a slow `case-creation` consumer does not block `audit`).                                                                                                                                                                                                                                                                                                             |
| **Dead-letter strategy** | `transaction.decided.dlq`, alerted. A DLQ'd `REVIEW` decision is a **missed case** and pages on-call in a real deployment — noted here as the reason this is the one DLQ with an attached severity, not just a queue.                                                                                                                                                                                                                                                 |
| **Idempotency**          | `case-creation`: conditional insert on `transactionId` (RISK-005, RT-DUP-001) — a duplicate delivery must never create a second case. `feature-update`: deduplicates by `eventId` before applying counter increments.                                                                                                                                                                                                                                                 |

## `review.created`

|                          |                                                                                                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**              | Signals that a fraud case now exists and needs analyst attention.                                                                                                                                        |
| **Producer**             | `event-worker`'s case-creation consumer, immediately after inserting the case row (same logical step, separate technical write — the case table is the source of truth; this event is the notification). |
| **Consumers**            | `review-api` (populates the case queue) · `analytics`                                                                                                                                                    |
| **Partition key**        | `transactionId`.                                                                                                                                                                                         |
| **Ordering requirement** | None.                                                                                                                                                                                                    |
| **Retention**            | 30 days — cases can remain open longer than a typical audit-event's useful topic lifetime.                                                                                                               |
| **Retry strategy**       | Exponential backoff, 3 attempts.                                                                                                                                                                         |
| **Dead-letter strategy** | `review.created.dlq`, alerted (same missed-case severity as above).                                                                                                                                      |
| **Idempotency**          | `review-api`'s queue view is a projection keyed by `caseId`; re-applying the same event is a no-op upsert.                                                                                               |

## `review.completed`

|                          |                                                                                                                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**              | Records a reviewer's decision on a case (FR-011).                                                                                                                                                                                |
| **Producer**             | `review-api`, on a successful `APPROVE` / `BLOCK` / `ESCALATE` action — published only after the case-lifecycle transition (`applyCaseAction`, `packages/domain`) succeeds, so an illegal transition never reaches Kafka at all. |
| **Consumers**            | `audit` · `analytics`                                                                                                                                                                                                            |
| **Partition key**        | `transactionId`.                                                                                                                                                                                                                 |
| **Ordering requirement** | None — a case can only be reviewed once (the lifecycle is single-transition-to-terminal), so there is at most one `review.completed` event per case.                                                                             |
| **Retention**            | 30 days.                                                                                                                                                                                                                         |
| **Retry strategy**       | Exponential backoff, 3 attempts.                                                                                                                                                                                                 |
| **Dead-letter strategy** | `review.completed.dlq`, alerted.                                                                                                                                                                                                 |
| **Idempotency**          | `audit` consumer dedupes by `eventId`, as with every other audit-bound event.                                                                                                                                                    |

## `audit.events`

**Phase 6 implementation note:** this topic is not currently produced to.
`apps/event-worker`'s audit-persistence consumer subscribes directly to
`transaction.received`, `transaction.decided`, `review.created` and
`review.completed` instead, deriving each `audit_events` row from the
domain event itself (`packages/contracts/src/events/topics.ts` records the
same deviation, next to the eventType→topic map). Adopting this generic
topic as originally specified would mean every producer writing TWO
outbox rows per action — the domain event and a second, redundant
generic one — for no consumer that needs the generic shape today. The
table below describes the original design; revisit it if a future
consumer (Phase 10's model-registry auditing, most likely) genuinely
needs the generic envelope rather than a specific one.

|                          |                                                                                                                                                                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**              | The generic, append-only trail behind FR-008 — "what happened, to what, when, and why", uniformly across every domain event, rather than one bespoke audit schema per action.                                                                                                             |
| **Producer**             | Every service, via its own outbox, for any state-changing action (not only the four domain events above — includes policy changes, model registrations, etc.).                                                                                                                            |
| **Consumers**            | `audit-persistence` (event-worker) — the only consumer. Writes to the append-only `audit_events` table and nowhere else.                                                                                                                                                                  |
| **Partition key**        | `aggregateId` (a `transactionId`, `caseId`, or `modelVersion` depending on `aggregateType`) — keeps one aggregate's history in delivery order for that consumer, which matters here because audit rows are typically read back in temporal order for one aggregate at investigation time. |
| **Ordering requirement** | Per-aggregate ordering is desired (not strictly required — the table has its own timestamp — but avoids the append-only log's insertion order fighting the aggregate's true event order).                                                                                                 |
| **Retention**            | 90 days on the topic. The durable record is the Postgres table, which is retained indefinitely (subject to a future archival policy, out of scope for the prototype); the topic's retention is only about how long a consumer can replay from Kafka to rebuild the table if needed.       |
| **Retry strategy**       | Exponential backoff, 5 attempts (higher than other topics — an audit write failing is more consequential than a feature update failing).                                                                                                                                                  |
| **Dead-letter strategy** | `audit.events.dlq`. This DLQ is the highest-severity one in the system: a message here means an event exists that has _no_ durable audit trail, which is precisely the gap FR-008 exists to close. Alerted immediately, not batched.                                                      |
| **Idempotency**          | Insert keyed by `eventId`, unique constraint enforced at the database level as the final backstop, not just application-level dedup.                                                                                                                                                      |

## `model.updated`

|                          |                                                                                                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**              | FR-012 — announces a model version's registration or activation change. Populated meaningfully from Phase 10; a stub/rules "registration" (e.g. `model-v0-stub`) can use the same event at Phase 5 boot. |
| **Producer**             | `ml-service`'s model registry (Phase 10), or an administrative action for the stub/rules baseline versions.                                                                                              |
| **Consumers**            | `audit` · `dashboard` (model list, active-version indicator)                                                                                                                                             |
| **Partition key**        | `modelVersion`.                                                                                                                                                                                          |
| **Ordering requirement** | None.                                                                                                                                                                                                    |
| **Retention**            | 90 days.                                                                                                                                                                                                 |
| **Retry strategy**       | Exponential backoff, 3 attempts.                                                                                                                                                                         |
| **Dead-letter strategy** | `model.updated.dlq`, alerted.                                                                                                                                                                            |
| **Idempotency**          | `dashboard`'s model list is a projection keyed by `modelVersion` — re-applying is an upsert.                                                                                                             |

---

## Cross-cutting policies

**Consumer groups.** Each logical consumer (`audit`, `feature-update`, `case-creation`,
`analytics`, `review-api`, `dashboard`) runs its own consumer group, so one slow or failed
consumer never blocks another from processing the same topic (NFR-005, ADR-001).

**Schema evolution.** A payload schema may only add optional fields to remain backward
compatible. A breaking change ships as a new event type (e.g. `transaction.decided.v2`)
consumed alongside the old one until every consumer has migrated — never an in-place
breaking change to an existing schema, which would silently break whichever consumer
deploys last.

**What is deliberately not a topic.** Feature _reads_ — nothing publishes "features
requested"; that is a synchronous Redis read on the hot path (ADR-002). There is also no
`transaction.scored` topic distinct from `transaction.decided`: scoring and deciding
happen in the same synchronous call in `fraud-api` (ADR-003), so there is no intermediate
state worth publishing separately — the original proposal sketch's finer-grained topic
list was collapsed for the same reason ADR-004 collapsed the service list.

**Message headers (Phase 7, ADR-007).** Every message the outbox relay publishes
carries a `traceparent` header (W3C Trace Context) — the value persisted on the
originating `outbox_events.trace_context` row. Every consumer extracts it before
processing, so a Kafka hop does not start a disconnected trace. Not part of the
payload schema (it travels out-of-band, same as any other Kafka message metadata),
and consumer logic must not depend on its presence — a missing header (tracing
disabled, or a pre-migration-0003 row) degrades to "process normally, just without
a linked trace," never an error.
