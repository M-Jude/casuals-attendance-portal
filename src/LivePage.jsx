import { useCallback, useEffect, useRef, useState } from 'react';

// Live view of a crew's current shift: who's on site, who hasn't come in,
// who has left. Refreshes itself every REFRESH_MS while the page is visible;
// the server pulls new badges from BioStar every couple of minutes.
const REFRESH_MS = 30 * 1000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Clock time in Kampala for a timestamp (ms).
function clock(ms) {
  return new Date(ms + 3 * 3600 * 1000).toISOString().slice(11, 16);
}
function dayLabel(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
function duration(minutes) {
  if (minutes == null) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')} m` : `${m} min`;
}
function ago(ms, now) {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min ago`;
}

// Board sections, in the order a supervisor needs them.
const GROUPS = [
  { state: 'late', title: 'Not in yet', hint: 'past the grace period with no badge', tone: 'critical' },
  { state: 'due', title: 'Expected', hint: 'not due yet', tone: 'muted' },
  { state: 'on-site', title: 'On site', hint: '', tone: 'ok' },
  { state: 'left', title: 'Left', hint: 'clocked out', tone: 'info' },
  { state: 'out-only', title: 'Badged out only', hint: 'no check-in recorded', tone: 'warn' },
  { state: 'absent', title: 'Absent', hint: 'no badge for the whole shift', tone: 'critical' }
];

function PersonCard({ p }) {
  let line;
  if (p.state === 'on-site') line = <>In {clock(p.checkIn)} · <strong>{duration(p.onSiteMinutes)}</strong> on site</>;
  else if (p.state === 'left') line = <>In {clock(p.checkIn)} · out {clock(p.checkOut)}</>;
  else if (p.state === 'out-only') line = <>Out {clock(p.checkOut)}</>;
  else if (p.state === 'late') line = <><strong>{duration(p.minutesLate)}</strong> since the shift started</>;
  else if (p.state === 'absent') line = 'No badge this shift';
  else line = 'Not due yet';
  return (
    <div className={`live-card live-card--${p.state}`}>
      <div className="live-card__top">
        <div className="live-card__name">{p.worker.name}</div>
        <span className="live-card__id">{p.worker.biostarUserId}</span>
      </div>
      <div className="live-card__line">{line}</div>
      {(p.lateIn || p.earlyOut || p.cover || p.badges > 2) && (
        <div className="tags live-card__tags">
          {p.lateIn && <span className="tag tag--late-in">Late in</span>}
          {p.earlyOut && <span className="tag tag--early-out">Early out</span>}
          {p.cover && <span className="chip chip--info" title="Working this shift and approved by this crew’s supervisor, but not on the crew’s schedule (no schedule, or covering)">Not on crew</span>}
          {p.badges > 2 && <span className="chip" title="More than two badges this shift">{p.badges} badges</span>}
        </div>
      )}
    </div>
  );
}

export default function LivePage({ api, user }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [crewId, setCrewId] = useState('');
  const [loadedAt, setLoadedAt] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(false);
  const timer = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api(`/api/live${crewId ? `?crewId=${crewId}` : ''}`);
      setData(d);
      setError('');
      setLoadedAt(Date.now());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [api, crewId]);

  // Poll while the page is visible; catch up at once when it comes back.
  useEffect(() => {
    load();
    const schedule = () => {
      clearInterval(timer.current);
      if (!document.hidden) timer.current = setInterval(load, REFRESH_MS);
    };
    const onVisibility = () => { if (!document.hidden) load(); schedule(); };
    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer.current);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);

  // The "x s ago" labels tick every few seconds.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const shift = data?.shift;
  const people = data?.people || [];
  const phaseLabel = !shift ? '' : !shift.current
    ? `Next shift starts ${dayLabel(shift.date)} at ${shift.startTime}`
    : shift.phase === 'upcoming'
      ? `Starts in ${duration(Math.max(0, Math.round((shift.start - now) / 60000)))}`
      : shift.phase === 'in-progress'
        ? `In progress · ${duration(Math.round((now - shift.start) / 60000))} in, ${duration(Math.max(0, Math.round((shift.end - now) / 60000)))} to go`
        : `Ended ${ago(shift.end, now)} — late check-outs still showing`;

  return (
    <div className="page live">
      <div className="page__head">
        <div>
          <h2 className="page__title">Live</h2>
          <p className="page__hint">
            Who’s in right now{data?.crew ? ` on ${data.crew.name}` : ''}. Updates by itself every 30 seconds; badges reach it within a couple of minutes of the door.
          </p>
        </div>
        <div className="live__controls">
          {data?.crews?.length > 0 && (
            <label className="field">
              Crew
              <select value={crewId || data.crew.id} onChange={(e) => setCrewId(e.target.value)}>
                {data.crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
          <button className="btn" onClick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
        </div>
      </div>

      <div className="live__status" role="status">
        <span className={`live__dot ${error ? 'live__dot--off' : ''}`} aria-hidden="true" />
        {error
          ? <span className="error" style={{ margin: 0 }}>{error}</span>
          : <span>Updated {ago(loadedAt, now)} · BioStar last pulled {ago(data?.lastSyncAt ? new Date(data.lastSyncAt).getTime() : null, now)}</span>}
      </div>

      {data && !shift && <div className="empty">{data.crew.name} has no shifts in its cycle.</div>}

      {shift && (
        <>
          <div className={`live-shift live-shift--${shift.current ? shift.phase : 'off'}`}>
            <div>
              <div className="live-shift__label">{shift.current ? `${data.crew.name} is on` : `${data.crew.name} is off now`}</div>
              <div className="live-shift__title">{shift.name} shift · {dayLabel(shift.date)}, {shift.startTime} – {shift.endTime}</div>
            </div>
            <div className="live-shift__phase">{phaseLabel}</div>
          </div>

          <div className="live-kpis">
            <div className="live-kpi"><span className="live-kpi__value">{data.counts.expected}</span><span className="live-kpi__label">On the crew</span></div>
            <div className="live-kpi live-kpi--ok"><span className="live-kpi__value">{data.counts.onSite}</span><span className="live-kpi__label">On site</span></div>
            <div className="live-kpi live-kpi--critical"><span className="live-kpi__value">{data.counts.late + data.counts.absent}</span><span className="live-kpi__label">Not in</span></div>
            <div className="live-kpi live-kpi--warn"><span className="live-kpi__value">{data.counts.lateIn}</span><span className="live-kpi__label">Late in</span></div>
            <div className="live-kpi live-kpi--info"><span className="live-kpi__value">{data.counts.left}</span><span className="live-kpi__label">Left</span></div>
            {data.counts.covers > 0 && <div className="live-kpi"><span className="live-kpi__value">{data.counts.covers}</span><span className="live-kpi__label">Also working</span></div>}
          </div>

          <div className="live-layout">
            <div className="live-board">
              {people.length === 0 && <div className="empty">Nobody is scheduled on this shift.</div>}
              {GROUPS.map((g) => {
                const list = people.filter((p) => p.state === g.state).sort((a, b) => a.worker.name.localeCompare(b.worker.name));
                if (!list.length) return null;
                return (
                  <section key={g.state} className={`live-group live-group--${g.tone}`}>
                    <h3 className="live-group__title">{g.title} <span className="live-group__count">{list.length}</span>{g.hint && <span className="live-group__hint">{g.hint}</span>}</h3>
                    <div className="live-grid">{list.map((p) => <PersonCard key={p.worker.id} p={p} />)}</div>
                  </section>
                );
              })}
            </div>
            <aside className="live-feed">
              <h3 className="live-group__title">Latest badges</h3>
              {data.feed.length === 0 ? <p className="small muted">No badges yet this shift.</p> : (
                <ol className="live-feed__list">
                  {data.feed.map((f, i) => (
                    <li key={`${f.at}-${f.worker.id}-${i}`}>
                      <span className="live-feed__time">{clock(f.at)}</span>
                      <span className="live-feed__name">{f.worker.name}</span>
                    </li>
                  ))}
                </ol>
              )}
            </aside>
          </div>
        </>
      )}
      {!data && !error && <div className="empty">Loading…</div>}
      {user.role === 'supervisor' && !user.crewId && <div className="empty">Your account isn’t linked to a crew yet.</div>}
    </div>
  );
}
