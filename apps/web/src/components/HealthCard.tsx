interface ComponentHealth {
  readonly status: 'up' | 'down';
  readonly latencyMs: number | null;
}

const DISPLAY_NAMES: Record<string, string> = {
  'fraud-api': 'fraud-api',
  'review-api': 'review-api',
  'ml-service': 'ml-service',
  postgres: 'PostgreSQL',
  redis: 'Redis',
};

export function HealthCard({
  name,
  health,
}: {
  name: string;
  health: ComponentHealth;
}): React.JSX.Element {
  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 600, fontSize: '0.92rem' }}>{DISPLAY_NAMES[name] ?? name}</span>
        <span className={`badge badge--${health.status}`}>{health.status}</span>
      </div>
      <div style={{ marginTop: 8, fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
        {health.latencyMs === null ? 'unreachable' : `${health.latencyMs} ms`}
      </div>
    </div>
  );
}
