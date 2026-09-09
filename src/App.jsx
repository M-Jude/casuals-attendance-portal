import { useState } from 'react';
import PortalLogin from './PortalLogin';
import AttendanceDashboard from './AttendanceDashboard';

const TOKEN_KEY = 'casuals_portal_token';

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY));

  function handleLogin(newToken) {
    sessionStorage.setItem(TOKEN_KEY, newToken);
    setToken(newToken);
  }

  function handleLogout() {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken(null);
  }

  return token ? (
    <AttendanceDashboard token={token} onLogout={handleLogout} />
  ) : (
    <PortalLogin onLogin={handleLogin} />
  );
}
