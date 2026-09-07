# FraudGuard — Requirements Baseline

**Version:** 1.0
**Status:** Baselined 2026-09-07
**Owners:** Team 04 — Dalsania Kalpkumar Pradipkumar (2025H1030209P), Milap Chaudhary
(2025H1030207P), Lokesh Patil (2025H1030054P)

Every requirement here carries a stable ID. Those IDs are the join key used by
[traceability-matrix.md](./traceability-matrix.md) to connect requirement → design →
implementation → test → result. **Do not renumber.** A withdrawn requirement is marked
`WITHDRAWN` and keeps its number.

---

## 1. Problem statement

Digital payment volume is large and continuous, while a fraud decision must be produced
inside the brief window in which an authorization is being processed. This makes fraud
detection a *systems* problem before it is a *modelling* problem: a perfectly accurate
classifier that answers in two seconds is useless in an authorization path, and a fast
classifier that ignores what the account did ninety seconds ago is blind to exactly the
attacks that matter most.

An offline batch classifier is insufficient for three reasons:

1. **Risk is temporal.** Card-testing, account takeover and velocity attacks are defined
   by behaviour over seconds and minutes. A model scoring only the fields present on the
   transaction row cannot see them.
2. **The decision is in the request path.** The answer has to come back before the
   authorization completes, which imposes a hard latency budget that batch systems never
   face.
3. **Availability is not optional.** A fraud service that is down cannot simply stop
   answering — the payment flow must still resolve, which forces an explicit and
   defensible degradation policy.

**Core problem.** How can we build a distributed system that evaluates thousands of
payment authorization requests per second, produces a fraud-risk score informed by
continuously updated behavioural context, and returns an `ALLOW` / `REVIEW` / `BLOCK`
decision inside a strict latency budget — while remaining horizontally scalable,
observable, and correct in the presence of partial failure?

---

## 2. Scope

### 2.1 In scope

- Synchronous fraud scoring and decisioning in the authorization path.
- Real-time behavioural feature computation and serving.
- A configurable deterministic rule engine.
- A pluggable scoring abstraction: stub → rule-based → ML, with no change to consumers.
- A policy-driven decision engine producing `ALLOW` / `REVIEW` / `BLOCK`.
- Asynchronous event propagation for audit, analytics, feature updates and training data.
- A human review workflow for cases raised by `REVIEW`.
- Model versioning and controlled deployment.
- Observability: metrics, structured logs, distributed traces, dashboards.
- Load, resilience and scalability testing with **measured** results.

### 2.2 Out of scope

Recorded explicitly so that absence is a decision, not an oversight.

- Real payment processing, settlement or any connection to a real card network.
- Any real customer or cardholder data. **All data is synthetic** (see CON-004).
- PCI-DSS certification. The design avoids storing PAN entirely, but no certification is
  claimed or pursued.
- Multi-region deployment and cross-region replication.
- Production Kubernetes deployment. Local Docker Compose is the deployment target.
- Chargeback, dispute and refund workflows.
- A customer-facing UI. The dashboard is an internal operations tool.

---

## 3. Functional requirements

Priority: **M** = Must (prototype fails without it), **S** = Should, **C** = Could.

