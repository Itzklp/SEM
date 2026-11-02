# FraudGuard — Threat Model

**Version:** 1.0 (baseline) · **Date:** 2026-09-07 · **Method:** STRIDE per component

Revisited at each phase gate and formally reviewed in Phase 11. A fraud platform is a
security control, so an attacker's goal is frequently to _defeat_ it rather than to
breach it — that shapes the analysis below.

---

## 1. Assets

| Asset                        | Why it matters                                                          |
| ---------------------------- | ----------------------------------------------------------------------- |
| The fraud decision           | The control itself. Forcing `ALLOW` is the attacker's primary objective |
| Risk policy configuration    | Knowing thresholds allows scoring just beneath them                     |
| Rule definitions and weights | Reveals exactly what to avoid                                           |
| Behavioural features         | Reveals what is tracked, and over what windows                          |
| Audit trail                  | Loss or tampering destroys accountability and investigation             |
| Transaction and user data    | Confidentiality (synthetic here, real in any deployment)                |
| Model artefacts              | Theft enables offline evasion testing                                   |
| Service availability         | An outage that fails open **is** a fraud technique                      |

---

## 2. Trust boundaries

```
  UNTRUSTED                    │  SEMI-TRUSTED         │  TRUSTED
  ─────────────────────────────┼───────────────────────┼──────────────────
  Payment gateway callers      │  Authenticated        │  Internal services
  Fraud analysts (browser)     │  API clients          │  Redis, Postgres,
  Any internet-facing traffic  │  Review UI sessions   │  Kafka, ml-service
                               │                       │
             ▲ Boundary 1 ─────┘         ▲ Boundary 2 ─┘
             AuthN + validation          AuthZ + rate limiting
             + rate limiting             + audit
```

**Boundary 3** — the container network — is trusted in this prototype. mTLS between
internal services is out of scope (SECURITY.md). In a real deployment it would not be.

---

## 3. STRIDE analysis

### 3.1 Scoring API (`fraud-api`) — the highest-value target

| Threat              | Scenario                                                                     | Mitigation                                                                                                                | Residual                                                               |
| ------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **S**poofing        | Attacker submits transactions as a legitimate gateway                        | Authentication on every request; short-lived tokens; per-client credentials                                               | Credential theft remains possible — no HSM                             |
| **T**ampering       | Fields altered in flight to lower the score (amount reduced, device swapped) | Schema validation rejecting unknown fields; TLS at the gateway; request signing                                           | Signing is Phase 11; until then a compromised transport is a real risk |
| **R**epudiation     | Caller denies submitting a transaction                                       | Every request audited with client identity, `requestId`, timestamp                                                        | Audit is append-only but not cryptographically chained                 |
| **I**nfo disclosure | Error messages or reasons leak thresholds, weights or rule internals         | **FR-007 requires reasons that explain without revealing internals.** Generic error responses; no stack traces to clients | An attacker can still infer thresholds by probing — see §4             |
| **D**oS             | Request flood exhausts capacity, forcing degradation                         | Rate limiting; load shedding with `429`; **cautious-open, not fail-open (ADR-005)**                                       | A sufficiently large flood still degrades service                      |
| **E**oP             | A scoring client reaches review or admin operations                          | Distinct privileges per operation; `review-api` is a separate service                                                     | —                                                                      |

### 3.2 Review API and workflow

| Threat | Scenario                                                          | Mitigation                                                                           |
| ------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **S**  | Attacker poses as an analyst to approve fraudulent cases          | Authentication; analyst role required                                                |
| **T**  | Case decision altered after the fact                              | Case history append-only; reviewer, timestamp, decision and reason recorded (FR-011) |
| **R**  | Analyst denies approving a case                                   | Every action attributed and audited                                                  |
| **I**  | Bulk export of transaction data through query APIs                | Authorization; pagination limits; query auditing                                     |
| **E**  | Analyst performs administrative actions (policy or model changes) | Separate admin privilege                                                             |

### 3.3 Event pipeline

| Threat | Scenario                                             | Mitigation                                                                                       |
| ------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **T**  | Forged events injected into Kafka to poison features | Broker not exposed outside the container network; producers authenticated in any real deployment |
| **R**  | Events lost, so a decision has no audit record       | **Transactional outbox (ADR-006)** guarantees publication                                        |
| **D**  | Consumer flooded, lag grows unbounded                | Cold path is isolated; lag is monitored and alerted; DLQ for poison messages                     |
| **I**  | Event payloads carry more data than consumers need   | Payloads carry only what consumers require; no PAN exists to leak                                |

