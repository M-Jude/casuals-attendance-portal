import { useState } from 'react';

export default function PortalLogin({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      if (!res.ok) {
        // 401 stays generic (don't reveal whether the email exists); other
        // failures — rate limiting, validation, server errors — are real
        // conditions worth telling the user about specifically, since
        // "password incorrect" is actively misleading for those.
        if (res.status === 401) {
          setError('Email or password is incorrect.');
        } else {
          const body = await res.json().catch(() => ({}));
          setError(body.error || 'Something went wrong. Try again.');
        }
        setSubmitting(false);
        return;
      }

      const data = await res.json();
      onLogin(data.token);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      setSubmitting(false);
    }
  }

  return (
    <div className="portal-login">
      <div className="portal-login__panel">
        <div className="portal-login__mark">CASUALS ATTENDANCE</div>
        <p className="portal-login__sub">Sign in to view your workers' attendance records.</p>

        <form onSubmit={handleSubmit}>
          <label className="portal-field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
            />
          </label>

          <label className="portal-field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>

          {error && <div className="portal-error" role="alert">{error}</div>}

          <button type="submit" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>

      <style>{`
        .portal-login {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          background: #0F1B2C;
          font-family: 'IBM Plex Sans', system-ui, sans-serif;
        }
        .portal-login__panel {
          width: 100%;
          max-width: 360px;
          padding: 40px 36px;
          background: #16243A;
          border: 1px solid #24354F;
        }
        .portal-login__mark {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 13px;
          letter-spacing: 0.06em;
          color: #3E8E7E;
          margin-bottom: 8px;
        }
        .portal-login__sub {
          color: #8A99AC;
          font-size: 14px;
          line-height: 1.5;
          margin: 0 0 28px;
        }
        .portal-field {
          display: block;
          margin-bottom: 18px;
        }
        .portal-field span {
          display: block;
          font-size: 13px;
          color: #8A99AC;
          margin-bottom: 6px;
        }
        .portal-field input {
          width: 100%;
          box-sizing: border-box;
          background: #0F1B2C;
          border: 1px solid #24354F;
          color: #E8EDF2;
          padding: 10px 12px;
          font-size: 15px;
          font-family: inherit;
        }
        .portal-field input:focus {
          outline: 2px solid #3E8E7E;
          outline-offset: 1px;
        }
        .portal-error {
          color: #C9A227;
          font-size: 13px;
          margin-bottom: 16px;
        }
        .portal-login button {
          width: 100%;
          background: #3E8E7E;
          color: #0F1B2C;
          border: none;
          padding: 11px;
          font-size: 15px;
          font-weight: 600;
          cursor: pointer;
        }
        .portal-login button:disabled {
          opacity: 0.6;
          cursor: default;
        }
        .portal-login button:hover:not(:disabled) {
          background: #4EA391;
        }
      `}</style>
    </div>
  );
}
