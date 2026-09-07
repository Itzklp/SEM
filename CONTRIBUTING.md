# Contributing to FraudGuard

Engineering standards for Team 04. These are not aspirational — the Definition of Done
in §1 is what "finished" means, and CI enforces the mechanical parts.

---

## 1. Definition of Done

**A feature is not complete because its code exists.** It is complete when every
applicable item below is true:

- [ ] Code exists and does what was asked
- [ ] Tests exist, and they test behaviour rather than restating the implementation
- [ ] Documentation updated — README, ADR, API docs, or runbook as applicable
- [ ] Structured logging at meaningful points, with request context attached
- [ ] Metrics exposed where operationally relevant
- [ ] Errors handled, with the failure mode explicitly chosen (see ADR-005)
- [ ] Security implications considered — authorization, input validation, data exposure
- [ ] Hot-path impact stated if the scoring path was touched (ADR-003)
- [ ] Traceability matrix updated with the requirement's new status
- [ ] CI green
- [ ] Integration verified against real infrastructure, not only mocks

---

## 2. Branching

| Branch       | Purpose                     | Rules                                 |
| ------------ | --------------------------- | ------------------------------------- |
| `main`       | Always releasable           | Protected. Merges from `develop` only |
| `develop`    | Integration                 | Protected. PRs only                   |
| `feat/*`     | New functionality           | From `develop`                        |
| `fix/*`      | Bug fixes                   | From `develop`                        |
| `docs/*`     | Documentation               | From `develop`                        |
| `test/*`     | Test-only work              | From `develop`                        |
| `refactor/*` | Behaviour-preserving change | From `develop`                        |

```
feat/redis-feature-store
fix/idempotency-race-condition
docs/adr-007-graph-signals
```

No direct commits to `main` or `develop`. No self-merge.

---

## 3. Commits

