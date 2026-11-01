# Phase 10 synthetic model evaluation

**Run dates:** 2026-10-31 (initial), 2026-11-02 (HTTP load comparison, circuit-breaker
verification, and two real bugs found while bringing the full stack up).  
**Dataset:** 100,000 deterministic synthetic transactions, seed `20261031`; fraud
scenario prevalence 2.49%.  
**Runtime:** local Windows development host, Python 3.12, scikit-learn 1.6.0.  
**Scope:** generated scenarios only. These figures are not estimates of real-world
fraud detection performance.

## Model selection

Candidates were fit on 75% of the rows and evaluated on a stratified 25% holdout.
The selected model maximizes PR-AUC among models with measured in-process single-row
p99 inference below the 15 ms model budget. On 2026-10-31, the random forest met that
budget at 9.59 ms p99 and had the highest candidate PR-AUC (0.9996); logistic
regression had 0.9958 PR-AUC at 0.98 ms p99; histogram gradient boosting had 0.9978
PR-AUC at 4.07 ms p99.

| Candidate                   | Precision | Recall |     F1 | ROC-AUC | PR-AUC |    FPR |    FNR | In-process p99 |
| --------------------------- | --------: | -----: | -----: | ------: | -----: | -----: | -----: | -------------: |
| Logistic regression         |    0.9351 | 0.9952 | 0.9642 |  0.9999 | 0.9958 | 0.0018 | 0.0048 |        0.98 ms |
| Random forest (selected)    |    0.9905 | 1.0000 | 0.9952 |  1.0000 | 0.9996 | 0.0002 | 0.0000 |        9.59 ms |
| Histogram gradient boosting |    0.9920 | 0.9904 | 0.9912 |  0.9999 | 0.9978 | 0.0002 | 0.0096 |        4.07 ms |

**Model selection is itself latency-sensitive to host load — a real finding, not
noise to average away.** Re-running the identical `train.py --rows 100000 --seed
20261031` on 2026-11-02 (same deterministic dataset, same fitted model weights)
measured the random forest's own single-row p99 at **62.6 ms** and histogram
gradient boosting at **17.4 ms** — both now over the 15 ms budget — while logistic
regression stayed at 2.4 ms. The selection logic correctly fell back to the only
eligible candidate (logistic regression). This is this project's own
already-documented RISK-001 class (Docker Desktop/WSL2 host contention measurably
changing latency figures between runs — Phase 4/5/9 hit the same thing) showing up
inside model SELECTION itself, not just inside the serving path: on a shared,
contended dev host, which model gets selected can change run to run, even with an
identical dataset and seed. The currently active, serving artifact as of this
session is `model-v1-synthetic-logistic-regression-d51686f1`, not the random forest
named above — `ml/models/registry.json` is the source of truth for whatever is
actually loaded, since it is a gitignored, regenerated-per-run build artifact.

## Controlled provider comparison

The comparison uses the same holdout rows, weights (`0.50` rules, `0.35` model,
`0.15` behavioural), and `0.40` decision threshold. The ML provider replaces only
the rules provider's stub-model signal; the other two components remain identical.
The rules row replicates the current default rule thresholds and provider formulas.

| Provider pipeline     | Precision | Recall |     F1 | ROC-AUC | PR-AUC |    FPR |    FNR | In-process p99 |
| --------------------- | --------: | -----: | -----: | ------: | -----: | -----: | -----: | -------------: |
| Rules + stub model    |    0.4388 | 0.4543 | 0.4464 |  0.8924 | 0.4603 | 0.0149 | 0.5457 |        0.30 ms |
| Rules + learned model |    0.5595 | 0.7014 | 0.6225 |  0.9938 | 0.8150 | 0.0141 | 0.2986 |        9.59 ms |

On these generated scenarios, the learned model improves fraud-relevant holdout
metrics at the cost of about 9.3 ms additional in-process p99 inference. The
comparison does not include HTTP/network overhead, concurrent load, or the full
authorization path. The configured 30 ms HTTP timeout remains a ceiling and is not
evidence that the end-to-end latency target is met.

## Reproduction

```powershell
.\.venv\Scripts\python apps/ml-service/app/train.py --rows 100000 --seed 20261031
```

