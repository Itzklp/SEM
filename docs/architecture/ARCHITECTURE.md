# FraudGuard — Architecture

**Version:** 1.0 · **Status:** Baselined 2026-09-07 · **Supersedes:** none

This document explains _what_ the system is and _why_ it is shaped that way. Individual
decisions are argued in full in [../adr/](../adr/); this document is the map that ties
them together.

---

## 1. The architectural driver

One constraint dominates every decision:

> A fraud decision must be returned inside the authorization window, at high request
> rates, and must still be returned when parts of the system are broken.

Everything below follows from that. Where a choice would have made the system tidier but
slower, or more impressive but less available, the latency and availability requirements
won — and the discarded alternative is recorded in the relevant ADR.

The single most consequential idea in FraudGuard is the **separation of the hot path
from the cold path**. It determines the service boundaries, the choice of datastore for
each concern, where Kafka is and is not used, and what happens during failure.

---

## 2. Two paths

### Path A — the hot path (synchronous, latency-critical)

```
   Payment gateway
         │  POST /api/v1/fraud/score
         ▼
   ┌─────────────────────────────────────────────────────┐
   │                    fraud-api                        │
   │           (stateless · horizontally scaled)         │
   │                                                     │
   │   1. authenticate + authorize          ~1 ms        │
   │   2. validate payload (schema)         ~1 ms        │
   │   3. idempotency check ────────────────┐            │
   │   4. load feature vector ──────────────┼──▶ Redis   │
   │   5. evaluate rules       (in-process) │   ~2-5 ms  │
   │   6. score                (provider)   │            │
   │   7. combine → risk score (in-process) │            │
   │   8. decide vs policy     (in-process) │            │
   │   9. write outbox record ──────────────┼──▶ Postgres│
   │  10. respond                           │   (async   │
   │                                        │    flush)  │
   └────────────────────────────────────────┴────────────┘
         │
         ▼
   ALLOW / REVIEW / BLOCK  + riskScore + reasons + versions
```

**Rules of the hot path, enforced by design and by test:**

| Rule                                                                  | Reason                                                                                                                                        |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| No Kafka round trip                                                   | A produce-then-consume cycle costs tens of milliseconds and couples the response to broker health. ADR-001.                                   |
| No synchronous PostgreSQL read                                        | Disk-backed reads are unpredictable under load. All read state comes from Redis. ADR-003.                                                     |
| Rules, scoring combination and the decision engine run **in-process** | These are pure CPU. Putting them behind HTTP would add network hops for zero architectural benefit and would multiply failure modes. ADR-004. |
| Every external call has a timeout and a fallback                      | A dependency may be slow; the response may not be. ADR-005.                                                                                   |
| The only writes are an idempotency marker and an outbox row           | Both are small, indexed, and on the write path only. ADR-006.                                                                                 |

**Latency budget (TARGET — to be replaced by measurement in Phase 9):**

| Stage                        | Budget     | Note                                         |
| ---------------------------- | ---------- | -------------------------------------------- |
| Ingress: auth, validation    | 3 ms       |                                              |
| Redis feature fetch          | 8 ms       | single pipelined round trip                  |
| Rule evaluation              | 5 ms       | in-process, pure functions                   |
| Scoring provider             | 15 ms      | stub ≈ 0; ML over HTTP is the expensive case |
| Decision + assembly          | 2 ms       |                                              |
| Outbox write                 | 7 ms       |                                              |
| **Service total**            | **40 ms**  | **NFR-003 target: p99 < 50 ms**              |
| Network + gateway + queueing | 160 ms     | headroom                                     |
| **End to end**               | **200 ms** | **NFR-002 target**                           |

The budget is deliberately loose against NFR-002 because the co-location problem
(RISK-001) will consume part of it in measurement noise.

### Path B — the cold path (asynchronous, event-driven)

```
   fraud-api ──▶ outbox (Postgres) ──▶ relay ──▶ Kafka
                                                  │
        ┌─────────────────────────────────────────┤
        ▼                 ▼              ▼        ▼
   audit consumer   feature consumer  case    analytics
        │                 │          consumer  consumer
        ▼                 ▼              ▼        ▼
   audit_events      Redis features   cases   projections
   (append-only)     (aggregates)              (dashboard)
```

