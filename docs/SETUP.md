# FraudGuard — Setup Guide

Gets a developer from a clean Windows machine to a running FraudGuard stack.

The measured state of the reference machine, and the reasoning behind the choices here,
is in [DEVELOPMENT_ENVIRONMENT.md](./DEVELOPMENT_ENVIRONMENT.md). Read that first if you
want the _why_; this document is the _how_.

**Target time:** ~45 minutes, most of it Docker Desktop downloading.

---

## 0. Prerequisites at a glance

| #   | Step                | Needed for                                        | Skip if                                         |
| --- | ------------------- | ------------------------------------------------- | ----------------------------------------------- |
| 1   | Node.js 22 + pnpm 9 | Everything                                        | `node -v` shows v22+ **and** `pnpm -v` shows 9+ |
| 2   | Docker Desktop      | Phase 2 onward: infra, integration/E2E/load tests | `docker compose version` works                  |
| 3   | Python 3.11+        | Phase 10 (ML) only                                | Not doing ML work yet                           |
| 4   | k6                  | Phase 9 (load tests) only                         | `k6 version` works                              |

Steps 1 and 2 are mandatory for any backend work. Steps 3 and 4 can wait.

---

## 1. Node.js toolchain

Node.js **v22.13.0** and npm **10.9.2** are already present on the reference machine.
Verify:

```powershell
node --version    # expect v22.x
npm --version     # expect 10.x
```

If Node is missing or older than 22:

```powershell
winget install -e --id OpenJS.NodeJS.LTS
```

Then install pnpm (**this is GAP-002 — currently missing**):

```powershell
npm install -g pnpm@9
pnpm --version    # expect 9.x
```

> **Why pnpm rather than npm workspaces?** A content-addressed store means the ~15
> workspace packages share one physical copy of each dependency. On a machine with
> 36 GB free on `C:`, that is a practical concern, not a stylistic one. pnpm's strict
> `node_modules` layout also prevents accidental reliance on undeclared transitive
> dependencies, which is exactly the class of bug that appears only in CI.

---

## 2. Installing Docker Desktop (REQUIRED)

**This is GAP-001, the one blocking gap.** Kafka, Redis, PostgreSQL, Prometheus and
Grafana all run as containers. Nothing from Phase 2 onward works without this.

### 2.1 Confirm WSL2 is ready

Already verified on the reference machine (WSL 2, Ubuntu, state `Stopped` — stopped is
fine, Docker starts it). Confirm on yours:

```powershell
wsl --status
wsl -l -v          # expect an entry with VERSION 2
```

If WSL is absent:

```powershell
wsl --install
```

then **reboot**.

### 2.2 Install

```powershell
winget install -e --id Docker.DockerDesktop
```

**Reboot after installation.** Launch Docker Desktop once and let it complete
first-run initialisation.

### 2.3 Relocate Docker data to `D:` (STRONGLY RECOMMENDED)

`C:` has only 36.2 GB free; `D:` has 121.3 GB. Images and volumes for this project run
to several GB and grow over time.

Docker Desktop → **Settings → Resources → Advanced → Disk image location** →
set to `D:\docker-data` → **Apply & restart**.

Do this _before_ pulling any images, otherwise you will move them later.

### 2.4 Constrain Docker's resources (REQUIRED on this machine)

With 7.86 GB total RAM, Docker must not be allowed to take everything, or Windows will
begin swapping and every latency measurement becomes noise.

Create or edit `%USERPROFILE%\.wslconfig`:

```ini
[wsl2]
memory=5GB
processors=6
swap=2GB
```

Then apply:

```powershell
wsl --shutdown
```

and restart Docker Desktop.

> **Why these numbers.** 5 GB leaves ~2.8 GB for Windows, VS Code and the Node
> processes that run on the host during development. 6 of 8 logical processors leaves
> two for the host so that k6 and the IDE are not starved. These are a **starting
> point** — Phase 9 may revise them, and any revision must be recorded in the
> performance report, because changing them changes the meaning of every measurement
> taken before and after.

