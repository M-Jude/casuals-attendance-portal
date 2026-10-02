import { useEffect, useRef, useState } from 'react';
import PasswordChecklist from './PasswordChecklist';
import { isStrongPassword } from './passwordPolicy';

// The branded full-screen card shared by sign-in and the first-sign-in
// password change.
function LoginFrame({ title, sub, children }) {
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
        <h1 className="portal-login__title">{title}</h1>
        <p className="portal-login__sub">{sub}</p>
        {children}
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
        .portal-field > span {
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
        .portal-code { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 24px !important; letter-spacing: 0.4em; text-align: center; }
        .portal-qr { display: block; margin: 4px auto 12px; border-radius: 8px; background: #fff; padding: 6px; }
        .portal-secret { font-size: 13px; color: var(--muted); text-align: center; margin: 0 0 16px; }
        .portal-secret code { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 14px; color: var(--text); word-break: break-all; }
        .portal-steps { font-size: 14px; color: var(--text); margin: 0 0 10px; padding-left: 20px; line-height: 1.5; }
        .portal-login__help { font-size: 12.5px; color: var(--muted); text-align: center; margin: 14px 0 0; }
        .portal-login button.portal-login__alt {
          background: var(--panel);
          color: var(--accent);
          border: 1px solid var(--accent);
        }
        .portal-login button.portal-login__alt:hover:not(:disabled) { background: var(--accent-bg); }
        .portal-login button.portal-login__secondary {
          background: none;
          color: var(--muted);
          font-weight: 500;
          margin-top: 10px;
        }
        .portal-login button.portal-login__secondary:hover:not(:disabled) {
          background: none;
          color: var(--text);
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

// POSTs to a sign-in endpoint (no session yet) and returns { status, body }.
async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

export default function PortalLogin({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // System Admins: after the password, the authenticator step.
  //   { mode: 'verify' | 'setup', mfaToken }
  const [twoStep, setTwoStep] = useState(null);

  if (twoStep) {
    return (
      <TwoStepScreen
        {...twoStep}
        onSignedIn={onLogin}
        onRestart={(message) => { setTwoStep(null); setPassword(''); setSubmitting(false); setError(message || ''); }}
      />
    );
  }

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
      if (data.mfaRequired || data.mfaSetupRequired) {
        setTwoStep({
          mode: data.mfaRequired ? 'verify' : 'setup',
          mfaToken: data.mfaToken,
          method: data.method,
          emailHint: data.emailHint,
          emailSent: data.emailSent,
          emailError: data.emailError
        });
        return;
      }
      onLogin(data.token);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      setSubmitting(false);
    }
  }

  return (
    <LoginFrame title="Welcome back" sub="Sign in to see attendance, approvals and reports.">
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
    </LoginFrame>
  );
}

// The second step for System Admins: a 6-digit code from their
// authenticator app or from an email. The first time (and after a reset)
// they choose which: scanning a QR code into an app, or having codes
// emailed. App users can always ask for an emailed code instead.
function TwoStepScreen({ mode, mfaToken, method, emailHint, emailSent, emailError, onSignedIn, onRestart }) {
  const [code, setCode] = useState('');
  const [choice, setChoice] = useState(null); // setup: 'app' | 'email'
  const [channel, setChannel] = useState(method === 'email' ? 'email' : 'app'); // sign-in
  const [setup, setSetup] = useState(null); // { qrDataUrl, secret }
  const [error, setError] = useState(method === 'email' && emailSent === false ? (emailError || 'The code couldn’t be emailed.') : '');
  const [note, setNote] = useState(method === 'email' && emailSent ? `We’ve emailed a code to ${emailHint}.` : '');
  const [submitting, setSubmitting] = useState(false);
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(method === 'email' && emailSent ? 60 : 0);
  const started = useRef(false);
  const usingEmail = mode === 'setup' ? choice === 'email' : channel === 'email';

  // Seconds until another email may be asked for.
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const id = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  // Setting up the app: fetch a QR code once.
  useEffect(() => {
    if (mode !== 'setup' || choice !== 'app' || started.current) return;
    started.current = true;
    postJson('/api/auth/mfa/setup', { mfaToken }).then(({ status, body }) => {
      if (status === 401) onRestart(body.error);
      else if (status !== 200) setError(body.error || 'Could not start the setup. Sign in again.');
      else setSetup(body);
    }).catch(() => setError('Could not reach the server. Check your connection and try again.'));
  }, [mode, choice, mfaToken, onRestart]);

  async function sendEmail() {
    if (sending || cooldown > 0) return;
    setSending(true);
    setError('');
    setNote('');
    try {
      const { status, body } = await postJson('/api/auth/mfa/email/send', { mfaToken });
      if (status === 200) { setNote(`We’ve emailed a code to ${body.to}. It works once, for 10 minutes.`); setCooldown(60); setCode(''); }
      else if (status === 401) onRestart(body.error);
      else { setError(body.error || 'The code couldn’t be sent. Try again.'); if (body.wait) setCooldown(body.wait); }
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    }
    setSending(false);
  }

  function switchToEmail() {
    setChannel('email');
    setCode('');
    sendEmail();
  }

  function chooseEmail() {
    setChoice('email');
    sendEmail();
  }

  async function submit(e) {
    e.preventDefault();
    if (submitting) return;
    setError('');
    setSubmitting(true);
    try {
      const { status, body } = mode === 'setup'
        ? await postJson('/api/auth/mfa/enable', { mfaToken, code, method: choice })
        : await postJson('/api/auth/mfa/verify', { mfaToken, code, channel });
      if (status === 200 && body.token) { onSignedIn(body.token); return; }
      if (status === 401) { onRestart(body.error); return; }
      setError(body.error || 'Something went wrong. Try again.');
      setCode('');
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    }
    setSubmitting(false);
  }

  const resendButton = (
    <button type="button" className="portal-login__secondary" disabled={sending || cooldown > 0} onClick={sendEmail}>
      {sending ? 'Sending…' : cooldown > 0 ? `Send a new code (${cooldown}s)` : 'Send a new code'}
    </button>
  );

  const codeField = (
    <label className="portal-field">
      <span>6-digit code</span>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        autoFocus
        required
        className="portal-code"
      />
    </label>
  );

  if (mode === 'setup' && !choice) {
    return (
      <LoginFrame
        title="Set up two-step sign-in"
        sub="System Admins confirm each sign-in with a 6-digit code as well as their password. Choose how you’d like to get it:"
      >
        <button type="button" onClick={() => setChoice('app')}>Authenticator app on my phone (recommended)</button>
        <p className="portal-login__help" style={{ margin: '6px 0 14px' }}>Google Authenticator, Microsoft Authenticator or similar. Works without signal; you can still ask for an emailed code when your phone isn’t with you.</p>
        <button type="button" className="portal-login__alt" onClick={chooseEmail}>Email me a code each time</button>
        <p className="portal-login__help" style={{ margin: '6px 0 14px' }}>Sent to {emailHint} whenever you sign in.</p>
        <button type="button" className="portal-login__secondary" onClick={() => onRestart('')}>Cancel</button>
      </LoginFrame>
    );
  }

  if (mode === 'setup' && choice === 'email') {
    return (
      <LoginFrame title="Set up two-step sign-in" sub="Enter the 6-digit code we’ve emailed you to confirm it reaches you.">
        <form onSubmit={submit}>
          {note && <p className="portal-login__help" style={{ margin: '0 0 14px' }}>{note}</p>}
          {codeField}
          {error && <div className="portal-error" role="alert">{error}</div>}
          <button type="submit" disabled={submitting || code.length !== 6}>{submitting ? 'Checking…' : 'Confirm and sign in'}</button>
          {resendButton}
          <button type="button" className="portal-login__secondary" onClick={() => { setChoice(null); setError(''); setNote(''); setCode(''); }}>Choose another way</button>
        </form>
      </LoginFrame>
    );
  }

  if (mode === 'setup') {
    return (
      <LoginFrame
        title="Set up your authenticator app"
        sub="Scan this into Google Authenticator, Microsoft Authenticator or a similar app on your phone."
      >
        {!setup && !error && <p className="portal-login__sub">Preparing…</p>}
        {setup && (
          <form onSubmit={submit}>
            <ol className="portal-steps">
              <li>Open your authenticator app and add an account by scanning this code:</li>
            </ol>
            <img className="portal-qr" src={setup.qrDataUrl} alt="QR code to add this account to your authenticator app" width={200} height={200} />
            <p className="portal-secret">Can’t scan it? Enter this key instead:<br /><code>{setup.secret}</code></p>
            <ol className="portal-steps" start={2}>
              <li>Enter the 6-digit code the app now shows for “UCAA Casuals Portal”.</li>
            </ol>
            {codeField}
            {error && <div className="portal-error" role="alert">{error}</div>}
            <button type="submit" disabled={submitting || code.length !== 6}>{submitting ? 'Checking…' : 'Confirm and sign in'}</button>
            <button type="button" className="portal-login__secondary" onClick={() => { setChoice(null); setError(''); setCode(''); }}>Choose another way</button>
          </form>
        )}
        {!setup && error && (
          <>
            <div className="portal-error" role="alert">{error}</div>
            <button type="button" onClick={() => onRestart('')}>Back to sign in</button>
          </>
        )}
      </LoginFrame>
    );
  }

  if (usingEmail) {
    return (
      <LoginFrame title="Check your email" sub={`Enter the 6-digit code we’ve emailed to ${emailHint}.`}>
        <form onSubmit={submit}>
          {note && <p className="portal-login__help" style={{ margin: '0 0 14px' }}>{note}</p>}
          {codeField}
          {error && <div className="portal-error" role="alert">{error}</div>}
          <button type="submit" disabled={submitting || code.length !== 6}>{submitting ? 'Checking…' : 'Sign in'}</button>
          {resendButton}
          {method !== 'email' && (
            <button type="button" className="portal-login__secondary" onClick={() => { setChannel('app'); setError(''); setNote(''); setCode(''); }}>Use my authenticator app instead</button>
          )}
          <button type="button" className="portal-login__secondary" onClick={() => onRestart('')}>Cancel</button>
          <p className="portal-login__help">Nothing arrived? Check your spam folder, wait a minute and send a new code — or ask another System Admin to reset your two-step sign-in.</p>
        </form>
      </LoginFrame>
    );
  }

  return (
    <LoginFrame title="Enter your code" sub="Open your authenticator app and enter the 6-digit code shown for “UCAA Casuals Portal”.">
      <form onSubmit={submit}>
        {codeField}
        {error && <div className="portal-error" role="alert">{error}</div>}
        <button type="submit" disabled={submitting || code.length !== 6}>{submitting ? 'Checking…' : 'Sign in'}</button>
        <button type="button" className="portal-login__secondary" disabled={sending} onClick={switchToEmail}>{sending ? 'Sending…' : 'Email me a code instead'}</button>
        <button type="button" className="portal-login__secondary" onClick={() => onRestart('')}>Cancel</button>
        <p className="portal-login__help">Phone not with you? Use “Email me a code instead”. Lost it? Ask another System Admin to reset your two-step sign-in.</p>
      </form>
    </LoginFrame>
  );
}

// Shown instead of the portal while the account still has a password someone
// else chose (a new account, or an HR/admin reset). The API refuses
// everything else until this is done.
export function ChangePasswordScreen({ api, user, onChanged, onLogout }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!isStrongPassword(newPassword)) { setError('Your new password doesn’t meet all the requirements below it yet.'); return; }
    if (newPassword !== confirm) { setError('The new passwords don’t match.'); return; }
    if (newPassword === currentPassword) { setError('Choose a password different from the one you were given.'); return; }

    setSubmitting(true);
    try {
      await api('/api/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });
      onChanged();
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <LoginFrame
      title="Choose a new password"
      sub={`Welcome${user.name ? `, ${user.name}` : ''}. The password you were given is for your first sign-in only — choose your own to continue.`}
    >
      <form onSubmit={handleSubmit}>
        {/* Lets password managers save the new password against the right account. */}
        <input type="email" value={user.email} autoComplete="username" readOnly hidden />

        <label className="portal-field">
          <span>Password you were given</span>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        <label className="portal-field">
          <span>New password</span>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            aria-describedby="new-password-rules"
            required
          />
          <PasswordChecklist password={newPassword} id="new-password-rules" />
        </label>

        <label className="portal-field">
          <span>Confirm new password</span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>

        {error && <div className="portal-error" role="alert">{error}</div>}

        <button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save and continue'}
        </button>
        <button type="button" className="portal-login__secondary" onClick={onLogout}>
          Sign out
        </button>
      </form>
    </LoginFrame>
  );
}
