import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatDateLabel, formatDateTime, todayEat } from './api';
import { usePagination } from './Pagination';
import SupervisorDecision from './SupervisorDecision';
import { useSort } from './useSort';
import { isAlreadyDone, useBusy, useToast } from './toast';

function addDays(dateStr, n) {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

const EDITORS = ['sysadmin', 'hr', 'admin_assistant'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function ShiftChip({ shifts }) {
  if (!shifts || shifts.length === 0) return <span className="chip">Off</span>;
  return shifts.map((s) => <span key={s} className={`chip ${s === 'Day' ? 'chip--day' : 'chip--night'}`}>{s}</span>);
}

function describePattern(pattern) {
  const word = { D: 'Day', N: 'Night', O: 'Off' };
  return pattern.split('').map((c) => word[c]).join(', ');
}

// ------------------------------------------------------------------ crews

function RotationForm({ initial, submitLabel, onSubmit, withName }) {
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState(initial?.pattern || 'DDNNOO');
  const [anchorDate, setAnchorDate] = useState(initial?.anchorDate || todayEat());
  const [effectiveFrom, setEffectiveFrom] = useState(todayEat());
  const [error, setError] = useState('');
  const toast = useToast();
  const { guard, busy } = useBusy();

  // On success the caller closes the form and confirms; on failure it stays
  // open with what was entered.
  function submit(e) {
    e.preventDefault();
    return guard(async () => {
      setError('');
      try {
        await onSubmit({ name, pattern: pattern.toUpperCase(), anchorDate, effectiveFrom });
      } catch (err) {
        setError(err.message);
        toast.error(err.message);
      }
    });
  }

  return (
    <form onSubmit={submit}>
      <div className="form-row">
        {withName && (
          <label className="field">Crew name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        )}
        <label className="field">
          Cycle (D Day · N Night · O off)
          <input value={pattern} onChange={(e) => setPattern(e.target.value)} pattern="[DNOdno]{2,31}" required style={{ width: 120 }} />
        </label>
        <label className="field">A day the crew starts the cycle<input type="date" value={anchorDate} onChange={(e) => setAnchorDate(e.target.value)} required /></label>
        <label className="field">Effective from<input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required /></label>
        <button className="btn btn--primary" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
      </div>
      <p className="small muted" style={{ margin: '8px 0 0' }}>
        {describePattern(pattern.toUpperCase().replace(/[^DNO]/g, '')) || '—'}. Dates before “effective from” keep the cycle that applied then.
      </p>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

function CrewsTab({ api, user }) {
  const [crews, setCrews] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const toast = useToast();
  const { guard, isBusy } = useBusy();
  const isAdmin = user.role === 'sysadmin';
  const canSeeProposals = ['sysadmin', 'hr', 'admin_assistant'].includes(user.role);

  const load = useCallback(() => {
    setError('');
    api('/api/crews').then((d) => setCrews(d.crews)).catch((err) => setError(err.message));
    if (canSeeProposals) api('/api/crews/proposals').then((d) => setProposals(d.proposals)).catch(() => {});
  }, [api, canSeeProposals]);

  useEffect(() => { load(); }, [load]);

  function resolve(p, action) {
    return guard(`proposal-${p.id}`, async () => {
      setError('');
      try {
        await api(`/api/crews/proposals/${p.id}/${action}`, { method: 'POST' });
        toast.success(action === 'apply'
          ? `${p.crew.name}’s new cycle applied from ${formatDateLabel(p.effectiveFrom)}. Attendance has been recalculated.`
          : `Cycle change for ${p.crew.name} dismissed.`);
        load();
      } catch (err) {
        if (isAlreadyDone(err)) { toast.info(err.message); load(); return; }
        setError(err.message);
        toast.error(`Couldn’t ${action} the cycle change: ${err.message}`);
      }
    });
  }

  function rename(crew) {
    const name = window.prompt('Crew name', crew.name);
    if (!name || name.trim() === crew.name) return undefined;
    return guard(`rename-${crew.id}`, async () => {
      try {
        await api(`/api/crews/${crew.id}`, { method: 'PATCH', body: { name } });
        toast.success(`${crew.name} renamed to ${name.trim()}.`);
        load();
      } catch (err) {
        setError(err.message);
        toast.error(`Couldn’t rename ${crew.name}: ${err.message}`);
      }
    });
  }

  return (
    <>
      {error && <div className="error">{error}</div>}

      {proposals.map((p) => (
        <div className="notice" key={p.id}>
          <strong>{p.crew.name}: cycle change detected.</strong> Most of the crew has been punching on a different cycle since{' '}
          {formatDateLabel(p.effectiveFrom)} ({p.evidence?.membersPreferringNew} of {p.evidence?.membersConsidered} workers).
          Detected cycle: {describePattern(p.pattern)} starting {formatDateLabel(p.anchorDate)}.
          {isAdmin ? (
            <div className="form-row" style={{ marginTop: 10 }}>
              <button className="btn btn--primary btn--small" disabled={isBusy(`proposal-${p.id}`)} onClick={() => resolve(p, 'apply')}>Apply from {formatDateLabel(p.effectiveFrom)}</button>
              <button className="btn btn--small" disabled={isBusy(`proposal-${p.id}`)} onClick={() => resolve(p, 'dismiss')}>Dismiss</button>
            </div>
          ) : (
            <div className="small muted" style={{ marginTop: 6 }}>Waiting for the System Admin to apply or dismiss it.</div>
          )}
        </div>
      ))}

      <div className="cards">
        {crews.map((c) => (
          <div className="card" key={c.id}>
            <div className="form-row" style={{ justifyContent: 'space-between' }}>
              <h3 className="card__title">{c.name}</h3>
              {isAdmin && <button className="btn btn--link small" disabled={isBusy(`rename-${c.id}`)} onClick={() => rename(c)}>Rename</button>}
            </div>
            <p className="card__sub">
              {c.members} worker{c.members === 1 ? '' : 's'} · Supervisor: {c.supervisors.map((s) => s.name).join(', ') || 'none yet'}
            </p>
            {c.rotation ? (
              <div className="card__row">Cycle: <strong>{describePattern(c.rotation.pattern)}</strong> <span className="small">(since {formatDateLabel(c.rotation.effectiveFrom)})</span></div>
            ) : (
              <div className="card__row">No cycle set.</div>
            )}
            <div className="card__row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              {c.upcoming.map((u, i) => (
                <div key={u.date} style={{ textAlign: 'center' }}>
                  <div className="small muted">{i === 0 ? 'Today' : DAY_NAMES[new Date(`${u.date}T00:00:00Z`).getUTCDay()]}</div>
                  <ShiftChip shifts={u.shifts} />
                </div>
              ))}
            </div>
            {isAdmin && (
              <div style={{ marginTop: 12 }}>
                {editing === c.id ? (
                  <RotationForm
                    initial={c.rotation}
                    submitLabel="Change cycle"
                    onSubmit={async (v) => {
                      await api(`/api/crews/${c.id}/rotations`, { method: 'POST', body: v });
                      toast.success(`${c.name}’s cycle changed from ${formatDateLabel(v.effectiveFrom)}. Attendance has been recalculated.`);
                      setEditing(null);
                      load();
                    }}
                  />
                ) : (
                  <button className="btn btn--small" onClick={() => setEditing(c.id)}>Change cycle…</button>
                )}
              </div>
            )}
            {c.history.length > 1 && (
              <details style={{ marginTop: 10 }}>
                <summary className="small muted">Cycle history</summary>
                {c.history.map((h) => (
                  <div key={h.id} className="small muted">From {formatDateLabel(h.effectiveFrom)}: {h.pattern}, starting {formatDateLabel(h.anchorDate)}{h.note ? ` — ${h.note}` : ''}</div>
                ))}
              </details>
            )}
          </div>
        ))}
      </div>

      {crews.length === 0 && <div className="empty">No crews yet.{isAdmin ? ' Run scripts/bootstrapSchedules.js to detect them from punches, or create one below.' : ''}</div>}

      {isAdmin && (
        <div className="panel">
          {creating ? (
            <>
              <h3 className="panel__title">New crew</h3>
              <RotationForm
                withName
                submitLabel="Create crew"
                onSubmit={async (v) => {
                  await api('/api/crews', { method: 'POST', body: v });
                  toast.success(`Crew ${v.name.trim()} created.`);
                  setCreating(false);
                  load();
                }}
              />
            </>
          ) : (
            <button className="btn" onClick={() => setCreating(true)}>New crew…</button>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- workers

function ScheduleEditor({ api, worker, crews, onSaved, onCancel }) {
  const [value, setValue] = useState(worker.schedule.type === 'crew' ? `crew:${worker.schedule.crewId}` : worker.schedule.type);
  // A worker's first-ever schedule covers their whole history by default:
  // from the day before their first punch (so a Night whose check-out was
  // that first punch is covered too). A change to an existing schedule
  // starts today by default.
  const firstSchedule = !worker.hasSchedule && worker.firstPunchDate;
  const historyStart = firstSchedule ? addDays(worker.firstPunchDate, -1) : null;
  const [effectiveFrom, setEffectiveFrom] = useState(historyStart || todayEat());
  const [error, setError] = useState('');
  const [decision, setDecision] = useState(null); // set when the worker is a supervisor being moved
  const toast = useToast();
  const { guard, busy } = useBusy();

  function save(supervisorAction) {
    return guard(async () => {
      setError('');
      const [type, crewId] = value.startsWith('crew:') ? ['crew', Number(value.slice(5))] : [value, null];
      const label = type === 'crew' ? crews.find((c) => c.id === crewId)?.name : { 'fixed-day': 'Permanent Day', 'fixed-night': 'Permanent Night', unassigned: 'Unassigned' }[type];
      try {
        await api(`/api/workers/${worker.id}/schedule`, { method: 'POST', body: { type, crewId, effectiveFrom, supervisorAction } });
        toast.success(`${worker.name} is now on ${label} from ${formatDateLabel(effectiveFrom)}. Their attendance has been recalculated.`);
        onSaved();
      } catch (err) {
        if (err.data?.decision) setDecision(err.data.decision);
        else {
          setError(err.message);
          toast.error(`Couldn’t change ${worker.name}’s schedule: ${err.message}`);
        }
      }
    });
  }

  if (decision) {
    return <SupervisorDecision decision={decision} busy={busy} onChoose={(action) => save(action)} onCancel={() => setDecision(null)} />;
  }

  return (
    <div>
      <div className="form-row">
        <select className="input" value={value} onChange={(e) => setValue(e.target.value)}>
          {crews.map((c) => <option key={c.id} value={`crew:${c.id}`}>{c.name}</option>)}
          <option value="fixed-day">Permanent Day</option>
          <option value="fixed-night">Permanent Night</option>
          <option value="unassigned">Unassigned</option>
        </select>
        <label className="field">from<input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></label>
        <button className="btn btn--primary btn--small" onClick={() => save()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button className="btn btn--small" onClick={onCancel}>Cancel</button>
      </div>
      {firstSchedule && (
        <p className="small muted" style={{ margin: '6px 0 0' }}>
          {effectiveFrom === historyStart
            ? `Their first schedule — applies to all their shifts on record (first badge ${formatDateLabel(worker.firstPunchDate)}).`
            : 'Their first schedule — shifts before this date stay judged without a schedule.'}
        </p>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function WorkersTab({ api, user }) {
  const [workers, setWorkers] = useState([]);
  const [crews, setCrews] = useState([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');
  const canEdit = EDITORS.includes(user.role);

  const load = useCallback(() => {
    api('/api/workers').then((d) => setWorkers(d.workers)).catch((err) => setError(err.message));
    api('/api/crews').then((d) => setCrews(d.crews)).catch(() => {});
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return workers.filter((w) =>
      (!q || w.name.toLowerCase().includes(q) || w.biostarUserId.toLowerCase().includes(q)) &&
      (filter === 'all' || (filter === 'unassigned' ? w.schedule.type === 'unassigned' : filter === 'differs' ? w.suggestion?.differs : w.schedule.label === filter))
    );
  }, [workers, query, filter]);

  const { sorted: sortedWorkers, th, sortKey } = useSort(visible, {
    id: (w) => w.biostarUserId,
    worker: (w) => w.name,
    schedule: (w) => w.schedule.label,
    today: (w) => (w.today.length ? w.today.join(' + ') : 'Off'),
    pattern: (w) => w.suggestion?.label
  });
  const { pageItems: pageWorkers, pager } = usePagination(sortedWorkers, { id: 'schedule-workers', defaultSize: 50, noun: 'workers', resetKey: `${query}|${filter}|${sortKey}` });

  const scheduleLabels = [...new Set(workers.map((w) => w.schedule.label))].filter((l) => l !== 'Unassigned').sort();

  return (
    <>
      <div className="form-row" style={{ marginBottom: 16 }}>
        <label className="field field--grow">Search<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name or employee ID" /></label>
        <label className="field">
          Show
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">Everyone</option>
            {scheduleLabels.map((l) => <option key={l} value={l}>{l}</option>)}
            <option value="unassigned">Unassigned</option>
            <option value="differs">Punches suggest a different schedule</option>
          </select>
        </label>
      </div>
      {error && <div className="error">{error}</div>}
      <table className="table">
        <thead>
          <tr>
            {th('id', 'ID')}
            {th('worker', 'Worker')}
            {th('schedule', 'Schedule')}
            {th('today', 'Today')}
            {th('pattern', 'Punch pattern')}
            {canEdit && <th />}
          </tr>
        </thead>
        <tbody>
          {pageWorkers.map((w) => (
            <tr key={w.id}>
              <td className="mono small">{w.biostarUserId}</td>
              <td>
                {w.name}
                {w.status !== 'active' && <span className="chip">inactive</span>}
                {w.account && (
                  <span className={`chip ${w.account.role === 'supervisor' ? 'chip--info' : ''}`} title={w.account.active ? 'Has a portal account' : 'Portal account disabled'}>
                    {w.account.role === 'supervisor' ? 'Supervisor' : 'Portal account'}{w.account.active ? '' : ' (disabled)'}
                  </span>
                )}
              </td>
              <td>
                {editing === w.id ? (
                  <ScheduleEditor api={api} worker={w} crews={crews} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
                ) : (
                  <>
                    {w.schedule.label}
                    {w.schedule.effectiveFrom && <div className="small muted">since {formatDateLabel(w.schedule.effectiveFrom)}</div>}
                  </>
                )}
              </td>
              <td><ShiftChip shifts={w.today} /></td>
              <td className="small">
                {w.suggestion ? (
                  <>
                    <span className={w.suggestion.differs ? '' : 'muted'}>{w.suggestion.label}</span>{' '}
                    <span className="muted">({Math.round(w.suggestion.confidence * 100)}% · {w.suggestion.completeShifts} shifts)</span>
                    {w.suggestion.differs && <span className="chip chip--warn">differs</span>}
                  </>
                ) : <span className="muted">not enough punches yet</span>}
              </td>
              {canEdit && (
                <td>{editing !== w.id && <button className="btn btn--small" onClick={() => setEditing(w.id)}>Change</button>}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {visible.length === 0 && <div className="empty">No workers match.</div>}
      {pager}
    </>
  );
}

// ---------------------------------------------------------- pattern review

function ReviewTab({ api }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(todayEat());
  const [pending, setPending] = useState(null); // { item, decision } while HR decides about a supervisor
  const toast = useToast();
  const { guard, isBusy } = useBusy();
  const { sorted: sortedItems, th, sortKey } = useSort(items, {
    worker: (i) => i.name,
    current: (i) => i.current,
    suggested: (i) => i.suggested,
    evidence: { get: (i) => i.confidence, first: 'desc' }
  });
  const { pageItems: pageReview, pager } = usePagination(sortedItems, { id: 'pattern-review', defaultSize: 25, noun: 'workers', resetKey: sortKey });

  const load = useCallback(() => {
    setLoading(true);
    api('/api/pattern-review')
      .then((d) => setItems(d.items))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  function act(item, action, supervisorAction) {
    return guard(item.workerId, async () => {
      setError('');
      try {
        await api(`/api/pattern-review/${item.workerId}/${action}`, { method: 'POST', body: { effectiveFrom, supervisorAction } });
        toast.success(action === 'accept'
          ? `${item.name} moved to ${item.suggested} from ${formatDateLabel(effectiveFrom)}.`
          : `Suggestion for ${item.name} dismissed.`);
        setPending(null);
        setItems((list) => list.filter((i) => i.workerId !== item.workerId));
      } catch (err) {
        // Accepting would move a supervisor off their crew — ask first.
        if (err.data?.decision) setPending({ item, decision: err.data.decision });
        else {
          setError(err.message);
          toast.error(`Couldn’t ${action} the suggestion for ${item.name}: ${err.message}`);
        }
      }
    });
  }

  return (
    <>
      <p className="page__hint" style={{ marginBottom: 16 }}>
        The system checks everyone’s punches every night against each crew’s cycle and against permanent Day or Night work.
        These workers’ recent punches fit a different schedule than the one they’re on — for example someone who now looks
        like a permanent Day worker. Accepting changes their schedule from the date below; dismissing hides this suggestion
        until the pattern changes again.
      </p>
      <div className="form-row" style={{ marginBottom: 16 }}>
        <label className="field">Apply accepted changes from<input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></label>
      </div>
      {error && <div className="error">{error}</div>}
      {pending && (
        <SupervisorDecision
          decision={pending.decision}
          onChoose={(choice) => act(pending.item, 'accept', choice)}
          onCancel={() => setPending(null)}
        />
      )}
      {loading ? <div className="empty">Loading…</div> : items.length === 0 ? <div className="empty">Nothing to review.</div> : (
        <table className="table">
          <thead>
            <tr>
              {th('worker', 'Worker')}
              {th('current', 'Currently')}
              {th('suggested', 'Punches fit')}
              {th('evidence', 'Evidence', { title: 'Sort by how clearly the punches fit (margin over the next best)' })}
              <th />
            </tr>
          </thead>
          <tbody>
            {pageReview.map((i) => (
              <tr key={i.workerId}>
                <td>{i.name}<div className="small muted mono">{i.biostarUserId}</div></td>
                <td>{i.current}</td>
                <td><strong>{i.suggested}</strong></td>
                <td className="small muted">
                  {i.completeShifts} complete shifts · {Math.round(i.confidence * 100)}% margin over next best
                  {i.details?.topCandidates && (
                    <div>{i.details.topCandidates.map((c) => `${c.label}: ${c.score}`).join(' · ')}</div>
                  )}
                  <div>checked {formatDateTime(i.computedAt)}</div>
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn btn--primary btn--small" disabled={!i.canAccept || isBusy(i.workerId)} title={i.canAccept ? '' : 'No crew is on this rotation yet'} onClick={() => act(i, 'accept')}>Accept</button>{' '}
                  <button className="btn btn--small" disabled={isBusy(i.workerId)} onClick={() => act(i, 'dismiss')}>Dismiss</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!loading && pager}
    </>
  );
}

// -------------------------------------------------------------- exceptions

const EXCEPTION_OPTIONS = [
  { value: 'Day', label: 'Day only', shifts: ['Day'] },
  { value: 'Night', label: 'Night only', shifts: ['Night'] },
  { value: 'Day,Night', label: 'Double shift (Day + Night)', shifts: ['Day', 'Night'] },
  { value: '', label: 'Off', shifts: [] }
];

function describeException(shifts) {
  if (shifts.length === 2) return 'Double shift';
  if (shifts.length === 0) return 'Off';
  return `${shifts[0]} only`;
}

function ExceptionsTab({ api }) {
  const [exceptions, setExceptions] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [workerId, setWorkerId] = useState('');
  const [date, setDate] = useState(todayEat());
  const [choice, setChoice] = useState('Day,Night');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const toast = useToast();
  const { guard, isBusy } = useBusy();
  const { sorted: sortedExceptions, th, sortKey } = useSort(exceptions, {
    date: (ex) => ex.date,
    worker: (ex) => ex.worker.name,
    works: (ex) => describeException(ex.shifts)
  });
  const { pageItems: pageExceptions, pager } = usePagination(sortedExceptions, { id: 'exceptions', defaultSize: 25, noun: 'exceptions', resetKey: sortKey });

  const load = useCallback(() => {
    api('/api/exceptions').then((d) => setExceptions(d.exceptions)).catch((err) => setError(err.message));
  }, [api]);

  useEffect(() => {
    load();
    api('/api/workers').then((d) => setWorkers(d.workers.filter((w) => w.status === 'active'))).catch(() => {});
  }, [api, load]);

  // Saving the same worker + date again just updates it (the server upserts),
  // so a repeat is harmless; the guard still stops a double click.
  function save(e) {
    e.preventDefault();
    return guard('save', async () => {
      setError('');
      const option = EXCEPTION_OPTIONS.find((o) => o.value === choice);
      const who = workers.find((w) => String(w.id) === String(workerId))?.name || 'the worker';
      try {
        await api('/api/exceptions', { method: 'PUT', body: { workerId: Number(workerId), date, shifts: option.shifts, note } });
        const works = option.shifts.length ? `works ${option.label.replace(/^\w/, (c) => c.toLowerCase())}` : 'is off';
        toast.success(`Exception saved: ${who} ${works} on ${formatDateLabel(date)}. Attendance for that date has been recalculated.`);
        setNote('');
        load();
      } catch (err) {
        setError(err.message);
        toast.error(`Couldn’t save the exception: ${err.message}`);
      }
    });
  }

  function remove(ex) {
    if (!window.confirm(`Remove the exception for ${ex.worker.name} on ${formatDateLabel(ex.date)}? They go back to their normal schedule for that date.`)) return undefined;
    return guard(`remove-${ex.id}`, async () => {
      try {
        await api(`/api/exceptions/${ex.id}`, { method: 'DELETE' });
        toast.success(`Exception removed: ${ex.worker.name} is back on their normal schedule for ${formatDateLabel(ex.date)}.`);
        load();
      } catch (err) {
        if (isAlreadyDone(err)) { toast.info(err.message); load(); return; }
        setError(err.message);
        toast.error(`Couldn’t remove the exception: ${err.message}`);
      }
    });
  }

  return (
    <>
      <div className="panel">
        <h3 className="panel__title">Record an exception</h3>
        <p className="page__hint" style={{ marginBottom: 12 }}>
          For one date, override what a worker was scheduled to work: covering another shift, a double shift (both count),
          or a day off. Night shifts are dated by the evening they start.
        </p>
        <form onSubmit={save}>
          <div className="form-row">
            <label className="field field--grow">
              Worker
              <select value={workerId} onChange={(e) => setWorkerId(e.target.value)} required>
                <option value="">Choose…</option>
                {workers.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.biostarUserId}) — {w.schedule.label}</option>)}
              </select>
            </label>
            <label className="field">Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label>
            <label className="field">
              Works
              <select value={choice} onChange={(e) => setChoice(e.target.value)}>
                {EXCEPTION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="field field--grow">Note<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. covering for …" maxLength={180} /></label>
            <button className="btn btn--primary" disabled={!workerId || isBusy('save')}>{isBusy('save') ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
        {error && <div className="error">{error}</div>}
      </div>

      {exceptions.length === 0 ? <div className="empty">No exceptions in the last two weeks or the coming month.</div> : (
        <table className="table">
          <thead>
            <tr>{th('date', 'Date')}{th('worker', 'Worker')}{th('works', 'Works')}<th>Note</th><th /></tr>
          </thead>
          <tbody>
            {pageExceptions.map((ex) => (
              <tr key={ex.id}>
                <td className="mono small">{formatDateLabel(ex.date)}</td>
                <td>{ex.worker.name}<div className="small muted mono">{ex.worker.biostarUserId}</div></td>
                <td>{describeException(ex.shifts)} <ShiftChip shifts={ex.shifts} /></td>
                <td className="small muted">{ex.note || ''}</td>
                <td><button className="btn btn--danger btn--small" disabled={isBusy(`remove-${ex.id}`)} onClick={() => remove(ex)}>{isBusy(`remove-${ex.id}`) ? 'Removing…' : 'Remove'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pager}
    </>
  );
}

export default function SchedulesPage({ api, user, tab, onTab }) {
  const tabs = [
    { id: 'crews', label: 'Crews' },
    { id: 'workers', label: 'Workers' },
    ...(['sysadmin', 'hr'].includes(user.role) ? [{ id: 'review', label: 'Pattern review' }] : []),
    { id: 'exceptions', label: 'Exceptions' }
  ];
  const active = tabs.some((t) => t.id === tab) ? tab : 'crews';

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h2 className="page__title">Schedules</h2>
          <p className="page__hint">
            Who is expected on which shift. Crews rotate through their cycle; permanent staff always work the same shift;
            exceptions override a single date. Attendance is judged against this, so a missed or extra punch only ever
            affects its own shift.
          </p>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={active === t.id} onClick={() => onTab(t.id)}>{t.label}</button>
        ))}
      </div>
      {active === 'crews' && <CrewsTab api={api} user={user} />}
      {active === 'workers' && <WorkersTab api={api} user={user} />}
      {active === 'review' && <ReviewTab api={api} />}
      {active === 'exceptions' && <ExceptionsTab api={api} user={user} />}
    </div>
  );
}
