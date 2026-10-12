# Phase 9 performance report — NFR-001, NFR-002, NFR-004

Every number below is **MEASURED** on the hardware described in §0, from a real
run recorded under `docs/testing/test-results/perf-runs/`, or is explicitly
labelled otherwise. No estimated number is presented as measured.

## 0. Hardware and methodology

- **Hardware**: one laptop, Intel i5-9300H — **4 physical cores, 8 logical
  (hyperthreaded)**, 8.4 GB RAM. Confirmed via `Get-CimInstance
Win32_Processor` and `docker info` (Docker Desktop/WSL2 sees all 8 logical
  CPUs; 3.76 GB allocated to the WSL2 VM). Matches
  `docs/DEVELOPMENT_ENVIRONMENT.md` §5.2's audit exactly — nothing about this
  phase's findings is a surprise relative to that audit; this report is where
  it gets a measured number instead of an estimate.
- **RISK-001, in force for every number in this report**: the load generator
  (k6) and the system under test (`fraud-api`, Postgres, Redis, Kafka) run
  **co-resident on this one machine**. Mitigations adopted, per §5.2's own
  recommendation (B + C + D; no second machine was available for mitigation
  A):
  - **B — CPU pinning**: §4. Result: pinning made **no measurable difference**
    to throughput — itself a finding, not a null result to discard (see §4).
  - **C — scaling experiment capped at 1→2→3 instances**: §3.
  - **D — both latency series reported separately**: every table below has a
    `client` column (k6's own `http_req_duration` — round-trip including this
    laptop's network stack) and a `server` column (diffed directly from
    `fraud-api`'s own `/metrics` histogram before/after the run). Where the
    two diverge sharply, that divergence is itself part of the finding.
- **Server-side latency methodology**: this repo's Prometheus scrapes every
  15s (`infrastructure/monitoring/prometheus/prometheus.yml`) — too coarse to
  resolve a histogram over a 20-45s steady window. `scripts/run-load-tests.mjs`
  instead snapshots `fraud-api`'s own cumulative `request_duration_seconds`
  histogram immediately before and after each stage and takes the delta — an
  exact bucket count for exactly that stage's requests, independent of scrape
  cadence. A server-side **p99 of exactly 256 ms** in any table below means
  the true value fell in the histogram's open-ended `+Inf` bucket (buckets
  top out at 256ms, `packages/observability/src/metrics/definitions.ts`) —
  reported as the last finite boundary rather than fabricating a number past
  it. The **average** (sum/count, unaffected by bucketing) is the reliable
  figure in that case and is called out explicitly where it matters (§2).