The cold path may be slower, may retry, and may lag. It must never be able to make the
hot path slower — which is why it is a separate process (`event-worker`) with its own
resource envelope.

**Why an outbox rather than producing to Kafka directly from the request handler?**
If we produce inside the request, we must either await the broker ack (adding its
latency and its failure mode to every authorization) or fire-and-forget (losing events
whenever the broker is briefly down). The outbox makes the event durable in the same
transaction that records the decision, and a separate relay moves it to Kafka. The
authorization never waits on Kafka, and no event is lost. Full argument in ADR-006.

---

## 3. Service decomposition

Four backend deployables and one frontend. The count is deliberately small — CON-001 and
the guidance against gratuitous distribution both point the same way. A component became
its own service only where it had a genuinely different **failure domain**, **scaling
profile**, or **runtime**.

| Deployable         | Responsibility                                                                                              | Why separate                                                                                                                                                                                                    | Scaling                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **`fraud-api`**    | The hot path: ingress, validation, auth, feature retrieval, rules, scoring, decision, outbox write          | The only latency-critical component. Everything else is kept out of its process so nothing can steal its event loop                                                                                             | Horizontal, stateless. This is the subject of the scaling experiment |
| **`event-worker`** | Kafka consumers: audit persistence, feature aggregation, case creation, analytics projections, outbox relay | Different failure domain and a completely different scaling profile — throughput-oriented, latency-tolerant. A slow consumer must never affect an authorization                                                 | Horizontal, by partition count                                       |
| **`review-api`**   | Analyst-facing: case queue, case actions, transaction/decision queries, model registry                      | **Bulkhead.** Analyst queries are heavy, unbounded and low-volume. Running them in `fraud-api` would let one expensive query consume the connection pool and event loop that authorizations depend on (NFR-007) | Rarely; 1 instance suffices                                          |
| **`ml-service`**   | Model inference over HTTP. **Phase 10 only**                                                                | Different runtime (Python). Isolating it means an ML failure is a dependency failure with a defined fallback, not a crash in the hot path                                                                       | Horizontal, independently                                            |
| **`dashboard`**    | React operations dashboard                                                                                  | Static frontend                                                                                                                                                                                                 | n/a                                                                  |

### What deliberately did _not_ become a service

This list matters as much as the one above.

| Component                  | Lives in                                 | Why not a service                                                                                                                                                                  |
| -------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rule engine                | `packages/domain`, in `fraud-api`        | Pure CPU, sub-millisecond. A network hop would add ~1–5 ms and a failure mode to save nothing. Rules are _configuration_; hot-reloading config does not require a separate process |
| Decision engine            | `packages/domain`, in `fraud-api`        | Same reasoning. It is a pure function of (rule results, score, policy)                                                                                                             |
| Feature engine — **read**  | `packages/feature-store`, in `fraud-api` | Reading is a Redis call. A "feature service" in front of Redis would add a hop to the hot path and be a pure proxy                                                                 |
| Feature engine — **write** | `event-worker`                           | Aggregation is stream processing. It belongs on the cold path, and it _is_ separated — just as a consumer, not as a synchronous service                                            |
| Audit                      | `event-worker`                           | Consumer, by definition asynchronous                                                                                                                                               |

> A "feature-service" and a "decision-service" appear in many reference architectures for
> this problem, and in the original proposal sketch. We are not building them as separate
> processes because on measurement they would only add latency and failure modes. The
> _logical_ separation is preserved — they are independent, independently testable
> packages with explicit interfaces — so if a real deployment ever needed to split them
> out, the seam already exists. ADR-004 records this in full.

---

## 4. C4 — Level 1: system context