[Conventional Commits](https://www.conventionalcommits.org/).

```
<type>(<scope>): <subject>

[body]

[footer]
```

| Type       | Use for                                                         |
| ---------- | --------------------------------------------------------------- |
| `feat`     | New capability                                                  |
| `fix`      | Bug fix                                                         |
| `refactor` | Behaviour-preserving restructuring                              |
| `perf`     | Performance improvement — **state the measurement in the body** |
| `test`     | Tests only                                                      |
| `docs`     | Documentation only                                              |
| `build`    | Build system, dependencies                                      |
| `ci`       | CI configuration                                                |
| `chore`    | Housekeeping                                                    |

Scopes: `fraud-api`, `event-worker`, `review-api`, `ml-service`, `dashboard`, `domain`,
`contracts`, `feature-store`, `persistence`, `messaging`, `observability`, `config`,
`testkit`, `infra`, `docs`, `ci`.

**Good:**

```
feat(feature-store): add pipelined velocity feature retrieval

Fetches the full feature vector in a single Redis pipeline instead of
N round trips. Measured p99 on the local stack: 12ms -> 4ms at 500 TPS.

Refs: FR-002, ADR-002
```

```
fix(messaging): dedupe consumer events by eventId

Duplicate Kafka delivery created two cases for one REVIEW decision.
Consumers now check the processed-event table before applying state.

Fixes: RISK-005
Refs: FR-010
```

**Bad:** `update code` · `fixes` · `WIP` · `feat: phase 5` (an entire phase in one
commit — split it).

### Keep commits small

One logical change per commit. A reviewer should be able to hold the whole diff in their
head. If the message needs "and", it is probably two commits.

---

## 4. Pull requests

**Template:**

```markdown
## What

One or two sentences.

## Why

Requirement ID (FR-xxx / NFR-xxx) or ADR reference.

## How

Approach, and any non-obvious decision.

## Hot-path impact

None | Describe the change and its measured/estimated latency cost.

## Testing

What was added; what it would catch if it broke.

## Checklist

- [ ] Definition of Done satisfied
- [ ] Traceability matrix updated
- [ ] No secrets, no real data
```

Reviewers: **one** for ordinary changes; **both** other developers for anything touching
`packages/contracts`, an ADR, or the hot path.

### Reviewing

Check that it is correct, that it is tested, that the failure modes were considered, and
that the hot-path rules were respected. "Looks good" is not a review. Disagreement is
resolved by evidence — a measurement, a test, or an ADR.

---

## 5. Code standards

### TypeScript

- **Strict mode. No exceptions.**
- `any` is prohibited. Use `unknown` and narrow. If `any` is genuinely unavoidable,
  justify it in a comment on the line.
- No non-null assertions (`!`) to silence the compiler — handle the null case.
- Return types are explicit on exported functions.
- Errors are typed; no bare `throw new Error(string)` for domain failures.

### Structure

- **No business logic in controllers.** Controllers validate, delegate, and shape the
  response.
- `packages/domain` has **zero I/O and zero framework imports.** This is what keeps the
  unit-test base fast, and it is checked by the architecture test.
- Functions do one thing. If it needs a comment to explain its sections, split it.
- Dependencies are injected, never constructed inline — that is what makes providers and
  stores substitutable in tests.

### Prohibited

- Commented-out code — Git remembers it
- `TODO` without a linked issue or a documented task
- `console.log` — use the injected logger
- Magic numbers on the hot path — name them and put them in config
- Catching an error and continuing silently
- **Weakening a test to make it pass**

### Naming

| Kind                       | Convention                                                       |
| -------------------------- | ---------------------------------------------------------------- |
| Files                      | `kebab-case.ts`                                                  |
| Classes, types, interfaces | `PascalCase`                                                     |
| Functions, variables       | `camelCase`                                                      |
| Constants                  | `UPPER_SNAKE_CASE`                                               |
| Kafka topics               | `dot.separated.lowercase`                                        |
| Metrics                    | `snake_case` with a unit suffix (`_seconds`, `_total`, `_bytes`) |
| Database                   | `snake_case`                                                     |

---

## 6. Testing

Each test must be able to answer three questions — put them in the test name or a short
comment:

1. **What** is being tested?
2. **Why** does it need testing?
3. **What failure** would it catch?

```ts
// Verifies velocity counters expire on the window boundary.
// Without this, a stale counter would make an old burst look current,
// producing false BLOCKs long after the activity ended.
it('excludes transactions older than the 5m window from transaction_count_5m', ...)
```

Aim for the pyramid: many unit tests, fewer integration, fewest E2E. If your first
instinct is an E2E test, ask whether the logic could be pure and unit-tested instead —
usually it can, and usually it should be.

**When a test fails, fix the code.** Changing the assertion to match broken behaviour is
the single most damaging thing you can do to this project's credibility.

---

## 7. Never commit

- `.env` or any real configuration
- Credentials, API keys, passwords, tokens, private certificates
- Real payment data, real customer data, real card numbers — **at any point, for any
  reason**
- Large binaries or datasets — reference them, generate them, or use LFS
- `node_modules`, build output, coverage reports
- IDE-local settings beyond the shared `.vscode/` recommendations

All configuration is by environment variable, and every variable appears in
`.env.example` with a placeholder value.

If a secret is committed: **rotate it first**, then remove it from history. Removing it
from history alone is not remediation.

---

## 8. Claims and measurements

The project's credibility rests on this section.

**Always label:**

| Label       | Meaning                                            |
| ----------- | -------------------------------------------------- |
| `TARGET`    | What we aim for. Not yet demonstrated              |
| `MEASURED`  | Produced by a reproducible test. Cite the run      |
| `ESTIMATED` | Derived by reasoning. Say from what                |
| `ASSUMED`   | Taken as given. Say why, and what happens if false |

**Never write** "FraudGuard supports 10 000 TPS."
**Write** "FraudGuard was tested at 10 000 TPS on the hardware in
DEVELOPMENT_ENVIRONMENT.md §1, measuring p99 = X ms and an error rate of Y%."

Every performance number must be reproducible by a teammate from the documented
procedure. If it cannot be reproduced, it is not a result.

**Report failures.** A failed load test, a missed target, an ADR that turned out to be
wrong — these are findings, and they belong in the documentation. Hiding them is worse
than the failure.

---

## 9. Architecture decisions

Any decision that is hard to reverse, affects more than one component, or that a future
reader would question, gets an ADR.

`docs/adr/ADR-NNN-short-title.md`:

```markdown
# ADR-NNN — Title

**Status:** Proposed | Accepted | Superseded by ADR-MMM
**Date:** YYYY-MM-DD
**Deciders:**
**Related:**

## Context

The forces at play. What makes this a real decision.

## Decision

What we are doing. Specific and concrete.

## Alternatives considered

Each one, and **why it was rejected**. This is the most valuable section —
it is what tells a future reader the option was understood, not overlooked.

## Consequences

### Positive

### Negative <- must not be empty. Every decision costs something.

### Neutral
```

An ADR with an empty "Negative" section will be sent back. A decision with no downside
was not a decision.

Rotate authorship. The reviewer must not be the author.

---

## 10. Local checks before pushing

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration    # requires: pnpm docker:up
```

CI runs the same commands. Running them locally first is faster than waiting for a red
build.