The generated CSV, JSON report, registry, and joblib artifact are ignored build
outputs under `ml/datasets/` and `ml/models/`. Training labels are generated from
the simulator's six attack scenarios and must not be treated as observed outcomes.
The model is not validated for production use.

## Feedback capture and registry events

`transaction.decided` now carries only the scoring feature values and amount
needed for training; it does not add user, device, merchant, or IP fields to the
training table. The cold-path `training-examples` consumer joins these inputs
with `review.completed` by transaction ID. Analyst `BLOCK` maps to label 1,
`APPROVE` maps to label 0, and `ESCALATE` remains unlabeled. These are analyst
outcomes, not independently verified ground truth, and the reviewed set may be
selection-biased. The migration is `0004_model_training_examples.sql`.

An administrator can register a model through `POST /api/v1/models`; the
registry row and `model.updated` outbox event are written in one transaction.
The event-worker audits that topic. The trainer publishes registration metadata
when both `ML_REGISTRY_URL` and `ML_REGISTRY_TOKEN` are configured. Serving
still loads the local artifact registry at process startup.

## HTTP load comparison (2026-11-02)

Run against the real, fully brought-up stack (`docker compose --profile core
--profile observability up -d`, migrations applied, `fraud-api` + `ml-service`
host processes) using `scripts/run-load-tests.mjs` (Phase 9's orchestrator,
reused as-is). Both legs score the identical synthetic workload, same
`fraud-api` process restarted with only `SCORING_PROVIDER` changed between runs.

**First attempt, confounded — reported here rather than discarded.** At a
300 TPS target, with `review-api`/`event-worker`/`ml-service` all running
simultaneously, **both** legs measured >99% `http_req_failed` (rules: 99.10%;
ml: 99.75%) — this laptop running the full service set at once saturates almost
immediately, consistent with Phase 9's own already-documented Postgres
write-path bottleneck (`performance-report.md` §2b), not anything ML-specific.
Comparing two legs that are both >99% failed measures this laptop, not the two
providers, so this pair is not used as the comparison below. `review-api` and
`event-worker` were stopped for the remaining runs (neither is on the scoring
request path — the training-example consumer and model registry are verified
separately, below) to isolate `fraud-api` + `ml-service` + Postgres + Redis.

| Target TPS | Provider | Achieved (req/s) | Client p99 (ms) | Server p99 (ms) | Degraded |
| ---------: | -------- | ---------------: | --------------: | --------------: | -------: |
|         20 | rules    |             16.3 |            55.5 |           55.25 |        0 |
|         20 | ml       |             16.3 |            77.6 |           72.69 |        0 |
|        100 | rules    |             80.0 |         1 239.3 |        2 075.91 |       10 |
|        100 | ml       |             70.1 |         4 929.2 |        4 581.73 |      365 |

**At a sustainable rate (20 TPS), ML's real added cost is small and clean:
roughly 17-22 ms of added p99 latency**, consistent with the `ml_duration_seconds`
histogram observed directly on `fraud-api` during this run (304 real HTTP calls
to `ml-service`; 288 of them, 94.7%, completed in under 25 ms). Zero degraded
responses on either leg at this rate.

**At 100 TPS, both legs are already past this laptop's write-path saturation
point (Phase 9), and ML degrades far more under it — 365 fallbacks vs. 10.**
This is a real, compounding effect, not a measurement artifact: `ML_TIMEOUT_MS`
is a tight 30 ms **wall-clock** budget for the whole `fraud-api`→`ml-service`
HTTP round trip. Once general host contention (the same Postgres commit
bottleneck, event-loop scheduling delay under load) stretches ordinary request
handling, that external network hop is the first thing to miss its own budget —
rules has no equivalent external call to miss. The circuit breaker did its job
correctly throughout (every request still returned `200` with a valid decision,
confirmed by `shed=0`/`errors=0` on both rows); the cost is latency, not
correctness.

**A cold first connection has a real, one-time cost, separate from load.**
Verified directly before any load test: the very first request from a freshly
started `fraud-api` to a freshly started `ml-service` reliably missed the 30 ms
budget and fell back, even though in-process inference measures ~1-2 ms and the
warm, steady-state HTTP round trip measures ~2-3 ms. This is not something the
load numbers above would otherwise surface, and it is the reason
`tests/resilience/ml-outage.resilience.test.ts` sends one deliberate,
unasserted warm-up request before its real assertions.