```
                        ┌────────────────────┐
                        │  Payment Gateway   │
                        │   (external)       │
                        └─────────┬──────────┘
                                  │ authorization request
                                  │ ALLOW/REVIEW/BLOCK
                                  ▼
   ┌──────────────┐      ╔══════════════════════╗      ┌──────────────────┐
   │Fraud Analyst │─────▶║                      ║─────▶│  Prometheus /    │
   │  (human)     │      ║      FraudGuard      ║      │  Grafana         │
   └──────────────┘      ║                      ║      │  (observability) │
                         ╚══════════╤═══════════╝      └──────────────────┘
   ┌──────────────┐                 │
   │  Platform    │────────────────▶│
   │  Operator    │   monitors,     │
   └──────────────┘   tunes policy  │
                                    ▼
                        ┌────────────────────┐
                        │  ML Training       │
                        │  Pipeline (offline)│
                        └────────────────────┘
```

| Actor                | Interaction                                                                   |
| -------------------- | ----------------------------------------------------------------------------- |
| Payment Gateway      | Submits authorization requests; receives a decision. The only hot-path client |
| Fraud Analyst        | Works the review queue; investigates transactions                             |
| Platform Operator    | Monitors health, tunes risk policy, promotes model versions                   |
| ML Training Pipeline | Consumes historical decisions; produces versioned model artefacts             |

---

## 5. C4 — Level 2: containers

```
 ┌────────────────────────────────────────────────────────────────────────────┐
 │                              FraudGuard                                    │
 │                                                                            │
 │   ┌────────────────┐                                                       │
 │   │  API Gateway   │  auth · rate limit · routing · TLS termination        │
 │   │  (Nginx)       │                                                       │
 │   └───┬────────┬───┘                                                       │
 │       │        │                                                           │
 │  HOT  │        │  COLD                                                     │
 │       ▼        ▼                                                           │
 │  ┌─────────┐  ┌────────────┐         ┌──────────────┐                      │
 │  │fraud-api│  │ review-api │         │ event-worker │                      │
 │  │ (Nest / │  │  (Nest /   │         │  (Nest /     │                      │
 │  │ Fastify)│  │  Fastify)  │         │   Kafka)     │                      │
 │  │ xN      │  │            │         │              │                      │
 │  └──┬───┬──┘  └──────┬─────┘         └──┬────┬───┬──┘                      │
 │     │   │            │                  │    │   │                         │
 │     │   └────────────┼──────────┐       │    │   │                         │
 │     ▼                ▼          ▼       ▼    │   ▼                         │
 │  ┌───────┐      ┌──────────┐  ┌──────────┐   │  ┌────────────┐             │
 │  │ Redis │      │PostgreSQL│  │  Kafka   │◀──┘  │ ml-service │             │
 │  │feature│      │ durable  │  │ (KRaft)  │      │  (Python)  │             │
 │  │ store │      │  state   │  │  events  │      │ Phase 10   │             │
 │  └───────┘      └──────────┘  └──────────┘      └────────────┘             │
 │      ▲                                                 ▲                   │
 │      └─────────────────────────────────────────────────┘                   │
 │                     fraud-api → ml-service (HTTP, timeout + breaker)        │
 │                                                                            │
 │   ┌────────────┐         ┌────────────┐        ┌────────────┐              │
 │   │ dashboard  │────────▶│ Prometheus │◀───────│  Grafana   │              │
 │   │  (React)   │         │            │        │            │              │
 │   └────────────┘         └────────────┘        └────────────┘              │
 └────────────────────────────────────────────────────────────────────────────┘
```

### Datastore responsibilities

The single most common way to fail this design is to let these blur.

| Store          | Holds                                                                      | Read on hot path?     | Written on hot path?                 | Rationale                                                                                     |
| -------------- | -------------------------------------------------------------------------- | --------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| **Redis**      | Behavioural features, velocity counters, idempotency markers, policy cache | **Yes — exclusively** | Idempotency marker only              | In-memory, predictable sub-millisecond latency, native TTL and atomic counters. ADR-002       |
| **PostgreSQL** | Transactions, decisions, cases, audit events, model registry, outbox       | **No**                | Outbox + decision, on the write path | Durable, queryable, relational. Its latency profile is unsuitable for hot-path reads. ADR-003 |
| **Kafka**      | Event log between producers and consumers                                  | **No**                | **No** — via outbox relay            | Durable async propagation, replay, consumer independence. ADR-001                             |

---

## 6. Repository structure

