import type { ScoreRequest, ScoreResponse } from '@fraudguard/contracts';
import { useState, type FormEvent } from 'react';

import { DecisionResultCard } from '@/components/DecisionResultCard';
import { useAuth } from '@/context/AuthContext';
import { apiRequest, ApiError } from '@/lib/apiClient';

// Seeded once at fraud-api startup (see apps/fraud-api/src/main.ts) — the
// one merchant this sandbox can guarantee reads as high-risk, the same
// role a "declined test card" plays in a real payments sandbox.
const HIGH_RISK_MERCHANT_ID = 'merchant_demo_high_risk';
const ROUTINE_MERCHANT_ID = 'merchant_coffee_shop_01';

interface PaymentForm {
  readonly merchantId: string;
  readonly amount: string;
  readonly currency: string;
  readonly paymentMethod: string;
}

const ROUTINE_PRESET: PaymentForm = {
  merchantId: ROUTINE_MERCHANT_ID,
  amount: '24.50',
  currency: 'USD',
  paymentMethod: 'card_token_demo',
};

const SUSPICIOUS_PRESET: PaymentForm = {
  merchantId: HIGH_RISK_MERCHANT_ID,
  amount: '1850.00',
  currency: 'USD',
  paymentMethod: 'card_token_demo',
};

interface HistoryEntry {
  readonly id: string;
  readonly result: ScoreResponse;
}

export function PaymentPracticePage(): React.JSX.Element {
  const { user } = useAuth();
  const [form, setForm] = useState<PaymentForm>(ROUTINE_PRESET);
  const [result, setResult] = useState<ScoreResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  function updateField<K extends keyof PaymentForm>(field: K, value: PaymentForm[K]): void {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const minorUnits = Math.round(Number(form.amount) * 100);
    const request: ScoreRequest = {
      transactionId: `txn_web_${crypto.randomUUID()}`,
      userId: `user_${user?.id ?? 'unknown'}`,
      merchantId: form.merchantId,
      deviceId: `device_web_${user?.id ?? 'unknown'}`,
      amount: { minorUnits, currency: form.currency },
      paymentMethod: form.paymentMethod,
      // A practice sandbox has no real client IP worth reporting — a fixed,
      // documentation-reserved address (RFC 5737) stands in for it.
      ipAddress: '203.0.113.42',
      timestamp: new Date().toISOString(),
    };

    try {
      const response = await apiRequest<ScoreResponse>('fraud-api', '/api/v1/fraud/score', {
        method: 'POST',
        body: request,
      });
      setResult(response);
      setHistory((current) => [{ id: response.transactionId, result: response }, ...current]);
    } catch (caughtError) {
      setError(
        caughtError instanceof ApiError
          ? caughtError.message
          : 'Could not reach fraud-api — is it running?',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="stack">
      <div className="page-header">
        <h1>Practice a payment</h1>
        <p>Send a real request to fraud-api and see exactly how it gets decided.</p>
      </div>

      <div className="card">
        <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => setForm(ROUTINE_PRESET)}
          >
            Fill a routine payment
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => setForm(SUSPICIOUS_PRESET)}
          >
            Fill a suspicious payment
          </button>
        </div>

        <form onSubmit={(event) => void handleSubmit(event)}>
          <div className="form-row">
            <div className="form-field">
              <label htmlFor="merchantId">Merchant</label>
              <input
                id="merchantId"
                value={form.merchantId}
                onChange={(event) => updateField('merchantId', event.target.value)}
                required
              />
            </div>
            <div className="form-field">
              <label htmlFor="paymentMethod">Payment method token</label>
              <input
                id="paymentMethod"
                value={form.paymentMethod}
                onChange={(event) => updateField('paymentMethod', event.target.value)}
                required
              />
            </div>
          </div>
          <div className="form-row">
            <div className="form-field">
              <label htmlFor="amount">Amount</label>
              <input
                id="amount"
                type="number"
                min="0.01"
                step="0.01"
                value={form.amount}
                onChange={(event) => updateField('amount', event.target.value)}
                required
              />
            </div>
            <div className="form-field">
              <label htmlFor="currency">Currency</label>
              <select
                id="currency"
                value={form.currency}
                onChange={(event) => updateField('currency', event.target.value)}
              >
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
              </select>
            </div>
          </div>

          {error && <div className="alert alert--danger">{error}</div>}

          <button type="submit" className="btn" disabled={isSubmitting}>
            {isSubmitting ? 'Sending…' : 'Send payment'}
          </button>
        </form>
      </div>

      {result && <DecisionResultCard result={result} />}

      {history.length > 1 && (
        <div className="card">
          <strong style={{ fontSize: '0.9rem' }}>This session&apos;s attempts</strong>
          <table style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>Transaction</th>
                <th>Decision</th>
                <th>Risk score</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.result.transactionId}</td>
                  <td>
                    <span className={`badge badge--${entry.result.decision.toLowerCase()}`}>
                      {entry.result.decision}
                    </span>
                  </td>
                  <td>{entry.result.riskScore.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
