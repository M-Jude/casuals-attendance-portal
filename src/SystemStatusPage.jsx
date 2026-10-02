import { useCallback, useEffect, useState } from 'react';
import { ROLE_LABEL, formatDateTime } from './api';

// Is the portal healthy? For System Admins (UCAA ICT) and Auditors.
// Read-only; refreshes every minute.

const STATUS = {
  ok: { label: 'OK', cls: 'chip--ok' },
  warn: { label: 'Needs attention', cls: 'chip--warn' },
  error: { label: 'Problem', cls: 'chip--critical' }
};
const OVERALL = {
  ok: 'Everything is working.',
  warn: 'Working, but something needs attention.',
  error: 'Something isn’t working — see below.'
};

const when = (v) => (v ? formatDateTime(v) : '—');

function Row({ label, children }) {
  return (
    <div className="status__row">
      <span className="status__label">{label}</span>
      <span className="status__value">{children ?? '—'}</span>
    </div>
  );
}

function Details({ section }) {
  const d = section.details || {};
  switch (section.id) {
    case 'application':
      return (
        <>
          <Row label="Version">{d.commit ? (d.commit === 'manual' ? 'Deployed by hand' : <span className="mono">{d.commit.slice(0, 7)}</span>) : 'Unknown'}</Row>
          <Row label="Deployed">{when(d.deployedAt)}{d.runUrl && <> · <a href={d.runUrl} target="_blank" rel="noreferrer">GitHub run</a></>}</Row>
          <Row label="Last deploy">{d.lastDeploy ? `${d.lastDeploy.at} — ${d.lastDeploy.ok ? 'succeeded' : 'failed'}` : '—'}</Row>
          <Row label="Running since">{when(d.startedAt)}</Row>
          <Row label="Public address">{d.publicUrl}</Row>
          <Row label="Node.js">{d.nodeVersion}</Row>
          <Row label="Sync settings">Re-checks the last {d.syncLookbackDays} days hourly; live sync every {d.liveSyncMinutes ? `${d.liveSyncMinutes} min` : '— (off)'}</Row>
        </>
      );
    case 'database':
      return <Row label="Response time">{d.responseMs !== undefined ? `${d.responseMs} ms` : '—'}</Row>;
    case 'biostar':
      return (
        <>
          <Row label="Last hourly / manual sync">{when(d.lastFullSyncAt)}</Row>
          <Row label="Last live sync">{when(d.lastLiveSyncAt)}</Row>
          <Row label="Newest punch on record">{when(d.newestPunchAt)}</Row>
          {d.lastFullSyncError && <Row label="Last sync error">{when(d.lastFullSyncFailedAt)} — {d.lastFullSyncError}</Row>}
          {d.lastLiveSyncError && <Row label="Last live-sync error">{d.lastLiveSyncError}</Row>}
        </>
      );
    case 'email':
      return (
        <>
          <Row label="Mail server">{d.host || 'Not set'}</Row>
          <Row label="Sent from">{d.from}</Row>
          <Row label="Last sent">{when(d.lastOkAt)}</Row>
          {d.lastError && <Row label="Last failure">{when(d.lastErrorAt)} — {d.lastError}</Row>}
        </>
      );
    case 'setup':
      return (
        <>
          <Row label="Shifts">{d.shifts?.length ? d.shifts.join(', ') : 'None'}</Row>
          <Row label="Active workers">{d.activeWorkers}</Row>
          <Row label="Crews">{d.crews}</Row>
        </>
      );
    case 'accounts':
      return (
        <>
          <Row label="Active accounts">{d.active !== undefined ? `${d.active} (${d.disabled} disabled)` : '—'}</Row>
          <Row label="By role">{d.byRole ? Object.entries(d.byRole).map(([r, n]) => `${ROLE_LABEL[r] || r}: ${n}`).join(' · ') : '—'}</Row>
          <Row label="System Admins">{d.systemAdmins !== undefined ? `${d.systemAdmins} active, ${d.systemAdminsWithTwoStep} with two-step sign-in` : '—'}</Row>
          <Row label="On a temporary password">{d.onTemporaryPassword}</Row>
        </>
      );
    case 'approvals':
      return (
        <>
          <Row label="Waiting for approval">{d.waiting}</Row>
          <Row label="Escalated to HR">{d.escalated}</Row>
        </>
      );
    default:
      return null;
  }
}

export default function SystemStatusPage({ api }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api('/api/system/status')
      .then((d) => { setData(d); setError(''); })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => {
    load();
    const id = setInterval(load, 60 * 1000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h2 className="page__title">System status</h2>
          <p className="page__hint">
            {data ? <><span className={`chip ${STATUS[data.overall].cls}`}>{STATUS[data.overall].label}</span> {OVERALL[data.overall]} Checked {formatDateTime(data.checkedAt)}.</> : 'Checking…'}
          </p>
        </div>
        <button className="btn" onClick={load} disabled={loading}>{loading ? 'Checking…' : 'Check again'}</button>
      </div>
      {error && <div className="error">{error}</div>}
      {data && (
        <div className="cards">
          {data.sections.map((s) => (
            <div className={`card status status--${s.status}`} key={s.id}>
              <div className="form-row" style={{ justifyContent: 'space-between' }}>
                <h3 className="card__title">{s.title}</h3>
                <span className={`chip ${STATUS[s.status].cls}`}>{STATUS[s.status].label}</span>
              </div>
              <p className="card__sub">{s.summary}</p>
              <Details section={s} />
            </div>
          ))}
        </div>
      )}
      <p className="small muted" style={{ marginTop: 16 }}>
        Sync and email results are kept in memory, so they start blank after the portal restarts (e.g. after a deploy) until the next sync or email.
      </p>
    </div>
  );
}
