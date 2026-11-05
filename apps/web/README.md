# FraudGuard web

The browser client for `fraud-api` and `review-api`: a payment-practice sandbox for an
ordinary customer, and an operations dashboard for an admin.

## Running it

```
pnpm --filter @fraudguard/review-api dev   # port 3001 — owns login
pnpm --filter @fraudguard/fraud-api dev    # port 3000 — scores payments
pnpm --filter @fraudguard/web dev          # port 5173
```

(`pnpm dev` at the repo root starts all three, plus `event-worker`, together.) Needs
`pnpm docker:up` and `pnpm db:migrate` first, same as the rest of the stack.

Copy `.env.example` to `.env.local` if the default API URLs (`localhost:3000`/`:3001`)
don't match your setup.

## Signing in

Two accounts are seeded by migration `0005_users_and_test_runs.sql`, password
`fraudguard-demo` for both:

| Email                     | Role     | Can do                                             |
| -------------------------- | -------- | --------------------------------------------------- |
| `customer@fraudguard.dev`  | customer | Practice a payment                                   |
| `admin@fraudguard.dev`     | admin    | Practice a payment, view system health, run test suites |

## What's actually real here

Every button calls a real endpoint — there's no mocked data in this app:

- **Practice a payment** sends a real `POST /api/v1/fraud/score`. The "suspicious payment"
  preset uses a merchant that `fraud-api` seeds as high-risk on every boot
  (`merchant_demo_high_risk` — see `apps/fraud-api/src/main.ts`), the same role a declined
  test card plays in a real payments sandbox.
- **System health** calls `review-api`'s `/api/v1/admin/system-health`, which pings every
  deployable's own `/health` in one round trip.
- **Test runs** actually spawns `pnpm test:<suite>` as a child process and streams its real
  stdout — this is the same command CI runs, not a canned result. `integration`, `e2e` and
  `resilience` need the local Docker stack (and, for `integration`/`e2e`, a migrated test
  database) already running; without that they still run, and fail honestly.