### 2.5 Verify

```powershell
docker --version           # expect 24.x or newer
docker compose version     # expect v2.20 or newer
docker run --rm hello-world
```

All three must succeed before continuing.

---

## 3. Clone and install

```powershell
cd d:\SEM
pnpm install
```

Then create your local environment file:

```powershell
Copy-Item .env.example .env
```

`.env` is git-ignored and **must never be committed**. `.env.example` contains only
placeholder values and is the authoritative list of every variable the system reads.

Fill in real local values for the credentialed ones (`POSTGRES_PASSWORD`,
`GRAFANA_ADMIN_PASSWORD`, `AUTH_JWT_SECRET`, `K6_API_KEY`) — don't leave the
`CHANGE_ME_*` placeholders in place:

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

`CREDENTIALS.md` (repo root, also git-ignored) is a standing inventory of every
credential in use — which service, what value, where it's consumed, and whether it's
even active (Redis and Kafka are deliberately unauthenticated locally — network-isolated
by design, see `docs/security/threat-model.md` §3.4). Keep it in sync when you rotate
anything; **verify `git check-ignore -v CREDENTIALS.md` matches before ever running a
broad `git add`.**

---

## 4. Starting the stack

Infrastructure is grouped into Docker Compose **profiles** so that a constrained machine
only runs what the current task needs. This is a direct consequence of the capacity
analysis in DEVELOPMENT_ENVIRONMENT.md §5.1.

| Profile         | Contains                            | Approx. RAM | Use when                                                 |
| --------------- | ----------------------------------- | ----------- | -------------------------------------------------------- |
| `core`          | PostgreSQL, Redis, Kafka (KRaft)    | ~2.0 GB     | Normal development, unit + integration tests             |
| `observability` | Prometheus, Grafana                 | ~0.6 GB     | Working on metrics/dashboards, and during load tests     |
| `apps`          | fraud-api, event-worker, review-api | ~0.5 GB     | Full containerised E2E; omit to run services on the host |

```powershell
# Minimum viable development environment
pnpm docker:up            # -> profile: core

# Add metrics and dashboards
pnpm docker:up:obs        # -> core + observability

# Everything, fully containerised
pnpm docker:up:all

# Stop, keeping data volumes
pnpm docker:down

# Stop and destroy data volumes (full reset)
pnpm docker:reset
```

### 4.1 Two ways to run the application services

Both are supported. They differ in trade-offs, not in correctness.

|                         | **Host mode** (recommended for development) | **Container mode** (recommended for E2E and load tests) |
| ----------------------- | ------------------------------------------- | ------------------------------------------------------- |
| Command                 | `pnpm docker:up` then `pnpm dev`            | `pnpm docker:up:all`                                    |
| Hot reload              | Yes                                         | No (rebuild required)                                   |
| Debugger attach         | Straightforward                             | Requires exposing the inspector port                    |
| Resource cost           | Lower — no extra container overhead         | Higher                                                  |
| Fidelity to deployment  | Lower                                       | Higher                                                  |
| Horizontal scaling test | Not possible                                | `docker compose up --scale fraud-api=4`                 |

Host mode reaches infrastructure at `localhost`; container mode uses Compose service
names. Both are covered by the same `.env.example` keys — only the host values differ,
and the container overrides live in the Compose file.

### 4.2 Apply database migrations

```powershell
pnpm db:migrate
```

Migrations are the **only** sanctioned way to change schema. Never edit a database by
hand — a hand-edited database cannot be reproduced by a teammate or by CI.

### 4.3 Health check

```powershell
curl http://localhost:3000/api/v1/health
```

---

## 5. Everyday commands

