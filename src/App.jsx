import { useCallback, useEffect, useMemo, useState } from 'react';
import PortalLogin, { ChangePasswordScreen } from './PortalLogin';
import Shell from './Shell';
import { makeApi } from './api';

const TOKEN_KEY = 'casuals_portal_token';

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState(null);
  const [loadError, setLoadError] = useState('');

  function handleLogin(newToken) {
    sessionStorage.setItem(TOKEN_KEY, newToken);
    setToken(newToken);
  }

  const handleLogout = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
  }, []);

  const api = useMemo(() => (token ? makeApi(token, handleLogout) : null), [token, handleLogout]);

  useEffect(() => {
    if (!api) return;
    setLoadError('');
    api('/api/auth/me')
      .then(({ user: me }) => setUser(me))
      .catch((err) => setLoadError(err.message));
  }, [api]);

  if (!token) return <PortalLogin onLogin={handleLogin} />;
  if (!user) {
    return (
      <div className="shell">
        <div className="empty">{loadError || 'Loading…'}</div>
      </div>
    );
  }
  // A password someone else chose must be replaced before anything else.
  if (user.mustChangePassword) {
    return (
      <ChangePasswordScreen
        api={api}
        user={user}
        onChanged={() => setUser({ ...user, mustChangePassword: false })}
        onLogout={handleLogout}
      />
    );
  }
  return <Shell token={token} user={user} api={api} onLogout={handleLogout} />;
}
