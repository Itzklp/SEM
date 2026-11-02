# FraudGuard — final technical report

**Date:** 2026-11-02. **Status:** Phases 0-11 complete. **Scope:** this report
synthesises the whole project; it does not re-derive what the per-phase documents
already prove in detail — each claim below links to the document that actually
measured it.

## 1. What FraudGuard is

A real-time payment-fraud decisioning platform: an authorization request arrives,
a decision (`ALLOW`/`REVIEW`/`BLOCK`) must be returned inside a tight latency
budget, and the decision must still be returned — degraded, never silently wrong
— when any dependency is broken. That single constraint
(`docs/architecture/ARCHITECTURE.md` §1) drives every other decision in the
system: the hot-path/cold-path split, the choice of Redis for features, the
transactional outbox for guaranteed event delivery, and the per-dependency
degradation policy.

**Services** (`ARCHITECTURE.md`, ADR-004): `fraud-api` (the hot path —
authenticate, validate, fetch features, score, decide, persist, respond),
`review-api` (analyst case queue, model registry), `event-worker` (the cold path
— outbox relay, four independent Kafka consumer groups), `ml-service` (an
isolated Python inference process, Phase 10). Four deployables, not seven
microservices — a deliberate, argued choice (ADR-004), not a default.

## 2. What was built, phase by phase

| Phase | Delivered                                                                          | Status |
| ----- | ---------------------------------------------------------------------------------- | ------ |
| 0     | Environment audit, requirements baseline, ADRs 001-006, this roadmap               | ✅     |
| 1     | Contracts, domain model, OpenAPI spec, toolchain                                   | ✅     |
| 2     | Docker stack (Postgres, Redis, Kafka KRaft, Prometheus, Grafana)                   | ✅     |
| 3     | `fraud-api` ingestion pipeline, JWT auth, idempotency                              | ✅     |
| 4     | `packages/feature-store` — 11 real behavioural features over Redis                 | ✅     |
| 5     | Rule engine, score combiner, decision engine — **zero ML, fully functional**       | ✅     |
| 6     | Transactional outbox, `event-worker`, `review-api`, audit trail                    | ✅     |
| 7     | Metrics, tracing (Jaeger), dashboards, alert rules                                 | ✅     |
| 8     | 5/7 ADR-005 resilience rows verified against real outages; contract + E2E tests    | ✅     |
| 9     | k6 load matrix 500-20,000 TPS; bottleneck analysis; horizontal scaling             | ✅     |
| 10    | Synthetic model comparison, `MLScoringProvider`, model registry, training pipeline | ✅     |
| 11    | Security review, dependency audit, ADR review, this report, demo script            | ✅     |

Every phase's own completion report (`docs/ROADMAP.md`) lists its delivered
items, deliberate deviations, and the real bugs found while building it — this
report does not repeat that detail, only the headlines that matter across
phases.

## 3. The central, honest finding

**The system is functionally complete and correct; it does not meet its own
throughput and latency targets on this hardware, and the reason is identified,
not guessed.** `docs/testing/test-results/performance-report.md` measured
NFR-001 (≥2,000 TPS), NFR-002 (p99<200ms @ 2,000 TPS), and NFR-004 (throughput
scales with instance count) as **NOT MET**, and named the same root cause behind
all three: Postgres's synchronous-commit write path (the transactional outbox's
own `INSERT`, ADR-006), under this laptop's WSL2-virtualised disk, costs far
more under sustained concurrent load than the architecture's own budget assumed.
Three independent experiments converge on this:

- Raising the hot-path connection pool helped once (a genuine Phase 1 sizing
  bug, fixed) and then stopped helping — ruling out "not enough connections."
- Horizontal scaling went flat, then negative, across 1→2→3 instances — adding
  more application processes added more contention for the same bottleneck, not
  more capacity.
- CPU pinning (isolating the load generator from the system under test onto
  disjoint cores) made no measurable difference — ruling out scheduler
  contention as the cause.

This is reported as a finding, not softened: `docs/adr/PHASE_11_ADR_REVIEW.md`
traces it directly to ADR-006's own stated assumption ("well inside the 7ms
write budget") being wrong by three to four orders of magnitude under load on
this specific hardware. The correctness guarantee the outbox buys — confirmed
zero lost events across every outage test this project ran — is real and worth
keeping; the performance cost of the mechanism that buys it was asserted, never
measured, until Phase 9 measured it.

## 4. Machine learning: a measured comparison, not an assumption

Phase 10 built the ML path as CON-005 requires: as a configuration change
(`SCORING_PROVIDER=ml`) behind the same `FraudScoringProvider` interface the
rule-based system already used, with a timeout, a real circuit breaker, and a
deterministic fallback. On the generated synthetic scenarios
(`docs/testing/test-results/phase10-ml-evaluation.md`), the learned model wins
on every fraud-relevant metric (holdout PR-AUC 0.8150 vs. 0.4603 for the rule
baseline) at a real, measured cost: ~17-22ms of added p99 latency at a
sustainable rate, and a second process whose own outage must be handled — which
it is, verified against a real killed-and-restarted process, not a mock
(`tests/resilience/ml-outage.resilience.test.ts`). The comparison also
discovered that model _selection itself_ is sensitive to this laptop's host
load — the identical, deterministic training run selected a different
candidate model on two different days, because the latency-based selection
rule measured different numbers under different ambient load. Reported as a
methodology finding, not hidden by re-running until the "nicer" model won.

