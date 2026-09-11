# ADR-007 — Observability stack: metrics, tracing, alerting

**Status:** Accepted
**Date:** 2026-09-12
**Deciders:** Team 04
**Related:** ADR-001, ADR-003, ADR-005, ADR-006, FR-013, NFR-010, NFR-011

---

## Context

Phase 7's goal is "the system can be understood while it is running" — Prometheus
metrics, per-stage hot-path timing, distributed tracing across `fraud-api` → Redis →
PostgreSQL → Kafka → `event-worker`, Grafana dashboards, and alert rules. Four decisions
had to be made that the roadmap names but does not settle on its own: how metrics get
instrumented, how tracing gets instrumented, what backend traces go to, and how alerting
is delivered.

A complication specific to this system: the transactional outbox (ADR-006) means the
Kafka publish that "completes" a request happens in a **different process, at a later
time**, than the request itself. Standard distributed-tracing context propagation
(function calls, message headers) does not bridge that gap by itself — nothing carries
trace context across "write a row now, a poller reads it back later."

## Decision

### 1. Metrics: `prom-client`, one shared `Registry`, manual instrumentation

`packages/observability` defines all eleven roadmap-named metrics (plus
`review_queue_depth`, added to support the "review-queue depth" alert ADR-005 already
names) exactly once, on one `Registry` every app imports. No auto-collecting middleware
framework (e.g. `express-prom-bundle`) — this project uses Fastify/NestJS and a plain
`node:http` server (`event-worker` has no framework at all), so a Fastify-specific
plugin (`http-metrics.ts`, registered directly on the underlying Fastify instance, not
via `app.register()` — see that file's doc comment on why) plus direct `measure()` calls
at I/O boundaries (Redis, Postgres, Kafka) covers every app with one mechanism.

### 2. Tracing: manual spans at existing I/O boundaries, not auto-instrumentation

OpenTelemetry ships auto-instrumentation packages for `pg`, `ioredis` and `kafkajs`.
**Not used.** Every Redis/Postgres/Kafka call in this system already passes through one
of three small, already-enumerable packages (`@fraudguard/feature-store`,
`@fraudguard/persistence`, `@fraudguard/messaging`). `measure()`
(`packages/observability/src/measure.ts`) wraps each call site with BOTH a span and the
matching Prometheus histogram observation from the SAME timer — one mechanism producing
two numbers that cannot drift apart, versus two separately-maintained libraries (a
hand-timed histogram plus an auto-instrumentation span) that could silently disagree
about where an operation starts and ends the moment either one changes. `HttpInstrumentation`
(the one OpenTelemetry package actually used) is kept because it is the one boundary this
system does not already wrap by hand — the inbound request itself.

### 3. Trace context survives the outbox gap via a persisted column, not magic

`outbox_events.trace_context` (migration 0003) stores the W3C `traceparent` captured at
write time (`captureTraceparent()`). The relay reads it back and (a) sets it as the
published Kafka message's `traceparent` header and (b) runs the actual publish inside
`runWithExtractedContext(row.traceContext, ...)`, so the publish span is a child of the
ORIGINAL request's trace despite running in a different process, possibly much later.
Every consumer extracts the same header the same way. This is the one piece of this
phase that is genuinely specific to this system's architecture, not a generic tracing
recipe — ADR-006's own async gap is exactly what standard context propagation assumes
does not exist.

### 4. Backend: Jaeger (`all-in-one`, OTLP-native), not Tempo or Zipkin

`jaegertracing/all-in-one` receives OTLP/HTTP directly (no collector needed), runs with
in-memory storage (no object-storage dependency, unlike Tempo's usual setup), and ships
its own UI on one container. Given `DEVELOPMENT_ENVIRONMENT.md` §5.1's 4-core/7.86 GB
capacity constraint, every added container is a real trade-off — Jaeger's footprint
(~150–250 MB, no second dependency) is the cheapest correct answer for "can a developer
look up one trace by id locally."

### 5. Alerting: Prometheus's own rule evaluation, no Alertmanager

The five roadmap-named alert rules (`infrastructure/monitoring/prometheus/alerts.yml`)
are evaluated by Prometheus directly — firing state is visible in Prometheus's own UI and
queryable as the `ALERTS` metric, which satisfies "alert rules" as a deliverable.
Alertmanager (routing, notification channels, silencing) is not deployed: this prototype
has no on-call rotation and no real recipient for a notification, so Alertmanager would
be infrastructure with nothing real behind it — the same reasoning Phase 6 already
applied to the outbox relay never dead-lettering.

## Alternatives considered

### A. OpenTelemetry auto-instrumentation for pg/ioredis/kafkajs

- **Rejected** — see Decision §2. Two independently-measured numbers for the same
  operation is a correctness risk this system does not need to accept, given the I/O
  call sites are already small and enumerable.

### B. A generic `express-prom-bundle`-style HTTP metrics middleware

- **Rejected.** This project runs on Fastify (two apps) and nothing (event-worker) — a
  framework-specific bundle would not cover event-worker at all, and would still need a
  hand-written metrics server there regardless.

### C. Tempo as the tracing backend

- **Rejected on capacity and complexity**, the same reasoning ADR-006 applied to
  Debezium: Tempo's recommended local setup still wants an S3-compatible object store,
  a second new dependency this prototype's scope does not justify when Jaeger's
  in-memory `all-in-one` answers the same exit criterion.

### D. Re-deriving trace context from `transactionId` alone (no persisted traceparent)

- **Rejected.** `transactionId` correlates records but is not a valid W3C trace id
  (wrong format, and multiple real traces — e.g. the original score request and a later,
  unrelated review — legitimately share one `transactionId`). A real traceparent,
  captured once and carried explicitly, is what actually lets spans from different
  processes link into one trace rather than merely being filterable by a shared string.

### E. Alertmanager deployed now, routes left unconfigured

- **Rejected.** An Alertmanager with no real notification channel is a container that
  exists to satisfy a checklist, not to alert anyone — worse than not deploying it, since
  it invites treating "Alertmanager is running" as "alerting works."

## Consequences

### Positive

- One measurement point per I/O boundary — metrics and traces cannot disagree about
  timing, because they share a timer.
- A single transaction's trace survives the outbox's process/time gap, proved directly
  (`tests/integration/observability.integration.test.ts`'s `IT-TRACE-001`), not assumed
  from "OpenTelemetry usually handles this."
- Every added container (Jaeger) has a named, capacity-justified reason; none are added
  "because the stack usually has one."

### Negative

- Manual spans are more code than auto-instrumentation, and a future I/O call site that
  forgets to call `measure()`/`withSpan()` goes unobserved silently — there is no
  enforcement mechanism for this today (unlike ADR-003's hot-path import-scan test).
- Jaeger's in-memory storage means traces do not survive a container restart — acceptable
  for local development, would need a real backend (Tempo + object storage, or a managed
  APM) before this system left a single developer's machine.
- No Alertmanager means no actual notification delivery — firing alerts are visible only
  to someone looking at Prometheus or Grafana, not pushed to anyone. Acceptable for a
  prototype with no on-call rotation; would need revisiting before any real deployment.

### Neutral

- The five alert thresholds in `alerts.yml` are explicit `ASSUMED` values, same as every
  other unmeasured threshold in this project (rule thresholds, score-combination weights)
  — Phase 9's load testing is what would calibrate them against real numbers.
