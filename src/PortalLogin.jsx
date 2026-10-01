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
        <div className="portal-login__brand">
          <div className="side__logo" aria-hidden="true">UA</div>
          <div>
            <div className="portal-login__mark">UCAA-Ark Group</div>
            <div className="portal-login__org">Casuals Management System</div>
          </div>
        </div>
        <h1 className="portal-login__title">Welcome back</h1>
        <p className="portal-login__sub">Sign in to see attendance, approvals and reports.</p>

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
          padding: 20px;
          box-sizing: border-box;
          background:
            radial-gradient(900px 520px at 0% 0%, rgba(20, 125, 110, 0.18) 0%, transparent 60%),
            radial-gradient(800px 480px at 100% 100%, rgba(33, 49, 64, 0.16) 0%, transparent 60%),
            var(--bg);
          font-family: var(--font);
        }
        .portal-login__panel {
          width: 100%;
          max-width: 400px;
          padding: 40px 38px 36px;
          background: var(--panel);
          border: 1px solid var(--line);
          border-radius: 20px;
          box-shadow: var(--shadow-lg);
        }
        .portal-login__brand { display: flex; align-items: center; gap: 12px; margin-bottom: 30px; }
        .portal-login__mark { font-size: 15px; font-weight: 700; color: var(--text); }
        .portal-login__org { font-size: 12.5px; color: var(--muted); }
        .portal-login__title { font-size: 24px; font-weight: 700; letter-spacing: -0.015em; margin: 0 0 6px; color: var(--text); }
        .portal-login__sub {
          color: var(--muted);
          font-size: 14px;
          line-height: 1.5;
          margin: 0 0 26px;
        }
        .portal-field {
          display: block;
          margin-bottom: 18px;
        }
        .portal-field span {
          display: block;
          font-size: 13px;
          font-weight: 500;
          color: var(--muted);
          margin-bottom: 7px;
        }
        .portal-field input {
          width: 100%;
          box-sizing: border-box;
          background: var(--panel);
          border: 1px solid var(--line-strong);
          border-radius: 10px;
          color: var(--text);
          padding: 11px 13px;
          font-size: 15px;
          font-family: inherit;
        }
        .portal-field input:focus {
          outline: none;
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-bg);
        }
        .portal-error {
          color: var(--critical);
          background: var(--critical-bg);
          border-radius: 8px;
          padding: 10px 12px;
          font-size: 13px;
          margin-bottom: 16px;
        }
        .portal-login button {
          width: 100%;
          background: var(--accent);
          color: var(--on-accent);
          border: none;
          border-radius: 10px;
          padding: 12px;
          margin-top: 6px;
          font-size: 15px;
          font-weight: 600;
          cursor: pointer;
        }
        .portal-login button:disabled {
          opacity: 0.6;
          cursor: default;
        }
        .portal-login button:hover:not(:disabled) {
          background: var(--accent-hover);
        }

        /* Phones: a full-screen sign-in, like an app's. */
        @media (max-width: 600px) {
          .portal-login {
            align-items: stretch;
            padding: calc(28px + env(safe-area-inset-top)) 20px calc(24px + env(safe-area-inset-bottom));
            background: var(--panel);
          }
          .portal-login__panel {
            display: flex; flex-direction: column; justify-content: center;
            max-width: none; padding: 0; border: none; box-shadow: none; background: none;
          }
          .portal-login__brand { margin-bottom: 40px; }
          .portal-login__brand .side__logo { flex-basis: 48px; height: 48px; border-radius: 14px; font-size: 18px; }
          .portal-login__title { font-size: 28px; }
          .portal-field input { font-size: 16px; padding: 14px; border-radius: 12px; }
          .portal-login button { padding: 15px; font-size: 16px; border-radius: 12px; }
        }
      `}</style>
    </div>
  );
}
