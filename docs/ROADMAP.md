# FraudGuard — Development Roadmap

**Baselined:** 2026-09-07

Phases are ordered by dependency, not by preference. Two orderings are load-bearing and
must not be rearranged:

1. **ML is last (Phase 10).** The system must be complete and measured without it, so
   that ML integration is a controlled comparison against a working baseline rather than
   an untestable entanglement. CON-005.
2. **Performance work (Phase 9) comes after observability (Phase 7) and testing
   (Phase 8).** Measuring a system you cannot observe produces numbers you cannot
   explain, and optimising a system without a regression suite produces speed at the cost
   of correctness.

**Exit criteria are binding.** A phase is not complete when its code exists; it is
complete when it satisfies the Definition of Done in [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## Phase 0 — Environment and repository ✅ **COMPLETE**

|                |                                                                                     |
| -------------- | ----------------------------------------------------------------------------------- |
| **Goal**       | A professional repository skeleton and an honest picture of what the machine can do |
| **Blocked by** | —                                                                                   |

**Delivered:**

- Environment audit, reproducible via `scripts/audit-environment.ps1` (verified: exits 1 on missing prerequisites)
- `docs/DEVELOPMENT_ENVIRONMENT.md` with the prerequisite matrix, capacity analysis and the co-location measurement problem
- `docs/SETUP.md`
- Git repository initialised; monorepo structure
- Requirements baseline with FR/NFR IDs, assumptions, constraints, risk register
- `ARCHITECTURE.md` with C4 context and container views
- ADRs 001–006
- This roadmap; the three-developer task breakdown

**Exit criteria:** ⚠️ **Partially met — GAP-001 (Docker) is open.** Documentation and
repository work are complete; toolchain installation is pending user action.

---

## Phase 1 — Architecture and domain

|                |                                                                                       |
| -------------- | ------------------------------------------------------------------------------------- |
| **Goal**       | Contracts frozen enough that three developers can build in parallel without colliding |
| **Blocked by** | — (does **not** require Docker)                                                       |

**Deliverables**

- `packages/contracts` — request/response DTOs, Zod schemas, Kafka event schemas, error shapes
- `packages/domain` — entities, value objects, invariants, lifecycle state machine, **zero I/O**
- `FraudScoringProvider` interface — the abstraction CON-005 depends on
- `FraudRule` interface and rule result shape
- OpenAPI specification for v1
- Kafka topic catalogue: purpose, producer, consumers, partition key, ordering, retention, retry, DLQ
- Database schema design with a documented rationale per table and per index
- Sequence diagrams for the scoring, review and degraded flows
- Toolchain: TypeScript strict, ESLint, Prettier, Jest, CI workflow

**Exit criteria**

- `pnpm typecheck` and `pnpm lint` pass on an empty implementation
- Domain unit tests pass with no infrastructure running
- Contracts reviewed and agreed by all three developers
- CI green

**Why first:** contracts are the coordination mechanism. Without them, parallel work
produces integration debt.

---

## Phase 2 — Infrastructure ✅ **COMPLETE**

|                |                                                  |
| -------------- | ------------------------------------------------ |
| **Goal**       | `pnpm docker:up` yields a healthy local stack    |
| **Blocked by** | ~~GAP-001 — Docker Desktop~~ resolved 2026-09-07 |

**Delivered**

- `docker-compose.yml` with `core` / `observability` / `apps` profiles (`apps` empty by
  design until Phase 3 — an empty profile is a valid no-op)
- Kafka in KRaft mode, single broker, `KAFKA_HEAP_OPTS` capped at 768m, `mem_limit`
  1200m; `kafka-init` bootstraps all 12 catalogue topics (6 + DLQs) with per-topic
  retention from `docs/architecture/kafka-topics.md`
- PostgreSQL with `infrastructure/postgres/init.sql` (pgcrypto, pg_stat_statements) —
  app schema/migrations remain a Phase 3 `packages/persistence` deliverable, deliberately
  not pulled forward
- Redis with `maxmemory 200mb`, `allkeys-lru`, persistence off (derived state — ADR-002)
- Prometheus scrape config (5 targets: self + the 4 not-yet-existing app services,
  correctly showing `down`); Grafana with the Prometheus datasource and an
  "Infrastructure Health" dashboard both provisioned with zero manual UI steps
- Health checks and memory limits on every container

**Exit criteria — all verified, not assumed**

- ✅ All 5 containers healthy (`docker compose ps`)
- ✅ Stack survives restart: `docker compose restart postgres redis kafka` → all
  re-reached `healthy`; Kafka's 12 topics confirmed still present afterward (volume
  persistence, not just process survival)
