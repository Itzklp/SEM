import type { ScoreResponse } from '@fraudguard/contracts';

const DECISION_COPY: Record<ScoreResponse['decision'], string> = {
  ALLOW: 'Approved — this payment went through.',
  REVIEW: 'Held for review — not auto-approved, an analyst would look at this one.',
  BLOCK: 'Declined — this payment was blocked.',
};

export function DecisionResultCard({ result }: { result: ScoreResponse }): React.JSX.Element {
  return (
    <div className="card stack" style={{ gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className={`badge badge--${result.decision.toLowerCase()}`}>{result.decision}</span>
        <span style={{ color: 'var(--color-text-muted)', fontSize: '0.82rem' }}>
          {result.processingTimeMs.toFixed(0)} ms · risk score {result.riskScore.toFixed(2)}
        </span>
      </div>

      <p style={{ margin: 0 }}>{DECISION_COPY[result.decision]}</p>

      {result.degraded && (
        <div className="alert alert--muted">
          Degraded mode ({result.degradedReason}) — a dependency was unavailable, so this ran on a
          wider, more cautious policy band rather than failing outright.
        </div>
      )}

      {result.reasons.length > 0 && (
        <div>
          <strong style={{ fontSize: '0.85rem' }}>Why:</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
            {result.reasons.map((reason) => (
              <li key={reason.reason} style={{ fontSize: '0.88rem' }}>
                {reason.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <dl className="decision-meta">
        <div>
          <dt>Transaction</dt>
          <dd>{result.transactionId}</dd>
        </div>
        <div>
          <dt>Scoring provider</dt>
          <dd>{result.scoringProvider}</dd>
        </div>
        <div>
          <dt>Policy / model version</dt>
          <dd>
            {result.policyVersion} / {result.modelVersion}
          </dd>
        </div>
      </dl>
    </div>
  );
}