| ID | Requirement | Pri | Source | Acceptance criteria |
| --- | --- | --- | --- | --- |
| **FR-001** | Accept and validate payment authorization requests in real time over a versioned HTTP API. | M | Proposal §FR1 | A well-formed request returns `200` with a decision. A malformed request returns `400` with a structured error naming the offending field, and **no** partial side effects. |
| **FR-002** | Maintain and compute continuously updated behavioural features from the transaction stream. | M | Proposal §FR2 | After N transactions for a user, the velocity/aggregate features served for that user reflect all N. Feature computation is deterministic for a given event sequence. |
| **FR-003** | Evaluate every transaction against a configurable set of deterministic fraud rules. | M | Proposal §FR3 | Rules are declared as data/config, not embedded in controllers. Adding a rule requires no change to the decision engine. Each rule returns `triggered`, `severity`, `reason`, `scoreContribution`. |
| **FR-004** | Produce a machine-learning risk score through a stable provider abstraction. | M | Proposal §FR3 | Stub, rule-based and ML providers are interchangeable behind one interface. Swapping providers requires no change to the decision engine or API contract. |
| **FR-005** | Combine rule, model and behavioural signals into a single normalised risk score in `[0,1]`. | M | Proposal §FR4 | Score is deterministic for identical input. Combination weights are configuration, not code. |
| **FR-006** | Classify each transaction as `ALLOW`, `REVIEW` or `BLOCK` using a configurable policy. | M | Proposal §FR4 | Thresholds are configurable at runtime without redeployment. The active policy version is recorded on every decision. |
| **FR-007** | Return an explainable decision listing the reasons that drove it. | M | Brief §15 | Every non-`ALLOW` decision carries at least one human-readable reason. Reasons never leak internal weights, thresholds or model internals. |
| **FR-008** | Maintain an immutable audit trail of transaction events and fraud decisions. | M | Proposal §FR5 | Every decision is retrievable afterwards with its inputs, score, reasons, policy version and model version. Audit records are append-only. |
| **FR-009** | Publish transaction and decision events asynchronously for downstream consumers. | M | Proposal §FR5 | Events reach Kafka without blocking the authorization response. Broker unavailability does not fail an authorization (see FR-016). |
| **FR-010** | Create a fraud case for every `REVIEW` decision. | M | Proposal §FR6 | A `REVIEW` decision yields exactly one case. Duplicate delivery of the triggering event does not create duplicate cases. |
| **FR-011** | Provide a review workflow allowing an analyst to `APPROVE`, `BLOCK` or `ESCALATE` a case. | M | Proposal §FR6 | Case state transitions are validated; illegal transitions are rejected. Reviewer identity, timestamp, decision and reason are persisted. |
| **FR-012** | Support model versioning and controlled deployment of updated models. | S | Proposal §FR7 | Multiple model versions can be registered. The active version is selectable by configuration. Every decision records the exact version used. |
| **FR-013** | Expose real-time operational monitoring of throughput, latency, decision mix and service health. | M | Proposal §FR8 | Prometheus metrics endpoint plus provisioned Grafana dashboards showing TPS, p50/p95/p99, decision distribution, error rate and consumer lag. |
| **FR-014** | Provide query APIs for transactions, decisions, cases and models. | S | Brief §23 | Documented in OpenAPI. Paginated. Authorized. |
| **FR-015** | Authenticate and authorize every API caller. | M | Brief §22 | Unauthenticated requests receive `401`; insufficient privilege receives `403`. Scoring, review and administrative operations require distinct privileges. |
| **FR-016** | Degrade gracefully to a defined fallback when a non-critical dependency is unavailable. | M | Proposal §NFR4 | With Redis, Kafka or the ML provider down, the service still returns a decision within the latency budget, flags the decision as degraded, and records which signal was unavailable. |
| **FR-017** | Process authorization requests idempotently by transaction identifier. | S | Brief §7 | Re-submitting the same `transactionId` returns the original decision rather than re-scoring, and creates no duplicate audit records or cases. |
| **FR-018** | Provide a deterministic synthetic transaction generator covering normal and fraudulent patterns. | M | Brief §42 | Same seed produces a byte-identical event sequence. Covers normal, high-velocity, amount-anomaly, suspicious-device, suspicious-merchant, geographic-anomaly, repeated-failure and coordinated-ring patterns. |

---

## 4. Non-functional requirements

Every target below is a **TARGET** until Phase 9 replaces it with a **MEASURED** value.
The distinction is enforced throughout the project's reporting (see
[docs/testing/test-strategy.md](../testing/test-strategy.md)).

