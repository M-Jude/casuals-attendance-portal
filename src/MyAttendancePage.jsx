import { useEffect, useMemo, useState } from 'react';
import { formatDateLabel, formatTime, todayEat } from './api';
import { statusTags } from './shiftStatus';
import { doubleShiftRuns, countDoubleShifts, doubleShiftTitle, possibleDoubles, POSSIBLE_DOUBLE_TITLE, normalizeDoubles, mergeDoubles } from './doubleShift';
import StatusTags from './StatusTags';
import PunchHistoryModal from './PunchHistoryModal';
import { usePagination } from './Pagination';
import { useSort } from './useSort';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function monthRange(offset) {
  const [y, m] = todayEat().split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + offset, 1));
  const last = new Date(Date.UTC(y, m + offset, 0));
  const iso = (d) => d.toISOString().slice(0, 10);
  return { from: iso(first), to: offset === 0 ? todayEat() : iso(last), label: `${MONTHS[first.getUTCMonth()]} ${first.getUTCFullYear()}` };
}

function approvalLabel(r) {
  // A Day + Night double shift: each shift is approved by its own supervisor.
  if (r.parts) {
    const [a, b] = r.parts.map(approvalLabel);
    if (a.key === b.key) return a;
    if (a.key === 'changed' || b.key === 'changed') return { key: 'changed', label: 'Changed after approval' };
    return { key: 'pending', label: `${a.key === 'approved' ? 'Day' : 'Night'} approved, ${a.key === 'approved' ? 'Night' : 'Day'} waiting` };
  }
  if (r.changedAfterApproval) return { key: 'changed', label: 'Changed after approval' };
  return r.approvedAt ? { key: 'approved', label: 'Approved' } : { key: 'pending', label: 'Waiting for approval' };
}