### 3.4 Feature store

| Threat | Scenario                                                   | Mitigation                                                                                                      |
| ------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **T**  | Attacker manipulates their own counters to appear low-risk | Redis unreachable from outside the container network; features written only by consumers, never by client input |
| **I**  | Feature keys reveal what is tracked                        | Network isolation; authenticated Redis in any real deployment                                                   |
| **D**  | Keyspace exhaustion via generated identifiers              | `maxmemory` with an eviction policy; TTLs on all windowed keys                                                  |

---

## 4. Fraud-specific threats

The threats that generic web-application modelling misses.

| Threat                      | Description                                                                                              | Mitigation                                                                                                                        | Residual                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threshold probing**       | Attacker submits many transactions to locate the `ALLOW`/`REVIEW` boundary, then transacts just below it | Velocity rules catch the probing itself; per-client rate limiting; reasons do not disclose numeric scores or thresholds           | **Real.** Any deterministic threshold is discoverable given enough probes. Partly why ML scoring is valuable — it is harder to reverse-engineer |
| **Availability-as-evasion** | Attacker induces a Redis or ML outage to force degraded scoring, then attacks during the window          | **ADR-005 cautious-open**: ambiguous transactions go to `REVIEW`, not `ALLOW`. Degraded-decision ratio is monitored and alertable | A sustained outage floods the review queue — the documented operator action is itself a risk decision                                           |
| **Slow-and-low**            | Activity paced beneath every velocity window                                                             | Multiple overlapping windows (5 m, 1 h, 24 h); aggregate as well as count features                                                | Fundamental limit of window-based detection                                                                                                     |
| **Feature poisoning**       | Attacker builds benign history before attacking                                                          | Account-age features; relationship signals across device and merchant                                                             | Long-horizon patience defeats short-horizon features                                                                                            |
| **Coordinated rings**       | Many accounts, each individually unremarkable                                                            | Device- and merchant-level aggregates; relationship signals (Phase 5)                                                             | Requires the graph signals to be genuinely implemented, not just planned                                                                        |
| **Replay**                  | Successful authorization resubmitted                                                                     | Idempotency by `transactionId` (FR-017); timestamp validation                                                                     | —                                                                                                                                               |
| **Model extraction**        | Systematic probing to reconstruct the scoring function                                                   | Rate limiting; no score returned in a form that eases regression                                                                  | Inherent to any scoring API that returns useful information                                                                                     |

---

## 5. Prototype-specific risks

Honest accounting of what is weak _because_ this is coursework.

| Risk                                    | Impact                                                                      | Accepted because                                                 |
| --------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| No mTLS between internal services       | An attacker inside the container network can read or forge internal traffic | Container network is the trust boundary for a local prototype    |
| Secrets in `.env`                       | Local file compromise exposes local credentials                             | No real credentials exist; production would use a secret manager |
| Audit log not cryptographically chained | A database-level attacker could alter history                               | Append-only enforcement is adequate at this scope                |
| Single Kafka broker                     | Broker loss is unrecoverable                                                | Hardware constraint (CON-002); documented against NFR-013        |
| No WAF or edge DDoS protection          | Vulnerable to volumetric attack                                             | Not internet-exposed                                             |

---

## 6. Verification

Every mitigation claimed above has a corresponding test in the Phase 8 and Phase 11
suites — a mitigation that is not tested is a mitigation that is assumed. **Phase
11's own review (below) found this was not yet true for four of these rows, and one
row's check (`ST-RATE-001`) exposed a real bug in the mitigation itself, not just a
missing test.**