```
fraudguard/
├── apps/
│   ├── fraud-api/          # hot path
│   ├── event-worker/       # Kafka consumers + outbox relay
│   ├── review-api/         # analyst + query APIs
│   ├── ml-service/         # Python inference (Phase 10)
│   └── dashboard/          # React operations UI
│
├── packages/
│   ├── contracts/          # DTOs, Zod schemas, Kafka event schemas — single source of truth
│   ├── domain/             # entities, value objects, rules, scoring interface, decision engine — ZERO I/O
│   ├── config/             # typed, validated environment configuration
│   ├── observability/      # Pino logger, OpenTelemetry, Prometheus registry
│   ├── persistence/        # Drizzle schema, migrations, repositories
│   ├── messaging/          # Kafka producer/consumer, idempotency, DLQ
│   ├── feature-store/      # Redis feature definitions + client
│   └── testkit/            # seeded synthetic generator, fixtures, harnesses
│
├── infrastructure/         # docker, kafka, postgres, redis, monitoring
├── tests/                  # unit, integration, contract, e2e, resilience, load
├── ml/                     # datasets, training, evaluation, models, notebooks
├── docs/                   # architecture, adr, requirements, testing, operations, security
└── scripts/
```

**`packages/domain` has no I/O and no framework dependency.** That is what lets the
majority of the test suite be fast unit tests over pure functions (the base of the test
pyramid), and it is what makes the fraud logic explainable independently of the transport
and storage around it.

---

## 7. Sequence — a scored authorization

```
Gateway   fraud-api    Redis    ml-service   Postgres   Kafka   event-worker
   │          │          │          │           │         │          │
   ├─ POST ──▶│          │          │           │         │          │
   │          ├─ authn/authz/validate           │         │          │
   │          ├─ GET idem:{txId} ─▶│            │         │          │
   │          │◀─ miss ────────────┤            │         │          │
   │          ├─ PIPELINE features▶│            │         │          │
   │          │◀─ feature vector ──┤            │         │          │
   │          ├─ evaluate rules (in-process)    │         │          │
   │          ├─ score ───────────────────▶     │         │          │
   │          │◀─ probability + version ──┤     │         │          │
   │          ├─ combine → risk score           │         │          │
   │          ├─ apply policy → DECISION        │         │          │
   │          ├─ BEGIN; decision + outbox; COMMIT ──▶     │          │
   │          ├─ SET idem:{txId} ──▶│            │        │          │
   │◀─ 200 ───┤                                           │          │
   │          │                                           │          │
   │          │        ····· authorization complete ····· │          │
   │          │                                           │          │
   │          │                    relay polls outbox ───▶├─ produce▶│
   │          │                                           │          ├─ audit
   │          │                                           │          ├─ features
   │          │                                           │          ├─ case (if REVIEW)
   │          │                                           │          └─ analytics
```

Note where the response is returned: **before** anything touches Kafka. That is the
whole point of the split.

---

## 8. Failure behaviour

Fail-open versus fail-closed is a business decision with a security consequence, so it is
made explicitly per dependency rather than globally. The reasoning is argued in ADR-005;
the summary:

| Failure                       | Behaviour                                                                                                                                             | Direction         | Why                                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Redis down**                | Score using transaction-intrinsic rules only. Mark decision `degraded`, record `FEATURES_UNAVAILABLE`. Tighten thresholds so the `REVIEW` band widens | **Cautious-open** | Refusing all payments because a cache is down is a worse outcome than reviewing more of them. Widening `REVIEW` shifts risk to humans rather than accepting it blindly |
| **ML provider down / slow**   | Circuit breaker opens; fall back to the rule-based provider. Mark `degraded`, record `ML_UNAVAILABLE`                                                 | **Fallback**      | Rules are a complete, if blunter, scorer. This is exactly why the provider abstraction exists                                                                          |
| **Kafka down**                | Authorization unaffected. Outbox rows accumulate; relay retries with backoff and drains on recovery                                                   | **Invisible**     | The hot path never touched Kafka to begin with                                                                                                                         |
| **PostgreSQL down**           | Cannot durably record the decision → **fail closed** on the write, return `503`                                                                       | **Closed**        | An unrecorded decision is an unauditable decision. For a financial system, silently deciding without a record is the one unacceptable outcome                          |
| **`fraud-api` instance lost** | Gateway health check ejects it; traffic moves to remaining instances                                                                                  | **Transparent**   | Stateless services, so nothing is lost                                                                                                                                 |
| **`event-worker` down**       | Consumer lag grows; the hot path is unaffected. Processing resumes from committed offsets                                                             | **Deferred**      | Cold path is allowed to lag                                                                                                                                            |
| **Overload**                  | Rate limiting at the gateway; load shedding above a concurrency ceiling with `429`                                                                    | **Shed**          | A fast `429` is better than a queue that makes every request breach the latency budget                                                                                 |