// The signed-in account holder's own shifts (their linked worker record).
export default function MyAttendancePage({ api, token, user }) {
  const presets = useMemo(() => [monthRange(0), monthRange(-1), monthRange(-2)], []);
  const [range, setRange] = useState(presets[0]);
  const [custom, setCustom] = useState(false);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    if (range.from > range.to) return;
    setLoading(true);
    setError('');
    api(`/api/me/attendance?from=${range.from}&to=${range.to}`)
      .then((d) => setRows(d.summaries))
      .catch((err) => { setError(err.message); setRows([]); })
      .finally(() => setLoading(false));
  }, [api, range]);

  // A Day + that evening's Night is one line (Day's clock-in to Night's
  // clock-out); the cards count the two shifts on their own.
  const records = useMemo(() => normalizeDoubles(rows), [rows]);
  const lines = useMemo(() => mergeDoubles(records), [records]);
  const { sorted, th, sortKey } = useSort(lines, {
    date: { get: (r) => r.date, first: 'desc' },
    shift: (r) => r.shift.name,
    in: (r) => r.checkIn,
    out: (r) => r.checkOut,
    hours: { get: (r) => r.hoursWorked, first: 'desc' },
    status: (r) => ({ 'late-in,early-out': 0, 'late-in': 1, 'early-out': 2 })[statusTags(r).join(',')],
    approval: (r) => approvalLabel(r).label
  });
  const { pageItems, pager } = usePagination(sorted, { id: 'my-attendance', defaultSize: 25, noun: 'shifts', resetKey: `${range.from}|${range.to}|${sortKey}` });

  const worked = records.filter((r) => r.status !== 'no-show');
  const doubles = useMemo(() => doubleShiftRuns(records), [records]);
  const possible = useMemo(() => possibleDoubles(records), [records]);
  const hours = records.reduce((a, r) => a + (r.hoursWorked || 0), 0);
  const tagged = records.map(statusTags);
  const lateIn = tagged.filter((t) => t.includes('late-in')).length;
  const earlyOut = tagged.filter((t) => t.includes('early-out')).length;
  const approved = records.filter((r) => r.approvedAt && !r.changedAfterApproval).length;

  const cards = [
    { label: 'Shifts worked', value: worked.length, sub: `${worked.filter((r) => r.shift.name !== 'Night').length} Day · ${worked.filter((r) => r.shift.name === 'Night').length} Night · ${countDoubleShifts(doubles)} double`, tone: 'navy' },
    { label: 'Hours', value: hours.toFixed(1), sub: worked.length ? `avg ${(hours / Math.max(1, records.filter((r) => r.hoursWorked != null).length)).toFixed(1)} h per shift` : 'no completed shifts', tone: 'ok' },
    { label: 'Late in', value: lateIn, sub: 'checked in after the grace period', tone: 'warn' },
    { label: 'Early out', value: earlyOut, sub: 'left before the shift ended', tone: 'critical' },
    { label: 'Approved', value: `${approved} / ${records.length}`, sub: 'shifts approved so far', tone: 'grey' }
  ];

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h2 className="page__title">My attendance</h2>
          <p className="page__hint">
            Your own shifts as recorded by BioStar{user.worker ? ` — ${user.worker.name}, ${user.worker.biostarUserId}` : ''}. Select a shift to see every badge.
          </p>
        </div>
      </div>

      <div className="panel" style={{ padding: '16px 22px' }}>
        <div className="form-row">
          <div className="segmented" role="tablist" aria-label="Period">
            {presets.map((p) => (
              <button key={p.label} type="button" role="tab" aria-selected={!custom && range.label === p.label} onClick={() => { setCustom(false); setRange(p); }}>
                {p.label}
              </button>
            ))}
            <button type="button" role="tab" aria-selected={custom} onClick={() => setCustom(true)}>Other dates</button>
          </div>
          {custom && (
            <>
              <label className="field">From<input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value, label: 'custom' }))} /></label>
              <label className="field">To<input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value, label: 'custom' }))} /></label>
            </>
          )}
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="report__kpis" style={{ padding: 0, marginBottom: 24 }}>
        {cards.map((c) => (
          <div key={c.label} className={`report__kpi report__kpi--${c.tone}`} style={{ background: 'var(--panel)' }}>
            <div className="report__kpi-label">{c.label}</div>
            <div className="report__kpi-value">{c.value}</div>
            <div className="report__kpi-sub">{c.sub}</div>
          </div>
        ))}
      </div>

      {loading ? <div className="empty">Loading…</div> : rows.length === 0 ? (
        <div className="empty">No shifts recorded for this period.</div>
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>{th('date', 'Date')}{th('shift', 'Shift')}{th('in', 'Clock in')}{th('out', 'Clock out')}{th('hours', 'Hours')}{th('status', 'Status')}{th('approval', 'Approval')}</tr>
            </thead>
            <tbody>
              {pageItems.map((r) => {
                const a = approvalLabel(r);
                return (
                  <tr key={r.id} className="is-clickable" tabIndex={0} onClick={() => setSelected(r)} onKeyDown={(e) => { if (e.key === 'Enter') setSelected(r); }}>
                    <td className="mono">{formatDateLabel(r.date)}</td>
                    <td>
                      {r.parts ? (
                        <>
                          <span className="chip chip--day">Day</span><span className="chip chip--night">Night</span>
                          <span className="tag tag--double" title="You worked the Day and the Night back to back — 2 shifts, shown as one line.">Double shift · 2 shifts</span>
                        </>
                      ) : (
                        <>
                          <span className={`chip ${r.shift.name === 'Night' ? 'chip--night' : 'chip--day'}`}>{r.shift.name}</span>
                          {doubles.has(r.id) && <span className="tag tag--double" title={doubleShiftTitle(doubles.get(r.id))}>Double shift</span>}
                          {!doubles.has(r.id) && possible.has(r.id) && <span className="tag tag--possible-double" title={POSSIBLE_DOUBLE_TITLE}>Possible double — check</span>}
                        </>
                      )}
                    </td>
                    <td className="mono">{formatTime(r.checkIn)}</td>
                    <td className="mono">{formatTime(r.checkOut)}</td>
                    <td className="mono">{r.hoursWorked ?? '—'}</td>
                    <td><StatusTags row={r} /></td>
                    <td><span className={`chip ${a.key === 'approved' ? 'chip--ok' : a.key === 'changed' ? 'chip--warn' : ''}`}>{a.label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {pager}
        </>
      )}

      {selected && <PunchHistoryModal token={token} summary={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
