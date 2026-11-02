# Phase 11 — architecture review against the ADRs

**Date:** 2026-11-02. **Method:** each ADR's `Decision` and `Consequences` sections
checked against what Phases 1-10 actually measured, not re-argued from first
principles. Per `docs/ROADMAP.md`'s own instruction for this phase: name any
decision that turned out to be wrong, not just the ones that held up.

## ADR-001 — Kafka never in the authorization path

**Held.** Every resilience phase re-confirmed this directly against a real stopped
Kafka container (`kafka-outage.resilience.test.ts`, Phase 6 and re-run in Phase 8/9):
authorizations are unaffected, outbox drains fully on recovery. The architecture
test (`hot-path.test.ts`) has caught zero violations across ten phases of changes
on top of it, including Phase 10's entirely new ML provider and training pipeline.
No finding.

## ADR-002 — Redis as the real-time feature store

**The architecture held; one specific number did not.** `REDIS_TIMEOUT_MS=20` was
set to protect the 8ms feature-fetch budget, but Phase 9's load testing found it
tripping under even light concurrency that had nothing to do with Redis itself being
slow (Redis's own container CPU stayed under 1% throughout) — the single,
non-pooled `ioredis` connection (`createRedisClient`, deliberate per
`redis-client.ts`'s own doc comment) means any brief scheduling delay on
`fraud-api`'s side is enough to blow a 20ms budget that was sized for Redis's
response time, not for queueing behind other work on the same connection. The
fallback itself worked exactly as designed every time (cautious-open, never a
failure) — this is a case where the DEGRADATION mechanism is sound but fires more
often in practice than the ADR's authors likely pictured when the number was
chosen. **Recommendation for whoever revisits this**: either a small connection pool
(trading simplicity for headroom) or a measured, not guessed, timeout derived from
this project's own p99 figures (Phase 4's 3.97ms real p99 under no load — 20ms
already has ~5x headroom over that baseline, so the problem is concurrency, not the
number itself).

## ADR-003 — Hot-path / cold-path separation and the hot-path budget

**The architectural boundary held perfectly; the budget TABLE was never actually
enforced the way this ADR claims, and the configured numbers don't match it.**

- The ADR's own "Enforcement" section names a "Budget assertion": the server-side
  `fraud_score_duration_seconds` histogram "is asserted against the 40ms p99 budget
  in the integration suite." **This test does not exist.** Grepping the entire test
  suite for this assertion finds nothing — Phase 9's own load testing measured
  end-to-end latency against NFR-002's (looser, 200ms) target instead, never
  against this ADR's internal 40ms figure. The claim in the ADR is aspirational, not
  built.
- The ADR's per-stage table specifies a 7ms PostgreSQL write budget and a 15ms
  scoring-provider budget. The actual configured values are
  `POSTGRES_STATEMENT_TIMEOUT_MS=100` (14x looser) and `ML_TIMEOUT_MS=30` (2x
  looser). Neither configuration file nor the ADR references the other — they have
  silently diverged over nine phases of work.
- What DID hold, rigorously, the whole time: the import-graph architecture test
  (no Kafka, no synchronous Postgres read on the scoring path) — zero violations
  across every phase, including Phase 10's new provider and consumer.

**Recommendation**: either build the missing budget-assertion test against the
_actual_ configured numbers, or update this ADR's table to match reality and drop
the "asserted in the integration suite" claim until it is true. Both are one
afternoon's work; leaving the mismatch undocumented is the actual risk.

## ADR-004 — Four backend deployables, not seven microservices; bulkhead pools

**One of this ADR's own numbers turned out to be wrong, found and fixed in
Phase 9.** `POSTGRES_POOL_HOT_MAX=10` (the bulkhead's hot-path pool size, set at
Phase 1 and never revisited) queued even light, non-saturating traffic rather than
executing it — a 50-TPS smoke stage, nowhere near this laptop's real ceiling,
measured p99 drop from 2457ms to 49ms once raised to 50. The bulkhead CONCEPT
(separate hot/cold pools so analyst query load cannot starve authorization writes)
is independently confirmed sound by `tests/resilience/bulkhead-isolation
.resilience.test.ts` — this was a sizing mistake, not a design mistake, and it was
sized once at the very first phase, before any load-testing evidence existed to
size it against. Fixed in `.env.example`'s committed default (Phase 9).

**A second, related finding — in the test suite's own code, not the
architecture — surfaced while re-running the full resilience suite for this
review.** Five resilience test files (`redis-outage`, `kafka-outage`,
`overload-shedding`, `postgres-outage`, `dependency-latency`) used `hotPool` —
the bulkhead's own hot-path pool, with ADR-003's 100ms `statement_timeout` — for
their own cleanup/assertion queries, not just `coldPool` as `bulkhead-isolation
.resilience.test.ts` already did correctly. Repeated full-suite runs during this
review intermittently failed 4-7 of 8 files with `canceling statement due to
statement timeout` on those cleanup queries — initially, and incorrectly,
attributed to this laptop's already-documented host-contention variance
(RISK-001), the default and usually-correct explanation for exactly this kind of
flakiness in this project. It was not that, this time: switching all five files'
test-side queries to `coldPool` (matching the pattern Phase 8/9 already
established elsewhere, just not applied uniformly) took the suite from
intermittently 4-7/8 failing to a stable 8/8 across three consecutive full runs.
**Worth recording precisely because the familiar, already-accepted explanation
was the wrong one this time** — a reminder that RISK-001 is a real, measured
phenomenon, not a license to stop looking once a plausible-sounding cause
presents itself.

## ADR-005 — Per-dependency degradation policy

**The policy itself held up exceptionally well across three phases of adversarial
testing against real infrastructure (Redis, Kafka, PostgreSQL, the ML provider, and
overload, each stopped/killed for real); one row's IMPLEMENTATION had a real,
long-standing bug that none of that testing caught until Phase 11 looked
specifically for it.** `@fastify/rate-limit`'s own thrown error (a plain `Error`
with `.statusCode = 429`, not a NestJS `HttpException`) was being caught by
`HttpExceptionFilter`'s generic branch and surfaced as `500 INTERNAL_ERROR` instead
of `429` — verified directly against the real running process (`X-RateLimit-
Remaining` correctly counting to zero; every over-limit response was `500`, not
`429`). This went unnoticed through Phase 8's entire resilience suite because
`overload-shedding.resilience.test.ts` tests a _different_ ADR-005 row
(`MAX_CONCURRENT_REQUESTS`, a concurrency ceiling) — nothing in this project's test
suite, until Phase 11, ever actually exceeded the time-window rate limit and looked
at the response. The POLICY TABLE was right; one row's wiring was silently broken
since whenever `@fastify/rate-limit` was first registered. Fixed; see
`docs/security/threat-model.md` §6.

