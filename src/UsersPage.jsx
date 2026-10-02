import { useCallback, useEffect, useMemo, useState } from 'react';
import { ROLE_LABEL, todayEat, formatDateLabel } from './api';
import { usePagination } from './Pagination';
import { useSort } from './useSort';
import PasswordChecklist from './PasswordChecklist';
import { isStrongPassword } from './passwordPolicy';

// Roles that never have a worker record (the Director role, when added).
const NO_WORKER_LINK = ['director'];

const workerLabel = (w) => `${w.name} (${w.biostarUserId})`;

// Search box over worker records; calls onPick(worker | null).
function WorkerPicker({ workers, value, onPick, placeholder, id }) {
  const [text, setText] = useState(value ? workerLabel(value) : '');
  useEffect(() => { setText(value ? workerLabel(value) : ''); }, [value]);
  return (
    <>
      <input
        list={id}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          onPick(workers.find((w) => workerLabel(w) === e.target.value.trim()) || null);
        }}
      />
      <datalist id={id}>
        {workers.map((w) => <option key={w.id} value={workerLabel(w)} />)}
      </datalist>
    </>
  );
}

function UserRow({ api, account, crews, freeWorkers, workersById, canEdit, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [password, setPassword] = useState('');
  const [linkTo, setLinkTo] = useState(null);
  const [moveTo, setMoveTo] = useState('');
  const [moveFrom, setMoveFrom] = useState(todayEat());
  const [confirmMove, setConfirmMove] = useState(false);
  const [error, setError] = useState('');
  const isSupervisor = account.role === 'supervisor';
  const linkedWorker = account.casualWorkerId ? workersById.get(account.casualWorkerId) : null;

  async function patch(body) {
    setError('');
    try {
      await api(`/api/users/${account.id}`, { method: 'PATCH', body });
      setEditing(false);
      setPassword('');
      setLinkTo(null);
      setConfirmMove(false);
      onSaved();
    } catch (err) {
      setError(err.message);
    }
  }

  const targetCrew = crews.find((c) => String(c.id) === String(moveTo));

  return (
    <tr>
      <td>
        <div style={{ fontWeight: 600 }}>{account.name || '—'}{!account.active && <span className="chip chip--critical" style={{ marginLeft: 8 }}>disabled</span>}
          {account.active && account.mustChangePassword && <span className="chip chip--warn" style={{ marginLeft: 8 }} title="Still on the password they were given — they'll choose their own at their next sign-in.">temporary password</span>}</div>
        {account.worker
          ? <div className="small muted">Worker {account.worker.biostarUserId}{account.worker.status !== 'active' && ' · inactive in BioStar'}</div>
          : <div className="small muted">No worker record</div>}
      </td>
      <td className="small">{account.email}</td>
      <td>{ROLE_LABEL[account.role] || account.role}</td>
      <td>{account.crew?.name || '—'}</td>
      <td>
        {canEdit && !editing && <button className="btn btn--small" onClick={() => setEditing(true)}>Manage</button>}
        {editing && (
          <div className="manage">
            {isSupervisor && (
              <div className="manage__block">
                <div className="manage__label">Move to another crew</div>
                <p className="small muted" style={{ margin: '0 0 8px' }}>
                  A supervisor leads the crew they rotate with, so this also moves {linkedWorker ? linkedWorker.name : 'their worker record'} onto that crew’s cycle.
                </p>
                {!confirmMove ? (
                  <div className="form-row">
                    <select className="input" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                      <option value="">Choose crew…</option>
                      {crews.filter((c) => c.id !== account.crewId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <input className="input" type="date" value={moveFrom} onChange={(e) => setMoveFrom(e.target.value)} title="From" />
                    <button className="btn btn--small" disabled={!moveTo} onClick={() => setConfirmMove(true)}>Move…</button>
                  </div>
                ) : (
                  <div className="decision">
                    <div className="decision__title">Move {account.name} to {targetCrew?.name}?</div>
                    <p className="decision__body">
                      From {formatDateLabel(moveFrom)} they rotate with <strong>{targetCrew?.name}</strong> and become its supervisor.
                      {account.crew ? ` ${account.crew.name} will need a new supervisor.` : ''} To take them off supervising instead, change their schedule in Schedules → Workers.
                    </p>
                    <div className="decision__actions">
                      <button className="btn btn--primary btn--small" onClick={() => patch({ moveToCrewId: Number(moveTo), effectiveFrom: moveFrom })}>Yes, move them</button>
                      <button className="btn btn--link small" onClick={() => setConfirmMove(false)}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {!isSupervisor && !NO_WORKER_LINK.includes(account.role) && (
              <div className="manage__block">
                <div className="manage__label">Worker record</div>
                {account.worker ? (
                  <div className="form-row">
                    <span className="small">{workerLabel(account.worker)}</span>
                    <button className="btn btn--small" onClick={() => patch({ casualWorkerId: null })}>Unlink</button>
                  </div>
                ) : (
                  <div className="form-row">
                    <label className="field field--grow">
                      <WorkerPicker id={`link-${account.id}`} workers={freeWorkers} value={linkTo} onPick={setLinkTo} placeholder="Search a name or ID…" />
                    </label>
                    <button className="btn btn--small" disabled={!linkTo} onClick={() => patch({ casualWorkerId: linkTo.id })}>Link</button>
                  </div>
                )}
              </div>
            )}

            <div className="manage__block">
              <div className="manage__label">Password</div>
              <div className="form-row">
                <input className="input" type="password" placeholder="Temporary password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" aria-describedby={`reset-password-rules-${account.id}`} />
                <button className="btn btn--small" disabled={!isStrongPassword(password)} onClick={() => patch({ password })}>Reset password</button>
              </div>
              {password && <PasswordChecklist password={password} id={`reset-password-rules-${account.id}`} />}
              <p className="small muted" style={{ margin: '6px 0 0' }}>Temporary: they’ll have to choose their own at their next sign-in.</p>
            </div>
            <div className="form-row" style={{ marginTop: 10 }}>
              <button className={`btn btn--small ${account.active ? 'btn--danger' : ''}`} onClick={() => patch({ active: !account.active })}>
                {account.active ? 'Disable account' : 'Re-enable account'}
              </button>
              <button className="btn btn--link small" onClick={() => { setEditing(false); setConfirmMove(false); setError(''); }}>Close</button>
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
  const [workers, setWorkers] = useState([]);
  const [form, setForm] = useState({ name: '', email: '', role: '', password: '' });
  const [worker, setWorker] = useState(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const { sorted: sortedUsers, th, sortKey } = useSort(users, {
    name: (u) => u.name,
    email: (u) => u.email,
    role: (u) => ROLE_LABEL[u.role] || u.role,
    crew: (u) => u.crew?.name
  });
  const { pageItems: pageUsers, pager } = usePagination(sortedUsers, { id: 'users', defaultSize: 25, noun: 'accounts', resetKey: sortKey });

  const load = useCallback(() => {
    api('/api/users')
      .then((d) => {
        setUsers(d.users);
        setCanCreate(d.canCreate);
        setForm((f) => ({ ...f, role: f.role || d.canCreate[0] || '' }));
      })
      .catch((err) => setError(err.message));
    api('/api/crews').then((d) => setCrews(d.crews)).catch(() => {});
    api('/api/workers').then((d) => setWorkers(d.workers)).catch(() => {});
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const workersById = useMemo(() => new Map(workers.map((w) => [w.id, w])), [workers]);
  // Active workers not already linked to an account.
  const freeWorkers = useMemo(() => {
    const linked = new Set(users.map((u) => u.casualWorkerId).filter(Boolean));
    return workers.filter((w) => w.status === 'active' && !linked.has(w.id));
  }, [workers, users]);

  const isSupervisor = form.role === 'supervisor';
  const canLink = !NO_WORKER_LINK.includes(form.role);
  const leadsCrew = isSupervisor && worker ? (worker.schedule.type === 'crew' ? worker.schedule.label : null) : undefined;
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  function pickWorker(w) {
    setWorker(w);
    if (w) setForm((f) => ({ ...f, name: f.name || w.name }));
  }

  async function create(e) {
    e.preventDefault();
    setError('');
    setSaved('');
    if (isSupervisor && !worker) { setError('Choose the supervisor’s worker record — every supervisor is a worker.'); return; }
    try {
      await api('/api/users', { method: 'POST', body: { ...form, casualWorkerId: canLink && worker ? worker.id : null } });
      setSaved(`Account created for ${form.email}. Share the temporary password with them securely — they’ll have to choose their own when they first sign in.`);
      setForm((f) => ({ ...f, name: '', email: '', password: '' }));
      setWorker(null);
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
              ? 'Create accounts for shift supervisors, Finance and the Admin Assistant. A supervisor is one of the workers and leads the crew they rotate with.'
              : 'All portal accounts. As System Admin you can create any role, including HR.'}
            {' '}Accounts linked to a worker record also get a “My attendance” page.
          </p>
        </div>
      </div>

      <div className="panel">
        <h3 className="panel__title">New account</h3>
        <form onSubmit={create}>
          <div className="form-row">
            <label className="field">
              Role
              <select value={form.role} onChange={set('role')}>
                {canCreate.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            </label>
            {canLink && (
              <label className="field field--grow">
                {isSupervisor ? 'Worker record (required)' : 'Worker record (optional)'}
                <WorkerPicker id="new-account-worker" workers={freeWorkers} value={worker} onPick={pickWorker} placeholder="Search a name or employee ID…" />
              </label>
            )}
          </div>
          {isSupervisor && worker && (
            <p className={`small ${leadsCrew ? 'muted' : 'error'}`} style={{ margin: '10px 0 0' }}>
              {leadsCrew
                ? <>Will lead <strong>{leadsCrew}</strong> — the crew {worker.name} rotates with.</>
                : <>{worker.name} isn’t on a crew ({worker.schedule.label}). Put them on a crew in Schedules → Workers first.</>}
            </p>
          )}
          <div className="form-row" style={{ marginTop: 14 }}>
            <label className="field">Name<input value={form.name} onChange={set('name')} required placeholder={worker ? worker.name : ''} /></label>
            <label className="field">Email<input type="email" value={form.email} onChange={set('email')} required /></label>
            <label className="field">Temporary password<input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" aria-describedby="new-account-password-rules" required /></label>
            <button className="btn btn--primary" disabled={!isStrongPassword(form.password) || (isSupervisor && (!worker || !leadsCrew))}>Create</button>
          </div>
          {form.password && <PasswordChecklist password={form.password} id="new-account-password-rules" />}
        </form>
        {error && <div className="error">{error}</div>}
        {saved && <div className="success">{saved}</div>}
      </div>

      <table className="table">
        <thead>
          <tr>{th('name', 'Name')}{th('email', 'Email')}{th('role', 'Role')}{th('crew', 'Crew')}<th /></tr>
        </thead>
        <tbody>
          {pageUsers.map((u) => (
            <UserRow
              key={u.id}
              api={api}
              account={u}
              crews={crews}
              freeWorkers={freeWorkers}
              workersById={workersById}
              canEdit={canCreate.includes(u.role) && u.id !== user.id}
              onSaved={load}
            />
          ))}
        </tbody>
      </table>
      {pager}
    </div>
  );
}
