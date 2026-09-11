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

## Phase 3 — Transaction ingestion ✅ **COMPLETE**

|                  |                                                                          |
| ---------------- | ------------------------------------------------------------------------ |
| **Goal**         | A validated, authenticated authorization request reaches a stub decision |
| **Blocked by**   | ~~Phase 1, Phase 2~~ both complete                                       |
| **Requirements** | FR-001, FR-015, FR-017                                                   |

**Delivered**

- `apps/fraud-api` on NestJS + Fastify — the real pipeline: JWT auth
  (`JwtAuthGuard`/`PrivilegesGuard`, FR-015) → Zod validation
  (`ZodValidationPipe` against `packages/contracts`) → Redis idempotency
  fast path → `PlaceholderScoringProvider` (Phase 3 stub, satisfies CON-005's
  interface) → threshold `decide()` → persist (`packages/persistence`,
  atomic transaction+decision write) → respond
- `packages/persistence` — Drizzle schema for `transactions`/`decisions`
  matching `data-model.md`, hand-rolled SQL migration runner (`pnpm
db:migrate`/`db:rollback`), hot/cold connection pools (ADR-004 bulkhead)
- `packages/feature-store` — Redis client + idempotency (this phase);
  placeholder feature vector Phase 4 will extend without relocating
- `packages/testkit` — seeded transaction generator (FR-018, partial — see
  below) and a JWT test-token signer
