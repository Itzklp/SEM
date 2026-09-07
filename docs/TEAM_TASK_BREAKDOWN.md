# FraudGuard — Task Breakdown for Three Developers

**Team 04**

| Dev | Name | Primary domain |
| --- | --- | --- |
| **D1** | Dalsania Kalpkumar Pradipkumar (2025H1030209P) | API, domain, decisioning, security |
| **D2** | Milap Chaudhary (2025H1030207P) | Events, streaming features, data, infrastructure |
| **D3** | Lokesh Patil (2025H1030054P) | Testing, observability, performance, dashboard, ML integration |

Assignment follows the natural seams in the architecture, so the three streams touch
different files most of the time. **Ownership means accountability for delivery, not
exclusive access.** Every developer reviews across boundaries, and every developer writes
tests and documentation for their own work — a specialist testing role would concentrate
quality knowledge in one person and remove it from the other two, which is the opposite
of what a three-person team needs.

---

## Standing responsibilities

| Responsibility | Owner |
| --- | --- |
| Architecture decisions and ADR authorship | **All three.** An ADR needs at least one reviewer who did not write it |
| Code review | **All three.** No self-merge to `develop` or `main` |
| Tests for your own code | **The author** |
| Documentation for your own components | **The author** |
| Test *strategy* and shared harnesses | D3 |
| CI pipeline health | D3 primary, all fix red builds |
| Contract changes in `packages/contracts` | **Requires all three to approve** — it is the shared coordination surface |

---

## Phase-by-phase allocation

### Phase 1 — Architecture and domain

Contracts first, because everything else depends on them. Expect the first two days to be
mostly design conversation, not typing.

| Dev | Tasks |
| --- | --- |
| **D1** | `packages/domain`: entities, value objects, invariants, lifecycle state machine · `FraudScoringProvider` and `FraudRule` interfaces · OpenAPI v1 · error taxonomy |
| **D2** | `packages/contracts` Kafka event schemas · topic catalogue (purpose, producer, consumers, partition key, ordering, retention, retry, DLQ) · database schema with per-table and per-index rationale · `packages/config` |
| **D3** | TypeScript strict config · ESLint + Prettier · Jest setup · GitHub Actions CI · `packages/observability` skeleton · `packages/testkit` scaffold |

**Joint:** the request/response DTOs. This is the interface between D1's API and D3's
tests and dashboard, and between D1's decisions and D2's events — agree it together
before anyone builds on it.

**Gate:** contracts reviewed and approved by all three, CI green.

---

### Phase 2 — Infrastructure *(blocked on Docker — GAP-001)*

| Dev | Tasks |
| --- | --- |
| **D2** | **Lead.** `docker-compose.yml` with profiles · Kafka KRaft + topic bootstrap · PostgreSQL + migration runner · Redis with `maxmemory` and eviction policy · health checks and memory limits |
| **D3** | Prometheus scrape config · Grafana datasource and dashboard provisioning · **measure** actual stack memory and startup time, replacing the Phase 0 estimates |
| **D1** | Nginx gateway config · `.env.example` completeness · reviews D2's schema |

---

### Phase 3 — Transaction ingestion

| Dev | Tasks |
| --- | --- |
| **D1** | **Lead.** `apps/fraud-api` on Nest + Fastify · `POST /api/v1/fraud/score` · validation · authN/authZ · idempotency · lifecycle wiring · Swagger |
| **D2** | `packages/persistence`: repositories, migrations, connection pooling with separate hot/cold pools |
| **D3** | Integration test harness (Testcontainers) · request-scoped logging context (`requestId`/`traceId`/`transactionId`) · **the ADR-003 architecture test** · seeded synthetic generator (FR-018) |

**D3's architecture test lands in Phase 3 deliberately** — it must exist before there is
code for it to police, not after.

---

### Phase 4 — Feature system

| Dev | Tasks |
| --- | --- |
| **D2** | **Lead.** `packages/feature-store` · declarative feature definitions with windows and defaults · pipelined vector fetch · Redis structures for velocity/aggregate/distinct · feature update consumers · rebuild-from-replay |
| **D1** | Integrate feature retrieval into the hot path with timeout and default-on-failure · consume the feature vector in scoring |
| **D3** | Deterministic feature tests · in-memory feature store for unit tests · **measure** feature-fetch p99 against the 8 ms budget |

---

### Phase 5 — Rules, scoring, decisions ★ *the critical gate*

| Dev | Tasks |
| --- | --- |
| **D1** | **Lead.** Rule engine + the six rules · `StubFraudScoringProvider` · `RuleBasedScoringProvider` · score combination · decision engine + policy · explainability · degraded threshold set |
| **D2** | Policy and rule configuration loading with hot reload · merchant/IP risk reference data seeding |
| **D3** | Full unit suite over rules and decisions · determinism tests · explainability tests (reasons present, internals not leaked) · demo scenarios for `ALLOW`/`REVIEW`/`BLOCK` |

**Gate — the most important in the project:** FraudGuard demonstrably works end to end
with **zero ML code in the repository**.