## ADR-006 — Transactional outbox for decision events

**The correctness guarantee is real and was proven repeatedly (Phase 6-9); the
ADR's own stated performance assumption was wrong under load, and Phase 9 is the
proof.** The ADR's "Consequences → Positive" section states: "The extra hot-path
cost is one `INSERT` in a transaction already being performed — well inside the
7ms write budget." Phase 9's load testing measured this exact step (`persist`,
`insertScored`) averaging **11,000-25,000ms** under sustained load — not
milliseconds, seconds — because the commit's cost is not the `INSERT` itself but
`synchronous_commit`'s WAL fsync, which this laptop's WSL2-virtualised disk makes
far more expensive under write contention than the ADR's author evidently expected.
The durability guarantee this pattern buys (confirmed zero lost events across every
outage test this project has run) is real and worth the cost — but the ADR's own
performance claim about that cost was asserted, not measured, and Phase 9 is the
first time anyone actually measured it. This is this project's single most
consequential "assumption vs. measurement" gap: it is the named root cause behind
NFR-001/002/004 all failing in `performance-report.md`. **Not fixed** —
`synchronous_commit=off` is a durability-affecting decision outside any later
phase's authority to make unilaterally; named here as the clearest candidate for a
superseding ADR, should a future phase take it up.

## ADR-007 — Observability stack

**Held, and was directly load-bearing for diagnosing several of this session's own
findings** — not a passive deliverable. The per-stage `measure()` pattern
(Phase 7) is what let Phase 9 name `persist` specifically as the bottleneck rather
than "the hot path is slow" generically. `ml_duration_seconds` (defined in Phase 7,
honestly unobserved until Phase 10's provider existed) is what confirmed the ML
HTTP call itself was fast (288/304 calls under 25ms) while the overall request
degraded under load for an unrelated reason — without that histogram, Phase 10's
"is ML slow, or is something else slow" question would have had no real answer.
Jaeger's trace propagation through the outbox (Phase 7's hardest problem) was never
revisited and never broke. No finding.

## Summary

| ADR | Architecture                           | Specific numbers / implementation                                                                                                                                    |
| --- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 001 | Held                                   | —                                                                                                                                                                    |
| 002 | Held                                   | `REDIS_TIMEOUT_MS` too tight for a single unpooled connection under concurrency — not fixed, documented                                                              |
| 003 | Held (import-graph test)               | Claimed budget-assertion test does not exist; configured timeouts (100ms, 30ms) don't match the ADR's own table (7ms, 15ms) — not fixed, documented                  |
| 004 | Held (bulkhead-isolation test)         | `POSTGRES_POOL_HOT_MAX` sizing was wrong — **fixed in Phase 9**                                                                                                      |
| 005 | Held (3 phases of real-outage testing) | `@fastify/rate-limit`'s 429 silently became a 500 — **fixed in Phase 11**                                                                                            |
| 006 | Correctness guarantee held             | Performance assumption ("well inside the 7ms budget") was wrong by 3-4 orders of magnitude under load — **named as root cause, not fixed (needs a superseding ADR)** |
| 007 | Held, actively useful                  | —                                                                                                                                                                    |