| Command                                | Purpose                                            |
| -------------------------------------- | -------------------------------------------------- |
| `pnpm install`                         | Install all workspace dependencies                 |
| `pnpm dev`                             | Run all services in watch mode on the host         |
| `pnpm build`                           | Type-check and build every package and app         |
| `pnpm lint` / `pnpm lint:fix`          | ESLint across the monorepo                         |
| `pnpm format`                          | Prettier                                           |
| `pnpm typecheck`                       | `tsc --noEmit`, strict mode                        |
| `pnpm test`                            | Unit tests (fast, no infrastructure required)      |
| `pnpm test:integration`                | Integration tests (**requires** `core` profile up) |
| `pnpm test:e2e`                        | End-to-end tests                                   |
| `pnpm test:resilience`                 | Failure-injection suite                            |
| `pnpm test:load`                       | k6 load scenarios                                  |
| `pnpm db:migrate` / `pnpm db:rollback` | Schema migrations                                  |
| `pnpm docker:up` / `:obs` / `:all`     | Start infrastructure by profile                    |
| `pnpm docker:down` / `docker:reset`    | Stop / stop and wipe volumes                       |
| `pnpm seed`                            | Generate deterministic synthetic data              |

---

## 6. Optional tooling

### Python (Phase 10 only)

Python **3.12.1** and pip **24.0** are already present. When ML work begins:

```powershell
cd ml
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

The virtual environment lives at `ml/.venv` and is git-ignored.

### k6 (Phase 9 only)

k6 **v1.3.0** is already installed via Chocolatey. If missing:

```powershell
choco install k6      # or: winget install -e --id Grafana.k6
k6 version
```

### GitHub CLI (optional)

```powershell
winget install -e --id GitHub.cli
gh auth login
```

Nothing in the build depends on it.

---

## 7. Accessing infrastructure

No native `psql`, `redis-cli` or Kafka CLI is installed, by design — the container's own
client always matches its server version.

```powershell
# PostgreSQL
docker compose exec postgres psql -U fraudguard -d fraudguard

# Redis
docker compose exec redis redis-cli

# Kafka — list topics
docker compose exec kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list

# Kafka — consumer group lag
docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --all-groups
```

---

## 8. Service endpoints

| Service             | URL                           | Notes                                                    |
| ------------------- | ----------------------------- | -------------------------------------------------------- |
| Fraud API           | http://localhost:3000         | Hot path — authorization scoring                         |
| Fraud API — OpenAPI | http://localhost:3000/docs    | Swagger UI                                               |
| Fraud API — metrics | http://localhost:3000/metrics | Prometheus scrape target                                 |
| Review API          | http://localhost:3001         | Cold path — cases, transactions, models                  |
| Dashboard           | http://localhost:5173         | React operations dashboard                               |
| Prometheus          | http://localhost:9090         | `observability` profile                                  |
| Grafana             | http://localhost:3030         | `observability` profile. Default login in `.env.example` |
| PostgreSQL          | localhost:5432                |                                                          |
| Redis               | localhost:6379                |                                                          |
| Kafka               | localhost:9092                |                                                          |

---

## 9. Troubleshooting

| Symptom                                        | Likely cause                                    | Fix                                                                                                          |
| ---------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `docker: command not found`                    | GAP-001 unresolved                              | §2                                                                                                           |
| Machine freezes / heavy swapping under load    | Docker unconstrained                            | Apply `.wslconfig` from §2.4, then `wsl --shutdown`                                                          |
| Kafka container restarts repeatedly            | Insufficient memory for the JVM                 | Raise `memory` in `.wslconfig`, or stop the `observability` profile while developing                         |
| `EADDRINUSE` on 3000/5432/6379/9092            | Port taken by another process                   | `netstat -ano \| findstr :3000`, then stop the owner                                                         |
| Integration tests fail with connection refused | `core` profile not running                      | `pnpm docker:up`, wait for health checks                                                                     |
| Load-test latency is wildly inconsistent       | k6 competing with the system under test for CPU | Expected on this hardware — see DEVELOPMENT_ENVIRONMENT.md §5.2. Do not report such a run without the caveat |
| `C:` fills up                                  | Docker data still on `C:`                       | §2.3                                                                                                         |
| pnpm reports missing workspace package         | Stale install                                   | `pnpm install --force`                                                                                       |