---

### Phase 6 — Events, audit, review

| Dev | Tasks |
| --- | --- |
| **D2** | **Lead.** Outbox table and relay with `SKIP LOCKED`, backoff, DLQ · Kafka producers/consumers · audit persistence · feature update consumers · consumer idempotency |
| **D1** | `apps/review-api` · case queue and actions · case state machine · transaction/decision query APIs · outbox write in the decision transaction |
| **D3** | **Duplicate-delivery test** (RISK-005) · Kafka-outage test · outbox drain verification · contract tests producer ↔ consumer |

---

### Phase 7 — Observability

| Dev | Tasks |
| --- | --- |
| **D3** | **Lead.** All metrics · per-stage hot-path timing · OpenTelemetry tracing · Grafana dashboards as provisioned JSON · alert rules |
| **D1** | Instrument the hot path per stage · structured error logging |
| **D2** | Consumer lag, outbox depth and Redis/DB latency metrics |

---

### Phase 8 — Testing and resilience

Everyone writes tests for their own components. D3 owns the strategy and the shared
failure-injection harness.

| Dev | Tasks |
| --- | --- |
| **D3** | **Lead.** `test-strategy.md`, `test-plan.md` · failure-injection harness · E2E suite · resilience tests for **every ADR-005 row** · pyramid-shape review |
| **D1** | Unit + integration coverage for API, rules, decisions · security tests (authN/authZ, rate limit, replay, tampering) |
| **D2** | Integration coverage for persistence, messaging, feature store · duplicate/malformed message handling |

---

### Phase 9 — Performance

| Dev | Tasks |
| --- | --- |
| **D3** | **Lead.** k6 scenarios 500 → 20 000 TPS · CPU pinning · client- and server-side latency series · scaling experiment · performance report |
| **D1** | Hot-path bottleneck fixes as measurements dictate |
| **D2** | Infrastructure tuning: Kafka, Redis, connection pools, container limits |

**Joint:** bottleneck analysis. Interpreting these numbers on constrained, co-resident
hardware needs more than one pair of eyes — misreading a contention artefact as an
architectural limit is the easiest mistake available here (RISK-001).

---

### Phase 10 — ML

| Dev | Tasks |
| --- | --- |
| **D3** | **Lead.** Dataset · exploration · feature engineering aligned to serving features · baseline and comparison models · evaluation on the full fraud-relevant metric set · model selection · `apps/ml-service` |
| **D1** | `MLScoringProvider` with timeout, circuit breaker and rule fallback · model version recorded on every decision |
| **D2** | Model registry storage · `model.updated` event · training-data capture from the event stream |

**Joint:** the ML-versus-baseline comparison. If ML does not beat the rule baseline, that
is the finding and it gets reported.

---

### Phase 11 — Hardening and report

| Dev | Tasks |
| --- | --- |
| **D1** | Security review · threat model validation · dependency audit · `SECURITY.md` |
| **D2** | Data model review · operations runbooks · failure recovery procedures |
| **D3** | Performance regression run · resilience re-run · traceability matrix completion with real results |

**Joint:** the final technical report and the demo rehearsal. Every member must be able
to answer questions on **any** part of the system — that is the actual bar (Brief §48).

---

## Parallelism map

Where the three streams genuinely run independently:

```
Phase 1  D1 domain ─────────  D2 events+data ─────  D3 tooling+CI
Phase 3  D1 API ────────────  D2 persistence ─────  D3 harness+arch test
Phase 4  D1 hot-path wiring   D2 feature store ───  D3 feature tests
Phase 5  D1 rules+decisions   D2 config+refdata ──  D3 test suite
Phase 6  D1 review-api ─────  D2 outbox+consumers   D3 idempotency tests
Phase 7  D1 instrumentation   D2 infra metrics ───  D3 dashboards+tracing
```

Synchronisation points where work must converge:

| Point | Phase | Why |
| --- | --- | --- |
| Contract freeze | 1 | Everything depends on the DTOs and event schemas |
| Feature vector shape | 4 | D2 produces it, D1 consumes it |
| Phase 5 gate | 5 | End-to-end without ML — the project's central claim |
| Metrics naming | 7 | D3's dashboards depend on D1's and D2's metric names |
| Performance interpretation | 9 | Requires joint judgement (RISK-001) |

---

## Working agreements

1. **Branching:** `main` (protected, always releasable) · `develop` (integration) ·
   `feat/*`, `fix/*`, `docs/*`, `test/*` from `develop`.
2. **Commits:** Conventional Commits. Small and logically grouped — never one commit per
   phase.
3. **Review:** at least one other developer. Contract changes need both others.
4. **Definition of Done** (CONTRIBUTING.md) applies to every task — code alone is not
   done.
5. **Never weaken a test to make it pass.** Diagnose, document, fix, retest.
6. **Never claim an unmeasured number.** TARGET / MEASURED / ESTIMATED / ASSUMED, always
   labelled.
7. **Rotate the ADR author.** The reviewer must not be the author.
