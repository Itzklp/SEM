# FraudGuard — Test Strategy

**Version:** 1.0 (baseline) · **Date:** 2026-09-07

---

## 1. What we are actually testing for

The system's central claims are that it decides **correctly**, **quickly**, and
**reliably under partial failure**. The test suite exists to substantiate those three
claims with evidence, not to produce a coverage number.

Three rules govern everything below:

1. **Every test states what it tests, why, and what failure it would catch.** A test that
   cannot answer the third question is testing the implementation rather than the
   behaviour, and it will break on every refactor while catching nothing.
2. **A failing test is a finding, not an obstacle.** Diagnose, document, fix, retest.
   Changing an assertion to match broken behaviour is the most damaging thing anyone can
   do to this project.
3. **A number is only a result if a teammate can reproduce it.**

---

## 2. The pyramid, and why the base is wide

```
                    ▲
                   ╱ ╲          E2E  (~15)          full stack, real infra
                  ╱───╲         slow, brittle, high confidence
                 ╱     ╲
                ╱───────╲       Integration (~60)   real Redis/Postgres/Kafka
               ╱         ╲      catches what mocks cannot
              ╱───────────╲
             ╱             ╲    Unit (~300+)        pure, in-process, milliseconds
            ╱───────────────╲   the fraud logic itself
           ─────────────────────

     Separate axes, not layers:
     Contract · Architecture · Resilience · Security · Load
```

**The base is wide because of a deliberate design decision.** `packages/domain` — rules,
scoring combination, the decision engine, the lifecycle state machine — has **zero I/O**
(ADR-004). That is exactly the logic most in need of exhaustive testing, and because it
is pure, it can be tested exhaustively in milliseconds with no infrastructure.

If the unit suite ever requires a running service, an architectural rule has been broken,
and CI is configured so that this shows up as a failure rather than a slow build.

---

## 3. Test types

### 3.1 Unit — `UT-`

**Runs against:** nothing. Pure functions and in-memory doubles.
**Speed:** whole suite under 30 s.

Covers: each fraud rule's trigger conditions and boundaries; score combination
determinism and bounds; decision thresholds including exact boundary values; lifecycle
transitions, legal and illegal; feature window arithmetic; explainability (reasons
present, internals absent); the seeded generator's determinism.

> **Determinism is a first-class test target.** FR-018 and NFR-015 depend on it: if the
> generator or the stub scorer is not perfectly reproducible, every performance and
> detection result becomes unrepeatable, and the project's central claims become
> unverifiable.

### 3.2 Integration — `IT-`

**Runs against:** real PostgreSQL, Redis and Kafka via Testcontainers.
**Speed:** a few minutes.

Covers what mocks structurally cannot: SQL that is valid in the dialect, Redis data-type
and TTL behaviour, Kafka serialisation and consumer-group semantics, migration
correctness, transaction boundaries including outbox atomicity, connection-pool
behaviour under concurrency.

> A mock of Redis returns what we *believe* Redis returns. Half the bugs in this layer
> live in the gap between that belief and reality.

### 3.3 Contract — `CT-`

**Runs against:** schemas and interfaces.

Two contracts matter most:

- **Provider substitutability.** Stub, rule-based and ML providers must all satisfy
  `FraudScoringProvider` identically. This is the test that protects CON-005 — if it
  passes, Phase 10 genuinely is a configuration change.
- **Producer ↔ consumer.** Every published event validates against the schema its
  consumers expect. Catches the classic cross-developer break where D2 changes a payload
  and D3's consumer fails silently in production.

### 3.4 Architecture — `AT-`

**Runs against:** the import graph.

Enforces ADR-003 mechanically: no synchronous PostgreSQL read reachable from the
`fraud-api` scoring path; no Kafka consumer in the hot path; `packages/domain` imports no
I/O and no framework.

> A documented convention that is not checked decays. With three developers working in
> parallel, the architecture document will not be reread at the moment the violating
> import is written — this test is what catches it then.

### 3.5 End-to-end — `E2E-`

**Runs against:** the full stack.
**Kept deliberately few.** E2E tests are slow, flaky, and give poor failure localisation.
They verify that the pieces are wired together, not that each piece is correct.

