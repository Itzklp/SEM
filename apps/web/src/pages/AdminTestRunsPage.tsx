import {
  RUNNABLE_TEST_SUITES,
  type RunnableTestSuite,
  type TestRunDetailDto,
  type TestRunSummaryDto,
} from '@fraudguard/contracts';
import { useCallback, useEffect, useState } from 'react';

import { TestRunLog } from '@/components/TestRunLog';
import { apiRequest, ApiError } from '@/lib/apiClient';

const RUNS_LIST_POLL_MS = 3_000;
const ACTIVE_RUN_POLL_MS = 1_500;

// These two need the local Docker stack (and a migrated test database)
// running first — the run will still happen, it'll just fail fast with
// "errored" if that infra isn't there, which the dashboard shows honestly
// rather than hiding the option.
const SUITES_NEEDING_INFRA = new Set<RunnableTestSuite>(['integration', 'e2e', 'resilience']);

export function AdminTestRunsPage(): React.JSX.Element {
  const [runs, setRuns] = useState<TestRunSummaryDto[]>([]);
  const [selectedRun, setSelectedRun] = useState<TestRunDetailDto | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startingS, setStartingSuite] = useState<RunnableTestSuite | null>(null);

  const refreshList = useCallback(async (): Promise<void> => {
    const response = await apiRequest<TestRunSummaryDto[]>('review-api', '/api/v1/admin/test-runs');
    setRuns(response);
  }, []);

  useEffect(() => {
    void refreshList();
    const interval = setInterval(() => void refreshList(), RUNS_LIST_POLL_MS);
    return () => clearInterval(interval);
  }, [refreshList]);

  useEffect(() => {
    if (!selectedId) {
      return;
    }
    let cancelled = false;

    async function poll(): Promise<void> {
      const detail = await apiRequest<TestRunDetailDto>(
        'review-api',
        `/api/v1/admin/test-runs/${selectedId}`,
      );
      if (!cancelled) {
        setSelectedRun(detail);
      }
    }

    void poll();
    const interval = setInterval(() => {
      if (selectedRun?.status !== 'running') {
        return;
      }
      void poll();
    }, ACTIVE_RUN_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // selectedRun?.status is read inside the interval callback on purpose —
    // re-subscribing the whole effect on every status tick would restart
    // polling instead of letting it run continuously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  async function triggerRun(suite: RunnableTestSuite): Promise<void> {
    setError(null);
    setStartingSuite(suite);
    try {
      const { id } = await apiRequest<{ id: string }>('review-api', '/api/v1/admin/test-runs', {
        method: 'POST',
        body: { suite },
      });
      setSelectedId(id);
      await refreshList();
    } catch (caughtError) {
      setError(
        caughtError instanceof ApiError ? caughtError.message : 'Could not start the test run',
      );
    } finally {
      setStartingSuite(null);
    }
  }

  return (
    <div className="stack">
      <div className="page-header">
        <h1>Test runs</h1>
        <p>Triggers the real `pnpm test:&lt;suite&gt;` command and streams its actual output.</p>
      </div>

      {error && <div className="alert alert--danger">{error}</div>}

      <div className="card">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {RUNNABLE_TEST_SUITES.map((suite) => (
            <button
              key={suite}
              type="button"
              className="btn btn--secondary"
              disabled={startingS !== null}
              onClick={() => void triggerRun(suite)}
              title={
                SUITES_NEEDING_INFRA.has(suite)
                  ? 'Needs the local Docker stack and a migrated test database'
                  : undefined
              }
            >
              {startingS === suite ? 'Starting…' : `Run ${suite}`}
              {SUITES_NEEDING_INFRA.has(suite) ? ' *' : ''}
            </button>
          ))}
        </div>
        <p
          style={{
            marginTop: 10,
            marginBottom: 0,
            fontSize: '0.78rem',
            color: 'var(--color-text-muted)',
          }}
        >
          * needs the local Docker stack running first
        </p>
      </div>

      {selectedRun && <TestRunLog run={selectedRun} />}

      <div className="card">
        <strong style={{ fontSize: '0.9rem' }}>Recent runs</strong>
        <table style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>Suite</th>
              <th>Status</th>
              <th>Result</th>
              <th>Started</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td>{run.suite}</td>
                <td>
                  <span className={`badge badge--${run.status}`}>{run.status}</span>
                </td>
                <td>
                  {run.totalCount === null ? '—' : `${run.passedCount}/${run.totalCount} passed`}
                </td>
                <td>{new Date(run.startedAt).toLocaleTimeString()}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setSelectedId(run.id)}
                  >
                    View log
                  </button>
                </td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td colSpan={5} style={{ color: 'var(--color-text-muted)' }}>
                  No test runs yet — trigger one above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
