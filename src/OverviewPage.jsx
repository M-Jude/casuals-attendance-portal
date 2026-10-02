import { useCallback, useEffect, useState } from 'react';

// The month at a glance: headcount, shifts and hours, attendance quality
// and approval discipline, each compared with the previous month. The
// Director's home page; also for HR, the System Admin and the Auditor.

const num = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-GB'));

function thisMonthEat() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 7);
}

// A headline figure and its change on the previous month. `lowerIsBetter`
// colours a rise in absences red rather than green.
function Tile({ label, value, sub, delta, unit = '', lowerIsBetter = false, previousLabel }) {
  let cls = 'ov__delta--flat';
  if (delta) cls = (delta > 0) !== lowerIsBetter ? 'ov__delta--good' : 'ov__delta--bad';
  return (
    <div className="ov__tile">
      <div className="ov__tile-label">{label}</div>
      <div className="ov__tile-value">{value}</div>
      {sub && <div className="ov__tile-sub">{sub}</div>}
      {delta !== null && delta !== undefined && (
        <div className={`ov__delta ${cls}`} title={`Compared with ${previousLabel}`}>
          {delta === 0 ? 'same as last month' : `${delta > 0 ? '▲' : '▼'} ${num(Math.abs(delta))}${unit} on last month`}
        </div>
      )}
    </div>
  );
}

export default function OverviewPage({ api }) {
  const [month, setMonth] = useState(thisMonthEat());
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setError('');
    api(`/api/overview?month=${month}`).then(setData).catch((err) => setError(err.message));
  }, [api, month]);

  useEffect(() => { load(); }, [load]);

  const o = data?.overview;
  const t = o?.totals;
  const c = data?.change || {};
  const prevLabel = data?.previousLabel;

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h2 className="page__title">Overview{data ? ` — ${data.label}` : ''}</h2>
          <p className="page__hint">
            Ark Group casuals at UCAA, compared with {prevLabel || 'the previous month'}.
            {data?.inProgress ? ' This month is still in progress.' : ''}
          </p>
        </div>
        <label className="field">Month<input type="month" value={month} max={thisMonthEat()} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>
      </div>

      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="empty">Loading…</div>}

      {data && (
        <>
          {data.attention.length > 0 && (
            <div className="notice">
              <strong>Worth a look</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{data.attention.map((a) => <li key={a}>{a}</li>)}</ul>
            </div>
          )}

          <div className="ov__tiles">
            <Tile label="Workers" value={num(t.workers)} sub="worked at least one shift" delta={c.workers} previousLabel={prevLabel} />
            <Tile label="Shifts worked" value={num(t.shiftsWorked)} sub={`Day ${num(t.dayShifts)} · Night ${num(t.nightShifts)}`} delta={c.shiftsWorked} previousLabel={prevLabel} />
            <Tile label="Hours worked" value={num(t.hours)} delta={c.hours} previousLabel={prevLabel} />
            <Tile label="Attendance" value={t.attendanceRate === null ? '—' : `${t.attendanceRate}%`} sub="scheduled shifts turned up for" delta={c.attendanceRate} unit=" pts" previousLabel={prevLabel} />
            <Tile label="Absent" value={num(t.noShows)} delta={c.noShows} lowerIsBetter previousLabel={prevLabel} />
            <Tile label="Late arrivals" value={num(t.late)} delta={c.late} lowerIsBetter previousLabel={prevLabel} />
            <Tile label="Early check-outs" value={num(t.earlyOut)} delta={c.earlyOut} lowerIsBetter previousLabel={prevLabel} />
            <Tile label="Missing punches" value={num(t.missingPunch)} sub="no check-in or no check-out" delta={c.missingPunch} lowerIsBetter previousLabel={prevLabel} />
            <Tile label="Double shifts" value={num(t.doubleShifts)} delta={c.doubleShifts} previousLabel={prevLabel} />
          </div>

          <div className="panel">
            <h3 className="panel__title">By crew</h3>
            {o.byCrew.length === 0 ? <div className="empty">No shifts this month.</div> : (
              <table className="table">
                <thead><tr><th>Crew</th><th>Workers</th><th>Shifts</th><th>Hours</th><th>Attendance</th><th>Absent</th><th>Late</th></tr></thead>
                <tbody>
                  {o.byCrew.map((r) => (
                    <tr key={r.crew}>
                      <td>{r.crew}</td><td>{num(r.workers)}</td><td>{num(r.shifts)}</td><td>{num(r.hours)}</td>
                      <td>{r.attendanceRate === null ? '—' : `${r.attendanceRate}%`}</td><td>{num(r.noShows)}</td><td>{num(r.late)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="cards">
            <div className="card">
              <h3 className="card__title">Approvals</h3>
              <p className="card__sub">Batches due this month (each crew’s shift, plus HR’s monthly batch for permanent staff).</p>
              <div className="status__row"><span className="status__label">Approved</span><span>{num(o.approvals.approved)} of {num(o.approvals.batches)}</span></div>
              <div className="status__row"><span className="status__label">Approved on time (within 48 h)</span><span>{o.approvals.onTimeRate === null ? '—' : `${o.approvals.onTimeRate}%`}</span></div>
              <div className="status__row"><span className="status__label">Still waiting</span><span>{num(o.approvals.waiting)}</span></div>
              <div className="status__row"><span className="status__label">Escalated to HR</span><span>{num(o.approvals.escalated)}</span></div>
              <div className="status__row"><span className="status__label">Changed after approval</span><span>{num(t.changedAfterApproval)} shift{t.changedAfterApproval === 1 ? '' : 's'}</span></div>
              <div className="status__row"><span className="status__label">Shifts approved so far</span><span>{num(t.approvedShifts)} of {num(t.shiftsWorked)}</span></div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
