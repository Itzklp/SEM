# ADR-003 — Hot-path / cold-path separation and the hot-path budget

**Status:** Accepted
**Date:** 2026-09-07
**Deciders:** Team 04
**Related:** ADR-001, ADR-002, ADR-004, ADR-006, NFR-002, NFR-003, RISK-004

---

## Context

NFR-002 requires p99 end-to-end latency below 200 ms at 2 000 TPS. Latency budgets are
not violated by a single bad decision; they are violated by accumulation. A synchronous
database call added "just for this one thing", a logging call that awaits a flush, an
extra service hop for tidiness — each is individually defensible and collectively fatal.

This is the most likely way for the project to fail (RISK-004), and it is a *process*
risk as much as a design one: the pressure to add hot-path work arrives later, during
feature development, when the architecture document is no longer being read.

We therefore need the hot path to be a **named, enforced constraint** rather than a
convention.

## Decision

**Every operation is explicitly classified as hot path or cold path, and the hot path
has enumerated rules enforced by automated test.**

### Hot path — everything between receiving an authorization request and responding

Permitted operations, exhaustively:

| # | Operation | Store | Budget |
| --- | --- | --- | --- |
| 1 | Authenticate + authorize | in-process | 2 ms |
| 2 | Schema validation | in-process | 1 ms |
| 3 | Idempotency check | Redis | included in 8 ms |
| 4 | Feature vector fetch (one pipelined call) | Redis | 8 ms |
| 5 | Rule evaluation | in-process, pure | 5 ms |
| 6 | Scoring provider | in-process (stub/rules) or HTTP (ML) | 15 ms |
| 7 | Score combination + policy decision | in-process, pure | 2 ms |
| 8 | Decision + outbox write, one transaction | PostgreSQL | 7 ms |
| | **Total service budget** | | **40 ms** |

**Prohibited on the hot path — no exceptions without a superseding ADR:**

- Any synchronous **read** from PostgreSQL.
- Any Kafka produce-and-await or consume.
- Any synchronous call to `review-api`, or to any service other than `ml-service`.
- Any unbounded call — every external call carries an explicit timeout.
- Any synchronous logging flush, or log writes that block on I/O.
- Any full-object serialisation of large payloads for audit purposes (that is the
  outbox's job, on the cold path).

### Cold path — everything after the response is returned

Audit persistence, feature aggregation, case creation, analytics projections, training
capture, model retraining, reporting. Runs in `event-worker`, in a separate process, with
its own resource envelope. May retry, may lag, may be slow.

### Enforcement

A convention that is not checked is a convention that decays. Therefore:

1. **Architecture test** — an automated test asserts that the `fraud-api` scoring module
   has no import path reaching a PostgreSQL *read* repository or a Kafka *consumer*.
   Violations fail CI.
2. **Budget assertion** — the server-side `fraud_score_duration_seconds` histogram is
   asserted against the 40 ms p99 budget in the integration suite, so a regression is
   caught at merge time and not in Phase 9.
3. **Per-stage timing** — each stage above is separately instrumented, so when the budget
   is breached the responsible stage is immediately identifiable rather than requiring
   bisection.
4. **PR checklist** — `CONTRIBUTING.md` requires any change touching the scoring path to
   state its latency impact.

## Alternatives considered

### A. No formal separation; optimise once measured

- **Rejected.** By Phase 9, hot-path violations would be spread across the codebase and
  entangled with features built on top of them. Removing a synchronous database read from
  a scoring path late in the project is a redesign, not an optimisation. The cost of the
  discipline now is far lower than the cost of retrofitting it.

### B. Separation as documentation only, without automated enforcement

- **Rejected.** With three developers working in parallel across the boundary, the
  document will not be reread at the moment the violating line is written. The
  architecture test is cheap and catches it at the only moment that matters.

### C. A tighter budget (e.g. 20 ms service time)

- **Rejected as premature.** 40 ms against a 200 ms end-to-end requirement leaves room
  absorbing the measurement noise that RISK-001 guarantees on this hardware. A budget
  that is breached constantly for environmental reasons teaches the team to ignore it.
  The budget can be tightened once measurements exist.

### D. Write the audit record synchronously for a stronger guarantee

- **Rejected.** It would add a second write and couple the response to audit-table
  contention. The outbox (ADR-006) provides the same durability guarantee within the
  transaction we are already performing.

## Consequences

### Positive

- The latency budget is a testable property, not an aspiration — regressions surface at
  merge time.
- When p99 degrades, per-stage instrumentation names the cause immediately.
- The classification gives a clear, mechanical answer to "where does this new feature
  go?", which is exactly what three parallel developers need.
- Cold-path work can be made arbitrarily thorough without any latency consequence.

### Negative

- Some functionality is harder to place. Anything wanting historical data during scoring
  must either have it precomputed into Redis by the cold path, or not exist. This is a
  real constraint on feature design and will occasionally be inconvenient — that is the
  intended trade.
- The architecture test needs maintenance as module structure evolves.
- Developers must think about path classification for every change, which is friction.
  Accepted deliberately.

### Neutral

- The 40 ms budget is a **TARGET**. Phase 9 replaces each row with a measured value, and
  the table is revised against evidence rather than defended.
