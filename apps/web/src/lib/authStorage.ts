import type { SessionUser } from '@fraudguard/contracts';

const TOKEN_KEY = 'fraudguard.token';
const USER_KEY = 'fraudguard.user';

export interface StoredSession {
  readonly token: string;
  readonly user: SessionUser;
}

export function saveSession(session: StoredSession): void {
  localStorage.setItem(TOKEN_KEY, session.token);
  localStorage.setItem(USER_KEY, JSON.stringify(session.user));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): SessionUser | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}
