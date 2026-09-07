# ADR-001 — Kafka for asynchronous propagation, never in the authorization path

**Status:** Accepted
**Date:** 2026-09-07
**Deciders:** Team 04
**Related:** ADR-003, ADR-006, NFR-002, RISK-002

---

## Context

FraudGuard has two workloads with irreconcilable characteristics.

The **authorization decision** is synchronous, latency-bound (NFR-002: p99 < 200 ms),
and must produce an answer the caller is blocked on. The **downstream work** — audit
persistence, feature aggregation, case creation, analytics projections, training-data
capture — is throughput-bound, tolerant of seconds of delay, and must not be lost.

Multiple independent consumers need the same transaction and decision events, and new
consumers will be added over the project's life (analytics in Phase 6, training capture
in Phase 10). Consumers must be addable without modifying the producer.

The tempting move — and one seen in many event-driven reference architectures — is to
make the whole pipeline event-driven: the API produces to `transactions.raw`, a scoring
consumer picks it up, produces to `transactions.scored`, a decision consumer produces to
`transactions.decided`, and the API correlates the result back to the waiting request.

## Decision

**Kafka is used exclusively for asynchronous propagation on the cold path. No Kafka
round trip occurs in the authorization request path.**

Concretely:

1. `fraud-api` performs its entire decision synchronously and in-process, reading only
   from Redis, and responds to the caller.
2. The decision and its event payload are written to a transactional **outbox** table in
   the same PostgreSQL transaction (see ADR-006).
3. A relay publishes outbox rows to Kafka **after** the response has been returned.
4. All consumers — audit, feature aggregation, case creation, analytics — read from
   Kafka and run in `event-worker`, a separate process.

Kafka runs as a **single broker in KRaft mode** (no ZooKeeper).

## Alternatives considered

### A. Fully event-driven authorization (produce → consume → correlate)

The architecturally "purest" option, and the one most likely to be chosen for the wrong
reasons.

- **Rejected because of latency.** Each hop costs a produce ack, a partition write, a
  consumer poll cycle and a fetch. Even well-tuned, that is 10–30 ms *per hop*;
  `linger.ms` and consumer poll intervals make the tail far worse. Three hops plus
  response correlation would plausibly consume the entire 200 ms budget before any fraud
  logic ran.
- **Rejected because of coupling to broker health.** The authorization path would fail
  whenever Kafka is unavailable, converting a cold-path dependency into a hot-path
  single point of failure. This directly contradicts FR-016 and NFR-005.
- **Rejected because of complexity.** Correlating an async result back to a blocked HTTP
  request needs a correlation store, a timeout policy, and an answer for what happens
  when the response arrives after the caller gave up. Substantial machinery, negative
  value.

### B. No Kafka; consumers read directly from PostgreSQL

- **Rejected.** Each new consumer means new polling logic and more load on the durable
  store. No replay, no independent offsets, no backpressure semantics. It also puts
  analytical scan load on the same database that serves the write path.

### C. A lighter queue (Redis Streams, RabbitMQ, NATS)

- **Redis Streams** was genuinely attractive on a 7.86 GB machine — Redis is already
  required, so it costs no additional process. **Rejected** because it would make Redis a
  shared failure domain for both the hot path and all event propagation; a Redis incident
  would then take out features *and* audit *and* case creation simultaneously. Isolating
  failure domains is worth the memory.
- **RabbitMQ** is a queue, not a log: no replay, and no independent consumer offsets over
  retained history. Replay matters here because Phase 10 needs to reconstruct training
  data from historical events.
- **NATS JetStream** is a reasonable fit and lighter than Kafka. **Rejected** on
  ecosystem grounds: Kafka's consumer-lag semantics, tooling and Prometheus exporters are
  what the observability requirements (NFR-011) assume, and Kafka is the technology the
  project is expected to demonstrate.

### D. Kafka with ZooKeeper (the classic topology)

- **Rejected on capacity grounds.** ZooKeeper is a second JVM, roughly 400–600 MB, on a
  machine with 7.86 GB. KRaft is production-supported, is the default in current Kafka,
  and is identical from a client's perspective.

## Consequences

### Positive

- The authorization path's latency is bounded by Redis and in-process CPU — both
  predictable — rather than by broker behaviour.
- Kafka being down is invisible to payment authorization. This is directly demonstrable
  as a resilience test (NFR-005) and is one of the project demos.
- New consumers are added without touching the producer, satisfying open/closed at the
  system level.
- Event replay is available for rebuilding features and generating training data.
- Consumer lag is a first-class health signal (NFR-011) rather than a hidden queue depth.

### Negative

- Downstream state is **eventually consistent**. A decision is returned to the caller
  before its audit record exists. Accepted and documented as NFR-012; the outbox
  guarantees it will exist.
- The outbox introduces a relay component and polling latency (target: sub-second).
- Consumers must be **idempotent**, because at-least-once delivery means duplicates are
  normal, not exceptional (FR-010, FR-017, RISK-005).
- A single broker means `replication.factor=1`. **Broker-loss durability cannot be
  demonstrated on this hardware** — recorded honestly against NFR-013 rather than
  glossed over.
- Kafka's JVM is the largest single memory consumer in the stack (RISK-002).

### Neutral

- Should Kafka's footprint prove unworkable, a Kafka-API-compatible broker with a smaller
  runtime would be a drop-in change at the infrastructure layer only, because all client
  code sits behind `packages/messaging`. That substitution would require its own ADR.
