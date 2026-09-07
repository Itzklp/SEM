# ADR-005 — Per-dependency degradation policy (fail-open vs fail-closed)

**Status:** Accepted
**Date:** 2026-09-07
**Deciders:** Team 04
**Related:** ADR-002, ADR-003, FR-016, NFR-005, NFR-008

---

## Context

FR-016 requires graceful degradation. "Graceful" is not self-defining: for a fraud
system, the choice between failing open (approve when uncertain) and failing closed
(reject when uncertain) is a **business and security trade-off with real money and real
customers on either side**.

- **Fail open** — a fraud outage becomes a fraud *window*. Attackers probe for exactly
  this, and an outage that reliably produces approvals is an incentive to cause outages.
- **Fail closed** — a cache hiccup declines legitimate customers. At payment scale, a
  few minutes of blanket declines is a serious commercial and reputational event, and it
  converts a partial failure into a total one.

A single global policy is wrong because the dependencies are not equivalent. Losing
Redis costs us *signal quality*. Losing PostgreSQL costs us *the audit record*. Those
should not produce the same behaviour.

The decision must also be *visible*: a degraded decision that looks identical to a
healthy one is a silent failure, which is worse than either policy.

## Decision

**Degradation policy is defined per dependency, according to what capability is lost.
Every degraded decision is explicitly flagged, persisted and exported as a metric.**

### Policy table

| Dependency | Capability lost | Policy | Behaviour |
| --- | --- | --- | --- |
| **Redis** | Behavioural features (velocity, aggregates, history) | **Cautious-open** | Score using transaction-intrinsic rules only, using each feature's declared default. Widen the `REVIEW` band by lowering the `BLOCK` threshold and the `ALLOW` ceiling. Flag `degraded`, reason `FEATURES_UNAVAILABLE` |
| **ML provider** | Learned risk probability | **Fallback** | Circuit breaker opens, `RuleBasedScoringProvider` takes over. Rules are a complete scorer, so signal is reduced, not absent. Flag `degraded`, reason `ML_UNAVAILABLE` |
| **Kafka** | Async propagation | **Invisible** | Hot path never touched Kafka. Outbox rows accumulate; relay retries with backoff and drains on recovery. Not a degraded decision |
| **PostgreSQL** | Durable record of the decision | **Fail closed** | Return `503` with `Retry-After`. Do **not** return a decision |
| **`fraud-api` instance** | Capacity | **Transparent** | Health check ejects it at the gateway; stateless, so traffic simply moves |
| **`event-worker`** | Cold-path processing | **Deferred** | Lag grows, hot path unaffected, resumes from committed offsets |
| **Overload** | Ability to meet the latency budget | **Shed** | Rate limit at the gateway; shed above a concurrency ceiling with `429` and `Retry-After` |

### Why PostgreSQL is the sole fail-closed case

Redis loss degrades *how well* we decide. PostgreSQL loss means we cannot record *that*
we decided. For a financial system, an unrecorded decision is unauditable and
irreproducible: we could not explain it to a customer, an analyst or an auditor, and the
transaction would be invisible to every downstream process. Returning `503` — an honest
"ask again shortly", which upstream gateways are built to handle — is better than
producing an answer that leaves no trace.

### Why Redis is cautious-open rather than fail-closed

Blanket-declining every payment because a cache is unavailable converts a degraded
service into a total outage, with immediate commercial damage. But plain fail-open is a
standing invitation to induce the outage. **Cautious-open** is the middle position:
transactions that intrinsic rules can clear still clear; everything ambiguous is pushed
into `REVIEW` rather than approved. Risk is shifted to human reviewers instead of
accepted blindly.

This has a cost that must be planned for, not discovered: a Redis outage under load will
flood the review queue. Therefore review-queue depth is a monitored, alertable signal,
and the degradation policy includes a documented operator action (temporarily raise the
`REVIEW` threshold, accepting more risk, if the queue becomes unworkable). That is an
operational decision made by a human with context — which is the right place for it.

### Visibility requirements

Non-negotiable, because a silent degradation is the worst of both policies:

1. Every degraded decision carries `degraded: true` and a machine-readable reason code in
   the API response.
2. The flag and reason are persisted with the decision, so historical analysis can
   separate degraded from healthy decisions.
3. `fraud_decisions_total` is labelled by `degraded` and `reason`, making the degraded
   proportion a dashboard panel and an alert threshold.
4. Entering and leaving degraded mode is logged at `warn` with the dependency named.
5. `/api/v1/health` reports per-dependency status, so degradation is visible before a
   human notices decisions changing.

### Resilience patterns applied

| Pattern | Applied to | Configuration |
| --- | --- | --- |
| Timeout | Every external call | Redis 20 ms · ML 30 ms · Postgres 100 ms. All below the stage budgets in ADR-003 |
| Circuit breaker | ML provider | Opens after 5 consecutive failures or a 50% error rate over 20 requests; half-open probe after 10 s |
| Retry | **Cold path only** | Exponential backoff with full jitter, max 3 attempts. **No retries on the hot path** — a retry inside a 40 ms budget consumes it |
| Bulkhead | Connection pools | Separate pools for hot path and cold path; `review-api` is a separate process |
| Rate limiting | Gateway | Per-client token bucket |
| Load shedding | `fraud-api` | Concurrency ceiling; `429` beyond it |

**On retries.** Retrying a hot-path call is almost always wrong here: the budget does not
allow it, and retrying into a struggling dependency is how a slowdown becomes an outage
(retry storms). The hot path fails fast to its fallback. Only the cold path retries, and
only with jittered backoff and a bounded attempt count.

## Alternatives considered

### A. Global fail-open

- **Rejected on security.** It creates a reliable exploitation window and an incentive to
  attack availability in order to defeat fraud controls (NFR-008).

### B. Global fail-closed

- **Rejected on availability and proportionality.** Declining all payments because a
  cache is down is a self-inflicted total outage. It also treats a signal-quality loss as
  equivalent to an auditability loss, which they are not.

### C. Fail-closed on Redis, open elsewhere

- **Rejected.** Redis is precisely the dependency where partial function remains useful.
  Intrinsic rules still catch a meaningful class of fraud without any feature data.

### D. Serve stale features from a local cache when Redis is down

- **Deferred, not rejected.** Genuinely attractive: it would preserve more signal during
  an outage. Not adopted now because it adds a second feature-freshness regime to reason
  about, and stale velocity counters can be actively misleading (an attacker's burst is
  invisible in a stale window). Revisit in Phase 11 with measurements. Recorded here so
  the option is not lost.

## Consequences

### Positive

- Each policy is justified by the specific capability lost, not by a blanket rule.
- Degradation is observable, measurable and alertable rather than silent.
- Directly testable: every row is a resilience test case (NFR-005), and three are project
  demos.
- The security trade-off is documented, so the team can defend it under questioning —
  which is a stated goal of the project.

### Negative

- More implementation complexity than one global policy: per-dependency handling, a
  degraded-mode threshold set, and the flag threaded through response, persistence and
  metrics.
- Cautious-open on Redis will flood the review queue under a sustained outage. Mitigated
  by monitoring and a documented operator action, but not eliminated.
- The degraded threshold set is a second policy configuration to tune and test.

### Neutral

- Thresholds and timeouts here are **initial values**, not tuned ones. Phase 9 and
  Phase 11 revise them against measurements, and any revision is recorded.