- ✅ Recovery from a full reset verified: `docker compose down -v` (removes all 5
  volumes + network) → `docker compose --profile core up -d` → healthy again in 21s,
  topics recreated cleanly
- ✅ **Measured**, not estimated: startup time (28.4s core, ~45s full stack) and idle
  memory (≈0.60 GB for 5 containers) — full report:
  [docs/testing/test-results/phase2-infrastructure-report.md](../testing/test-results/phase2-infrastructure-report.md)

**One real issue found and fixed:** `apache/kafka`'s combined KRaft mode rejected
`0.0.0.0` as the `CONTROLLER` listener's bind address, even though that listener is
never advertised to clients — full root-cause explanation in the report and inline in
`docker-compose.yml`.

---

## Phase 3 — Transaction ingestion

|                  |                                                                          |
| ---------------- | ------------------------------------------------------------------------ |
| **Goal**         | A validated, authenticated authorization request reaches a stub decision |
| **Blocked by**   | Phase 1, Phase 2                                                         |
| **Requirements** | FR-001, FR-015, FR-017                                                   |

**Deliverables**

- `apps/fraud-api` on NestJS + Fastify
- `POST /api/v1/fraud/score` with full schema validation
- Authentication and authorization; standard error responses
- Idempotency by `transactionId`
- Transaction lifecycle state machine wired
- Nginx gateway with rate limiting
- Structured Pino logging with `requestId` / `traceId` / `transactionId`
- Swagger UI served

**Exit criteria**

- Valid request returns a decision; invalid request returns `400` naming the field, with no side effects
- Unauthenticated → `401`; unauthorized → `403`
- Duplicate `transactionId` returns the original decision
- Integration tests pass against real infrastructure

---

## Phase 4 — Feature system

|                  |                                                            |
| ---------------- | ---------------------------------------------------------- |
| **Goal**         | Real behavioural features, served from Redis inside budget |
| **Blocked by**   | Phase 3                                                    |
| **Requirements** | FR-002, NFR-003                                            |

**Deliverables**

- `packages/feature-store` — declarative feature definitions with windows, key layouts and **defaults on miss**
- Redis client with single-pipeline vector fetch
- Velocity, aggregate, distinct-count and risk-lookup feature families
- Feature update consumers in `event-worker`
- Feature rebuild-from-replay path (ADR-002 requires this to exist and be tested, not assumed)
- In-memory feature store for unit tests
- Deterministic feature-computation tests

**Exit criteria**

- After N seeded transactions, served features reflect all N
- **Measured** p99 feature-fetch latency against the 8 ms budget
- Rebuild-from-replay reproduces the same feature state
- Missing Redis returns declared defaults rather than throwing

---

## Phase 5 — Rules, scoring and decisions

|                  |                                                |
| ---------------- | ---------------------------------------------- |
| **Goal**         | **FraudGuard works end to end without any ML** |
| **Blocked by**   | Phase 4                                        |
| **Requirements** | FR-003 – FR-007                                |

**Deliverables**

- Rule engine with `VelocityRule`, `AmountDeviationRule`, `DeviceRiskRule`, `GeographicAnomalyRule`, `FailedAttemptRule`, `MerchantRiskRule`
- `StubFraudScoringProvider` — fully deterministic
- `RuleBasedScoringProvider`
- Score combination with configurable weights
- Decision engine with configurable policy thresholds and a recorded policy version
- Explainability: reasons on every decision, with no leakage of weights, thresholds or internals
- Degraded-mode threshold set (ADR-005)

**Exit criteria — this is the project's most important gate**

