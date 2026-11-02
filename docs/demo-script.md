# FraudGuard — rehearsed demo script

**Prerequisites**: `pnpm docker:up:obs`, `pnpm db:migrate`, `fraud-api`/`review-api`/
`event-worker` running (`pnpm --filter <app> dev`), a `score`-privilege JWT and a
`review`-privilege JWT (`pnpm --filter @fraudguard/testkit sign-token`, or
`signTestToken` for a specific privilege set). Each demo states exactly what to run and
exactly what the audience should see — rehearsed, not improvised.

---

## Demo 1 — The three decisions, end to end

**Shows**: the system works completely without any ML (FR-003/005/006/007, Phase 5's
own exit criterion).

```bash
# ALLOW — a routine transaction
curl -s -X POST http://localhost:3000/api/v1/fraud/score \
  -H "authorization: Bearer $SCORE_TOKEN" -H "content-type: application/json" \
  -d '{"transactionId":"demo_allow","userId":"demo_user","merchantId":"demo_merchant","deviceId":"demo_device","amount":{"minorUnits":2500,"currency":"USD"},"paymentMethod":"card_token_demo","ipAddress":"203.0.113.1","timestamp":"<now>"}'
# → decision: ALLOW, reasons: []

# BLOCK — velocity + merchant risk together (no single rule fires alone)
# ...repeat with a high-risk merchant and rapid repeated calls; see
# demo-scenarios.integration.test.ts for the exact constructed inputs.
```

**Say**: "Every decision carries a policy version, a model version, and at least one
client-safe reason when it isn't `ALLOW` — enforced unconditionally
(`buildReasons()`), not left to each rule to remember."

## Demo 2 — Explainability without leakage

**Shows**: FR-007's two-sided guarantee — a reason always exists, and it never reveals
the threshold, weight, or rule name that produced it.

Point at the `reasons` array in Demo 1's BLOCK response, then at
`packages/domain/src/decision/reasons.test.ts`'s `UT-EXPL-002`: `Object.keys(reason)`
is exactly `['reason']` at runtime — asserted, not just hoped for.

## Demo 3 — Runtime policy change, no restart

**Shows**: FR-006 — the decision policy is live-configurable.

```bash
curl -s http://localhost:3000/api/v1/admin/policy -H "authorization: Bearer $ADMIN_TOKEN"
curl -s -X PUT http://localhost:3000/api/v1/admin/policy -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" -d '{"allowMax":0.30, ...}'
# Immediately re-run Demo 1's borderline transaction — the decision changes.
```

**Say**: "No deploy, no restart — the next request after the `PUT` uses the new policy."

## Demo 4 — The review workflow, and the audit trail it produces

**Shows**: FR-008/010/011 — a REVIEW case, queued, approved, and durably audited.

```bash
# Score a borderline transaction → REVIEW, a case is created (async, via the outbox)
curl -s http://localhost:3001/api/v1/fraud/cases?status=OPEN -H "authorization: Bearer $REVIEW_TOKEN"
curl -s -X POST http://localhost:3001/api/v1/fraud/cases/<caseId>/review \
  -H "authorization: Bearer $REVIEW_TOKEN" -H "content-type: application/json" \
  -d '{"action":"APPROVE","reason":"confirmed with cardholder"}'
```

Then query `audit_events` directly and show all four actions (`transaction.received`,
`transaction.decided`, `fraud.case.created`, `fraud.case.reviewed`) for the same
transaction — the full basis, not pieces of it (`tests/e2e/full-lifecycle.e2e.test.ts`'s
`E2E-001`).

## Demo 5 — A real Redis outage, live

**Shows**: ADR-005's cautious-open policy — not just a flag, the actual widened
decision band.

```bash
docker compose stop redis
# Re-run the SAME $2,500 transaction from Demo 1 — it now lands in REVIEW, with
# degraded:true, degradedReason:"FEATURES_UNAVAILABLE".
docker compose start redis
# Re-run again once healthy — back to ALLOW.
```

**Say**: "Same amount, same everything — only Redis's availability changed, and the
decision band widened, not just a flag." (`tests/resilience/redis-outage
.resilience.test.ts`.)

## Demo 6 — A real Kafka outage, and recovery

**Shows**: ADR-001 — the hot path has zero dependency on Kafka being reachable.

```bash
docker compose stop kafka
curl ... /api/v1/fraud/score ...   # still 200, still a real decision
docker compose start kafka
# Watch outbox_events.published_at go from NULL to populated as the relay catches up.
```

## Demo 7 — ML scoring, with a real outage and recovery

**Shows**: Phase 10's whole point — ML is a configuration change, with a real
circuit breaker, not a leap of faith.

```bash
# SCORING_PROVIDER=ml in .env, fraud-api restarted, ml-service running.
curl ... /api/v1/fraud/score ...   # scoringProvider: "ml", a real model version

# Kill ml-service.
curl ... (x5)                       # scoringProvider: "rules", degradedReason: "ML_UNAVAILABLE" — never a 5xx

# Restart ml-service, wait past ML_CIRCUIT_BREAKER_RESET_MS.
curl ...                            # scoringProvider: "ml" again — the breaker closed on a successful probe
```

**Say**: "This is the automated version of what you just watched —
`tests/resilience/ml-outage.resilience.test.ts` drives the real process through
exactly this lifecycle, every time."

## Demo 8 — Watching one transaction, end to end, in Jaeger and Grafana

**Shows**: FR-013 — the system can be understood while it's running, across the
hot-path/cold-path gap ADR-006 creates.

1. Open Grafana's `golden-signals.json` dashboard, note current throughput/latency.
2. Fire one real `POST /fraud/score`.
3. Open Jaeger, find the trace by its `traceId` — show the single trace spanning
   **both** `fraud-api` and `event-worker`: the root HTTP span, all five hot-path
   stages, the outbox relay's publish, and all Kafka consumers picking up the same
   `traceparent` that was persisted with the outbox row.

**Say**: "This trace crosses a process boundary and a time gap — the request already
returned before the consumer side of this trace even runs — and it's still one trace,
not two."

---

## If something goes wrong mid-demo

- **A resilience demo (5/6/7) doesn't recover**: check `docker compose ps` — a
  container that didn't fully restart will show as unhealthy. `docker compose
restart <service>` and retry.
- **ML demo shows `ML_UNAVAILABLE` on the very first request after restarting
  `ml-service`**: expected — the first connection between processes has a real
  one-time cost (documented in `phase10-ml-evaluation.md`). Fire the request twice.
- **A query against `audit_events`/`model_versions` returns nothing**: confirm the
  relevant consumer (`event-worker`) is actually running — the outbox relay and the
  consumers are separate processes from `fraud-api`.
