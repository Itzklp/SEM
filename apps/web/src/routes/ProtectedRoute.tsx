import { Navigate, Outlet } from 'react-router-dom';

import { useAuth } from '@/context/AuthContext';

/** `requireRole` omitted: any signed-in user. Set it to gate a route to admins only. */
export function ProtectedRoute({ requireRole }: { requireRole?: 'admin' }): React.JSX.Element {
  const { user } = useAuth();

  if (!user) {
    return <Navigate to="/login" replace />;
  }
  if (requireRole && user.role !== requireRole) {
    return <Navigate to="/practice" replace />;
  }
  return <Outlet />;
}
