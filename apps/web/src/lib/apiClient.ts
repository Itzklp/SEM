import { getStoredToken } from './authStorage';

// Fall back to the same defaults the backend apps themselves listen on
// (packages/config's own FRAUD_API_PORT/REVIEW_API_PORT defaults) so this
// works out of the box without requiring a .env.local first — without
// these, a missing env var silently becomes the string "undefined" in the
// fetch URL below, which the browser then resolves as a path on Vite's
// own dev server instead of the real API, and fails with a confusing 404.
const SERVICE_BASE_URLS = {
  'fraud-api': import.meta.env.VITE_FRAUD_API_URL || 'http://localhost:3000',
  'review-api': import.meta.env.VITE_REVIEW_API_URL || 'http://localhost:3001',
} as const;

type ServiceName = keyof typeof SERVICE_BASE_URLS;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  readonly authenticated?: boolean;
}

/** Every call to fraud-api or review-api from the browser goes through here — one place to attach the bearer token and turn FraudGuard's standard error shape into something a component can just catch. */
export async function apiRequest<T>(
  service: ServiceName,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = 'GET', body, authenticated = true } = options;
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (authenticated) {
    const token = getStoredToken();
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
  }

  const response = await fetch(`${SERVICE_BASE_URLS[service]}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const errorBody = payload as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      errorBody?.error?.message ?? `Request to ${service} failed with status ${response.status}`,
      response.status,
      errorBody?.error?.code ?? 'UNKNOWN_ERROR',
    );
  }

  return payload as T;
}
