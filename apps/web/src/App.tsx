import { Navigate, Route, BrowserRouter, Routes } from 'react-router-dom';

import { AppShell } from '@/components/AppShell';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { AdminHealthPage } from '@/pages/AdminHealthPage';
import { AdminTestRunsPage } from '@/pages/AdminTestRunsPage';
import { LoginPage } from '@/pages/LoginPage';
import { PaymentPracticePage } from '@/pages/PaymentPracticePage';
import { ProtectedRoute } from '@/routes/ProtectedRoute';

function HomeRedirect(): React.JSX.Element {
  const { user } = useAuth();
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  return <Navigate to="/practice" replace />;
}

export function App(): React.JSX.Element {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<HomeRedirect />} />
          <Route path="/login" element={<LoginPage />} />

          <Route element={<ProtectedRoute />}>
            <Route element={<AppShell />}>
              <Route path="/practice" element={<PaymentPracticePage />} />

              <Route element={<ProtectedRoute requireRole="admin" />}>
                <Route path="/admin/health" element={<AdminHealthPage />} />
                <Route path="/admin/tests" element={<AdminTestRunsPage />} />
              </Route>
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
