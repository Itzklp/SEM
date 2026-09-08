# Phase 2 — Infrastructure: Measured Results

**Date:** 2026-09-08 · **Machine:** as described in [DEVELOPMENT_ENVIRONMENT.md §1](../../DEVELOPMENT_ENVIRONMENT.md#1-detected-hardware)
(Intel i5-9300H, 4 cores / 8 logical, 7.86 GB RAM) · **Docker:** 29.7.2, Compose v5.5.1

This is a **MEASURED** report — every number below came from an actual `docker compose
up` run on this machine, not an estimate. It replaces the corresponding rows of the
capacity analysis in [DEVELOPMENT_ENVIRONMENT.md §5.1](../../DEVELOPMENT_ENVIRONMENT.md#51-estimated-resident-memory-of-the-full-local-stack),
which is left in place (marked superseded below) rather than deleted, per the project's
rule that ESTIMATED and MEASURED are always distinguished, not silently swapped.

---

## 1. What was tested

```
pnpm docker:up          # core profile: postgres, redis, kafka, kafka-init
pnpm docker:up:obs      # + observability profile: prometheus, grafana
```

Verified, not assumed:

- Every container reports `healthy` on its Compose healthcheck.
- `kafka-init` creates all 12 catalogue topics (6 + their DLQs) with the retention
  values from [kafka-topics.md](../../architecture/kafka-topics.md), then exits 0.
- Prometheus self-scrape (`job=prometheus`) is `up`; the four application-service
  targets (`fraud-api`, `review-api`, `event-worker`, `ml-service`) correctly show
  `down` with a DNS-resolution error — **expected and correct**, since none of those
  services exist yet (Phase 3+). A green target here would have meant the scrape
  config was silently pointed at the wrong thing.
- Grafana's Prometheus datasource and the "Infrastructure Health" dashboard are
  present via provisioning, confirmed through the Grafana HTTP API — no manual UI
  step was involved (Phase 7 exit criterion, satisfied early since the mechanism is
  identical however many dashboards exist).

## 2. Startup time (MEASURED)

| Step                                                     | Time                                                                                                   | Notes                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `core` profile: all 4 containers → healthy               | **28.4 s**                                                                                             | Dominated by Kafka's KRaft storage format + JVM start; Postgres and Redis were healthy within ~6 s |
| `+observability` profile: prometheus + grafana → healthy | **~15 s** (isolated), 67 s wall-clock including Compose re-verifying already-healthy `core` containers | Grafana's own health endpoint was the long pole, at ~12 s after Prometheus was already healthy     |
| **Full stack, cold, from `docker compose ... up -d`**    | **≈ 45 s**                                                                                             | Sum of the above with no artificial waiting between profiles                                       |

**Target for the Phase 3+ developer inner loop:** infra startup should not be something
a developer waits on more than once a day — 45 s cold, and near-instant on a subsequent
`docker:up` once images are cached and volumes exist, comfortably clears that bar.

## 3. Memory (MEASURED — container RSS only, idle, no application traffic)

`docker stats --no-stream`, full stack (`core` + `observability`), immediately after
every healthcheck passed, before any transaction was ever sent (no services exist yet
to send one):

| Container                | Mem usage       | % of its `mem_limit` |
| ------------------------ | --------------- | -------------------- |
| `kafka`                  | **475.2 MiB**   | 39.6% of 1200m       |
| `grafana`                | **67.5 MiB**    | 22.5% of 300m        |
| `prometheus`             | **29.8 MiB**    | 7.5% of 400m         |
| `postgres`               | **21.9 MiB**    | 4.3% of 512m         |
| `redis`                  | **8.2 MiB**     | 3.2% of 256m         |
| **Total (5 containers)** | **≈ 602.6 MiB** |                      |

### Comparison against the Phase 0 estimate

| Component                        | ESTIMATED (Phase 0) | MEASURED (idle) |                                                                                                    |
| -------------------------------- | ------------------- | --------------- | -------------------------------------------------------------------------------------------------- |
| Kafka (KRaft, 1 broker)          | 1.2–1.6 GB          | **0.46 GB**     | Well under estimate — idle JVM heap (`-Xmx768m`) is mostly unused before any topic carries traffic |
| PostgreSQL 16                    | 300–500 MB          | **0.02 GB**     | Estimate assumed active backends/connections; idle with no app connected is far smaller            |
| Redis 7                          | 80–150 MB           | **0.008 GB**    | Same reason — near-empty keyspace                                                                  |
| Prometheus                       | 250–400 MB          | **0.03 GB**     | Short retention, tiny TSDB with 5 targets                                                          |
| Grafana                          | 150–250 MB          | **0.07 GB**     |                                                                                                    |
| **Subtotal, these 5 containers** | **~2.0–2.9 GB**     | **~0.60 GB**    |                                                                                                    |

**Read this correctly: the estimate was not wrong, it was measuring a different
state.** Phase 0's numbers were for a stack under load, with real connections, a
populated keyspace and topics carrying traffic — none of which exists yet. As Phase 3
onward adds real transactions, Kafka's heap and Postgres's buffer usage will grow
toward (and should be checked against) the original estimate. **This report will be
re-run under Phase 9 load and the comparison updated with a genuinely load-bearing
number** — that is the actual test of the capacity analysis, not this idle baseline.

**What this idle measurement does establish solidly:** the _floor_ is far more
comfortable than Phase 0 feared. With 602 MB in use against 7.86 GB total (and ~5 GB
allotted to WSL2 per `SETUP.md §2.4`), there is substantial headroom for `fraud-api`
instances, k6, and normal host-side work (IDE, browser) even before any tuning.

### Not yet measured (still ESTIMATED — tracked, not lost)

- WSL2 VM overhead itself (300–500 MB estimated) — not isolated by `docker stats`,
  which reports only container cgroup memory, not the VM's own footprint.
- `fraud-api` / `event-worker` / `review-api` per-instance memory — these services
  don't exist until Phase 3.
- k6 load-generator memory — Phase 9.
- Full-stack memory **under load** — the number that actually matters for the
  Phase 9 capacity conversation (RISK-001).

## 4. Restart and reset behaviour (MEASURED)

Both exit criteria requiring "survives restart" and "documented recovery from a full
reset" were run against the real stack, not assumed from the compose file's shape:

| Test                | Command                                                         | Result                                                                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restart survival    | `docker compose restart postgres redis kafka`                   | All three back to `healthy` within 21s. Kafka's 12 bootstrapped topics were confirmed present afterward via `kafka-topics.sh --list` — this checks **volume persistence**, not just that the process came back up |
| Full reset          | `docker compose --profile core --profile observability down -v` | All 5 named volumes and the network removed cleanly, no errors                                                                                                                                                    |
| Recovery from reset | `docker compose --profile core up -d` (from the state above)    | Healthy in **21 s** (faster than the original 28.4 s cold start — image layers already cached), topics recreated correctly by `kafka-init`                                                                        |

## 5. Issue found and fixed during this phase

**Kafka failed to start** on the first attempt with:
`IllegalArgumentException: advertised.listeners cannot use the nonroutable meta-address 0.0.0.0`

Root cause: in `apache/kafka`'s combined KRaft mode (`process.roles=broker,controller`),
the broker computes an "effective advertised address" for **every** listener declared
in `KAFKA_LISTENERS`, falling back to that listener's raw bind address for any listener
not present in `KAFKA_ADVERTISED_LISTENERS`. The `CONTROLLER` listener is correctly
_not_ advertised (it's reached via `controller.quorum.voters`, never by clients) — but
its bind address still has to pass the same "not 0.0.0.0" validation as a real
advertised address. Binding `PLAINTEXT` to `0.0.0.0` (normal — it has a real advertised
entry) while binding `CONTROLLER` to the container's own resolvable hostname (`kafka`,
via Docker's embedded DNS) resolved it. Full explanation is inline in `docker-compose.yml`.

This is exactly the kind of finding this report exists to surface — it cost real
debugging time and is now saved for the team and for anyone reproducing this setup.

## 6. Reproducing this report

```powershell
pnpm docker:reset        # clean slate
Measure-Command { pnpm docker:up }        # core profile timing
docker compose --profile core --profile observability up -d   # add observability
docker stats --no-stream
```

Health and topic verification:

```powershell
docker compose ps
docker logs fraudguard-kafka-init-1        # topic bootstrap output
curl http://localhost:9090/api/v1/targets  # Prometheus scrape targets
curl http://localhost:3030/api/health      # Grafana health
```