- `tests/architecture/hot-path.test.ts` — the ADR-003 enforcement test,
  landed on schedule (D3's Phase 3 deliverable)
- Full transaction lifecycle state machine actually driven end to end
  (RECEIVED → VALIDATED → FEATURES_LOADED → SCORED → DECIDED), persisted
  status reflecting the real outcome
- Swagger UI served from the existing hand-authored `openapi.yaml`
- Structured Pino logging (per-request `requestId`/`traceId` context is a
  Phase 7 observability enhancement, not yet wired — logged honestly rather
  than claimed)

**Deliberately deferred:** the Nginx gateway. Rate limiting is satisfied at
the application layer (`@fastify/rate-limit`, ADR-005's overload policy) for
now; a gateway in front of `fraud-api` is infrastructure work with no new
application behaviour behind it, and fits better alongside Phase 6+'s
multi-service routing than as a solo addition here.

**Exit criteria — all verified against a live server and real infrastructure**

- ✅ Valid, authenticated request → `200` with a decision (verified via
  `curl` against a running instance, not only mocked)
- ✅ Malformed request → `400` naming the offending field, **zero
  persisted rows** (`IT-API-002`)
- ✅ Unauthenticated → `401`; wrong privilege → `403` (`ST-001`, `ST-005`)
- ✅ Duplicate `transactionId` → identical original decision (`IT-IDEM-001`)
- ✅ Integration tests pass against real Postgres + Redis (7/7,
  `tests/integration/fraud-api-scoring.integration.test.ts`)

**Three real bugs found and fixed while getting there — not filed away, fixed and regression-tested:**

1. **`z.coerce.boolean()` silently broken for every boolean env var.**
   `Boolean("false")` is `true` in JS — `POSTGRES_SSL=false` was coercing to
   `true`, and `pnpm db:migrate` failed against the non-SSL local Postgres
   with "The server does not support SSL connections". Fixed with a proper
   string-aware `booleanEnv()` preprocessor in `packages/config`; 7 new
   regression tests lock in `"false"` → `false` for every boolean field.
2. **`transitionTransaction()`'s return value was never captured.** Every
   persisted transaction stayed at `status='RECEIVED'` regardless of how
   far the pipeline actually got — the function validates _and returns_
   the new status, and the return was discarded. Fixed in
   `ScoringService`; the integration happy-path test now asserts
   `status = 'DECIDED'` directly against the database.
3. **CLI/dev scripts resolved workspace packages via stale compiled
   `dist/`, not live source**, and never loaded `.env` at all. `ts-node`
   resolves `@fraudguard/*` through each package's `main` field
   (`dist/index.js`) — `pnpm db:migrate` was silently running Phase-1-era
   compiled code. Fixed with `tsconfig-paths/register` (redirects to `src`
   at runtime, matching what Jest's `moduleNameMapper` already did for
   tests) plus a `.env`-loading preload (`apps/fraud-api/preload.js`,
   `packages/persistence`'s migration scripts) — ES import hoisting means
   `dotenv.config()` has to run in a plain-JS `-r` preload, not inside
   `main.ts` itself, or the whole `AppModule` import chain (which calls
   `loadConfig()` eagerly) resolves before it does.

**FR-018 status: partial.** The generator produces well-formed,
deterministic transactions (`UT-GEN-001` verified) — sufficient for this
phase's integration tests. The seven fraud-pattern generators (velocity,
amount-anomaly, etc.) are meaningful once a feature store and rule engine
exist to detect them against (Phase 4/5); building them now would mean
testing against nothing. Tracked honestly in the traceability matrix as
partial, not claimed complete.

---

## Phase 4 — Feature system ✅ **COMPLETE**

|                  |                                                            |
| ---------------- | ---------------------------------------------------------- |
| **Goal**         | Real behavioural features, served from Redis inside budget |
| **Blocked by**   | ~~Phase 3~~ complete                                       |
| **Requirements** | FR-002, NFR-003 (partial — see below)                      |

**Delivered**

- `packages/feature-store` — declarative feature definitions (`feature-definitions.ts`:
  every window, default and the longest-retention constant, in one place), Redis key
  layout (`keys.ts`), a real read path (`feature-reader.ts`) and write path
  (`feature-writer.ts`) replacing the Phase 3 placeholder
- All 11 catalogue features computed for real: `transaction_count_5m/1h`,
  `amount_sum_1h`, `average_amount_24h`, `distinct_merchants_1h`,
  `distinct_locations_24h`, `failed_transactions_10m`, `device_transaction_count`,
  `account_age_days`, `merchant_risk_score`, `ip_risk_score`
- A single per-user rolling event log (sorted set, keyed by `transactionId`) plus
  parallel hashes for amount/merchant/IP backs every velocity/aggregate/distinct
  feature — trimmed to the longest window (24h) on every write, anchored to the
  _event's_ timestamp rather than wall-clock time (required for replay determinism —
  see below)
- Risk-lookup read mechanism with default-on-miss (`risk-lookup.ts`); seeding real
  merchant/IP reference data is Phase 5's named deliverable
  (`docs/TEAM_TASK_BREAKDOWN.md`), not pulled forward
- Two pipelined Redis round trips per fetch (not one per feature — see below) via
  `fraud-api`'s existing `ScoringService`, wired in place of the Phase 3 placeholder,
  with an explicit ADR-005 cautious-open fallback (`tryGetFeatureVector`) on Redis
  failure
- `createInMemoryRedis()` (`packages/testkit`, backed by `ioredis-mock`) — the
  "in-memory feature store for unit tests" deliverable, shared rather than
  hand-rolled so later packages (Phase 5's rule engine, most likely) can reuse it
- 12 unit tests (`packages/feature-store/src/feature-store.test.ts`) + 3 integration
  tests against real Redis (`tests/integration/feature-store.integration.test.ts`)

**Two deliberate deviations from the original deliverable list, surfaced rather than
hidden:**

1. **Distinct counts use an exact `Set`, not HyperLogLog.** ADR-002 names HLL as an
   option "where exactness is not required"; it does not mandate it. `ioredis-mock`
   does not implement `PFADD`/`PFCOUNT` at all (confirmed empirically, not assumed),
   which would have blocked unit testing without Docker. Given ADR-002's own access
   characteristics — "small per entity" — exact counting over a pulled window is
   cheap and avoids HLL's probabilistic error for no real benefit at this scale.
2. **Feature _writes_ are not wired to a Kafka consumer.** `apps/event-worker` and the
   outbox relay are Phase 6 deliverables (`ARCHITECTURE.md`'s service table: "Feature
   engine — write | event-worker"); nothing publishes `transaction.decided` yet.
   `recordTransactionFeatures()` is the consumer's entire body, already built and
   tested — Phase 6's job is to call it from a Kafka handler, not design it. Proved
   end to end now by calling it directly (exactly what the rebuild-from-replay test
   does) rather than waiting for Phase 6 to exist.

**Exit criteria — all verified against real Redis, not only a mock**

- ✅ After N seeded transactions, served features reflect all N (`IT-FEAT-001`, 8/8)
- ✅ **Measured**, not estimated: feature-fetch latency over 200 samples against a
  local real Redis — p50 1.7 ms, p99 3.97 ms, max 6.4 ms, against the 8 ms budget
  (`IT-FEAT-003`). **Caveat (RISK-001):** co-located, single-threaded, no load — this
  is not NFR-003's sustained-load measurement, which stays Phase 9's job; it is only
  evidence the read path has headroom before Phase 9 puts load behind it
- ✅ Rebuild-from-replay reproduces the same feature state, byte-for-byte, against
  both the in-memory store and real Redis (`IT-FEAT-002`) — required anchoring
  window trimming to event time rather than wall-clock time, or a replay run later
  than the original events would trim more aggressively than the live run did and
  silently fail to reproduce it
- ✅ Missing Redis returns declared defaults rather than throwing — proved for the
  first time against a **real** Redis outage (`redis.disconnect()` mid-suite), not
  only the Phase 3 placeholder's permanently-"unavailable" vector
  (`fraud-api-scoring.integration.test.ts`, new test)

**One real bug the tests caught:** `amount_sum_1h`/`average_amount_24h` were computed
by summing stored minor units directly — a $10 + $20 transaction pair reported `3000`,
not `30`. `Money.toMajorUnits()`'s own doc comment says major units are "for ...
feature computation only" — missed on first pass, caught by a unit test asserting the
actual dollar figure rather than just "some positive number." Fixed by converting once,
at the read boundary.

**One real bug in the test suite itself, not the product:** the new integration test's
`beforeAll`/`afterAll` originally called `redis.flushdb()` to clear its own state —
which intermittently deleted `fraud-api-scoring.integration.test.ts`'s idempotency
keys when Jest ran both files concurrently against the same Redis, since the two
files don't share a worker process. Fixed by scoping cleanup to this package's own
`feat:` keyspace. Also surfaced, empirically: ioredis's `keyPrefix` option does not
apply to `KEYS`'s pattern argument or strip it from results — confirmed against a
live client, not assumed, and documented in the fix.

**FR-002 status: the acceptance criterion is met** ("after N transactions, served
features reflect all N; feature computation is deterministic for a given event
sequence") — proved directly, including under replay. What is NOT yet true is "from
the transaction stream" in the literal, Kafka-consuming sense: that connection is
Phase 6's. **NFR-003 status: not claimed.** Phase 4 measured the feature-fetch
sub-component against ADR-002's internal 8 ms budget; NFR-003 itself is the
end-to-end in-service p99 under sustained load, which remains Phase 9's, unchanged in
the traceability matrix.

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
