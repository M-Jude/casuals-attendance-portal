import { useCallback, useEffect, useRef, useState } from 'react';
import { TAG_LABEL, statusTags, isGuessed, GUESSED_TITLE } from './shiftStatus';
import StatusTags from './StatusTags';
import { useSort } from './useSort';

// Status column sort: Late in + Early out, then Late in, then Early out, then blank.
const STATUS_ORDER_KEY = { 'late-in,early-out': 0, 'late-in': 1, 'early-out': 2 };
import { formatDateLabel, formatDateTime, formatTime } from './api';
import { usePagination } from './Pagination';
import { isAlreadyDone, useToast } from './toast';

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
  if (byStatus['no-show']) bits.push(`${byStatus['no-show']} absent`);
  if (byStatus['no-checkout']) bits.push(`${byStatus['no-checkout']} no checkout`);
  if (byStatus['no-checkin']) bits.push(`${byStatus['no-checkin']} no check-in`);
  return bits.join(' · ');
}

function RowFlags({ row }) {
  return (
    <>
      {row.source === 'exception' && <span className="chip chip--info">Exception</span>}
      {row.source === 'suggested' && <span className="chip" title="No confirmed schedule yet — judged against the pattern their punches fit">Schedule not confirmed</span>}
      {row.source === 'unscheduled' && <span className="chip chip--warn">Unscheduled</span>}
      {isGuessed(row) && !row.double && <span className="chip chip--warn" title={GUESSED_TITLE}>Shift guessed</span>}
      {row.hasMultiplePunches && <span className="chip chip--warn">Multiple punches</span>}
      {(row.checkInImplied || row.checkOutImplied) && <span className="chip">Implied time</span>}
    </>
  );
}

// Half of a Day + Night double shift: the other shift is approved by its own
// supervisor; show the whole stretch so it's clear both were worked.
function DoubleNote({ row }) {
  const d = row.double;
  if (!d) return null;
  const continues = d.part === 'Day' ? `continues into the Night until ${formatTime(d.checkOut)}` : `continues from the Day, in at ${formatTime(d.checkIn)}`;
  return (
    <div className="small" style={{ color: 'var(--info)' }} title={`The ${d.partnerShift} shift is approved by ${d.partnerApprover}${d.partnerApproved ? ' (approved)' : ' (not yet approved)'}.`}>
      Double shift — 2 shifts; {continues}. {d.totalHours != null ? `${d.totalHours} h in all.` : ''}
    </div>
  );
}

function PendingChange({ row }) {
  if (!row.changedAfterApproval || !row.pendingValues) return null;
  const p = row.pendingValues;
  if (p.deleted) return <div className="small" style={{ color: 'var(--warn)' }}>Will be removed — no longer supported by the punches.</div>;
  return (
    <div className="small" style={{ color: 'var(--warn)' }}>
      Changed since approval → now {formatTime(p.checkIn)}–{formatTime(p.checkOut)}
      {statusTags(p).map((t) => ` · ${TAG_LABEL[t]}`).join('')}
      {p.hoursWorked != null ? ` · ${p.hoursWorked} h` : ''}
    </div>
  );
}

