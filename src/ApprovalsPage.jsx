import { useCallback, useEffect, useState } from 'react';
import { STATUS_LABEL, statusClassName } from './shiftStatus';
import { formatDateLabel, formatDateTime, formatTime } from './api';

function unitState(u) {
  if (u.status === 'approved') return { label: 'Approved', cls: 'chip--ok' };
  if (u.open) return { label: 'Shift in progress', cls: 'chip--info' };
  if (u.escalatedAt) return { label: 'Escalated', cls: 'chip--critical' };
  if (u.status === 'reopened') return { label: 'Changed — re-approve', cls: 'chip--warn' };
  return { label: 'Awaiting approval', cls: 'chip--warn' };
}

function summaryBits(byStatus) {
  const bits = [];
  if (byStatus.late) bits.push(`${byStatus.late} late`);
  if (byStatus['no-show']) bits.push(`${byStatus['no-show']} no-show`);
  if (byStatus['no-checkout']) bits.push(`${byStatus['no-checkout']} no checkout`);
  if (byStatus['no-checkin']) bits.push(`${byStatus['no-checkin']} no check-in`);
  return bits.join(' · ');
}

function RowFlags({ row }) {
  return (
    <>
      {row.source === 'exception' && <span className="chip chip--info">Exception</span>}
      {row.source === 'unscheduled' && <span className="chip chip--warn">Unscheduled</span>}
      {row.lateIn && row.status !== 'late' && <span className="chip chip--warn">Late in</span>}
      {row.earlyCheckOut && <span className="chip chip--warn">Early out</span>}
      {row.hasMultiplePunches && <span className="chip chip--warn">Multiple punches</span>}
      {(row.checkInImplied || row.checkOutImplied) && <span className="chip">Implied time</span>}
    </>
  );
}

function PendingChange({ row }) {
  if (!row.changedAfterApproval || !row.pendingValues) return null;
  const p = row.pendingValues;
  if (p.deleted) return <div className="small" style={{ color: 'var(--warn)' }}>Will be removed — no longer supported by the punches.</div>;
  return (
    <div className="small" style={{ color: 'var(--warn)' }}>
      Changed since approval → now {formatTime(p.checkIn)}–{formatTime(p.checkOut)} · {STATUS_LABEL[p.status] || p.status}
      {p.hoursWorked != null ? ` · ${p.hoursWorked} h` : ''}
    </div>
  );
}

