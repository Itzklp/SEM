# Development Environment Audit

**Audit date:** 2026-09-07
**Audited machine:** Windows 10 Home Single Language 10.0.19045 (x64)
**Auditor:** Automated inspection via PowerShell 5.1 + manual review
**Repository root:** `d:\SEM`

This document records the **measured** state of the development machine at the time of
the audit. It is not a wish-list and not a plan. Every "Installed?" value below was
produced by actually invoking the tool. Values marked `-` mean the tool was not found on
`PATH`.

Re-run the audit at any time with:

```powershell
pwsh -File scripts/audit-environment.ps1
```

---

## 1. Detected hardware

| Property           | Measured value                       |
| ------------------ | ------------------------------------ |
| CPU                | Intel Core i5-9300H @ 2.40 GHz       |
| Physical cores     | 4                                    |
| Logical processors | 8                                    |
| Installed RAM      | 7.86 GB                              |
| Hypervisor present | Yes (WSL2 / Hyper-V platform active) |
| Free disk — `C:`   | 36.2 GB                              |
| Free disk — `D:`   | 121.3 GB                             |

**This hardware profile materially constrains the project.** See
[§5 Capacity analysis](#5-capacity-analysis-and-its-effect-on-the-nfrs) — it changes what
NFR-001 and NFR-002 can honestly claim, and that analysis is a required input to the
performance phase (Phase 9), not an afterthought.

---

## 2. Prerequisite matrix

### 2.1 Required — the project cannot proceed without these

| Tool           | Required version    | Why required                                                                                                                                                        | Installed?                      | Detected version | Installation instructions |
| -------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------- | ------------------------- |
| Git            | >= 2.40             | Version control, Conventional Commits history, branch workflow                                                                                                      | **YES**                         | 2.45.1.windows.1 | —                         |
| Node.js        | >= 22.0 (LTS)       | Runtime for all backend services and the build toolchain. v22 is required for stable `node:test`, native fetch and the V8 version our profiling assumptions rest on | **YES**                         | v22.13.0         | —                         |
| npm            | >= 10.0             | Bootstraps the package manager; used to install pnpm                                                                                                                | **YES**                         | 10.9.2           | —                         |
| pnpm           | >= 9.0              | Monorepo workspace manager. Chosen over npm workspaces for content-addressed storage — matters on a machine with 36 GB free on `C:`                                 | **YES** _(resolved 2026-09-07)_ | 9.15.9           | —                         |
| Docker Engine  | >= 24.0             | Runs Kafka, Redis, PostgreSQL, Prometheus and Grafana. Without it there is no infrastructure layer and no integration/E2E/load testing                              | **YES** _(resolved 2026-09-07)_ | 29.7.2           | —                         |
| Docker Compose | >= 2.20 (v2 plugin) | Single-command local orchestration of the full stack                                                                                                                | **YES** _(resolved 2026-09-07)_ | v5.5.1           | —                         |
| Python         | >= 3.11             | ML training, evaluation and the inference service (Phase 10 only)                                                                                                   | **YES**                         | 3.12.1           | —                         |
| pip            | >= 23.0             | Python dependency installation                                                                                                                                      | **YES**                         | 24.0             | —                         |
| k6             | >= 0.50             | Load testing. Produces the throughput/latency evidence required by NFR-001 and NFR-002                                                                              | **YES**                         | v1.3.0           | —                         |

### 2.2 Present and useful

| Tool          | Why relevant                                                                     | Installed? | Detected version                   |
| ------------- | -------------------------------------------------------------------------------- | ---------- | ---------------------------------- |
| VS Code       | Primary IDE; recommended extension set is committed at `.vscode/extensions.json` | **YES**    | 1.136.1                            |
| WSL2 (Ubuntu) | Docker Desktop backend; also gives a POSIX shell for scripts                     | **YES**    | WSL 2, Ubuntu, currently `Stopped` |
| Chocolatey    | Windows package manager — installed k6                                           | **YES**    | 2.4.3                              |
| winget        | Windows package manager — preferred route for Docker Desktop and GitHub CLI      | **YES**    | v1.29.290                          |
| curl          | Manual API probing, health checks, smoke scripts                                 | **YES**    | Present (bundled `curl.exe`)       |

### 2.3 Optional — deliberately **not** required

The following are commonly listed as fraud-platform prerequisites. We are **not**
installing them natively, and the reason is recorded here rather than left implicit
(see §4).

| Tool                       | Why it is optional                                                                                                                                    | Decision                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| PostgreSQL client (`psql`) | Only needed for ad-hoc DB inspection. The `postgres` container ships `psql`; migrations run through the application's migration runner, never by hand | Use `docker compose exec postgres psql`. Not installed natively.              |
| Redis CLI (`redis-cli`)    | Only needed for ad-hoc cache inspection                                                                                                               | Use `docker compose exec redis redis-cli`. Not installed natively.            |
| Kafka CLI tooling          | Topic creation is automated by `infrastructure/kafka/`; consumer-lag inspection is exposed as a Prometheus metric                                     | Use `docker compose exec kafka kafka-topics.sh`. Not installed natively.      |
| GitHub CLI (`gh`)          | Convenience for PRs and CI log inspection. Nothing in the build depends on it                                                                         | **NOT installed.** Optional. `winget install GitHub.cli`                      |
| GNU Make                   | Some teams use a `Makefile` as the command entry point. We use `pnpm` scripts instead, so the toolchain stays identical on Windows, macOS and CI      | **NOT installed.** Not required — `package.json` scripts are the entry point. |

---

## 3. Gaps that block progress

**Both gaps below are resolved as of 2026-09-07.** Kept here, marked resolved, as the
record of what was missing and how it was fixed — the point of an audit document is to
be a history, not just a current snapshot.

### GAP-001 — Docker Desktop ✅ **RESOLVED 2026-09-07**

1. **What was missing:** Docker Engine and the Docker Compose v2 plugin.
   No `docker` binary was on `PATH`. A stale `%LOCALAPPDATA%\Docker` directory existed,
   suggesting a previous install had been removed without leaving a working engine.
2. **Why it was needed:** Kafka, Redis, PostgreSQL, Prometheus and Grafana all run as
   containers. Without Docker the project could not start infrastructure, and therefore
   could not run integration tests, E2E tests, resilience tests or load tests.
3. **Resolution:** installed via `winget install -e --id Docker.DockerDesktop`, following
   [SETUP.md §2](./SETUP.md#2-installing-docker-desktop-required). Installed to
   `%LOCALAPPDATA%\Programs\DockerDesktop` (not the historical
   `C:\Program Files\Docker\Docker` default) — the user-level PATH entry
   (`%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin`) is what a _new_ shell picks
   up; a shell already open at install time needs to be restarted, which is why the
   very first verification attempt in this session failed with "docker not recognized"
   before a `$env:PATH` refresh confirmed the binary was in fact present and working.
4. **Verified:**
   ```
   docker --version        # Docker version 29.7.2, build a7dcaa6
   docker compose version  # Docker Compose version v5.5.1
   docker run --rm hello-world   # succeeded
   ```
5. **Outstanding from §2.3/§2.4 of SETUP.md** (disk relocation to `D:`, the `.wslconfig`
   memory cap) — not yet confirmed applied. Re-run
   `scripts/audit-environment.ps1` after applying them; the script does not currently
   check Docker's configured resource limits, only its presence.

### GAP-002 — pnpm ✅ **RESOLVED 2026-09-07**

1. **What was missing:** the `pnpm` package manager.
2. **Why it was needed:** workspace linking across `apps/*` and `packages/*`.
3. **Resolution:** `npm install -g pnpm@9`.
4. **Verified:** `pnpm --version` → `9.15.9`.

### Newly available, not required: Terraform

`terraform version` → `v1.13.0` is present on this machine, pre-existing or installed
alongside Docker tooling. **Not currently used.** Per an explicit team decision
recorded in [ARCHITECTURE.md §13](./architecture/ARCHITECTURE.md#13-cloud-deployment-posture-design-intent-only),
cloud infrastructure-as-code is deliberately deferred — the team develops and tests
entirely on this local machine for now and will scope an AWS (or equivalent) deployment
phase explicitly later. Noting its presence here only so its availability is not
mistaken for a decision to use it.

Trivial to resolve and does not require a restart.

---

## 4. Documented substitutions

Per the project's engineering rules, no native installation is silently substituted for
required infrastructure. The substitutions made, and their justification:

| Required capability            | Native install? | Substituted with                                          | Justification                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | --------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Kafka broker                   | No              | `apache/kafka` container, **KRaft mode, single broker**   | KRaft removes the ZooKeeper process entirely — roughly 400–600 MB of JVM saved on a 7.86 GB machine. It is still Apache Kafka with identical client semantics. Single broker means `replication.factor=1`, so **broker-loss durability cannot be demonstrated** on this machine; this limitation is recorded against NFR-004 rather than hidden. |
| Redis                          | No              | `redis:7-alpine` container                                | No behavioural difference for our access patterns.                                                                                                                                                                                                                                                                                               |
| PostgreSQL                     | No              | `postgres:16-alpine` container                            | Migrations are applied by the app's runner; the DB is never hand-edited.                                                                                                                                                                                                                                                                         |
| Prometheus / Grafana           | No              | containers, provisioned from `infrastructure/monitoring/` | Dashboards are committed as code, so they are reproducible.                                                                                                                                                                                                                                                                                      |
| `psql`, `redis-cli`, Kafka CLI | No              | `docker compose exec` into the respective container       | Guarantees the client version matches the server version. Avoids three extra native installs on a constrained disk.                                                                                                                                                                                                                              |

---

## 5. Capacity analysis and its effect on the NFRs

This section exists because the target NFRs were written before the hardware was known.
The numbers below are **estimates derived from component defaults**, not measurements —
they are labelled as such, and Phase 9 replaces them with measured values.

### 5.1 Resident memory of the full local stack

> **Superseded in part.** Kafka, PostgreSQL, Redis, Prometheus and Grafana were
> ESTIMATED here at Phase 0 and are now **MEASURED** (idle, container RSS only) —
> full detail, methodology and the Kafka startup issue found along the way:
> [docs/testing/test-results/phase2-infrastructure-report.md](../testing/test-results/phase2-infrastructure-report.md).
> The measured idle total for those five containers is **≈ 0.60 GB**, well under the
> estimate — expected, since idle is not the state the estimate was reasoning about.
> The comparison table in that report explains the gap and states plainly what is
> **still** ESTIMATED (WSL2 VM overhead, and everything below the line, none of which
> exists yet) versus what will be re-measured **under load** in Phase 9, which is the
> number that actually matters for RISK-001.

| Component                                        | Estimated RSS    | Basis                                                                                         |
| ------------------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------- |
| Kafka (KRaft, 1 broker)                          | 1.2–1.6 GB       | JVM heap 1 GB + off-heap; ESTIMATED — **idle MEASURED: 0.46 GB, see above**                   |
| PostgreSQL 16                                    | 300–500 MB       | default `shared_buffers` 128 MB + backends; ESTIMATED — **idle MEASURED: 0.02 GB**            |
| Redis 7                                          | 80–150 MB        | small keyspace; ESTIMATED — **idle MEASURED: 0.01 GB**                                        |
| Prometheus                                       | 250–400 MB       | 15 s scrape, short retention; ESTIMATED — **idle MEASURED: 0.03 GB**                          |
| Grafana                                          | 150–250 MB       | ESTIMATED — **idle MEASURED: 0.07 GB**                                                        |
| WSL2 VM overhead                                 | 300–500 MB       | ESTIMATED — not isolable via `docker stats`, still open                                       |
| `fraud-api` (per instance)                       | 120–200 MB       | Node.js baseline + heap; ESTIMATED — service doesn't exist yet (Phase 3)                      |
| `event-worker`                                   | 150–250 MB       | ESTIMATED — service doesn't exist yet (Phase 3)                                               |
| `review-api`                                     | 100–150 MB       | ESTIMATED — service doesn't exist yet (Phase 3)                                               |
| k6 at 2 000 TPS                                  | 200–400 MB       | ESTIMATED — Phase 9                                                                           |
| **Total (1 API instance, full observability)**   | **≈ 2.9–4.4 GB** | **Idle infra subtotal now MEASURED at ≈ 0.60 GB; full total remains ESTIMATED until Phase 9** |
| **Total (4 API instances — scaling experiment)** | **≈ 3.3–5.0 GB** |                                                                                               |

Against 7.86 GB installed (of which Windows itself typically holds 2–3 GB), the full
stack fits, but **without comfortable headroom**. This drives three concrete decisions
already reflected in the design:

- Docker Compose uses **profiles**, so observability and load-generation tiers can be
  brought up only when needed (`docs/SETUP.md §4`).
- Every container gets an explicit `mem_limit`, so an OOM is a diagnosable container
  failure rather than a machine freeze.
- Node services run with an explicit `--max-old-space-size` rather than letting V8 size
  the heap against total system memory.

### 5.2 CPU contention — the load-testing measurement problem

**This is the most important finding in this audit.**

The machine has 4 physical cores. During a load test, the following compete for them:

- k6 generating load (1–2 cores at target rate)
- the `fraud-api` instances under test
- Kafka, PostgreSQL, Redis
- Prometheus scraping, Grafana rendering
- Windows + WSL2

The load generator and the system under test **share the same CPU**. This is a textbook
measurement error: past a certain load, k6 and the API starve each other, and the
resulting latency figures measure _contention on this laptop_, not the platform's
capability.

**Consequences that must be stated explicitly in every performance report:**

1. Measured p99 latency at high load will be **pessimistic** and partly attributable to
   co-location. It is not a clean measurement of FraudGuard.
2. The 2 000 TPS target (NFR-001) is plausible on this hardware but **not yet
   demonstrated** — it stays labelled TARGET until Phase 9 produces a number.
3. The 10 000 and 20 000 TPS scenarios will almost certainly saturate **this laptop**
   before they saturate FraudGuard's architecture. Reporting "FraudGuard saturates at
   _N_ TPS" from such a run would be false. The honest claim is: _"On the reference
   hardware described in DEVELOPMENT_ENVIRONMENT.md §1, with load generated
   co-resident, the system saturated at N TPS; the bottleneck was identified as X."_
4. The **horizontal scaling experiment (1 → 2 → 4 → 8 instances)** is the part most
   damaged by this. With 4 physical cores, going beyond ~3 API instances adds no real
   parallelism and will show flat-to-negative scaling for reasons that have nothing to
   do with the architecture.

**Mitigations, in order of preference:**

| Option                                                                                                                                               | Effect                                                                                   | Cost                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------- |
| A. Run k6 from a second physical machine on the same LAN                                                                                             | Removes the co-location error entirely. The only way to get a clean number               | Requires a second machine; k6 install there |
| B. Pin containers and k6 to disjoint CPU sets (`cpuset`)                                                                                             | Bounds the interference and makes it _quantifiable_                                      | Reduces headroom for both sides             |
| C. Cap the scaling experiment at 1 → 2 → 3 instances and report per-core efficiency                                                                  | Keeps the scaling claim honest                                                           | Cannot demonstrate 8-instance scaling       |
| D. Report co-located results with the caveat, and additionally report the _server-side_ p99 measured inside the API (excluding client-side queueing) | Separates "how fast is the service" from "how fast is the round trip on a loaded laptop" | Two latency series to explain               |

**Recommendation:** adopt **B + C + D** as the baseline (they need no extra hardware),
and adopt **A** for the final headline numbers if a second machine can be borrowed for
an afternoon. This is a decision for the team; it is raised now because it changes what
Phase 9 can claim, not how Phase 9 is built.

### 5.3 Disk

`C:` has 36.2 GB free. Docker Desktop stores its WSL2 disk image under
`%LOCALAPPDATA%` on `C:` by default. Container images for Kafka, Postgres, Redis,
Prometheus and Grafana plus layers and volumes will consume roughly 4–8 GB and grow with
use. `D:` has 121.3 GB free.

**Action:** relocate the Docker WSL2 data disk to `D:` during installation.
Procedure in [SETUP.md §2.3](./SETUP.md#23-relocate-docker-data-to-d-strongly-recommended).

---

## 6. Audit summary

| Category                  | Status                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Repository                | Initialised at `d:\SEM`, branch `main`, previously empty — **no existing work was at risk**                                          |
| Toolchain — required      | **9 of 9 present.** Docker and pnpm resolved 2026-09-07 (GAP-001, GAP-002)                                                           |
| Toolchain — optional      | GitHub CLI and Make absent by choice; all DB/cache/broker CLIs delegated to containers                                               |
| Hardware                  | Functional but constrained. 4 cores / 7.86 GB drives compose profiles, memory limits, and a revised scaling-experiment scope         |
| Risk to NFR-001 / NFR-002 | **Open.** Targets are unchanged; the ability to _measure_ them cleanly on this machine is limited and mitigations are proposed above |
| Blocked phases            | **None.** Phase 2 (infrastructure) is now unblocked                                                                                  |

---

## 7. Reproducing this audit

`scripts/audit-environment.ps1` re-runs every detection in this document and prints a
table in the same shape. Run it after installing Docker to confirm GAP-001 is closed.
