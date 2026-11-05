import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '@/context/AuthContext';
import { ApiError } from '@/lib/apiClient';

export function LoginPage(): React.JSX.Element {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (user) {
    const redirectTo = (location.state as { from?: string } | null)?.from ?? '/practice';
    return <Navigate to={redirectTo} replace />;
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const signedInUser = await login(email, password);
      navigate(signedInUser.role === 'admin' ? '/admin/health' : '/practice', { replace: true });
    } catch (caughtError) {
      setError(
        caughtError instanceof ApiError
          ? caughtError.message
          : 'Could not reach the server — is review-api running?',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>FraudGuard</h1>
        <p>Sign in to practice a payment or review the system.</p>

        {error && <div className="alert alert--danger">{error}</div>}

        <form onSubmit={(event) => void handleSubmit(event)}>
          <div className="form-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          <button type="submit" className="btn" disabled={isSubmitting} style={{ width: '100%' }}>
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="demo-credentials">
          Demo accounts — password <code>fraudguard-demo</code> for both:
          <br />
          customer: <code>customer@fraudguard.dev</code>
          <br />
          admin: <code>admin@fraudguard.dev</code>
        </div>
      </div>
    </div>
  );
}
