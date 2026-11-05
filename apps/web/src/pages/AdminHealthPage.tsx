import type { SystemHealthDto } from '@fraudguard/contracts';
import { useCallback, useEffect, useState } from 'react';

import { HealthCard } from '@/components/HealthCard';
import { apiRequest, ApiError } from '@/lib/apiClient';

const AUTO_REFRESH_MS = 10_000;

export function AdminHealthPage(): React.JSX.Element {
  const [health, setHealth] = useState<SystemHealthDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const response = await apiRequest<SystemHealthDto>(
        'review-api',
        '/api/v1/admin/system-health',
      );
      setHealth(response);
      setError(null);
    } catch (caughtError) {
      setError(
        caughtError instanceof ApiError ? caughtError.message : 'Could not load system health',
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <div className="stack">
      <div className="page-header">
        <h1>System health</h1>
        <p>Every deployable's own /health, fanned out in one call — refreshes every 10s.</p>
      </div>

      {error && <div className="alert alert--danger">{error}</div>}

      {isLoading && !health ? (
        <p>Loading…</p>
      ) : (
        health && (
          <>
            <div className="grid-cards">
              {Object.entries(health.components).map(([name, componentHealth]) => (
                <HealthCard key={name} name={name} health={componentHealth} />
              ))}
            </div>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8rem' }}>
              Last checked {new Date(health.checkedAt).toLocaleTimeString()}
            </p>
          </>
        )
      )}
    </div>
  );
}
