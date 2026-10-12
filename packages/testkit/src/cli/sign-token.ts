/**
 * Phase 9 load-test helper: prints a signed score-privilege JWT to stdout.
 * Reuses `signTestToken` rather than hand-rolling signing a second time —
 * the k6 scripts themselves cannot sign a token (no `jsonwebtoken` inside
 * k6's JS runtime), so the orchestrator generates one here, once per run,
 * and passes it in via `-e TOKEN=...`.
 *
 * Usage: pnpm --filter @fraudguard/testkit sign-token [expiresInSeconds]
 */
import { config as loadEnvFile } from 'dotenv';

loadEnvFile({ path: `${__dirname}/../../../../.env` });

import { signTestToken } from '../auth-token';

const secret = process.env['AUTH_JWT_SECRET'];
const issuer = process.env['AUTH_JWT_ISSUER'];
const audience = process.env['AUTH_JWT_AUDIENCE'];

if (!secret || !issuer || !audience) {
  throw new Error('AUTH_JWT_SECRET/AUTH_JWT_ISSUER/AUTH_JWT_AUDIENCE must be set (.env)');
}

const expiresInSeconds = Number(process.argv[2] ?? 7200);

process.stdout.write(
  signTestToken({ secret, issuer, audience, privileges: ['score'], expiresInSeconds }),
);
