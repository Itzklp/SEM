# FraudGuard

**A real-time distributed platform for payment fraud detection and decisioning.**

Team 04 · Department of Computer Science and Information Systems, BITS Pilani
Dalsania Kalpkumar Pradipkumar (2025H1030209P) · Milap Chaudhary (2025H1030207P) ·
Lokesh Patil (2025H1030054P)

---

## What this is

FraudGuard evaluates payment authorization requests in real time and returns
`ALLOW`, `REVIEW` or `BLOCK`, combining streaming behavioural features, deterministic
rules and a pluggable risk-scoring provider. A browser dashboard (`apps/web`) sits on
top for two kinds of user: an ordinary customer can send a practice payment and watch
it get decided, and an admin can check system health and run the real test suites,
both against the live stack, not a mock.

**The engineering problem is not fraud classification.** It is this:

> How do we process thousands of authorization requests per second, produce a reliable
> decision inside a strict latency budget, and keep working when parts of the system
> fail?

That framing drives every decision in [docs/architecture/architecture.md](docs/architecture/architecture.md).

---

## Current status

**All eleven phases are complete.** Architecture and contracts came before
implementation, rules came before the model, and every claim below is measured, not
asserted — the full breakdown, including what was deliberately deferred and the real
bugs found along the way, is in [docs/final-report.md](docs/final-report.md).

| Phase                          | Delivered                                                       | Status |
| ------------------------------ | --------------------------------------------------------------- | ------ |
| 0 — Environment and repository | Environment audit, requirements baseline, ADRs 001-006          | ✅     |
| 1 — Architecture and domain    | Contracts, domain model, OpenAPI spec, toolchain                | ✅     |
| 2 — Infrastructure             | Docker stack: Postgres, Redis, Kafka KRaft, Prometheus, Grafana | ✅     |
| 3 — Ingestion                  | `fraud-api` pipeline, JWT auth, idempotency                     | ✅     |
| 4 — Feature store              | 11 real behavioural features over Redis                         | ✅     |
| 5 — Decisioning                | Rule engine, score combiner, decision engine — zero ML          | ✅     |
| 6 — Review and audit           | Transactional outbox, `event-worker`, `review-api`              | ✅     |
| 7 — Observability              | Metrics, Jaeger tracing, dashboards, alert rules                | ✅     |
| 8 — Resilience                 | Real-outage tests, contract + end-to-end suites                 | ✅     |
| 9 — Performance                | k6 load matrix 500–20,000 TPS, bottleneck analysis              | ✅     |
| 10 — Machine learning          | Model comparison, `MLScoringProvider`, model registry           | ✅     |
| 11 — Hardening                 | Security review, dependency audit, ADR review, final report     | ✅     |

Also built, outside the eleven numbered phases: `apps/web`, the browser dashboard
described above.

---

## Try it

```powershell
pnpm install
Copy-Item .env.example .env
pnpm docker:up          # core infrastructure: Postgres, Redis, Kafka
pnpm db:migrate
pnpm dev                # starts every service, including apps/web
```

Open http://localhost:5173 and sign in — two seeded accounts, password
`fraudguard-demo` for both:

| Account                   | Can do                                                                |
| ------------------------- | --------------------------------------------------------------------- |
| `customer@fraudguard.dev` | Practice a payment — a real request to `fraud-api`'s scoring endpoint |
| `admin@fraudguard.dev`    | Also: view system health, trigger and watch real test suites run      |

Full prerequisites and command reference: [docs/setup.md](docs/setup.md). The web
app specifically: [apps/web/README.md](apps/web/README.md).

---

## Performance: targets, and what was actually measured