## Circuit breaker, verified against the real process (RT-ML-001)

`tests/resilience/ml-outage.resilience.test.ts` — deferred from Phase 8
(`docs/ROADMAP.md`'s own Phase 8 section: "no `MLScoringProvider` yet"), built
now that one exists. Spawns and kills a real `uvicorn` child process (never a
mock), on its own test port, and drives the full lifecycle: closed → scores via
the real model → killed → every request falls back to `rules` with
`degradedReason: "ML_UNAVAILABLE"` (never a 5xx) → breaker opens after
`ML_CIRCUIT_BREAKER_THRESHOLD` consecutive failures → service restarted →
half-open probe succeeds past `ML_CIRCUIT_BREAKER_RESET_MS` → closed again,
scoring via the real model. Confirmed stable across two consecutive runs.

**Two real bugs this verification pass found, fixed, not filed away:**

1. **`apps/review-api/src/models/models.controller.ts`'s `GET /api/v1/models`
   500'd on every call once a model was actually registered.**
   `ModelRegistryRepository.list()` runs a raw `db.execute(sql...)` — unlike
   drizzle's typed query builder, that path returns Postgres's own
   `timestamptz` text form (`"2026-11-02 00:00:00+00"`) as a plain string,
   never a parsed `Date`. The controller's `registeredAt instanceof Date`
   check therefore never took its true branch, and the raw Postgres text
   format fails `modelVersionSchema`'s strict ISO-8601
   `z.string().datetime({ offset: true })` check. Caught live, registering a
   model and then listing it back. Fixed by unconditionally re-parsing through
   `new Date(...).toISOString()`, which `Date`'s constructor accepts in
   either format.
2. **The same controller's admin-only `POST` did its privilege check as a
   manual inline `if (!request.auth?.privileges.includes('admin'))` instead of
   this codebase's established `@RequirePrivileges('admin')` +
   `PrivilegesGuard` decorator pattern** (already used identically by
   `review-api`'s own `cases.controller.ts` and `fraud-api`'s
   `policy.controller.ts`). Not a live vulnerability — the manual check was
   correct — but a real inconsistency: a declarative guard is enforced the
   same way everywhere it is used; a one-off inline check is one future edit
   away from being forgotten. Fixed to match the established pattern, `GET`
   left open to any authenticated client (no `@RequirePrivileges`, matching
   `PrivilegesGuard`'s own documented "no decorator = any authenticated
   request" fallthrough).
3. **Writing the automated version of the above test surfaced a third, subtler
   bug — in the test, not the application**: a static top-level `import {
AppModule } from '...'` is hoisted ahead of any code in the file, including
   `beforeAll`'s `process.env` overrides. `apps/fraud-api/src/common/
config.provider.ts` is `useValue: loadConfig()` — read once, at that
   module's first evaluation, by design ("Fail Fast": config cannot change
   mid-process in production either). The result: every assertion silently
   scored against whatever `ml-service` this machine's real `.env` already
   pointed at, not the test's own disposable instance — so "killing" the
   test's process never affected what `fraud-api` was actually calling, and
   outage assertions failed in a way that looked like a broken circuit
   breaker. Fixed by `require()`-ing `AppModule` and its config-dependent
   siblings inside `beforeAll`, after the overrides — documented in the test
   file itself as its own "caught a second time" note.

## Model registry and training pipeline, verified end to end (2026-11-02)

- `POST /api/v1/models` (admin) → `GET /api/v1/models` (any authenticated
  client) round-tripped a real registration; a non-admin token correctly got
  `403`; the `model.updated` outbox event was correctly picked up and recorded
  by `event-worker`'s audit consumer (confirmed directly in `audit_events`).
- Full training-label join, confirmed directly in Postgres: scored a
  transaction (landed in `REVIEW`), approved-then-blocked it through
  `review-api`, and found exactly one `model_training_examples` row joining
  both inputs — `predicted_decision='REVIEW'`, `label=true`,
  `label_source='analyst_review'` — proving the cross-topic join
  (`transaction.decided` + `review.completed`, arriving independently) by
  `transaction_id` works regardless of delivery order.