| Test              | Verifies                                                                           | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ST-001`/`ST-002` | Authentication rejects an absent or malformed token                                | VERIFIED — `fraud-api-scoring.integration.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ST-003`          | Authentication rejects an **expired** token                                        | **Gap found and closed in Phase 11** — no test anywhere signed a token with a past `exp`. Added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ST-004`          | Authentication rejects a token **forged** with the wrong signing secret            | **Gap found and closed in Phase 11** — same absence. Added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ST-005..007`     | Authorization separates scoring, review and admin privileges                       | VERIFIED                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ST-RATE-001`     | Rate limiting triggers and returns `429`                                           | **Gap found in Phase 11, and the mitigation itself was broken.** `@fastify/rate-limit`'s thrown error (a plain `Error` with `.statusCode = 429`, not a NestJS `HttpException`) fell into `HttpExceptionFilter`'s generic branch and surfaced as `500 INTERNAL_ERROR`. Verified against the real running process — 150 real concurrent requests, `X-RateLimit-Remaining` correctly counted to `0`, but every over-limit response was `500`, not `429`. Fixed in both `fraud-api` and `review-api`'s copies of the filter; reconfirmed `429` + `Retry-After` + `TOO_MANY_REQUESTS` against the real process afterward. |
| `ST-REPLAY-001`   | Replayed `transactionId` returns the original decision, no duplicate side effects  | **Partial coverage found, now complete.** The "no duplicate side effects" half was previously proven only for a _different_ replay vector (duplicate Kafka delivery, `IT-EVT-002`). Extended the existing API-resubmission test to also assert exactly one `decisions` row and two `outbox_events` rows after a replay of the same `transactionId`.                                                                                                                                                                                                                                                                  |
| `ST-TAMPER-001`   | Unknown and altered fields are rejected by schema validation                       | VERIFIED — `packages/contracts/src/dto/scoring.dto.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ST-INJECT-001`   | Unsafe characters in identifiers are rejected before reaching SQL/Redis/Kafka keys | VERIFIED — `packages/domain/src/entities/transaction.test.ts` (literal `'user; DROP TABLE transactions;'` payload)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ST-LEAK-001`     | Decision reasons contain no thresholds, weights or rule internals                  | VERIFIED — `packages/domain/src/decision/reasons.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ST-DEGRADE-001`  | Induced Redis outage produces cautious-open behaviour, **not** blanket approval    | VERIFIED — `tests/resilience/redis-outage.resilience.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| CI secret scan    | No credential reaches history                                                      | **VERIFIED as a real CI gate** — `.github/workflows/ci.yml`'s `security` job runs `gitleaks/gitleaks-action@v2` with `fetch-depth: 0` (full history, not just the working tree) on every PR and push to `main`/`develop`. *Correction*: an earlier pass of this section claimed this did not exist as a CI gate — it does; checked the workflow file directly rather than asserted from memory before finalising this review. |
| `pnpm audit`      | No known-vulnerable dependency at moderate severity or above                       | **The CI gate exists** (`pnpm audit --audit-level moderate`, same `security` job) **and would currently fail if run** — 2 low + 20 moderate + 20 high findings remain after Phase 11's fixes (§7), all at or above the `moderate` threshold this job enforces. Reported as the real, current state, not a hypothetical. |

### Residual risk found in Phase 11: rate-limit bypass via `X-Forwarded-For`

Both `fraud-api` and `review-api` run with Fastify's `trustProxy: true` — correct for
when a real reverse proxy sits in front (not yet built, `ARCHITECTURE.md` §14), but
in the CURRENT deployment there is no such proxy. A caller can set its own
`X-Forwarded-For` and have `@fastify/rate-limit`'s per-client key treat every request
as a different, first-seen client. This project's own Phase 9 load-test tooling
(`tests/load/score.k6.js`) relies on exactly this property on purpose, to simulate
many distinct merchants from one laptop — an accepted consequence of `trustProxy:
true` without a real proxy in front, not a new defect, but not previously called out
as a rate-limit bypass specifically. Residual: one attacker can defeat per-client
rate limiting by rotating a spoofed header value per request. Accepted for this
prototype (§5); the fix is the same one already named elsewhere in this project's
docs — a real gateway that sets, and the app trusts, `X-Forwarded-For` only from the
gateway's own address.

---

## 7. Dependency audit (Phase 11)

`pnpm audit` on 2026-11-02, before any fix: **60 findings — 6 low, 27 moderate, 23
high, 4 critical.** The `pnpm.overrides` block in the root `package.json` (added this
phase, pinning only the specific vulnerable leaf package, never a parent's declared
range) closed every critical with no code change required, verified by a full
`pnpm typecheck` + the complete test suite passing before each one was accepted:

