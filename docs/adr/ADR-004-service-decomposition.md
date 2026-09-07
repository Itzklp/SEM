# ADR-004 — Four backend deployables, not seven microservices

**Status:** Accepted
**Date:** 2026-09-07
**Deciders:** Team 04
**Related:** ADR-003, CON-001, NFR-004, NFR-007

---

## Context

The original proposal sketch names seven services: `api-gateway`, `fraud-service`,
`feature-service`, `decision-service`, `audit-service`, `review-service`, `ml-service`.
That decomposition follows the *logical* components of the system, which is an intuitive
and common way to draw a distributed architecture — and, for this problem, the wrong one.

The project must demonstrate distributed-systems competence. It must also be completely
understood by three developers in one term (CON-001) and run on a 4-core / 7.86 GB
machine (CON-002). Those pull in opposite directions, and the resolution needs to be
argued rather than assumed in either direction.

The decisive question is not "what are the logical components?" but **"what must be able
to fail, scale, or be deployed independently?"** A network boundary buys exactly those
three properties, and charges latency, failure modes, operational weight and cognitive
load for them.

## Decision

**Four backend deployables plus one frontend.** A component becomes its own service only
where it has a genuinely different failure domain, scaling profile, or runtime.

| Deployable | Justification for a process boundary |
| --- | --- |
| **`fraud-api`** | The latency-critical hot path. Must scale horizontally and independently (NFR-004); it is the subject of the scaling experiment. Everything else is kept out of its process so nothing competes for its event loop |
| **`event-worker`** | Different failure domain and opposite scaling profile — throughput-oriented, latency-tolerant. A slow consumer must be incapable of affecting an authorization. Scales by partition count, not by request rate |
| **`review-api`** | **Bulkhead (NFR-007).** Analyst queries are heavy, unbounded and low-volume. In `fraud-api` they would contend for the same connection pool and event loop that authorizations need. One expensive case query must not raise authorization p99 |
| **`ml-service`** | Different runtime (Python). Isolation converts an ML failure into a *dependency* failure with a defined fallback (ADR-005), rather than an in-process crash. Also scales independently, since inference cost differs from request-handling cost |
| **`dashboard`** | Static frontend |

### Components that remain in-process, and why

| Proposed service | Actual home | Why a network boundary would be wrong |
| --- | --- | --- |
| `feature-service` | `packages/feature-store`, in `fraud-api` | On the read side this would be a **pure proxy in front of Redis**. It adds a hop (~1–5 ms plus its own tail) and a failure mode, in exchange for nothing — Redis is already a shared network service reachable by every instance. The genuinely separate concern is feature *writing*, which **is** separated, into `event-worker` |
| `decision-service` | `packages/domain`, in `fraud-api` | A pure function of (rule results, score, policy). No state, no I/O, microseconds of CPU. A network call to compute a pure function would add latency and a failure mode to the most critical path in the system to save nothing |
| Rule engine | `packages/domain`, in `fraud-api` | Same. Rules are *configuration*; reloading configuration does not require a separate process |
| `audit-service` | `event-worker` | It is a Kafka consumer. It is already asynchronous and already isolated — as a consumer, not as a synchronous service |
| `api-gateway` | Nginx container | Real infrastructure concern (TLS, rate limiting, load balancing), but not application code we should write |

**Logical separation is preserved.** Each of these is an independent package with an
explicit interface and its own test suite, with no dependency on the others' internals.
If a production deployment ever needed to extract one, the seam already exists — the
change would be transport, not design. We are choosing not to pay for a boundary we do
not currently need.

## Alternatives considered

### A. Seven microservices as originally sketched

- **Rejected on latency.** `feature-service` and `decision-service` sit directly in the
  hot path. Two additional hops at ~2–5 ms each (worse at the tail) against a 40 ms
  service budget is a 10–25% cost for zero architectural benefit.
- **Rejected on failure surface.** Two more services that can be down, slow, or
  misconfigured — each needing its own timeout, retry policy, circuit breaker, health
  check, dashboard and alert.
- **Rejected on capacity.** Seven Node processes at 120–200 MB each is 0.8–1.4 GB before
  any infrastructure, on a machine with 7.86 GB (CON-002).
- **Rejected on team capacity.** Seven services × (deployment + config + observability +
  integration tests + operational docs) for three developers in one term, and the goal is
  a system the team can explain *completely* (Brief §48).

### B. A single modular monolith

- **Genuinely tempting**, and rejected for one specific reason: it cannot demonstrate the
  properties the project is evaluated on. With everything in one process there is no
  independent horizontal scaling of the latency-critical component (NFR-004), no bulkhead
  between analyst and authorization load (NFR-007), and no way to show that consumer
  failure leaves authorization unaffected (NFR-005). The distribution here is not
  decorative; each boundary is exercised by a specific test.

### C. Three services (fold `review-api` into `fraud-api`)

- **The closest alternative.** Rejected because NFR-007 — hot-path isolation from
  analyst query load — is a stated requirement with a specific resilience test attached.
  Folding them together would mean either dropping that requirement or verifying it
  falsely. `review-api` is a small Node process sharing all the same packages, so its
  marginal cost is genuinely low.

## Consequences

### Positive

- Every service boundary has a one-sentence justification and a test that exercises it.
  This directly answers the "why does this component exist?" questions in Brief §48.
- The hot path stays short: one network dependency for features (Redis), one for
  scoring (only when ML is enabled), one write (Postgres).
- Fits the hardware with room for the 4-instance scaling experiment.
- Three developers can hold the whole system in their heads.

### Negative

- The architecture looks *less* distributed than a seven-service diagram. This is a
  presentational cost against an engineering benefit; the justification table above is
  the answer, and it is a stronger answer than a bigger diagram.
- `fraud-api` is a larger process containing several logical components. Mitigated by
  strict package boundaries and the architecture test from ADR-003.
- If a component later needs independent scaling, extraction is work — bounded work,
  because the seam exists, but not free.

### Neutral

- The package structure is deliberately more granular than the deployment structure. That
  is the point: it keeps future extraction cheap without paying for it now.
