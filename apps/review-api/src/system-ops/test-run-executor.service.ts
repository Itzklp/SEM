import { spawn } from 'node:child_process';
import path from 'node:path';

import type { TestRunRepository, TestRunStatus } from '@fraudguard/persistence';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';

import { LOGGER } from '../common/logger.provider';
import { TEST_RUN_REPOSITORY } from '../common/persistence.provider';

/** `apps/review-api` always runs with its cwd at the package root, so the monorepo root is two levels up. */
const REPO_ROOT = path.resolve(process.cwd(), '..', '..');

const SUMMARY_LINE =
  /Tests:\s+(?:(\d+) failed, )?(?:(\d+) skipped, )?(?:(\d+) passed, )?(\d+) total/;

/**
 * Runs a real `pnpm test:<suite>` as a child process and records the
 * outcome — not a canned result. One run at a time: the `resilience`
 * suite stops and restarts real Docker containers, and two of those
 * racing each other would just produce a confusing, unreproducible mess.
 */
@Injectable()
export class TestRunExecutorService {
  private runInProgress = false;

  constructor(
    @Inject(TEST_RUN_REPOSITORY) private readonly runs: TestRunRepository,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async start(suite: string, triggeredBy: string): Promise<string> {
    if (this.runInProgress) {
      throw new ConflictException({
        code: 'TEST_RUN_IN_PROGRESS',
        message: 'Another test run is already in progress — wait for it to finish first',
      });
    }
    this.runInProgress = true;

    const runId = await this.runs.start(suite, triggeredBy);
    // Deliberately not awaited — the HTTP response carries the run id
    // immediately, and the dashboard polls for progress, the same shape
    // any real CI trigger-and-watch flow has.
    void this.execute(runId, suite).finally(() => {
      this.runInProgress = false;
    });
    return runId;
  }

  private async execute(runId: string, suite: string): Promise<void> {
    const child = spawn('pnpm', ['run', `test:${suite}`], {
      cwd: REPO_ROOT,
      shell: true,
      env: process.env,
    });

    child.stdout.on('data', (chunk: Buffer) => {
      void this.runs.appendLog(runId, chunk.toString());
    });
    child.stderr.on('data', (chunk: Buffer) => {
      void this.runs.appendLog(runId, chunk.toString());
    });

    const exitCode = await new Promise<number>((resolve) => {
      child.on('close', (code) => {
        resolve(code ?? 1);
      });
      child.on('error', () => {
        resolve(1);
      });
    });

    const record = await this.runs.findById(runId);
    const match = record?.log.match(SUMMARY_LINE);
    // Jest only prints "N failed," when N > 0 — a match with that group
    // absent means the summary line was found and zero tests failed, not
    // that the failure count is unknown.
    const failedCount = match ? Number(match[1] ?? 0) : null;
    const passedCount = match?.[3] ? Number(match[3]) : null;
    const totalCount = match?.[4] ? Number(match[4]) : null;

    let status: TestRunStatus;
    if (match) {
      status = exitCode === 0 && (failedCount ?? 0) === 0 ? 'passed' : 'failed';
    } else {
      // The suite never printed a Jest summary at all — it crashed before
      // running anything, most likely because the local infra it needs
      // (Docker stack, migrated test database) isn't up.
      status = 'errored';
    }

    this.logger.info({ runId, suite, status, exitCode }, 'test run finished');
    await this.runs.finish(runId, status, { passedCount, failedCount, totalCount });
  }
}