| Package      | Was                                                   | Fixed to | Reachable at runtime?                                                                                           |
| ------------ | ----------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `proxy-addr` | 2.0.7 (IP-spoofing via IPv4-mapped IPv6 trust subnet) | ≥2.0.8   | Yes — `fastify`'s IP resolution, used by both apps                                                              |
| `fast-uri`   | 2.4.6/3.1.7 (host confusion)                          | ≥3.1.9   | Yes — Fastify's schema compiler                                                                                 |
| `handlebars` | 4.7.9 (JS injection via AST/own-property)             | ≥4.7.10  | **No** — only reachable through `ts-jest`'s own diagnostic formatting, a test-time dev dependency never shipped |

**Two attempted fixes were reverted after breaking something `typecheck` alone did
not catch** — both caught and corrected before being shipped, which is itself the
point of verifying against the real running system rather than stopping at a clean
compile:

1. A blanket `pnpm update -r --no-save` resolved more findings at once but broke
   `apps/fraud-api/src/swagger.ts`'s **typecheck** (a `FastifyInstance`
   type-augmentation mismatch between differently-resolved copies of
   `@fastify/swagger`/`@fastify/rate-limit`'s declared types).
2. `@fastify/middie` (8.3.3, "auth bypass in child plugin scopes", patched at
   ≥9.3.2) typechecked cleanly when overridden — but ≥9.3.2 requires Fastify 5.x,
   and this project runs Fastify 4.28.1 (pinned via `@nestjs/platform-fastify`
   10.4.22). The break only surfaced at **runtime**, on the very next full
   resilience-suite run: `FastifyError: fastify-plugin: @fastify/middie - expected
'5.x' fastify version, '4.28.1' is installed`, failing every single resilience
   test. Reverted immediately. `@fastify/middie` stays unpatched — it is pulled in
   by `@nestjs/platform-fastify` itself (not a nested transitive dependency), and
   its vulnerable code path requires Express-style `.use()` middleware, which
   neither app registers anywhere (confirmed by `grep`). **Left open and
   unreachable, not silently fixed in a way that would have taken the whole
   platform down.**

The scoped `pnpm.overrides` approach — one named package at a time, typecheck AND
the full test suite (not typecheck alone) run after each — is what caught both of
these before either reached `main`.

**After the fixes that held: 2 low, 20 moderate, 20 high, 1 critical
(`@fastify/middie`, reviewed above, unreachable).** The remaining findings, reviewed
rather than ignored:

- **`drizzle-orm` 0.36.4, SQL injection via improperly escaped SQL **identifiers**
  (not values)**, patched at ≥0.45.2. Checked directly: `grep -rn "sql\.raw\|sql\.
identifier\|sql\.ref" packages/persistence/src/` returns nothing — every raw `sql`
  template in this codebase (`ModelRegistryRepository`, `ModelTrainingRepository`,
  and every other repository) uses only static, hardcoded table/column names with
  interpolated **values**, which drizzle's tagged template already parameterises
  safely; nowhere does this codebase build a dynamic identifier from any input. This
  specific CVE's exploit path does not apply to how this codebase actually uses
  drizzle. Not fixed — the 0.36→0.45 jump is a large enough API surface to risk
  breaking the persistence layer late in the project for a finding that is not
  exploitable here; left as a known, reviewed, deferred item rather than silently
  ignored.
- **`@nestjs/platform-fastify`/`fastify` middleware-bypass findings** (URL-encoding,
  HEAD-request, trailing-slash, path-scoped middleware bypass) — all require
  Express-style `.use()` middleware to be registered; confirmed not used anywhere in
  either app.
- **`find-my-way` (Fastify's router) HTTP/2 DoS, `zod` oversized-payload memory
  exhaustion, 5× `brace-expansion` ReDoS** — denial-of-service class findings, out of
  scope for this audit's severity bar per this project's own security-review
  practice (DoS is excluded; `brace-expansion` additionally is dev-tooling-only, a
  transitive dependency of `glob`/`minimatch` used by test/build tooling, not served
  to any client).
- **6 low-severity findings** not individually triaged — below this audit's time
  budget for this phase; none are critical or high.

`pnpm audit`'s own CI gate (named in §6's table) does not exist as an enforced CI
check — this review was done manually, once, for Phase 11. Recorded as an honest gap
rather than a met claim.