- A demo transaction of each class produces `ALLOW`, `REVIEW`, `BLOCK` respectively
- Identical input produces an identical score, every time
- Adding a rule requires **no** change to the decision engine
- Every non-`ALLOW` decision carries at least one reason
- **The system is fully functional and demonstrable with zero ML code in existence**

---

## Phase 6 — Events, audit and review

|                  |                                                                                 |
| ---------------- | ------------------------------------------------------------------------------- |
| **Goal**         | The cold path, with the durability and idempotency guarantees actually verified |
| **Blocked by**   | Phase 5                                                                         |
| **Requirements** | FR-008 – FR-011, NFR-012, NFR-013                                               |

**Deliverables**

- Outbox table, relay with `SKIP LOCKED`, backoff and dead-lettering (ADR-006)
- Kafka topics; producers and consumers in `event-worker`
- Append-only audit persistence
- Case creation on `REVIEW`, idempotent
- `apps/review-api`: case queue, `APPROVE` / `BLOCK` / `ESCALATE`, transaction and decision queries
- Consumer idempotency with event-ID deduplication
- DLQ handling and inspection

**Exit criteria**

- Every decision is recoverable with its full basis
- **Duplicate delivery test passes** — no duplicate cases, no double-counted features
- Kafka stopped for the duration of a load run: authorizations unaffected, outbox drains fully on recovery
- Illegal case transitions rejected

---

## Phase 7 — Observability

|                  |                                                  |
| ---------------- | ------------------------------------------------ |
| **Goal**         | The system can be understood while it is running |
| **Blocked by**   | Phase 6                                          |
| **Requirements** | FR-013, NFR-010, NFR-011                         |

**Deliverables**

- Prometheus metrics: `transactions_total`, `fraud_decisions_total` (labelled by decision and `degraded`), `fraud_score_duration_seconds`, `request_duration_seconds`, `request_errors_total`, `kafka_consumer_lag`, `redis_duration_seconds`, `db_duration_seconds`, `ml_duration_seconds`, `active_requests`, `outbox_pending_total`
- **Per-stage** hot-path timing (required by ADR-003 enforcement)
- OpenTelemetry tracing across `fraud-api` → Redis → Postgres → Kafka → `event-worker`
- Grafana dashboards committed as provisioned JSON
- Alert rules: latency budget breach, error rate, consumer lag, degraded-decision ratio, review-queue depth

**Exit criteria**

- A single transaction is traceable end to end by `traceId`
- Dashboards render real data under load
- Metrics contract test passes
- Dashboards reproduce from a clean checkout with no manual UI configuration

---

## Phase 8 — Testing and resilience

|                  |                                                          |
| ---------------- | -------------------------------------------------------- |
| **Goal**         | Correctness and failure behaviour verified, not asserted |
| **Blocked by**   | Phase 7                                                  |
| **Requirements** | FR-016, NFR-005 – NFR-007                                |

**Deliverables**

