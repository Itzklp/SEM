import type { TestRunDetailDto } from '@fraudguard/contracts';

export function TestRunLog({ run }: { run: TestRunDetailDto }): React.JSX.Element {
  return (
    <div className="card stack" style={{ gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>{run.suite}</strong>
        <span className={`badge badge--${run.status}`}>{run.status}</span>
      </div>
      {run.totalCount !== null && (
        <div style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>
          {run.passedCount} passed, {run.failedCount} failed, {run.totalCount} total
        </div>
      )}
      <pre className="log-viewer">{run.log || 'Waiting for output…'}</pre>
    </div>
  );
}