| ID | Category | Requirement | Target | Verification |
| --- | --- | --- | --- | --- |
| **NFR-001** | Performance | Sustained authorization throughput | ≥ 2 000 TPS | k6 sustained-rate scenario; Phase 9 |
| **NFR-002** | Performance | End-to-end fraud-decision latency at target load | p99 < 200 ms @ 2 000 TPS | k6 percentile report + server-side histogram; Phase 9 |
| **NFR-003** | Performance | Hot-path budget excluding network | p99 in-service < 50 ms | Server-side Prometheus histogram |
| **NFR-004** | Scalability | Latency-critical services scale horizontally behind a load balancer | Throughput increases materially as `fraud-api` instances go 1 → 2 → 3+ | Scaling experiment; Phase 9. **See RISK-001** |
| **NFR-005** | Fault tolerance | Continue serving decisions when a non-critical dependency fails | 0 authorization failures caused by Redis, Kafka or ML-provider outage | Resilience suite; Phase 8 |
| **NFR-006** | Fault tolerance | Survive the loss of a `fraud-api` instance | No sustained error spike; traffic drains to surviving instances | Resilience suite; Phase 8 |
| **NFR-007** | Availability | Hot path remains isolated from cold-path load | Review/analytics query load does not degrade authorization p99 | Bulkhead resilience test |
| **NFR-008** | Security | Transaction and user data protected in transit and at rest within the prototype's boundary | AuthN + AuthZ on every endpoint; no secrets in source; no PAN stored, ever | Security tests + review; Phase 11 |
| **NFR-009** | Security | Abuse resistance on public endpoints | Rate limiting enforced; replayed and tampered requests rejected | Security tests |
| **NFR-010** | Observability | Every request traceable end to end | `requestId`, `traceId`, `transactionId` present on all logs, metrics exemplars and spans | Observability tests; Phase 7 |
| **NFR-011** | Observability | Operational golden signals exposed | Throughput, p50/p95/p99, error rate, consumer lag, dependency latency all in Prometheus | Metrics contract test |
| **NFR-012** | Consistency | Strong consistency on the decision path; eventual consistency downstream | A returned decision is authoritative and immutable. Audit/analytics converge | Integration + E2E tests |
| **NFR-013** | Reliability | No decision event lost when the broker is briefly unavailable | Events published after recovery; at-least-once delivery with idempotent consumers | Resilience suite |
| **NFR-014** | Maintainability | Code quality gates enforced in CI | TypeScript strict, ESLint clean, formatted, CI red on failure | CI pipeline |
| **NFR-015** | Reproducibility | Any result can be reproduced by a teammate | Seeded generators, committed dashboards, migration-driven schema, documented test procedure | Phase 11 review |

---

## 5. Assumptions

| ID | Assumption | If it proves false |
| --- | --- | --- |
| **ASM-001** | Synthetic data is an acceptable substitute for real payment traffic for the purposes of this evaluation. | Fraud-detection quality metrics become indicative only; the systems results are unaffected. |
| **ASM-002** | A single-broker Kafka in KRaft mode is sufficient to demonstrate event-driven architecture. | Broker-failure durability cannot be demonstrated. Already recorded as a limitation in DEVELOPMENT_ENVIRONMENT.md §4. |
| **ASM-003** | Local Docker Compose on one machine is an acceptable deployment target. | Distributed-systems behaviour across real network boundaries is not exercised. |
| **ASM-004** | The upstream payment gateway treats `REVIEW` as a valid terminal response and handles it. | The `REVIEW` path would need a synchronous step-up flow, which is out of scope. |
| **ASM-005** | Behavioural features can be computed from the platform's own transaction stream, with no external data feed. | Merchant-risk and IP-risk features would need an external source; they are currently seeded from synthetic reference data. |
| **ASM-006** | Reviewer identity is supplied by the authentication layer; no separate identity provider is integrated. | An IdP integration would be required. |