function UnitDetail({ api, id, onBack, onApproved }) {
  const toast = useToast();
  const approving = useRef(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [comment, setComment] = useState('');
  const [rowComments, setRowComments] = useState({});
  const [busy, setBusy] = useState(false);
  // Comments typed on one page are kept when paging — they live in rowComments.
  const { sorted: sortedRows, th, sortKey } = useSort(data?.rows || [], {
    worker: (r) => r.worker.name,
    date: (r) => r.date,
    shift: (r) => r.shift.name,
    in: (r) => r.checkIn,
    out: (r) => r.checkOut,
    hours: { get: (r) => r.hoursWorked, first: 'desc' },
    status: (r) => STATUS_ORDER_KEY[statusTags(r).join(',')]
  });
  const { pageItems: pageRows, pager } = usePagination(sortedRows, { id: 'approval-rows', defaultSize: 50, noun: 'records', resetKey: `${id}|${sortKey}` });

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
    if (approving.current) return; // a second click while the first is still going
    approving.current = true;
    setBusy(true);
    setError('');
    const label = data?.unit?.label || 'this batch';
    try {
      await api(`/api/approvals/${id}/approve`, { method: 'POST', body: { comment, rowComments } });
      toast.success(`Approved: ${label}.`);
      onApproved();
    } catch (err) {
      if (isAlreadyDone(err)) {
        // Someone (or an earlier click) got there first — show the current state.
        toast.info(`${label} has already been approved.`);
        onApproved();
        return;
      }
      setError(err.message);
      toast.error(`Couldn’t approve ${label}: ${err.message}`);
      approving.current = false;
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
            {th('worker', 'Worker')}
            {isMonth && th('date', 'Date')}
            {th('shift', 'Shift')}
            {th('in', 'In')}
            {th('out', 'Out')}
            {th('hours', 'Hours')}
            {th('status', 'Status')}
            <th>Flags</th>
            <th style={{ width: '26%' }}>Comment</th>
          </tr>
        </thead>
        <tbody>
          {pageRows.map((r) => (
            <tr key={r.id}>
              <td>
                {r.worker.name}
                <div className="small muted mono">{r.worker.biostarUserId}</div>
              </td>
              {isMonth && <td className="mono small">{formatDateLabel(r.date)}</td>}
              <td>
                {r.shift.name}
                {r.double && <div><span className="tag tag--double">Double shift</span></div>}
              </td>
              {/* For half of a double shift: the changeover stands in for a missing in/out, and the hours are this shift's share. */}
              <td className="mono">{formatTime(r.checkIn || (r.double?.part === 'Night' ? r.double.changeover : null))}</td>
              <td className="mono">{formatTime(r.checkOut || (r.double?.part === 'Day' ? r.double.changeover : null))}</td>
              <td className="mono" title={r.double ? 'This shift\'s share of the double shift' : undefined}>{(r.double ? r.double.shareHours : r.hoursWorked) ?? '—'}</td>
              <td>
                {r.double ? <StatusTags tags={r.double.part === 'Day' ? statusTags(r).filter((t) => t !== 'early-out') : statusTags(r).filter((t) => t !== 'late-in')} /> : <StatusTags row={r} />}
                <PendingChange row={r} />
                <DoubleNote row={r} />
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
      {pager}

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
  const STATE_ORDER = { Escalated: 0, 'Changed — re-approve': 1, 'Awaiting approval': 2, 'Shift in progress': 3, Approved: 4 };
  const issues = (b) => (b.late || 0) + (b['no-show'] || 0) + (b['no-checkout'] || 0) + (b['no-checkin'] || 0);
  const { sorted: sortedUnits, th, sortKey } = useSort(units, {
    batch: (u) => u.label,
    state: (u) => STATE_ORDER[unitState(u).label],
    records: { get: (u) => u.rows, first: 'desc' },
    issues: { get: (u) => issues(u.byStatus), first: 'desc' },
    due: { get: (u) => u.dueAt, first: 'desc' }
  });
  const { pageItems: pageUnits, pager } = usePagination(sortedUnits, { id: 'approvals', defaultSize: 25, noun: 'batches', resetKey: `${status}|${scopeAll}|${sortKey}` });

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
    sysadmin: 'All approval batches, for reference. Approving is done by each crew’s supervisor, HR and the Admin Assistant — not the System Admin.',
    auditor: 'Every approval batch for every crew: who approved it and when, their comments, escalations, and records changed after approval. Read-only.',
    director: 'Every crew’s approval batches and their history: who approved each shift and when, comments, escalations, and records changed after approval. Read-only.'
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
              {th('batch', 'Batch')}
              {th('state', 'State', { title: 'Sort by state — escalated first' })}
              {th('records', 'Records')}
              {th('issues', 'Needs a look', { title: 'Sort by number of late arrivals, absences and missing punches' })}
              {th('due', 'Approvable from')}
            </tr>
          </thead>
          <tbody>
            {pageUnits.map((u) => {
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
      {!loading && pager}
    </div>
  );
}
