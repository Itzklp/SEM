# Security Policy

FraudGuard is an **academic prototype**. It is not production software, has no security
certification, and must not process real payment data. Within those limits it is built to
financial-system norms, because a fraud platform that is casual about security is
self-defeating.

The detailed threat analysis is in
[docs/security/threat-model.md](docs/security/threat-model.md).

---

## The one absolute rule

**No real payment data. No real customer data. Ever.**

| Never                            | Instead                                                                    |
| -------------------------------- | -------------------------------------------------------------------------- |
| Real card numbers (PAN)          | The system does not accept a PAN at all — only a synthetic token reference |
| Real cardholder names, addresses | Synthetic identifiers: `user_123`                                          |
| Real merchant identities         | `merchant_456`                                                             |
| Real device fingerprints         | `device_789`                                                               |
| Production data from any source  | The seeded generator in `packages/testkit`                                 |

**PAN is never accepted, never logged, never stored — there is no code path that can
receive one.** This is enforced at the schema level: the request DTO has no field for
it. That is a stronger guarantee than a redaction rule, because there is nothing to
redact.

Real data is also unnecessary here. The evaluation is of a distributed system, and
synthetic data with controllable fraud patterns is _better_ for that purpose — it is
reproducible, and it lets us construct exactly the attack patterns we want to detect.

---

## Security posture

### Implemented by design (from Phase 3)

| Control                                                                              | Where                      |
| ------------------------------------------------------------------------------------ | -------------------------- |
| Authentication on every endpoint                                                     | `fraud-api`, `review-api`  |
| Role-based authorization — scoring, review and admin are distinct privileges         | Both APIs                  |
| Schema validation on every input, rejecting unknown fields                           | `packages/contracts` (Zod) |
| Rate limiting per client                                                             | Nginx gateway              |
| Secure HTTP headers                                                                  | Gateway + application      |
| Secrets from environment variables only                                              | `packages/config`          |
| Structured security logging — auth failures, authorization denials, rate-limit trips | `packages/observability`   |
| Least privilege on database and Kafka credentials                                    | Infrastructure config      |
| Idempotency keys, limiting replay value                                              | `fraud-api`                |
| Parameterised queries throughout                                                     | `packages/persistence`     |

### Explicitly out of scope

Stated so their absence is a decision rather than an oversight:

- PCI-DSS certification (the design avoids PAN entirely, but nothing is certified)
- Hardware security modules or key management services
- mTLS between internal services
- WAF, DDoS protection at the network edge
- Production secret management (Vault, cloud KMS)
- Full audit-log tamper-proofing (append-only, but not cryptographically chained)

---

## Availability is a security property

For a fraud system this deserves stating explicitly: **an attacker who can cause an
outage may be trying to defeat the fraud controls, not just the service.**

If a fraud platform fails open, taking it down becomes a fraud technique. This is why the
degradation policy in [ADR-005](docs/adr/ADR-005-degradation-policy.md) is per dependency
and deliberately conservative — a Redis outage produces _more_ human review, not blanket
approvals. The security reasoning is set out there in full.

---

## Reporting a vulnerability

This is coursework, not a deployed service, so there is no external disclosure process.
Within the team:

1. **Do not** open a public issue describing an exploitable flaw with a working
   reproduction.
2. Raise it directly with the team.
3. Record it in `docs/security/` with severity, affected component and remediation.
4. Fix it, add a regression test, and note it in the Phase 11 security review.

---

## Secret handling

- Configuration is by environment variable, always.
- `.env` is git-ignored. `.env.example` holds placeholders and is the authoritative list
  of variables.
- CI includes a secret scan. A hit fails the build.
- If a secret is ever committed: **rotate it first**, then purge it from history.
  Rewriting history alone is not remediation — assume anything pushed was seen.

---

## Dependencies

- `pnpm audit` runs in CI.
- Dependencies are pinned via the lockfile, which is committed.
- New dependencies require justification in the PR — every added package is added attack
  surface and added maintenance.

---

## Security review schedule

| Phase | Review                                                                         |
| ----- | ------------------------------------------------------------------------------ |
| 3     | Authentication and authorization implementation                                |
| 6     | Audit trail integrity and completeness                                         |
| 8     | Security test suite: authN, authZ, rate limiting, replay, tampering, injection |
| 11    | Full review against the threat model; dependency audit; final sign-off         |
