import { NavLink, Outlet } from 'react-router-dom';

import { useAuth } from '@/context/AuthContext';

export function AppShell(): React.JSX.Element {
  const { user, logout } = useAuth();

  return (
    <div className="app-shell">
      <aside className="app-shell__sidebar">
        <div className="app-shell__brand">FraudGuard</div>
        <nav className="app-shell__nav">
          <NavLink to="/practice" className="app-shell__nav-link">
            Practice a payment
          </NavLink>
          {user?.role === 'admin' && (
            <>
              <div className="app-shell__nav-heading">Admin</div>
              <NavLink to="/admin/health" className="app-shell__nav-link">
                System health
              </NavLink>
              <NavLink to="/admin/tests" className="app-shell__nav-link">
                Test runs
              </NavLink>
            </>
          )}
        </nav>
      </aside>
      <div className="app-shell__body">
        <header className="app-shell__topbar">
          <div className="app-shell__user">
            <span className="app-shell__user-name">{user?.displayName}</span>
            <span className={`badge badge--${user?.role}`}>{user?.role}</span>
          </div>
          <button type="button" className="btn btn--ghost" onClick={logout}>
            Log out
          </button>
        </header>
        <main className="app-shell__content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