Covers the journeys that must never break: a transaction scored end to end with its audit
record; a `REVIEW` producing a case that an analyst can action; the full lifecycle
reflected in queries; the degraded path end to end.

### 3.6 Resilience — `RT-`

**Runs against:** the full stack, with injected failure.

**Every row of the ADR-005 policy table has a test.** A degradation policy that is written
down but not exercised is a hypothesis.

| Test | Injected failure | Asserts |
| --- | --- | --- |
| `RT-REDIS-001` | Redis stopped | Decisions still returned; `degraded` flag set; `FEATURES_UNAVAILABLE`; widened `REVIEW` band |
| `RT-ML-001` | ML service stopped / slow | Breaker opens; rule fallback; `degraded` flag; latency budget held |
| `RT-KAFKA-001` | Kafka stopped during load | **Zero authorization failures**; outbox accumulates; full drain on recovery |
| `RT-PG-001` | PostgreSQL stopped | `503` returned — **fail closed**, no undocumented decision |
| `RT-INST-001` | One `fraud-api` instance killed | Traffic moves; no sustained error spike |
| `RT-BULK-001` | Heavy analyst query load | Authorization p99 **unaffected** (NFR-007) |
| `RT-DUP-001` | Same Kafka message delivered twice | One case, no double-counted features (RISK-005) |
| `RT-SLOW-001` | Dependency latency injected | Timeouts fire; no cascade; no retry storm |
| `RT-MALFORM-001` | Malformed message on a topic | Routed to DLQ; consumer continues |
| `RT-OVERLOAD-001` | Load beyond the shedding ceiling | `429` with `Retry-After`; served requests still meet the budget |

### 3.7 Security — `ST-`

Every mitigation claimed in the threat model has a test. Listed in
[threat-model.md §6](../security/threat-model.md#6-verification).

### 3.8 Load — `LT-`

Phase 9. Detailed in [test-plan.md](./test-plan.md); results in
[test-results/](./test-results/).

**The measurement caveat is part of the test design, not a footnote.** The load generator
is co-resident with the system under test on a 4-core machine
([DEVELOPMENT_ENVIRONMENT.md §5.2](../DEVELOPMENT_ENVIRONMENT.md#52-cpu-contention--the-load-testing-measurement-problem)).
Therefore every load test records **both**:

- **client-side latency** (k6) — what a caller experiences, including contention
- **server-side latency** (Prometheus histogram) — what the service actually spent

Reporting only the first would attribute laptop contention to FraudGuard. Reporting only
the second would hide real queueing. Both are reported, and the difference between them
is itself informative.

---

## 4. Where each requirement is verified

See [traceability-matrix.md](../requirements/traceability-matrix.md) for the full mapping.
Its coverage check is a phase-gate criterion: **a requirement without a test case fails
the gate.**

---

## 5. CI enforcement

| Stage | Runs | Blocks merge |
| --- | --- | --- |
| Format, lint, typecheck | Every PR | Yes |
| Unit | Every PR | Yes |
| Architecture | Every PR | Yes |
| Integration + contract | Every PR | Yes |
| Build | Every PR | Yes |
| Security (audit + secret scan) | Every PR | Yes |
| E2E | Merge to `develop` | Yes |
| Resilience | Nightly and before a phase gate | Reported |
| Load | Manual, Phase 9 | Reported |

Load and resilience suites are not on the PR path — they need the full stack and minutes
of runtime, and on this hardware they would be unreliable in a shared runner. They gate
phases instead of commits.

---

## 6. What we are not doing, and why

| Not doing | Why |
| --- | --- |
| Chasing a coverage percentage | Coverage measures execution, not verification. A suite at 95% that asserts nothing meaningful is worse than 60% that tests the decision boundaries — it produces false confidence |
| Mutation testing | Valuable, and out of budget for a three-person term (CON-001) |
| E2E for logic that could be unit-tested | Slow, flaky, poor localisation. If it can be a pure function, it should be, and then it should be unit-tested |
| Testing framework or library behaviour | We test our code, not NestJS's |
| Snapshot tests for decision output | They lock in current behaviour without expressing intent, and get blindly regenerated when they break |