The `degraded` flag on a decision is not cosmetic — it is persisted and exported as a
metric, so the proportion of degraded decisions is visible on the dashboard and can be
alerted on.

---

## 9. Transaction lifecycle

```
   RECEIVED ──▶ VALIDATED ──▶ FEATURES_LOADED ──▶ SCORED ──▶ DECIDED
       │            │                │                          │
       │            ▼                ▼                    ┌─────┼─────┐
       │        REJECTED         DEGRADED ─────────┐      ▼     ▼     ▼
       │       (malformed)      (partial signal)   └──▶ ALLOW REVIEW BLOCK
       ▼                                                        │
    DUPLICATE                                                   ▼
   (idempotent                                            CASE_CREATED
    replay)                                                     │
                                                    ┌───────────┼───────────┐
                                                    ▼           ▼           ▼
                                                APPROVED     BLOCKED   ESCALATED
```

Every transition emits an audit event. The terminal decision and its full basis —
inputs, feature vector, rule results, score, policy version, model version — are
recoverable for any transaction (FR-008).

---

## 10. Design patterns in use

Each is here because it solves a stated problem, not to demonstrate pattern knowledge.

| Pattern                  | Where                                                             | Problem it solves                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Strategy**             | `FraudScoringProvider` — stub / rule-based / ML                   | The core requirement of CON-005: swap the scorer without the rest of the system knowing. This is the project's load-bearing abstraction |
| **Strategy**             | `FraudRule` implementations                                       | Rules must be addable without modifying the engine (Open/Closed)                                                                        |
| **Repository**           | `packages/persistence`                                            | Keeps domain logic free of SQL, so `packages/domain` can stay I/O-free and unit-testable                                                |
| **Outbox**               | Decision write → Kafka                                            | Atomic "record the decision and the intent to publish it" without putting the broker in the request path. ADR-006                       |
| **Circuit Breaker**      | `fraud-api` → `ml-service`                                        | Stops a slow ML service from consuming the latency budget of every request                                                              |
| **Bulkhead**             | `review-api` separate from `fraud-api`; separate connection pools | Analyst query load cannot exhaust hot-path resources (NFR-007)                                                                          |
| **Adapter**              | Redis, Kafka, Postgres clients behind domain-facing ports         | Enables in-memory test doubles, so unit tests need no infrastructure                                                                    |
| **Dependency Injection** | NestJS throughout                                                 | Makes the above substitutions possible at all                                                                                           |
| **Factory**              | Scoring provider selection by configuration                       | Chooses the implementation at composition time from config                                                                              |

Patterns considered and **rejected**: CQRS with separate read models (unnecessary
complexity at this scale — the read/write split we need is already achieved by Redis
versus Postgres); Event Sourcing as the system of record (the audit log gives us the
history we need without forcing every read through a projection); Saga (no distributed
transaction spans multiple services in this design).

---

## 11. Where ML plugs in

The system will be complete and fully tested before ML exists. Integration is a
**configuration change**, not a refactor:

```ts
// packages/domain — stable from Phase 5, unchanged by Phase 10
interface FraudScoringProvider {
  readonly name: string;
  score(input: ScoringInput): Promise<ScoringResult>; // { score, riskFactors, provider, modelVersion }
}
```

- **Phase 5** ships `StubFraudScoringProvider` (deterministic) and
  `RuleBasedScoringProvider`.
