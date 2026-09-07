# FraudGuard — Sequence Diagrams

**Version:** 1.0 (baseline) · **Date:** 2026-09-07

The primary scoring sequence is in [ARCHITECTURE.md §7](./ARCHITECTURE.md#7-sequence--a-scored-authorization).
This document covers the two remaining flows named in the roadmap: the review workflow
and the degraded-mode path.

---

## 1. Review workflow (FR-010, FR-011)

Begins where the scoring sequence ends: a `REVIEW` decision has been written and its
event relayed to Kafka.

```
event-worker      Kafka       review-api      Analyst        Postgres
     │               │             │              │              │
     │◀── consume ───┤ transaction.decided        │              │
     │   (decision = REVIEW)       │              │              │
     │               │             │              │              │
     ├─ INSERT fraud_cases ─────────────────────────────────────▶│
     │   (UNIQUE(transaction_id) — duplicate delivery of the     │
     │    same event fails this insert harmlessly, RISK-005)     │
     │               │             │              │              │
     ├─ produce ────▶│ review.created             │              │
     │               │             │              │              │
     │               │◀── consume ─┤              │              │
     │               │  (populates the OPEN-status case queue)   │
     │               │             │              │              │
     │               │             │◀── GET /fraud/cases?status=OPEN
     │               │             ├── list ─────▶│              │
     │               │             │              │              │
     │               │             │◀── GET /fraud/cases/:id ────┤
     │               │             ├── detail ───▶│ (transaction, risk
     │               │             │              │  score, reasons,
     │               │             │              │  feature summary)
     │               │             │              │              │
     │               │             │◀── POST /fraud/cases/:id/review
     │               │             │    { action, reason }       │
     │               │             │    (reviewerId from auth,   │
     │               │             │     never from the body)    │
     │               │             │              │              │
     │               │             ├─ applyCaseAction(OPEN, action)
     │               │             │  (packages/domain — throws  │
     │               │             │   IllegalTransitionError if │
     │               │             │   the case is not OPEN)     │
     │               │             │              │              │
     │               │             ├─ UPDATE fraud_cases ─────────────────▶│
     │               │             │  SET status, reviewed_at,   │
     │               │             │      reviewer_id, reason    │
     │               │             │              │              │
     │               │             ├── 200 result ───────────────▶│
     │               │             │              │              │
     │               │◀── produce ─┤ review.completed             │
     │               │             │              │              │
     │◀── consume ───┤             │              │              │
     ├─ INSERT audit_events ────────────────────────────────────▶│
```

**Points worth calling out:**

- The case-lifecycle check (`applyCaseAction`) happens **before** any write, so an
  illegal transition (e.g. reviewing an already-closed case — a second analyst racing
  the first, or a retried request) is rejected with no side effect, satisfying FR-011's
  acceptance criterion directly from the domain layer rather than from an ad hoc
  application check.
- `reviewerId` is taken from the authenticated session, never from the request body
  (ASM-006) — a caller cannot attribute a review action to someone else.
- This entire flow is cold path. Nothing here has a latency budget in the ADR-003
  sense; it is bounded by usability (an analyst waiting on a page load), not by a
  payment-authorization SLA.

---

## 2. Degraded-mode scoring (ADR-005)

The Redis-outage case — the most involved of the three fallback policies, because it
changes which policy thresholds apply, not just which data source is used.

```
Gateway      fraud-api                Redis (down)     Postgres
   │             │                         │               │
   ├─ POST ─────▶│                         │               │
   │             ├─ authn/authz/validate   │               │
   │             ├─ GET idem:{txId} ──────▶│               │
   │             │◀── timeout (20ms) ──────┤               │
   │             │                         │               │
   │             ├─ [Redis unreachable — ADR-005 cautious-open engages]
   │             ├─ features := ALL DEFAULTS (FeatureVector.source = 'unavailable')
   │             ├─ evaluate rules using declared per-feature defaults
   │             │   (featureOrDefault — never throws on a missing key)
   │             ├─ score via active provider (rules still run fully;
   │             │   only behavioural context is degraded, not the rules
   │             │   engine itself)
   │             ├─ combine → risk score
   │             │             │
   │             ├─ apply the DEGRADED policy band, not the healthy one:
   │             │     policy.degraded.allowMax (stricter)
   │             │     policy.degraded.blockMin (stricter)
   │             │   -> a score that would have been ALLOW under the
   │             │      healthy band may now land in REVIEW instead
   │             │
   │             ├─ decision.degraded = true
   │             ├─ decision.degradedReason = 'FEATURES_UNAVAILABLE'
   │             │             │
   │             ├─ BEGIN; INSERT decisions (degraded=true); INSERT outbox; COMMIT ─▶│
   │             ├─ log at WARN: "degraded mode: FEATURES_UNAVAILABLE"               │
   │◀─ 200 ──────┤  { decision, degraded: true, degradedReason: "FEATURES_UNAVAILABLE", ... }
   │             │
   │             │  fraud_decisions_total{degraded="true",reason="FEATURES_UNAVAILABLE"}++
   │             │  (this is the metric the ADR-005 visibility requirement and the
   │             │   Grafana degraded-ratio panel are built on)
```

**Why the policy band changes, not just the data:** scoring with all-default features
and then applying the _healthy_ thresholds would silently make the system more
permissive exactly when it has the least information — the opposite of "cautious-open".
Switching to the stricter degraded band is what keeps ambiguous transactions flowing to
`REVIEW` instead of `ALLOW` during an outage. `isValidRiskPolicy` (packages/domain) and
the config-loader's cross-field check (packages/config) both refuse to accept a degraded
band that is looser than the healthy one, specifically to stop this property from being
misconfigured away.

**The ML-outage variant** (`ML_UNAVAILABLE`) follows the same shape, with two
differences: the circuit breaker (not a bare timeout) decides when to engage, and the
fallback is a full alternate provider (`RuleBasedScoringProvider`) rather than
all-default features — rules still see real behavioural data, only the model's
probability is missing. The degraded policy band still applies, for the same reason.
