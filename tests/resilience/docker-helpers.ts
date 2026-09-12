import { execSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Shared by every `*.resilience.test.ts` file — extracted once several
 * tests needed the identical "stop/start a real container, poll its
 * health" shape (`kafka-outage.resilience.test.ts` had it first; Phase 8
 * added enough siblings that copy-pasting it again would have been the
 * third instance of the same duplication, the usual "extract now" line
 * this project draws elsewhere).
 */

const REPO_ROOT = join(__dirname, '..', '..');

// execSync has no timeout by default — an unresponsive docker daemon
// would then block this ENTIRE process indefinitely, including Jest's
// own per-test timeout (which relies on the event loop, and a
// synchronous call blocks it). A bounded timeout here is what makes
// "this took too long" fail loudly instead of hanging the suite.
const DOCKER_COMMAND_TIMEOUT_MS = 30_000;

export function dockerCompose(args: string): void {
  execSync(`docker compose ${args}`, {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    timeout: DOCKER_COMMAND_TIMEOUT_MS,
  });
}

/** `service` is a docker-compose service name (`postgres`, `redis`, `kafka`, ...) — matches `docker-compose.yml` exactly. */
export function isServiceHealthy(service: string): boolean {
  try {
    const output = execSync(`docker compose ps ${service} --format "{{.Status}}"`, {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      timeout: DOCKER_COMMAND_TIMEOUT_MS,
    }).toString();
    return output.includes('healthy');
  } catch {
    return false;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 2_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await sleep(intervalMs);
  }
  return predicate();
}

/** Backstop every resilience test's `beforeAll`/`afterAll` should call: guarantees a known starting AND ending state, so a prior failed run (or this one) never leaves a dependency down for whatever runs next. */
export async function ensureServiceHealthy(service: string, timeoutMs = 90_000): Promise<void> {
  if (!isServiceHealthy(service)) {
    dockerCompose(`start ${service}`);
    await waitUntil(() => isServiceHealthy(service), timeoutMs);
  }
}
