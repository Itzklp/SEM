# ADR-002 — Redis as the real-time feature store

**Status:** Accepted
**Date:** 2026-09-07
**Deciders:** Team 04
**Related:** ADR-001, ADR-003, FR-002, NFR-003

---

## Context

The hot path needs a behavioural feature vector for every transaction: velocity counters,
rolling aggregates, distinct-entity counts and risk lookups across the user, device,
merchant and IP dimensions. Representative features:

```
transaction_count_5m          amount_sum_1h            distinct_merchants_1h
transaction_count_1h          average_amount_24h       distinct_locations_24h
failed_transactions_10m       device_transaction_count merchant_risk_score
account_age_days              ip_risk_score            last_transaction_location
```

Access characteristics:

- **Read** on every authorization — so at 2 000 TPS, at least 2 000 reads/sec, each
  fetching 15–30 values.
- **Written** continuously by the cold path as new transactions are aggregated.
- Naturally **time-windowed** — a "count in the last 5 minutes" is meaningless without
  expiry.
- **Small per entity** — a few hundred bytes — but across many entities.
- Tolerant of **bounded staleness**: features updated a second ago are fine; features
  requiring a 40 ms read are not.

Within the 40 ms service budget (ARCHITECTURE.md §2), feature retrieval is allocated
**8 ms**.

## Decision

**Redis is the sole source of hot-path feature reads.** PostgreSQL is never read
synchronously during authorization.

- The entire feature vector is fetched in **one pipelined round trip**, not N round trips.
- Windowed counters use Redis-native structures with TTLs — atomic `INCR` on
  bucketed keys, sorted sets for sliding windows, HyperLogLog for distinct-entity
  cardinality where exactness is not required.
- Writes come from `event-worker` consuming Kafka. `fraud-api` writes only the
  idempotency marker.
- Feature definitions live in `packages/feature-store` as declarative descriptors, so a
  feature's key layout, window and default are defined in exactly one place.
- Every feature declares a **default used on miss or failure**, which is what makes the
  degraded-mode fallback (FR-016) possible rather than aspirational.

## Alternatives considered

### A. PostgreSQL with aggregate queries on the hot path

- **Rejected.** `SELECT count(*) ... WHERE user_id = ? AND ts > now() - interval '5 min'`
  is an index scan whose cost grows with the user's transaction history and whose tail
  latency depends on cache state, autovacuum and concurrent write load. At 2 000 TPS with
  ~20 features, this is thousands of aggregate queries per second against the same
  database handling the write path. p99 would be unpredictable by construction — the one
  property the hot path cannot tolerate.

### B. PostgreSQL with materialised views refreshed periodically

- **Rejected.** Refresh is expensive and periodic, so the staleness window is coarse
  (minutes). Velocity attacks operate inside that window, which defeats the point of
  computing velocity features at all.

### C. In-process in-memory cache in `fraud-api`

- **Fastest possible option, and rejected.** It breaks horizontal scaling (NFR-004): with
  N instances behind a load balancer, each holds a partial view, so the features a
  transaction sees depend on which instance received it. Velocity detection would degrade
  as we scale out — the exact opposite of the required behaviour. Also lost on restart.
- A small in-process cache for *slow-moving reference data* (merchant risk scores, policy
  config) is still worthwhile and is not excluded by this decision.

### D. A dedicated feature-store product (Feast, Tecton)

- **Rejected as over-engineering** under CON-001 and CON-006. These solve
  training/serving skew and feature governance across many teams — problems we do not
  have. They add substantial operational weight to a three-person prototype on 7.86 GB.

### E. Redis with RedisTimeSeries / RedisBloom modules

- **Rejected for now.** Requires Redis Stack, a larger image and a heavier runtime. Core
  Redis structures cover our windows adequately. Revisit only if a measured feature need
  proves otherwise.

## Consequences

### Positive

- Predictable sub-millisecond datastore latency; the 8 ms budget has real headroom.
- One pipelined round trip regardless of feature count — feature count grows without
  adding round trips.
- Native TTL means window expiry is free rather than a cleanup job.
- Atomic counters make concurrent updates from multiple consumers correct without locks.
- Shared across all `fraud-api` instances, so scaling out does not degrade feature
  quality (unlike option C).

### Negative

- **Redis becomes a hot-path dependency.** Mitigated by the degraded mode in ADR-005:
  every feature has a documented default, and a Redis outage produces cautious-open
  decisions rather than errors. This is explicitly tested (NFR-005).
- **Not durable by default.** Acceptable, because features are *derived* state: they can
  be rebuilt by replaying Kafka. That rebuild path must actually be implemented and
  tested, not assumed — tracked as a Phase 4 deliverable.
- Memory grows with tracked entities. Bounded by TTLs and a documented maximum keyspace;
  `maxmemory` plus an eviction policy is configured explicitly rather than left at the
  default.
- Feature values may be up to one relay+consumer cycle stale (target: sub-second).
  Accepted under NFR-012.

### Neutral

- Because features are behind a `FeatureStore` port in `packages/feature-store`, unit
  tests use an in-memory implementation and need no Redis. This keeps the base of the
  test pyramid fast (Brief §26).