Every number below comes from a real, reproducible k6 run against the live stack —
never asserted without a test that produced it. The honest result: **this platform
does not meet its own throughput and latency targets on the laptop it was developed
and measured on**, and the reason is identified, not guessed — see
[docs/final-report.md §3](docs/final-report.md#3-the-central-honest-finding) and
[docs/testing/test-results/performance-report.md](docs/testing/test-results/performance-report.md)
for the full chain of evidence.

| Metric                                   | TARGET                               | MEASURED                                                                         |
| ---------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| Throughput (NFR-001)                     | ≥ 2,000 TPS                          | **NOT MET** — 3,133 req/s best case, but already degraded well before that point |
| End-to-end latency @ sustainable rate    | p99 < 200 ms                         | **MET** — p99 ≈ 50 ms at the 20 TPS rate this hardware actually sustains cleanly |
| End-to-end latency @ 2,000 TPS (NFR-002) | p99 < 200 ms                         | **NOT MET** — server-side p99 2,294 ms                                           |
| Horizontal scaling (NFR-004)             | Throughput rises with instance count | **NOT MET** — went flat, then negative, 1→2→3 instances                          |

Three independent experiments converge on one root cause, not application code: this
laptop's WSL2-virtualised disk makes Postgres's synchronous-commit write path (the
transactional outbox's own `INSERT`, [ADR-006](docs/adr/ADR-006-transactional-outbox.md))
far more expensive under sustained concurrent load than the architecture's own budget
assumed. The correctness guarantee the outbox buys — zero lost events across every
outage test this project ran — held throughout; it's the performance cost of the
mechanism that buys it that was wrong, by three to four orders of magnitude, on this
specific hardware. Full root-cause chain:
[docs/adr/phase-11-review.md](docs/adr/phase-11-review.md).

---

## Architecture in brief

Two paths, deliberately separated:

**Hot path** (synchronous, latency-critical) — request → auth → validate → features from
**Redis** → rules → scoring provider → decision → respond. No Kafka. No synchronous
PostgreSQL reads.

**Cold path** (asynchronous) — decision written to a transactional **outbox** → relayed
to **Kafka** → consumed for audit, feature updates, case creation and analytics.

```
   apps/web ──▶ fraud-api ──▶ Redis          (features, hot)
                   │
                   ├──▶ ml-service          (Phase 10, behind a circuit breaker)
                   │
                   └──▶ PostgreSQL          (decision + outbox, one transaction)
                             │
                             └──▶ Kafka ──▶ event-worker ──▶ audit · features · cases
```

Four backend deployables (`fraud-api`, `event-worker`, `review-api`, `ml-service`) plus a
React dashboard (`apps/web`) — **not** seven microservices, for reasons argued in
[ADR-004](docs/adr/ADR-004-service-decomposition.md).

---

## Two rules that shaped everything

**1. ML is last.** The system had to be complete, tested and measured _without_ it
first. A stable `FraudScoringProvider` interface existed from Phase 5, with stub and
rule-based implementations; `MLScoringProvider` arrived in Phase 10 as a configuration
change — the decision engine, API contract and audit schema never moved. That also
made the eventual ML-versus-baseline comparison a controlled experiment, not a
retrofit.

**2. Claims must be measured.** TARGET, MEASURED, ESTIMATED and ASSUMED are labelled
distinctly everywhere in this repository. A test that fails is reported as failing —
including, in the end, three of this project's own NFRs.

---

## Documentation

| Document                                                           | What it covers                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------- |
| [final-report.md](docs/final-report.md)                            | Whole-project synthesis — start here                  |
| [demo-script.md](docs/demo-script.md)                              | Eight rehearsed, reproducible demos                   |
| [setup.md](docs/setup.md)                                          | Getting a machine running                             |
| [development-environment.md](docs/development-environment.md)      | Measured environment audit, capacity analysis         |
| [architecture.md](docs/architecture/architecture.md)               | C4 views, hot/cold paths, failure behaviour, patterns |
| [requirements.md](docs/requirements/requirements.md)               | FR/NFR baseline, assumptions, constraints, risks      |
| [traceability-matrix.md](docs/requirements/traceability-matrix.md) | Requirement → design → code → test → result           |
| [roadmap.md](docs/roadmap.md)                                      | Phases, deliverables, exit criteria, what shipped     |
| [team-task-breakdown.md](docs/team-task-breakdown.md)              | Three-developer allocation                            |
| [threat-model.md](docs/security/threat-model.md)                   | Security review, verified findings, dependency audit  |
| [CONTRIBUTING.md](CONTRIBUTING.md)                                 | Standards and Definition of Done                      |
| [SECURITY.md](SECURITY.md)                                         | Security posture                                      |

### Architecture decision records

| ADR                                                      | Decision                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| [ADR-001](docs/adr/ADR-001-event-driven-architecture.md) | Kafka for async propagation, **never** in the authorization path |
| [ADR-002](docs/adr/ADR-002-redis-feature-store.md)       | Redis as the sole hot-path feature store                         |
| [ADR-003](docs/adr/ADR-003-hot-path-design.md)           | Hot/cold separation, with an enforced latency budget             |
| [ADR-004](docs/adr/ADR-004-service-decomposition.md)     | Four deployables, not seven microservices                        |
| [ADR-005](docs/adr/ADR-005-degradation-policy.md)        | Per-dependency fail-open/fail-closed policy                      |
| [ADR-006](docs/adr/ADR-006-transactional-outbox.md)      | Transactional outbox for decision events                         |
| [phase-11-review.md](docs/adr/phase-11-review.md)        | Every ADR above, revisited against what was actually measured    |

---

## Technology, and why

Every component has a documented reason. Nothing is here to make the diagram look
impressive.

| Technology                               | Why                                                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Node.js 22 + TypeScript**              | Non-blocking I/O suits a latency-critical, I/O-bound path; strict typing carries the contracts                                                                     |
| **NestJS + Fastify**                     | DI makes the provider/rule substitution testable; Fastify is the faster adapter                                                                                    |
| **Redis**                                | Sub-millisecond hot-path feature reads with native TTL and atomic counters — [ADR-002](docs/adr/ADR-002-redis-feature-store.md)                                    |
| **PostgreSQL**                           | Durable, relational, queryable state. Off the hot path — [ADR-003](docs/adr/ADR-003-hot-path-design.md)                                                            |
| **Kafka (KRaft)**                        | Durable async propagation with replay and independent consumers — [ADR-001](docs/adr/ADR-001-event-driven-architecture.md). KRaft to avoid a second JVM on 7.86 GB |
| **Prometheus + Grafana + OpenTelemetry** | Golden signals, distributed tracing, dashboards as code                                                                                                            |
| **Pino**                                 | Structured JSON logs with low overhead on the hot path                                                                                                             |
| **k6**                                   | Load testing that produces the evidence NFR-001/002 require                                                                                                        |
| **React + Vite + TypeScript**            | `apps/web`'s browser client — shares contract types with the backend directly                                                                                      |
| **Python + scikit-learn / XGBoost**      | Phase 10 only                                                                                                                                                      |

---

## Data

**All data is synthetic.** No real customer, cardholder or payment data is used anywhere.
Card numbers are never accepted or stored — only synthetic tokenised references.
Identifiers take the form `user_123`, `merchant_456`, `device_789`.

The generator in `packages/testkit` is **seeded and deterministic**: the same seed
produces an identical event sequence, which is what makes performance and detection
results reproducible.

---

## Licence and academic context

Academic prototype developed for coursework at BITS Pilani. Not intended for production
use and not certified against any payment-industry standard.
