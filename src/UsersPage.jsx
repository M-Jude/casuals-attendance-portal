import { useCallback, useEffect, useState } from 'react';
import { ROLE_LABEL } from './api';

function UserRow({ api, account, crews, canEdit, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [crewId, setCrewId] = useState(account.crewId || '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function patch(body) {
    setError('');
    try {
      await api(`/api/users/${account.id}`, { method: 'PATCH', body });
      setEditing(false);
      setPassword('');
      onSaved();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <tr>
      <td>{account.name || '—'}{!account.active && <span className="chip chip--critical">disabled</span>}</td>
      <td className="mono small">{account.email}</td>
      <td>{ROLE_LABEL[account.role] || account.role}</td>
      <td>{account.crew?.name || '—'}</td>
      <td>
        {canEdit && !editing && <button className="btn btn--small" onClick={() => setEditing(true)}>Manage</button>}
        {editing && (
          <div>
            {account.role === 'supervisor' && (
              <div className="form-row">
                <select className="input" value={crewId} onChange={(e) => setCrewId(e.target.value)}>
                  {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <button className="btn btn--small" onClick={() => patch({ crewId: Number(crewId) })}>Change crew</button>
              </div>
            )}
            <div className="form-row" style={{ marginTop: 6 }}>
              <input className="input" type="password" placeholder="New password (8+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} />
              <button className="btn btn--small" disabled={password.length < 8} onClick={() => patch({ password })}>Reset password</button>
            </div>
            <div className="form-row" style={{ marginTop: 6 }}>
              <button className={`btn btn--small ${account.active ? 'btn--danger' : ''}`} onClick={() => patch({ active: !account.active })}>
                {account.active ? 'Disable account' : 'Re-enable account'}
              </button>
              <button className="btn btn--link small" onClick={() => setEditing(false)}>Close</button>
            </div>
            {error && <div className="error">{error}</div>}
          </div>
        )}
      </td>
    </tr>
  );
}

export default function UsersPage({ api, user }) {
  const [users, setUsers] = useState([]);
  const [canCreate, setCanCreate] = useState([]);
  const [crews, setCrews] = useState([]);
  const [form, setForm] = useState({ name: '', email: '', role: '', crewId: '', password: '' });
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const load = useCallback(() => {
    api('/api/users')
      .then((d) => {
        setUsers(d.users);
        setCanCreate(d.canCreate);
        setForm((f) => ({ ...f, role: f.role || d.canCreate[0] || '' }));
      })
      .catch((err) => setError(err.message));
    api('/api/crews').then((d) => setCrews(d.crews)).catch(() => {});
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  async function create(e) {
    e.preventDefault();
    setError('');
    setSaved('');
    try {
      await api('/api/users', {
        method: 'POST',
        body: { ...form, crewId: form.role === 'supervisor' ? Number(form.crewId) : null }
      });
      setSaved(`Account created for ${form.email}. Share the password with them securely.`);
      setForm((f) => ({ ...f, name: '', email: '', password: '' }));
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h2 className="page__title">Users</h2>
          <p className="page__hint">
            {user.role === 'hr'
              ? 'Create accounts for shift supervisors, Finance and the Admin Assistant. Each supervisor leads one crew.'
              : 'All portal accounts. As System Admin you can create any role, including HR.'}
          </p>
        </div>
      </div>

      <div className="panel">
        <h3 className="panel__title">New account</h3>
        <form onSubmit={create}>
          <div className="form-row">
            <label className="field">Name<input value={form.name} onChange={set('name')} required /></label>
            <label className="field">Email<input type="email" value={form.email} onChange={set('email')} required /></label>
            <label className="field">
              Role
              <select value={form.role} onChange={set('role')}>
                {canCreate.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            </label>
            {form.role === 'supervisor' && (
              <label className="field">
                Leads crew
                <select value={form.crewId} onChange={set('crewId')} required>
                  <option value="">Choose…</option>
                  {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            )}
            <label className="field">Initial password<input type="password" value={form.password} onChange={set('password')} minLength={8} required /></label>
            <button className="btn btn--primary">Create</button>
          </div>
        </form>
        {error && <div className="error">{error}</div>}
        {saved && <div className="success">{saved}</div>}
      </div>

      <table className="table">
        <thead>
          <tr><th>Name</th><th>Email</th><th>Role</th><th>Crew</th><th /></tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <UserRow key={u.id} api={api} account={u} crews={crews} canEdit={canCreate.includes(u.role) && u.id !== user.id} onSaved={load} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