- **Phase 10** adds `MLScoringProvider`, which calls `ml-service` over HTTP behind a
  timeout and circuit breaker, and falls back to `RuleBasedScoringProvider` when open.
- The decision engine, API contract, audit schema and dashboard are **untouched**.

The comparison of ML against the stub/rule baseline is then a controlled experiment,
because both run through the identical pipeline.

---

## 13. Cloud deployment posture (design intent only)

**No cloud infrastructure exists. None is being built.** This section records a design
constraint, not a deliverable — the team decided (2026-09-07) to develop and validate
entirely on local Docker Compose for now, and to scope an AWS-or-equivalent deployment as
its own explicit phase later, if and when requested. Terraform is present on the
development machine but is **not used** (see DEVELOPMENT_ENVIRONMENT.md §3).

The reason this is worth recording now rather than leaving implicit: RISK-001 means
several NFRs — horizontal scaling (NFR-004), throughput at high load (NFR-001) — cannot
be _cleanly measured_ on this laptop. The project's answer is not to weaken those
requirements, but to make sure the architecture remains capable of being measured
properly on cloud infrastructure later, without requiring a redesign to get there. That
requirement is already satisfied by decisions made for other reasons:

| Property already true                                                                                     | Why it also happens to enable a later cloud deployment                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every service is configured entirely by environment variable (`packages/config`)                          | No hardcoded hostname, credential or topology assumption to unwind — a container scheduler injects different values, nothing else changes                                                    |
| `fraud-api` is stateless and horizontally scaled behind a load balancer (ADR-004)                         | This is exactly the shape an ECS/EKS/Fargate service or equivalent expects — no session affinity, no local state to migrate                                                                  |
| Kafka replication factor and partition count are config (`KAFKA_TOPIC_REPLICATION_FACTOR`), not constants | Locally this is `1` (single KRaft broker — ADR-001's documented limitation). A managed broker service would set it to `3`; the application code does not change                              |
| Connection pool sizes, timeouts and circuit-breaker thresholds are config (ADR-005)                       | These are exactly the values that differ between a laptop and a multi-AZ deployment; nothing here is baked into source                                                                       |
| Every service is already a Docker image                                                                   | An image that runs under Compose runs under any container orchestrator without modification                                                                                                  |
| Hot-path/cold-path separation (ADR-003)                                                                   | Maps directly onto "latency-critical service with autoscaling" vs. "worker/queue-consumer service with different scaling triggers" — a distinction cloud autoscaling groups are built around |

**What is deliberately NOT done now:** no Terraform modules, no cloud provider account
configuration, no CI deployment step, no cost incurred. Building infrastructure-as-code
before it's needed would itself be a form of over-engineering (§40 of the brief) — the
constraint being protected here is _optionality_, not a half-built AWS environment
nobody is using yet.

**If a cloud validation phase is requested later**, its shape is already implied by the
table above: containerise (done), provision managed equivalents of Redis/Postgres/Kafka
(ElastiCache / RDS / MSK or equivalents), point the existing config at them, and run the
same k6 scenarios from Phase 9 with the load generator on separate infrastructure from
the system under test — which directly resolves RISK-001's co-location problem rather
than merely working around it. That would be new infrastructure work, not new
application work.

---

## 14. Open architectural questions

Recorded rather than quietly resolved. Each becomes an ADR when decided.

| #   | Question                                                                                                                                                                        | Decide by |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | Should the outbox relay live in `event-worker` or as its own process? Co-locating is simpler; separating gives independent scaling                                              | Phase 6   |
| 2   | Feature aggregation as Kafka Streams / a consumer with Redis atomics, or a dedicated stream processor? A processor is more capable, and heavier than 7.86 GB comfortably allows | Phase 4   |
| 3   | Nginx versus an in-process gateway module. Nginx is realistic; one fewer container helps on this hardware                                                                       | Phase 3   |
| 4   | Whether graph/relationship signals justify a dedicated store, or can be served as precomputed Redis aggregates                                                                  | Phase 5   |
| 5   | Whether/when to scope an actual cloud (AWS or equivalent) validation phase for NFR-001/NFR-004 — see §13. Deferred until requested                                              | TBD       |