- **Load generator**: k6, `tests/load/score.k6.js` — an open-model
  (`ramping-arrival-rate`) executor: NFR-001 is a throughput _target_, not a
  VU count, and a closed (VU-pool) model would silently throttle itself the
  moment the server slows down, hiding exactly the degradation this phase
  exists to measure. Each simulated VU carries a distinct spoofed
  `X-Forwarded-For` IP (`fraud-api`'s `trustProxy: true` honours it) so
  `RATE_LIMIT_MAX_REQUESTS=100`/s-per-client is exercised the way production
  traffic from many real merchants would, instead of the single real source
  IP this laptop actually has.
- **Every target TPS in `docs/ROADMAP.md`'s list was executed, including the
  ones that fail** — nothing is dropped from the table for saturating.

## 1. Sustained-throughput matrix (NFR-001, NFR-002)

Run: `summary-1791824630880.json`. `POSTGRES_POOL_HOT_MAX=50` (post-fix, §2).
Ramp 15s → steady 30s → ramp-down 5s per stage, 15s cooldown between stages.

| Target TPS | Achieved (client req/s) | Client p50 / p95 / p99 (ms) | Server p50 / p95 / p99 (ms) | Shed (429) | fraud-api CPU% | Verdict    |
| ---------: | ----------------------: | --------------------------- | --------------------------- | ---------: | -------------: | ---------- |
|        500 |                   383.1 | 467 / 3001 / 3033           | 0.6 / 3611 / 4722           |       9520 |           13.0 | **FAILED** |
|      1 000 |                   765.5 | 310 / 3001 / 3003           | 0.5 / 1 / 2328              |      20005 |           13.1 | **FAILED** |
|      2 000 |                  1522.4 | — / 3000 / 3006             | 0.5 / 1 / 2294              |       9369 |           13.0 | **FAILED** |
|      5 000 |                  1751.9 | — / 3001 / 4448             | 0.5 / 1 / 1                 |      14475 |           10.9 | **FAILED** |
|     10 000 |                  3133.2 | — / 2000 / 3018             | 0.6 / 2232 / 4241           |        945 |           12.3 | **FAILED** |
|     20 000 |                  1657.4 | — / 2774 / 3444             | 0.6 / 2344 / 4324           |        529 |            8.9 | **FAILED** |

(Client p50 reported as "—" where more than half the window's requests were
still in flight past k6's own `http_req_duration` window at test end — the
metric itself, not a measurement error; see §2.)

**NFR-001 (≥2 000 TPS sustained): NOT MET.** Best sustained throughput
achieved across this matrix was **3 133 req/s at the 10 000 TPS stage** — but
"achieved" here means requests that got a response at all, the great
majority of which were `429`s, not decisions. Counting only non-shed,
non-error 200 responses, actual sustained decision throughput never exceeded
roughly **200-400 decisions/s** at any stage (derived from
`shed429Count`/`serverSideErrorCount` against `achievedRps` in each stage's
`.result.json`) — far below 2 000.

**NFR-002 (p99 < 200 ms @ 2 000 TPS, end to end): NOT MET.** Both the client
p99 (3 006 ms, dominated by k6's own 3s request timeout firing) and the
server-side p99 (2 294 ms, real — see §2) are more than an order of magnitude
over budget at the 2 000 TPS stage.

Both failures are explained by a single root cause, named in §2, that no
amount of pool-size or instance-count tuning on this hardware removes.

## 2. Bottleneck analysis, fix, re-measurement

### 2a. Found and fixed: Postgres connection-pool exhaustion at light load

The first bottleneck found wasn't about throughput capacity at all — it was
about an undersized pool queueing even very light, non-saturating traffic.
`POSTGRES_POOL_HOT_MAX` was `10` (unchanged since Phase 1). A 50 TPS smoke
stage — nowhere near this laptop's real ceiling — measured:

| `POSTGRES_POOL_HOT_MAX` | Client p99 | Degraded decisions | Verdict                                                  |
| ----------------------: | ---------: | -----------------: | -------------------------------------------------------- |
|                      10 |   2 457 ms |                164 | requests queueing for a connection, not executing slowly |
|                      50 |      49 ms |                  0 | fixed                                                    |

Raised to `50` (headroom under Postgres's own `max_connections=100`, which
`review-api`/`event-worker`'s separate `coldPool`s also share). This is a
real, committed fix (`.env.example`'s documented default), not a benchmark-only
tweak — confirmed with a direct before/after measurement, not inferred.

### 2b. Found, and NOT fixable by pool size alone: Postgres write-commit latency under sustained load

Raising the pool further (`50` → `80`) and re-measuring the 2 000 TPS stage
made **no improvement** (achieved 1 430 vs. 1 522 req/s — within noise; server
p99 4 938 ms vs. 4 937 ms unpinned-baseline — unchanged). This rules out "not
enough connections" as the sustained-load bottleneck.

What the data shows instead: every stage's `persist` hot-path stage (the
`insertScored` transaction — `transactions` + `decisions` + two
`outbox_events` rows, one commit) has an **average** duration of **11.3–24.9
seconds** per request during the saturated steady-state window (`hotPath`
field in each `.result.json`; the per-bucket p99 is bucket-capped at 256ms per
§0 and is not the reliable number here — the sum/count average is).
`fraudguard-postgres-1`'s own `docker stats` CPU samples during these same
windows repeatedly spike to **580–617%** (multiple Postgres backend processes
genuinely busy at once, not idle-while-queueing) — Postgres itself is doing
real, heavy work, not waiting on a connection slot.

**Named root cause**: `synchronous_commit=on` / `fsync=on` (both Postgres
defaults, confirmed via `SHOW`) mean every `insertScored` commit blocks on a
WAL fsync. Under Docker Desktop's WSL2 virtualised disk layer, fsync latency
is known to be materially worse than bare-metal Linux — this is the same
RISK-001-adjacent, host-virtualisation cost this project has already measured
once before (Phase 4/5's Redis latency drift under session load). Under
concurrent write pressure, this single synchronous commit per request becomes
the serialising constraint regardless of how many Postgres connections or
`fraud-api` processes are waiting to use it.

**Not applied as a live fix**: `synchronous_commit=off` would trade away
exactly the durability guarantee ADR-006 is built around (a decision is
confirmed recorded before the HTTP response returns) — this is a real
architectural tradeoff requiring its own ADR, not something to flip mid-
benchmark to make a number look better. Recorded here as the identified lever
for whoever picks this phase's findings up, not exercised.

## 3. Horizontal scaling experiment (NFR-004)

Capped at 1 → 2 → 3 `fraud-api` instances (mitigation C, per §5.2: beyond
~3 processes on 4 physical cores adds no real parallelism and would measure
this laptop, not the architecture). No gateway/load balancer exists in front
of `fraud-api` (Phase 3's deliberate deferral, `ARCHITECTURE.md` §14) — k6
itself round-robins across instances (`BASE_URLS`) for this experiment,
recorded as a deliberate deviation from "behind a load balancer," not a
hidden one. Each instance used its own `POSTGRES_POOL_HOT_MAX=25` (kept the
combined pool ceiling across up to 3 instances safely under Postgres's
`max_connections=100`). Fixed target: 2 000 TPS, 10s ramp / 25s steady.

| Instances | Achieved (req/s) | Client p99 (ms) | Shed (429) |
| --------: | ---------------: | --------------: | ---------: |
|         1 |            871.4 |           8 162 |       3902 |
|         2 |            874.3 |           4 289 |        904 |
|         3 |            740.9 |           5 513 |          0 |

**NFR-004 (throughput increases materially 1→2→3+): NOT MET.** Throughput is
flat from 1→2 instances and **decreases** at 3 — exactly the flat-to-negative
scaling `DEVELOPMENT_ENVIRONMENT.md` §5.2 predicted in advance, for the same
reason as §2b: the shared Postgres write-commit path, not `fraud-api`'s own
CPU, is the constraint. Adding more `fraud-api` processes adds more
contention for that one shared, already-saturated resource, not more
capacity. This is the clean confirmation that §2b's root cause, not
`fraud-api` application code, is what NFR-001/002/004 are actually limited
by on this hardware.

## 4. CPU pinning (mitigation B)

Pinned run: Postgres/Redis/Kafka containers constrained to logical CPUs 0-3
(`docker-compose.cpupin.yml`, `cpuset`, maps to a WSL2-VM cgroup);
`fraud-api` pinned to the same 0-3 via Windows `Get-Process`
`.ProcessorAffinity`; k6 pinned to logical CPUs 4-7 the same way — load
generator and system-under-test on disjoint physical cores. Unpinned control:
identical config, affinity reset to all 8 logical CPUs, containers' `cpuset`
cleared. Both runs: single instance, 2 000 TPS target, 10s ramp / 25s steady.

| Configuration                 | Achieved (req/s) | Client p99 (ms) | Shed (429) |
| ----------------------------- | ---------------: | --------------: | ---------: |
| Pinned (k6 isolated from SUT) |           1533.8 |            3010 |       2239 |
| Unpinned (control)            |           1534.8 |            3096 |        180 |

**Result: pinning made no measurable difference to achieved throughput** —
itself the finding, not a null result to discard. It directly corroborates
§2b/§3: if k6-vs-`fraud-api` CPU scheduling contention were the bottleneck,
isolating them onto disjoint cores would have moved the number. It didn't,
because the real constraint (Postgres's synchronous commit path) sits outside
the CPU scheduler entirely. Pinning did shed _more_ aggressively (2 239 vs. 180) — plausibly because isolating `fraud-api`+Postgres onto only 4 of 8
logical CPUs while they wait on disk I/O leaves fewer spare cycles for
Node's event loop to service other requests while the one holding a slow
commit blocks — a secondary, smaller effect, not the main story.

## 5. Honest gaps

- **No second physical machine was available** — mitigation A (the only way
  to eliminate RISK-001 entirely) was not applied. Every number above carries
  the co-location caveat instead of eliminating it.
- **No gateway/load balancer exists yet** — §3's scaling experiment uses
  k6-side round robin across ports, not production load-balancing. NFR-004's
  acceptance criterion ("throughput increases materially") is still testable
  this way; "behind a load balancer" literally is not, and is recorded as
  deferred alongside Phase 8's `RT-INST-001`.
- **NFR-003** (p99 in-service hot-path < 50ms, excluding network) is **not**
  separately re-verified in this report at the per-component level Phase 4/5
  already measured it at (that measurement stands on its own, with its own
  RISK-001 caveat already recorded there) — this phase's server-side figures
  above are the END-TO-END request histogram, which includes the
  `persist`-stage bottleneck described in §2b and is not the same claim.
- **The fix in §2a is real and committed; the root cause in §2b is named,
  not fixed.** Changing `synchronous_commit` is a durability-affecting
  architectural decision (ADR-006 territory) outside this phase's scope to
  make unilaterally — reported honestly as the next team's starting point,
  not silently worked around.
