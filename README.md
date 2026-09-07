# FraudGuard

**A real-time distributed platform for payment fraud detection and decisioning.**

Team 04 · Department of Computer Science and Information Systems, BITS Pilani
Dalsania Kalpkumar Pradipkumar (2025H1030209P) · Milap Chaudhary (2025H1030207P) ·
Lokesh Patil (2025H1030054P)

---

## What this is

FraudGuard evaluates payment authorization requests in real time and returns
`ALLOW`, `REVIEW` or `BLOCK`, combining streaming behavioural features, deterministic
rules and a pluggable risk-scoring provider.

**The engineering problem is not fraud classification.** It is this:

> How do we process thousands of authorization requests per second, produce a reliable
> decision inside a strict latency budget, and keep working when parts of the system
> fail?

That framing drives every decision in [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md).

---

## Current status

**Phase 0 complete — no application code exists yet.** This is deliberate: architecture
and contracts come before implementation, and ML comes last.

| Phase | Status |
| --- | --- |
| 0 — Environment and repository | ✅ Complete (⚠️ Docker installation pending) |
| 1 — Architecture and domain | ⬜ Next |
| 2 — Infrastructure | 🔒 Blocked on Docker |
| 3–9 — Ingestion → performance | ⬜ Planned |
| 10 — Machine learning | ⬜ Planned (**last**, by design) |
| 11 — Hardening | ⬜ Planned |

Detail: [docs/ROADMAP.md](docs/ROADMAP.md)

### ⚠️ Before you can run anything

Two prerequisites are missing on the reference machine:

```powershell
npm install -g pnpm@9                              # GAP-002
winget install -e --id Docker.DockerDesktop        # GAP-001 — blocking
```

