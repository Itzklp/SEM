// Loads .env for local `pnpm test:integration` / `pnpm test:e2e` runs, so
// `loadConfig()` sees real values (POSTGRES_PASSWORD, AUTH_JWT_SECRET, ...)
// without every test file needing its own dotenv call. CI sets these as
// job-level env vars directly (.github/workflows/ci.yml) — dotenv's
// default (never override an already-set variable) means CI's values win
// and this file is a no-op there; .env doesn't exist in CI at all.
import { join } from 'node:path';

import { config } from 'dotenv';

config({ path: join(__dirname, '.env') });

// NestJS reads decorator metadata reflectively — every app entrypoint
// (apps/*/src/main.ts) imports this first. Tests that build a Nest
// testing module directly (bypassing main.ts) need the same polyfill
// loaded before any decorated class is imported, or DI resolution fails
// silently. One place to guarantee it, rather than every test file.
import 'reflect-metadata';
