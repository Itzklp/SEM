import type { LoginResponse, SessionUser } from '@fraudguard/contracts';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import { apiRequest } from '@/lib/apiClient';
import { clearSession, getStoredUser, saveSession } from '@/lib/authStorage';

interface AuthContextValue {
  readonly user: SessionUser | null;
  readonly login: (email: string, password: string) => Promise<SessionUser>;
  readonly logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [user, setUser] = useState<SessionUser | null>(() => getStoredUser());

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      login: async (email: string, password: string) => {
        const response = await apiRequest<LoginResponse>('review-api', '/api/v1/auth/login', {
          method: 'POST',
          body: { email, password },
          authenticated: false,
        });
        saveSession(response);
        setUser(response.user);
        return response.user;
      },
      logout: () => {
        clearSession();
        setUser(null);
      },
    }),
    [user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be called inside an AuthProvider');
  }
  return context;
}