function UnitDetail({ api, id, onBack, onApproved }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [comment, setComment] = useState('');
  const [rowComments, setRowComments] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setData(null);
    setError('');
    api(`/api/approvals/${id}`)
      .then((d) => {
        setData(d);
        setComment(d.unit.comment || '');
        setRowComments(Object.fromEntries(d.rows.map((r) => [r.id, r.supervisorComment || ''])));
      })
      .catch((err) => setError(err.message));
  }, [api, id]);

  async function approve() {
    setBusy(true);
    setError('');
    try {
      await api(`/api/approvals/${id}/approve`, { method: 'POST', body: { comment, rowComments } });
      onApproved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  if (error && !data) return <div className="page"><button className="btn btn--link" onClick={onBack}>← Back</button><div className="error">{error}</div></div>;
  if (!data) return <div className="page"><div className="empty">Loading…</div></div>;

  const { unit, rows } = data;
  const state = unitState(unit);
  const editable = unit.canApprove;
  const isMonth = unit.kind === 'hr-month';

  return (
    <div className="page">
      <button className="btn btn--link" onClick={onBack}>← All approvals</button>
      <div className="page__head" style={{ marginTop: 12 }}>
        <div>
          <h2 className="page__title">{unit.label}</h2>
          <p className="page__hint">
            <span className={`chip ${state.cls}`}>{state.label}</span>
            {unit.status !== 'approved' && !unit.open && (
              <>Approvable since {formatDateTime(unit.dueAt)}{unit.escalatesAt && !unit.escalatedAt ? ` · escalates to HR ${formatDateTime(unit.escalatesAt)}` : ''}</>
            )}
            {unit.escalatedAt && <> · escalated {formatDateTime(unit.escalatedAt)}</>}
            {unit.approvedAt && <> · approved {formatDateTime(unit.approvedAt)}{unit.approvedBy ? ` by ${unit.approvedBy.name}` : ''}</>}
          </p>
        </div>
      </div>

      {unit.changed > 0 && (
        <div className="notice">
          {unit.changed} record{unit.changed === 1 ? '' : 's'} changed after this was approved (for example a late punch synced from BioStar).
          The approved values stay in reports until you re-approve; the new values are shown under each record.
        </div>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>Worker</th>
            {isMonth && <th>Date</th>}
            <th>Shift</th>
            <th>In</th>
            <th>Out</th>
            <th>Hours</th>
            <th>Status</th>
            <th>Flags</th>
            <th style={{ width: '26%' }}>Comment</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                {r.worker.name}
                <div className="small muted mono">{r.worker.biostarUserId}</div>
              </td>
              {isMonth && <td className="mono small">{formatDateLabel(r.date)}</td>}
              <td>{r.shift.name}</td>
              <td className="mono">{formatTime(r.checkIn)}</td>
              <td className="mono">{formatTime(r.checkOut)}</td>
              <td className="mono">{r.hoursWorked ?? '—'}</td>
              <td>
                <span className={`chip chip--${{ ok: 'ok', late: 'warn', critical: 'critical', early: 'info', pending: '' }[statusClassName(r.status)] || ''}`}>
                  {STATUS_LABEL[r.status] || r.status}
                </span>
                <PendingChange row={r} />
              </td>
              <td><RowFlags row={r} /></td>
              <td>
                {editable ? (
                  <input
                    className="input"
                    style={{ width: '100%', boxSizing: 'border-box' }}
                    value={rowComments[r.id] || ''}
                    placeholder="Optional"
                    maxLength={2000}
                    onChange={(e) => setRowComments((c) => ({ ...c, [r.id]: e.target.value }))}
                  />
                ) : (
                  <span className="small muted">{r.supervisorComment || ''}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="panel" style={{ marginTop: 20 }}>
        <label className="field">
          Overall comment
          <textarea
            className="input"
            rows={3}
            value={comment}
            disabled={!editable}
            maxLength={2000}
            onChange={(e) => setComment(e.target.value)}
            placeholder={editable ? 'Anything HR or Finance should know about this shift' : ''}
          />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="form-row" style={{ marginTop: 12 }}>
          <button className="btn btn--primary" onClick={approve} disabled={!editable || busy}>
            {busy ? 'Approving…' : unit.status === 'reopened' ? 'Re-approve' : `Approve ${rows.length} record${rows.length === 1 ? '' : 's'}`}
          </button>
          {!editable && unit.cannotApproveReason && <span className="small muted">{unit.cannotApproveReason}</span>}
        </div>
      </div>
    </div>
  );
}

export default function ApprovalsPage({ api, user, onChanged }) {
  const [status, setStatus] = useState('pending');
  const [scopeAll, setScopeAll] = useState(false);
  const [units, setUnits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const canSeeAll = ['sysadmin', 'hr', 'admin_assistant'].includes(user.role);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ status });
    if (scopeAll) params.set('scope', 'all');
    api(`/api/approvals?${params}`)
      .then(({ units: list }) => setUnits(list))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [api, status, scopeAll]);

  useEffect(() => { load(); }, [load]);

  if (openId) {
    return (
      <UnitDetail
        api={api}
        id={openId}
        onBack={() => setOpenId(null)}
        onApproved={() => { setOpenId(null); load(); onChanged(); }}
      />
    );
  }

  const hint = {
    supervisor: `Approve each ${user.crewName || 'crew'} shift once it ends. Anything left unapproved for 48 hours is escalated to HR and the Admin Assistant.`,
    hr: 'Shifts escalated after 48 hours without supervisor approval, and the permanent-staff records you approve at month end.',
    admin_assistant: 'Shifts escalated after 48 hours without supervisor approval.',
    sysadmin: 'All approval batches. As System Admin you can approve any of them.'
  }[user.role];

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h2 className="page__title">Approvals</h2>
          <p className="page__hint">{hint}</p>
        </div>
        <div className="form-row">
          {canSeeAll && user.role !== 'sysadmin' && (
            <label className="checkbox"><input type="checkbox" checked={scopeAll} onChange={(e) => setScopeAll(e.target.checked)} /> Show every crew’s shifts</label>
          )}
          <label className="field">
            Show
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="pending">Waiting for approval</option>
              <option value="approved">Approved</option>
              <option value="all">All</option>
            </select>
          </label>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {loading ? (
        <div className="empty">Loading…</div>
      ) : units.length === 0 ? (
        <div className="empty">{status === 'pending' ? 'Nothing waiting for approval.' : 'No approval batches.'}</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Batch</th>
              <th>State</th>
              <th>Records</th>
              <th>Needs a look</th>
              <th>Approvable from</th>
            </tr>
          </thead>
          <tbody>
            {units.map((u) => {
              const state = unitState(u);
              return (
                <tr key={u.id} className="is-clickable" onClick={() => setOpenId(u.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setOpenId(u.id); }}>
                  <td>{u.label}</td>
                  <td>
                    <span className={`chip ${state.cls}`}>{state.label}</span>
                    {u.canApprove && <span className="chip chip--ok">You can approve</span>}
                  </td>
                  <td className="mono">
                    {u.rows}
                    {u.changed > 0 && <span className="small" style={{ color: 'var(--warn)' }}> ({u.changed} changed)</span>}
                  </td>
                  <td className="small muted">{summaryBits(u.byStatus) || '—'}</td>
                  <td className="small mono">{formatDateTime(u.dueAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
