import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export type TestRunStatus = 'running' | 'passed' | 'failed' | 'errored';

export interface TestRunRecord {
  readonly id: string;
  readonly suite: string;
  readonly status: TestRunStatus;
  readonly triggeredBy: string;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly passedCount: number | null;
  readonly failedCount: number | null;
  readonly totalCount: number | null;
  readonly log: string;
}

export interface TestRunSummary {
  readonly passedCount: number | null;
  readonly failedCount: number | null;
  readonly totalCount: number | null;
}

/** Raw `db.execute()` hands back Postgres's own `timestamptz` text, never a parsed `Date` — unlike drizzle's typed query builder. Converted once here so every caller can trust the `TestRunRecord` type as written. */
function toRecord(row: Record<string, unknown>): TestRunRecord {
  return {
    ...row,
    startedAt: new Date(row['startedAt'] as string),
    finishedAt: row['finishedAt'] ? new Date(row['finishedAt'] as string) : null,
  } as TestRunRecord;
}

export class TestRunRepository {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  async start(suite: string, triggeredBy: string): Promise<string> {
    const result = await this.db.execute(sql`
      INSERT INTO test_runs (suite, status, triggered_by) VALUES (${suite}, 'running', ${triggeredBy})
      RETURNING id
    `);
    return (result.rows[0] as { id: string }).id;
  }

  async appendLog(id: string, chunk: string): Promise<void> {
    await this.db.execute(sql`UPDATE test_runs SET log = log || ${chunk} WHERE id = ${id}`);
  }

  async finish(id: string, status: TestRunStatus, summary: TestRunSummary): Promise<void> {
    await this.db.execute(sql`
      UPDATE test_runs SET status = ${status}, finished_at = NOW(),
        passed_count = ${summary.passedCount}, failed_count = ${summary.failedCount},
        total_count = ${summary.totalCount}
      WHERE id = ${id}
    `);
  }

  async findById(id: string): Promise<TestRunRecord | null> {
    const result = await this.db.execute(sql`
      SELECT id, suite, status, triggered_by AS "triggeredBy", started_at AS "startedAt",
        finished_at AS "finishedAt", passed_count AS "passedCount",
        failed_count AS "failedCount", total_count AS "totalCount", log
      FROM test_runs WHERE id = ${id}
    `);
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  async listRecent(limit: number): Promise<readonly Omit<TestRunRecord, 'log'>[]> {
    const result = await this.db.execute(sql`
      SELECT id, suite, status, triggered_by AS "triggeredBy", started_at AS "startedAt",
        finished_at AS "finishedAt", passed_count AS "passedCount",
        failed_count AS "failedCount", total_count AS "totalCount"
      FROM test_runs ORDER BY started_at DESC LIMIT ${limit}
    `);
    return result.rows.map((row) => toRecord(row));
  }
}