Docker requires a reboot and **resource limits** — a 7.86 GB machine will swap without
them. Follow [docs/SETUP.md §2](docs/SETUP.md#2-installing-docker-desktop-required)
rather than installing ad hoc.

Verify at any time:

```powershell
pwsh -File scripts/audit-environment.ps1
```

---

## Performance targets

**These are targets. Nothing has been measured yet.** Per project rule, no number is
presented as achieved until a reproducible test has produced it.

| Metric | TARGET | MEASURED |
| --- | --- | --- |
| Throughput | ≥ 2 000 TPS | — |
| End-to-end latency | p99 < 200 ms @ 2 000 TPS | — |
| In-service latency | p99 < 50 ms | — |
| Horizontal scaling | Throughput rises with instance count | — |

> **Measurement caveat.** The load generator runs on the same 4-core machine as the
> system under test, so high-load latency figures will be pessimistic and partly reflect
> CPU contention rather than the platform. This is documented and mitigated rather than
> ignored — [DEVELOPMENT_ENVIRONMENT.md §5.2](docs/DEVELOPMENT_ENVIRONMENT.md#52-cpu-contention--the-load-testing-measurement-problem).

---

## Architecture in brief

Two paths, deliberately separated:

**Hot path** (synchronous, latency-critical) — request → auth → validate → features from
**Redis** → rules → scoring provider → decision → respond. No Kafka. No synchronous
PostgreSQL reads.

**Cold path** (asynchronous) — decision written to a transactional **outbox** → relayed
to **Kafka** → consumed for audit, feature updates, case creation and analytics.

```
   Gateway ──▶ fraud-api ──▶ Redis          (features, hot)
                   │
                   ├──▶ ml-service          (Phase 10, behind a circuit breaker)
                   │
                   └──▶ PostgreSQL          (decision + outbox, one transaction)
                             │
                             └──▶ Kafka ──▶ event-worker ──▶ audit · features · cases
```

Four backend deployables (`fraud-api`, `event-worker`, `review-api`, `ml-service`) plus a
React dashboard — **not** seven microservices, for reasons argued in
[ADR-004](docs/adr/ADR-004-service-decomposition.md).

---

## Two rules that shape everything

**1. ML is last.** The system must be complete, tested and measured *without* it. A
stable `FraudScoringProvider` interface exists from Phase 5, with stub and rule-based
implementations. `MLScoringProvider` arrives in Phase 10 as a configuration change — the
decision engine, API contract and audit schema do not move. That also makes the eventual
ML-versus-baseline comparison a controlled experiment.

**2. Claims must be measured.** TARGET, MEASURED, ESTIMATED and ASSUMED are labelled
distinctly everywhere in this repository. A test that fails is reported as failing.

---

## Documentation

| Document | What it covers |
| --- | --- |
| [SETUP.md](docs/SETUP.md) | Getting a machine running |
| [DEVELOPMENT_ENVIRONMENT.md](docs/DEVELOPMENT_ENVIRONMENT.md) | Measured environment audit, capacity analysis, gaps |
| [ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) | C4 views, hot/cold paths, failure behaviour, patterns |
| [requirements.md](docs/requirements/requirements.md) | FR/NFR baseline, assumptions, constraints, risks |
| [traceability-matrix.md](docs/requirements/traceability-matrix.md) | Requirement → design → code → test → result |
| [ROADMAP.md](docs/ROADMAP.md) | Phases, deliverables, exit criteria |
| [TEAM_TASK_BREAKDOWN.md](docs/TEAM_TASK_BREAKDOWN.md) | Three-developer allocation |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Standards and Definition of Done |
| [SECURITY.md](SECURITY.md) | Security posture |

### Architecture decision records

| ADR | Decision |
| --- | --- |
| [ADR-001](docs/adr/ADR-001-event-driven-architecture.md) | Kafka for async propagation, **never** in the authorization path |
| [ADR-002](docs/adr/ADR-002-redis-feature-store.md) | Redis as the sole hot-path feature store |
| [ADR-003](docs/adr/ADR-003-hot-path-design.md) | Hot/cold separation, with an enforced latency budget |
| [ADR-004](docs/adr/ADR-004-service-decomposition.md) | Four deployables, not seven microservices |
| [ADR-005](docs/adr/ADR-005-degradation-policy.md) | Per-dependency fail-open/fail-closed policy |
| [ADR-006](docs/adr/ADR-006-transactional-outbox.md) | Transactional outbox for decision events |

---

## Technology, and why

Every component has a documented reason. Nothing is here to make the diagram look
impressive.

| Technology | Why |
| --- | --- |
| **Node.js 22 + TypeScript** | Non-blocking I/O suits a latency-critical, I/O-bound path; strict typing carries the contracts |
| **NestJS + Fastify** | DI makes the provider/rule substitution testable; Fastify is the faster adapter |
| **Redis** | Sub-millisecond hot-path feature reads with native TTL and atomic counters — [ADR-002](docs/adr/ADR-002-redis-feature-store.md) |
| **PostgreSQL** | Durable, relational, queryable state. Off the hot path — [ADR-003](docs/adr/ADR-003-hot-path-design.md) |
| **Kafka (KRaft)** | Durable async propagation with replay and independent consumers — [ADR-001](docs/adr/ADR-001-event-driven-architecture.md). KRaft to avoid a second JVM on 7.86 GB |
| **Prometheus + Grafana + OpenTelemetry** | Golden signals, distributed tracing, dashboards as code |
| **Pino** | Structured JSON logs with low overhead on the hot path |
| **k6** | Load testing that produces the evidence NFR-001/002 require |
| **Python + scikit-learn / XGBoost** | Phase 10 only |

---

## Data

**All data is synthetic.** No real customer, cardholder or payment data is used anywhere.
Card numbers are never accepted or stored — only synthetic tokenised references.
Identifiers take the form `user_123`, `merchant_456`, `device_789`.

The generator in `packages/testkit` is **seeded and deterministic**: the same seed
produces an identical event sequence, which is what makes performance and detection
results reproducible.

---

## Quick start (once prerequisites are installed)

```powershell
pnpm install
Copy-Item .env.example .env
pnpm docker:up          # core infrastructure
pnpm db:migrate
pnpm dev
```

Full instructions and the command reference: [docs/SETUP.md](docs/SETUP.md).

---

## Licence and academic context

Academic prototype developed for coursework at BITS Pilani. Not intended for production
use and not certified against any payment-industry standard.
