import { useCallback, useEffect, useState } from 'react';
import Pagination from './Pagination';
import { ROLE_LABEL, formatDateLabel, todayEat } from './api';
import { downloadAuthenticated } from './downloadFile';

// Everything people have done in the portal — sign-ins, changes, approvals,
// downloads — with the IP address and device each came from. System Admin
// only; entries can't be edited or removed from here (or anywhere).

const CATEGORY_LABEL = {
  auth: 'Sign-in',
  account: 'Accounts',
  approval: 'Approvals',
  attendance: 'Attendance',
  schedule: 'Schedules',
  settings: 'Settings',
  download: 'Downloads',
  report: 'Report views',
  notification: 'Notifications',
  other: 'Other'
};
const CATEGORY_CHIP = { auth: 'chip--info', account: 'chip--warn', approval: 'chip--ok', settings: 'chip--warn', download: 'chip--info' };

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// "30 Sep 2026, 14:32:07" in Kampala — seconds matter in an audit.
function stamp(ts) {
  return new Date(ts).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Africa/Kampala'
  });
}

function DetailRow({ label, children }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div className="audit-detail__row">
      <div className="audit-detail__label">{label}</div>
      <div className="audit-detail__value">{children}</div>
    </div>
  );
}

function EntryDialog({ entry, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
    };
  }, [onClose]);

  const d = entry.details || {};
  return (
    <div className="dialog-backdrop" onClick={onClose} role="presentation">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="audit-entry-title" onClick={(e) => e.stopPropagation()}>
        <div className="dialog__head">
          <div>
            <div id="audit-entry-title" className="dialog__title">Audit entry #{entry.id}</div>
            <div className="small muted">{stamp(entry.createdAt)} EAT</div>
          </div>
          <button className="dialog__close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="dialog__body">
          <p className="audit-detail__summary">{entry.summary}</p>
          <DetailRow label="Result">
            <span className={`chip ${entry.success ? 'chip--ok' : 'chip--critical'}`}>{entry.success ? 'Succeeded' : 'Failed'}</span>
            {entry.statusCode ? <span className="small muted">HTTP {entry.statusCode}</span> : null}
          </DetailRow>
          <DetailRow label="User">
            {entry.userEmail ? <>{entry.userName || entry.userEmail}<div className="small muted">{entry.userEmail} · {ROLE_LABEL[entry.userRole] || entry.userRole}</div></> : <span className="muted">Not signed in</span>}
          </DetailRow>
          <DetailRow label="Action"><span className="mono small">{entry.action}</span> <span className={`chip ${CATEGORY_CHIP[entry.category] || ''}`}>{CATEGORY_LABEL[entry.category] || entry.category}</span></DetailRow>
          {entry.entityType && <DetailRow label="Record">{entry.entityType}{entry.entityId ? ` #${entry.entityId}` : ''}</DetailRow>}
          {d.downloadRef && <DetailRow label="Download ref"><span className="mono">{d.downloadRef}</span><div className="small muted">Printed on the downloaded file</div></DetailRow>}
          <DetailRow label="IP address"><span className="mono">{entry.ipAddress || '—'}</span></DetailRow>
          <DetailRow label="Device">{entry.device || '—'}</DetailRow>
          {entry.userAgent && <DetailRow label="User agent"><span className="small muted audit-detail__wrap">{entry.userAgent}</span></DetailRow>}
          <DetailRow label="Request"><span className="mono small audit-detail__wrap">{entry.method} {entry.path}</span></DetailRow>
          {d.before && (
            <DetailRow label="Changed">
              <table className="audit-diff">
                <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
                <tbody>
                  {Object.keys({ ...d.before, ...d.after }).map((k) => (
                    <tr key={k}><td>{k}</td><td>{String(d.before[k] ?? '—')}</td><td>{String(d.after?.[k] ?? '—')}</td></tr>
                  ))}
                </tbody>
              </table>
            </DetailRow>
          )}
          {(d.request || d.query || d.removed) && (
            <DetailRow label="Data sent">
              <pre className="audit-detail__json">{JSON.stringify(d.request || d.removed || d.query, null, 2)}</pre>
            </DetailRow>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AuditLogsPage({ api, token }) {
  const [from, setFrom] = useState(addDays(todayEat(), -6));
  const [to, setTo] = useState(todayEat());
  const [userId, setUserId] = useState('');
  const [category, setCategory] = useState('');
  const [result, setResult] = useState('');
  const [text, setText] = useState('');
  const [query, setQuery] = useState(''); // `text`, applied after a pause in typing
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(50);
  const [data, setData] = useState({ entries: [], total: 0, users: [], categories: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 350);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => { setPage(1); }, [from, to, userId, category, result, query, size]);

  const filterParams = useCallback(() => {
    const p = new URLSearchParams({ from, to });
    if (userId) p.set('userId', userId);
    if (category) p.set('category', category);
    if (result) p.set('result', result);
    if (query) p.set('q', query);
    return p;
  }, [from, to, userId, category, result, query]);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    const p = filterParams();
    p.set('page', String(page));
    p.set('size', String(size));
    api(`/api/audit?${p}`)
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [api, filterParams, page, size]);

  useEffect(() => { load(); }, [load]);

  async function exportCsv() {
    setExporting(true);
    setError('');
    try {
      await downloadAuthenticated(`/api/audit/export?${filterParams()}`, token, `audit-log_${from}_to_${to}.csv`);
      load(); // the export is itself an entry
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  }

  const pages = Math.max(1, Math.ceil(data.total / size));

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h2 className="page__title">Audit logs</h2>
          <p className="page__hint">
            Every sign-in, change, approval, report and download in the portal: who did it, when, from which IP address and device.
            Entries can&apos;t be edited or deleted. Downloads carry a reference that matches the file to its entry here.
          </p>
        </div>
        <div className="form-row audit-actions">
          <button className="btn" onClick={load} disabled={loading}>Refresh</button>
          <button className="btn btn--primary" onClick={exportCsv} disabled={exporting || data.total === 0}>{exporting ? 'Preparing…' : 'Export CSV'}</button>
        </div>
      </div>

      <div className="panel audit-filters">
        <div className="form-row">
          <label className="field">From<input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field">To<input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
          <label className="field">
            User
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Everyone</option>
              {data.users.map((u) => <option key={u.id} value={u.id}>{u.name || u.email} ({ROLE_LABEL[u.role] || u.role})</option>)}
            </select>
          </label>
          <label className="field">
            Type
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All actions</option>
              {(data.categories || []).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c] || c}</option>)}
            </select>
          </label>
          <label className="field">
            Result
            <select value={result} onChange={(e) => setResult(e.target.value)}>
              <option value="">Any</option>
              <option value="ok">Succeeded</option>
              <option value="failed">Failed</option>
            </select>
          </label>
          <label className="field field--grow">
            Search
            <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, email, IP address, device or action…" />
          </label>
        </div>
      </div>

      {error && <div className="error" role="alert">{error}</div>}

      {loading && data.entries.length === 0 ? (
        <div className="empty">Loading…</div>
      ) : data.entries.length === 0 ? (
        <div className="empty">No activity recorded for {from === to ? formatDateLabel(from) : `${formatDateLabel(from)} – ${formatDateLabel(to)}`} with these filters.</div>
      ) : (
        <>
          <table className={`table audit-table ${loading ? 'is-loading' : ''}`}>
            <thead>
              <tr><th>What happened</th><th>When (EAT)</th><th>User</th><th>IP address</th><th>Device</th><th>Result</th></tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.id} className="is-clickable" tabIndex={0} onClick={() => setOpen(e)} onKeyDown={(ev) => { if (ev.key === 'Enter') setOpen(e); }}>
                  <td>
                    <div className="audit-table__summary">{e.summary}</div>
                    <span className={`chip ${CATEGORY_CHIP[e.category] || ''}`}>{CATEGORY_LABEL[e.category] || e.category}</span>
                    {e.details?.downloadRef && <span className="chip mono">{e.details.downloadRef}</span>}
                  </td>
                  <td className="mono small audit-table__time">{stamp(e.createdAt)}</td>
                  <td>
                    {e.userEmail ? (
                      <>{e.userName || e.userEmail}<div className="small muted">{ROLE_LABEL[e.userRole] || e.userRole}</div></>
                    ) : <span className="muted">Not signed in</span>}
                  </td>
                  <td className="mono small">{e.ipAddress || '—'}</td>
                  <td className="small">{e.device || '—'}</td>
                  <td><span className={`chip ${e.success ? 'chip--ok' : 'chip--critical'}`}>{e.success ? 'OK' : 'Failed'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination total={data.total} page={Math.min(page, pages)} pages={pages} size={size} onPage={setPage} onSize={setSize} noun="entries" />
        </>
      )}

      {open && <EntryDialog entry={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