**What this result is not**: a real-world fraud-detection performance claim.
Every number in Phase 10's report is labelled as describing six generated
attack scenarios, not observed fraud, per CON-005 and the Brief's own
requirement that synthetic results never be presented as real-world ones.

## 5. Security review

`docs/security/threat-model.md` §6-7 is the full accounting. Headlines:

- **Two real defects found and fixed**, neither previously caught by three
  phases of resilience testing: `@fastify/rate-limit`'s `429` response was
  being silently converted to a generic `500` by the global exception filter
  (every client that got rate-limited saw a server error, not a retry signal);
  and three of the threat model's own claimed verifications (`ST-003`
  expired-token, `ST-004` forged-token, `ST-RATE-001` rate-limit-itself) had no
  test anywhere in the suite until this phase.
- **One dependency-update mistake caught by the test suite, not by inspection**:
  an attempted fix for a critical `@fastify/middie` finding typechecked cleanly
  but required a Fastify major version this project doesn't run, breaking
  every resilience test on the next real run. Reverted before being shipped —
  recorded as a demonstration of why "the build compiles" is not the same
  claim as "the system works."
- **Dependency audit**: 60 findings reduced to 2 low / 20 moderate / 20 high /
  0 critical via scoped version overrides, each verified against the full test
  suite, not assumed safe from the advisory text alone. The remaining findings
  were triaged individually — most require either Express-style middleware
  this codebase never registers, or are denial-of-service class findings in
  dev-tooling. The CI security gate (`pnpm audit --audit-level moderate`) would
  currently fail if run — reported as the real state, not hidden behind a
  passing local check.
- **One residual risk named, not fixed**: both HTTP services run with Fastify's
  `trustProxy: true` with no real reverse proxy in front yet, meaning a caller
  can spoof `X-Forwarded-For` to defeat per-client rate limiting entirely. This
  is an accepted consequence of a prototype with no gateway (the same gap
  named in ADR-004/ARCHITECTURE.md §14 and used, deliberately, by this
  project's own load-testing tooling) — not a new defect, but not previously
  named as a rate-limit bypass specifically.

## 6. Architecture decisions revisited

Full review: `docs/adr/PHASE_11_ADR_REVIEW.md`. Summary: the architectural
_shape_ of every ADR held — no decision needed reversing. Three ADRs had a
specific number or claimed test that turned out to be wrong, each named and
either fixed or left as a clearly-recorded finding for whoever picks this
project up next (ADR-002's Redis timeout, ADR-003's undelivered budget
assertion, ADR-006's performance assumption). ADR-004 and ADR-005 each had one
real bug in their own implementation, both found by testing and both fixed.

## 7. What is still genuinely open

Recorded here once, not scattered — each item traces to the phase document
that found it:

- **No gateway/load balancer exists** (`ARCHITECTURE.md` §14, still open).
  Blocks NFR-006 (instance-loss tolerance) and the literal "behind a load
  balancer" half of NFR-004; both have been worked around for testing
  purposes (direct multi-instance measurement, k6-side round robin) but
  neither is the production shape.
- **ADR-003's hot-path budget table does not match either the configured
  timeouts or an actual enforcing test** — named in the ADR review, not fixed,
  since fixing it means deciding which number is actually right, a decision
  this report does not make unilaterally.
- **ADR-006's write-path cost under load is the named root cause of every
  Phase 9 NFR miss**, and the only real fix (`synchronous_commit=off` or an
  equivalent durability tradeoff) is an architectural decision requiring its
  own ADR, not a Phase 11 patch.
- **The CI `pnpm audit` gate would fail today.** 40 findings remain above its
  own `moderate` threshold; all are triaged (§5) but not all are fixed.
- **No cryptographic chaining on the audit log; no request signing; no mTLS
  between internal services.** All three are named, accepted prototype-scope
  limitations in `threat-model.md` §5, not oversights.

## 8. Reproducing any claim in this report

Every number in this report traces to committed, raw evidence, not a summary
written after the fact:

- Load-test results: `docs/testing/test-results/perf-runs/*.result.json`, run
  via `pnpm test:load` (`scripts/run-load-tests.mjs`).
- ML evaluation: `ml/datasets/evaluation-report.json` (gitignored build
  output, regenerated deterministically by `pnpm ml:train --rows 100000 --seed
20261031`).
- Every resilience claim: `pnpm test:resilience`, against a real
  `docker compose --profile core --profile observability up -d` stack — no
  mocked failure anywhere in that suite.
- Every FR/NFR's actual verification status: `docs/requirements/
traceability-matrix.md`, filled from real test results, not aspirationally.