---

## 6. Constraints

| ID | Constraint | Impact |
| --- | --- | --- |
| **CON-001** | Three developers, one academic term. | Service count is deliberately minimised (4 backend deployables). See ADR-004. |
| **CON-002** | Development and testing on a 4-core / 7.86 GB Windows laptop. | Compose profiles, container memory limits, and a re-scoped scaling experiment. See DEVELOPMENT_ENVIRONMENT.md §5. |
| **CON-003** | The load generator is co-resident with the system under test. | High-load latency figures are pessimistic and confounded. **RISK-001.** |
| **CON-004** | No real customer, cardholder or payment data may be used, at any point. | All data synthetic. PAN is never accepted or stored; only a tokenised reference is used. |
| **CON-005** | ML must be the final implementation phase; the system must be fully functional without it. | The scoring provider abstraction (FR-004) is a load-bearing design element from day one, not a later refactor. |
| **CON-006** | No unjustified technology may be introduced. | Every infrastructure component requires an ADR stating why it exists. |

---

## 7. Risk register

| ID | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| **RISK-001** | Co-resident load generation confounds latency measurement, so NFR-002 and NFR-004 cannot be *cleanly* verified. | **High** | **High** | Report server-side and client-side latency separately; pin CPU sets; cap the scaling experiment at instance counts the core count can actually support; run the headline test from a second machine if one can be obtained. Every performance claim carries the hardware caveat. See DEVELOPMENT_ENVIRONMENT.md §5.2. |
| **RISK-002** | Kafka's JVM footprint destabilises the stack on 7.86 GB. | Medium | High | KRaft mode (no ZooKeeper), constrained heap, explicit `mem_limit`, Compose profiles. Fallback: a Kafka-API-compatible broker with a smaller footprint, which would require an ADR. |
| **RISK-003** | The team writes ML first, and the abstraction that makes it swappable never materialises. | Medium | High | CON-005 is enforced by phase ordering; `MLScoringProvider` is not implemented before Phase 10. |
| **RISK-004** | The hot path accretes synchronous database calls and blows the latency budget. | Medium | High | ADR-003 forbids PostgreSQL on the hot path. Enforced by an architecture test and a latency budget assertion in CI. |
| **RISK-005** | Duplicate Kafka delivery produces duplicate cases or double-counted features. | Medium | Medium | Idempotency keys and idempotent consumers (FR-010, FR-017); duplicate-delivery test in the resilience suite. |
| **RISK-006** | Docker Desktop cannot be installed, blocking all infrastructure. | Low | **Critical** | GAP-001 raised on day one; Phase 0/1 designed to proceed without it. |
| **RISK-007** | Effort drifts into the dashboard at the expense of the distributed-systems work being evaluated. | Medium | Medium | The dashboard is explicitly scoped as an operations tool, built after Phase 7. |

---

## 8. Requirement → phase mapping

| Phase | Requirements delivered |
| --- | --- |
| 0 — Environment & repository | NFR-014, NFR-015 (foundations) |
| 1 — Architecture & domain | All — as design; nothing implemented |
| 2 — Infrastructure | NFR-002 (foundations), RISK-002 mitigation |
| 3 — Ingestion | FR-001, FR-015, FR-017 |
| 4 — Feature system | FR-002, NFR-003 |
| 5 — Rules, scoring, decisions | FR-003, FR-004, FR-005, FR-006, FR-007 |
| 6 — Events, audit, review | FR-008, FR-009, FR-010, FR-011, NFR-012, NFR-013 |
| 7 — Observability | FR-013, NFR-010, NFR-011 |
| 8 — Testing | FR-016, NFR-005, NFR-006, NFR-007 |
| 9 — Performance | NFR-001, NFR-002, NFR-004 |
| 10 — ML | FR-004 (ML provider), FR-012 |
| 11 — Hardening | NFR-008, NFR-009, NFR-015 |
