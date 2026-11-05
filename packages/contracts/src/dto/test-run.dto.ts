import { z } from 'zod';

/**
 * Suites the admin dashboard can trigger, mapped to the matching
 * `pnpm test:<suite>` script (see root package.json). `integration`,
 * `e2e` and `resilience` need the local Docker stack already running —
 * the dashboard warns about that rather than hiding the option.
 */
export const RUNNABLE_TEST_SUITES = [
  'unit',
  'architecture',
  'contract',
  'integration',
  'e2e',
  'resilience',
] as const;
export type RunnableTestSuite = (typeof RUNNABLE_TEST_SUITES)[number];

export const TEST_RUN_STATUSES = ['running', 'passed', 'failed', 'errored'] as const;
export type TestRunStatus = (typeof TEST_RUN_STATUSES)[number];

export const startTestRunRequestSchema = z
  .object({
    suite: z.enum(RUNNABLE_TEST_SUITES),
  })
  .strict();

export type StartTestRunRequest = z.infer<typeof startTestRunRequestSchema>;

export const testRunSummarySchema = z
  .object({
    id: z.string(),
    suite: z.string(),
    status: z.enum(TEST_RUN_STATUSES),
    triggeredBy: z.string(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    passedCount: z.number().int().nullable(),
    failedCount: z.number().int().nullable(),
    totalCount: z.number().int().nullable(),
  })
  .strict();

export type TestRunSummaryDto = z.infer<typeof testRunSummarySchema>;

export const testRunDetailSchema = testRunSummarySchema.extend({ log: z.string() });

export type TestRunDetailDto = z.infer<typeof testRunDetailSchema>;