- Unit suite over `packages/domain` (the pyramid's base)
- Integration tests via Testcontainers
- Contract tests: API ↔ client, producer ↔ consumer
- E2E tests over the full stack
- Architecture test enforcing the ADR-003 hot-path rules
- Resilience suite covering **every row** of the ADR-005 policy table, plus slow dependencies, network timeouts, duplicate messages, malformed input, invalid auth and overload
- `docs/testing/test-strategy.md` and `test-plan.md`, each test stating what it tests, why, and what failure it would catch

**Exit criteria**

- Healthy pyramid shape — many unit, fewer integration, fewest E2E
- Every ADR-005 row has a passing test
- **Failures are reported, never silenced by weakening a test**

---

## Phase 9 — Performance and scalability

|                |                                                     |
| -------------- | --------------------------------------------------- |
| **Goal**       | **Measured** evidence for NFR-001, NFR-002, NFR-004 |
| **Blocked by** | Phase 8                                             |

**Deliverables**

- k6 scenarios at 500 / 1 000 / 2 000 / 5 000 / 10 000 / 20 000 TPS
- Per run: throughput, p50/p95/p99/max, error rate, CPU, memory, Kafka lag, Redis latency
- **Both** client-side and server-side latency series, reported separately (RISK-001 mitigation D)
- Horizontal scaling experiment, scoped to what 4 cores can honestly support (mitigation C)
- CPU pinning between the load generator and the system under test (mitigation B)
- Bottleneck analysis, fixes, re-measurement
- `docs/testing/test-results/performance-report.md`

**Exit criteria**

- Every scenario executed and recorded, **including the ones that fail**
- Each run marked `PASS` / `DEGRADED` / `FAILED` against its NFR
- Saturation point identified, with the bottleneck named
- **Every claim in the report is traceable to a reproducible run.** No estimated number is presented as measured
- The hardware caveat from DEVELOPMENT_ENVIRONMENT.md §5.2 appears in the report

---

## Phase 10 — Machine learning

|                  |                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------- |
| **Goal**         | Add a learned scorer as a _configuration change_, and measure whether it is actually better |
| **Blocked by**   | Phase 9 — **do not start earlier**                                                          |
| **Requirements** | FR-004 (ML), FR-012                                                                         |

**Deliverables**

1. Dataset definition (synthetic / publicly appropriate; **never real customer data**)
2. Exploration and cleaning
3. Feature engineering aligned to the _serving_ features, to avoid training/serving skew
4. Baseline: logistic regression
5. Comparison: random forest, XGBoost / LightGBM
6. Evaluation on **Precision, Recall, F1, ROC-AUC, PR-AUC, FPR, FNR and inference latency** — accuracy alone is meaningless on data this imbalanced
7. Model selection with the reasoning recorded
8. Serialisation and a versioned model registry
9. `apps/ml-service` inference API
10. `MLScoringProvider` behind timeout + circuit breaker, falling back to rules
11. Load test with ML enabled
12. **Controlled comparison: ML versus stub/rule baseline**, through the identical pipeline

**Exit criteria**

- Decision engine, API contract and audit schema **unchanged** — the abstraction held
- Every decision records its model version
- ML failure falls back to rules, verified under load
- Comparison reports both detection quality **and** latency cost
- If ML does not beat the rule baseline on the fraud-relevant metrics, **that result is reported as found**

---

## Phase 11 — Hardening and final report

|                |                                               |
| -------------- | --------------------------------------------- |
| **Goal**       | A defensible, reproducible, documented system |
| **Blocked by** | Phase 10                                      |

**Deliverables**

- Security review against `docs/security/threat-model.md`; dependency audit
- Performance regression check against the Phase 9 baseline
- Full resilience re-run
- Documentation completeness pass; traceability matrix filled with **actual** test results
- Architecture review against the ADRs — including any decision that turned out to be wrong
- Dead code and TODO cleanup
- Final technical report (Brief §44)
- Rehearsed demo script for all eight demos

**Exit criteria**

- Every FR and NFR traced to a test and a result
- Every performance claim labelled TARGET / MEASURED / ESTIMATED / ASSUMED
- Every "why" question in Brief §48 answerable from the documentation

---

## Dependency graph

```
Phase 0 ──▶ Phase 1 ──▶ Phase 3 ──▶ Phase 4 ──▶ Phase 5 ──▶ Phase 6 ──▶ Phase 7
              │            ▲                        │                       │
              └▶ Phase 2 ──┘                        │                       ▼
                 (needs Docker)      ┌──────────────┘                   Phase 8
                                     │                                      │
                              ★ working without ML                          ▼
                                                                        Phase 9
                                                                            │
                                                                            ▼
                                                                       Phase 10 (ML)
                                                                            │
                                                                            ▼
                                                                       Phase 11
```

## Critical path risks

| Risk                                              | Phase | Mitigation                                                                    |
| ------------------------------------------------- | ----- | ----------------------------------------------------------------------------- |
| Docker unavailable                                | 2     | GAP-001 raised immediately; Phase 1 proceeds without it                       |
| Hot-path violations accumulate                    | 3–6   | Architecture test from Phase 3 onward (ADR-003)                               |
| Co-location confounds measurement                 | 9     | Four documented mitigations; caveat in every report (RISK-001)                |
| ML started early, abstraction never materialises  | 10    | Phase ordering; `MLScoringProvider` not written before Phase 10 (RISK-003)    |
| Dashboard consumes time budgeted for systems work | 7+    | Explicitly scoped as an operations tool, built after observability (RISK-007) |
