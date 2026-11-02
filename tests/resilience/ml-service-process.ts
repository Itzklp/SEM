import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * RT-ML-001's equivalent of `docker-helpers.ts` for the containerised
 * dependencies: `ml-service` is a host-run Python process (same pattern as
 * `fraud-api`/`review-api`/`event-worker` — architecture.md's service
 * table), not a container, so "stop it" means killing this child process,
 * not `docker compose stop`.
 *
 * Requires a trained artifact (`pnpm ml:train`) — the registry and joblib
 * file are build outputs, gitignored, and not something this test should
 * generate itself (training 100k rows takes real time; a resilience test
 * exercising the OUTAGE/RECOVERY path has nothing to do with training).
 */
const REPO_ROOT = join(__dirname, '..', '..');
const PYTHON_EXE = join(REPO_ROOT, '.venv', 'Scripts', 'python.exe');
const REGISTRY_PATH = join(REPO_ROOT, 'ml', 'models', 'registry.json');

export function assertTrainedModelExists(): void {
  if (!existsSync(REGISTRY_PATH)) {
    throw new Error(
      `No trained model artifact at ${REGISTRY_PATH}. Run "pnpm ml:train" first — ` +
        'this resilience test exercises the outage/recovery path, not training itself.',
    );
  }
}

export function startMlService(port: number): ChildProcess {
  const child = spawn(
    PYTHON_EXE,
    ['-m', 'uvicorn', 'app.main:app', '--app-dir', 'apps/ml-service', '--port', String(port)],
    { cwd: REPO_ROOT, stdio: 'pipe' },
  );
  // Prevents an unhandled 'error' event (e.g. ENOENT if the venv is
  // missing) from crashing the whole Jest worker — the readiness poll
  // below is what actually surfaces a failure to start, with a useful
  // message, rather than this throwing an opaque one first.
  child.on('error', () => undefined);
  return child;
}

export function stopMlService(child: ChildProcess): void {
  child.kill();
}

export async function waitForReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
      if (response.status === 200) return true;
    } catch {
      // not listening yet — retried below
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
