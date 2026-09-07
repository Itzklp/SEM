# FraudGuard — Threat Model

**Version:** 1.0 (baseline) · **Date:** 2026-09-07 · **Method:** STRIDE per component

Revisited at each phase gate and formally reviewed in Phase 11. A fraud platform is a
security control, so an attacker's goal is frequently to *defeat* it rather than to
breach it — that shapes the analysis below.

---

## 1. Assets

| Asset | Why it matters |
| --- | --- |
| The fraud decision | The control itself. Forcing `ALLOW` is the attacker's primary objective |
| Risk policy configuration | Knowing thresholds allows scoring just beneath them |
| Rule definitions and weights | Reveals exactly what to avoid |
| Behavioural features | Reveals what is tracked, and over what windows |
| Audit trail | Loss or tampering destroys accountability and investigation |
| Transaction and user data | Confidentiality (synthetic here, real in any deployment) |
| Model artefacts | Theft enables offline evasion testing |
| Service availability | An outage that fails open **is** a fraud technique |

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

| Threat | Scenario | Mitigation | Residual |
| --- | --- | --- | --- |
| **S**poofing | Attacker submits transactions as a legitimate gateway | Authentication on every request; short-lived tokens; per-client credentials | Credential theft remains possible — no HSM |
| **T**ampering | Fields altered in flight to lower the score (amount reduced, device swapped) | Schema validation rejecting unknown fields; TLS at the gateway; request signing | Signing is Phase 11; until then a compromised transport is a real risk |
| **R**epudiation | Caller denies submitting a transaction | Every request audited with client identity, `requestId`, timestamp | Audit is append-only but not cryptographically chained |
| **I**nfo disclosure | Error messages or reasons leak thresholds, weights or rule internals | **FR-007 requires reasons that explain without revealing internals.** Generic error responses; no stack traces to clients | An attacker can still infer thresholds by probing — see §4 |
| **D**oS | Request flood exhausts capacity, forcing degradation | Rate limiting; load shedding with `429`; **cautious-open, not fail-open (ADR-005)** | A sufficiently large flood still degrades service |
| **E**oP | A scoring client reaches review or admin operations | Distinct privileges per operation; `review-api` is a separate service | — |

### 3.2 Review API and workflow

| Threat | Scenario | Mitigation |
| --- | --- | --- |
| **S** | Attacker poses as an analyst to approve fraudulent cases | Authentication; analyst role required |
| **T** | Case decision altered after the fact | Case history append-only; reviewer, timestamp, decision and reason recorded (FR-011) |
| **R** | Analyst denies approving a case | Every action attributed and audited |
| **I** | Bulk export of transaction data through query APIs | Authorization; pagination limits; query auditing |
| **E** | Analyst performs administrative actions (policy or model changes) | Separate admin privilege |

### 3.3 Event pipeline

| Threat | Scenario | Mitigation |
| --- | --- | --- |
| **T** | Forged events injected into Kafka to poison features | Broker not exposed outside the container network; producers authenticated in any real deployment |
| **R** | Events lost, so a decision has no audit record | **Transactional outbox (ADR-006)** guarantees publication |
| **D** | Consumer flooded, lag grows unbounded | Cold path is isolated; lag is monitored and alerted; DLQ for poison messages |
| **I** | Event payloads carry more data than consumers need | Payloads carry only what consumers require; no PAN exists to leak |

### 3.4 Feature store

| Threat | Scenario | Mitigation |
| --- | --- | --- |
| **T** | Attacker manipulates their own counters to appear low-risk | Redis unreachable from outside the container network; features written only by consumers, never by client input |
| **I** | Feature keys reveal what is tracked | Network isolation; authenticated Redis in any real deployment |
| **D** | Keyspace exhaustion via generated identifiers | `maxmemory` with an eviction policy; TTLs on all windowed keys |

---

## 4. Fraud-specific threats

The threats that generic web-application modelling misses.

| Threat | Description | Mitigation | Residual |
| --- | --- | --- | --- |
| **Threshold probing** | Attacker submits many transactions to locate the `ALLOW`/`REVIEW` boundary, then transacts just below it | Velocity rules catch the probing itself; per-client rate limiting; reasons do not disclose numeric scores or thresholds | **Real.** Any deterministic threshold is discoverable given enough probes. Partly why ML scoring is valuable — it is harder to reverse-engineer |
| **Availability-as-evasion** | Attacker induces a Redis or ML outage to force degraded scoring, then attacks during the window | **ADR-005 cautious-open**: ambiguous transactions go to `REVIEW`, not `ALLOW`. Degraded-decision ratio is monitored and alertable | A sustained outage floods the review queue — the documented operator action is itself a risk decision |
| **Slow-and-low** | Activity paced beneath every velocity window | Multiple overlapping windows (5 m, 1 h, 24 h); aggregate as well as count features | Fundamental limit of window-based detection |
| **Feature poisoning** | Attacker builds benign history before attacking | Account-age features; relationship signals across device and merchant | Long-horizon patience defeats short-horizon features |
| **Coordinated rings** | Many accounts, each individually unremarkable | Device- and merchant-level aggregates; relationship signals (Phase 5) | Requires the graph signals to be genuinely implemented, not just planned |
| **Replay** | Successful authorization resubmitted | Idempotency by `transactionId` (FR-017); timestamp validation | — |
| **Model extraction** | Systematic probing to reconstruct the scoring function | Rate limiting; no score returned in a form that eases regression | Inherent to any scoring API that returns useful information |

---

## 5. Prototype-specific risks

Honest accounting of what is weak *because* this is coursework.

| Risk | Impact | Accepted because |
| --- | --- | --- |
| No mTLS between internal services | An attacker inside the container network can read or forge internal traffic | Container network is the trust boundary for a local prototype |
| Secrets in `.env` | Local file compromise exposes local credentials | No real credentials exist; production would use a secret manager |
| Audit log not cryptographically chained | A database-level attacker could alter history | Append-only enforcement is adequate at this scope |
| Single Kafka broker | Broker loss is unrecoverable | Hardware constraint (CON-002); documented against NFR-013 |
| No WAF or edge DDoS protection | Vulnerable to volumetric attack | Not internet-exposed |

---

## 6. Verification

Every mitigation claimed above has a corresponding test in the Phase 8 and Phase 11
suites — a mitigation that is not tested is a mitigation that is assumed.

| Test | Verifies |
| --- | --- |
| `ST-001..004` | Authentication rejects absent, malformed, expired and forged tokens |
| `ST-005..007` | Authorization separates scoring, review and admin privileges |
| `ST-RATE-001` | Rate limiting triggers and returns `429` |
| `ST-REPLAY-001` | Replayed `transactionId` returns the original decision, no duplicate side effects |
| `ST-TAMPER-001` | Unknown and altered fields are rejected by schema validation |
| `ST-INJECT-001` | Injection attempts in string fields are safely parameterised |
| `ST-LEAK-001` | Decision reasons contain no thresholds, weights or rule internals |
| `ST-DEGRADE-001` | Induced Redis outage produces cautious-open behaviour, **not** blanket approval |
| CI secret scan | No credential reaches history |
| `pnpm audit` | No known-vulnerable dependency at moderate severity or above |
