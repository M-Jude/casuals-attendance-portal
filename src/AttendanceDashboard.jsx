import { useEffect, useState, useCallback, useMemo } from 'react';
import PunchHistoryModal from './PunchHistoryModal';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function formatTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kampala' });
}

function formatDate(dateStr) {
  // dateStr is a YYYY-MM-DD anchor date, not a timestamp — parse as UTC
  // midnight so no further timezone shifting is applied to it.
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString([], {
    day: '2-digit', month: 'short', timeZone: 'UTC'
  });
}

const STATUS_LABEL = {
  'on-time': 'On time',
  late: 'Late',
  'no-checkout': 'No checkout'
};

const STATUS_RANK = { late: 0, 'no-checkout': 1, 'on-time': 2 };

const SORT_OPTIONS = [
  { value: 'date-desc', label: 'Date (newest first)' },
  { value: 'date-asc', label: 'Date (oldest first)' },
  { value: 'name-asc', label: 'Name (A–Z)' },
  { value: 'name-desc', label: 'Name (Z–A)' },
  { value: 'id-asc', label: 'Employee ID (A–Z)' },
  { value: 'id-desc', label: 'Employee ID (Z–A)' },
  { value: 'status', label: 'Status (issues first)' }
];

const GROUP_OPTIONS = [
  { value: 'date', label: 'By date' },
  { value: 'worker', label: 'By employee' },
  { value: 'none', label: 'No grouping' }
];

function sortRows(rows, sortBy) {
  const sorted = [...rows];
  switch (sortBy) {
    case 'date-asc':
      sorted.sort((a, b) => a.date.localeCompare(b.date));
      break;
    case 'date-desc':
      sorted.sort((a, b) => b.date.localeCompare(a.date));
      break;
    case 'name-asc':
      sorted.sort((a, b) => a.worker.name.localeCompare(b.worker.name));
      break;
    case 'name-desc':
      sorted.sort((a, b) => b.worker.name.localeCompare(a.worker.name));
      break;
    case 'id-asc':
      sorted.sort((a, b) => a.worker.biostarUserId.localeCompare(b.worker.biostarUserId, undefined, { numeric: true }));
      break;
    case 'id-desc':
      sorted.sort((a, b) => b.worker.biostarUserId.localeCompare(a.worker.biostarUserId, undefined, { numeric: true }));
      break;
    case 'status':
      sorted.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
      break;
    default:
      break;
  }
  return sorted;
}

// Buckets already-sorted rows into named sections. Row order within a
// section follows the chosen sort; section order itself is always the same
// sensible default (newest date first / name A-Z) regardless of sort, so
// switching "sort by" never reshuffles which section things land in.
function groupRows(rows, groupBy) {
  if (groupBy === 'none') {
    return [{ key: 'all', label: null, rows }];
  }

  const groups = new Map();
  for (const row of rows) {
    const dateStr = row.date.slice(0, 10);
    const key = groupBy === 'date' ? dateStr : row.worker.id;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: groupBy === 'date' ? formatDate(dateStr) : `${row.worker.name} (${row.worker.biostarUserId})`,
        sortKey: groupBy === 'date' ? dateStr : row.worker.name.toLowerCase(),
        rows: []
      });
    }
    groups.get(key).rows.push(row);
  }

  const list = Array.from(groups.values());
  list.sort((a, b) => {
    if (groupBy === 'date') return b.sortKey.localeCompare(a.sortKey); // newest date first
    return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0; // name A-Z
  });
  return list;
}

export default function AttendanceDashboard({ token, onLogout }) {
  const [from, setFrom] = useState(daysAgoISO(7));
  const [to, setTo] = useState(todayISO());
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [selectedRow, setSelectedRow] = useState(null); // the summary row behind an open modal

  const [filterId, setFilterId] = useState('');
  const [filterName, setFilterName] = useState('');
  const [sortBy, setSortBy] = useState('date-desc');
  const [groupBy, setGroupBy] = useState('date');
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());

  const loadSummaries = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const params = new URLSearchParams({ from, to, limit: '500' });
      const res = await fetch(`/api/attendance/summary?${params}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (res.status === 401) {
        onLogout();
        return;
      }
      if (!res.ok) throw new Error('Request failed');

      const { summaries, total: totalCount } = await res.json();
      setRows(summaries);
      setTotal(totalCount);
    } catch {
      setError('Could not load attendance records. Try again.');
    } finally {
      setLoading(false);
    }
  }, [from, to, token, onLogout]);

  useEffect(() => {
    loadSummaries();
  }, [loadSummaries]);

  // Triggers a fresh pull from BioStar (the same job the hourly cron runs)
  // plus a recompute of the shift-aware summaries, then reloads the
  // currently selected date range so new punches show up without waiting
  // for the next scheduled sync.
  async function handleRefresh() {
    setSyncing(true);
    setError('');

    try {
      const res = await fetch('/api/attendance/sync', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });

      if (res.status === 401) {
        onLogout();
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Sync failed');
      }

      await loadSummaries();
    } catch (err) {
      setError(err.message || 'Could not sync with BioStar. Try again.');
    } finally {
      setSyncing(false);
    }
  }

  function handleExport() {
    const params = new URLSearchParams({ from, to });
    window.open(`/api/attendance/export?${params}`, '_blank');
  }

  const visibleRows = useMemo(() => {
    const idQuery = filterId.trim().toLowerCase();
    const nameQuery = filterName.trim().toLowerCase();
    if (!idQuery && !nameQuery) return rows;
    return rows.filter(
      (r) =>
        (!idQuery || r.worker.biostarUserId.toLowerCase().includes(idQuery)) &&
        (!nameQuery || r.worker.name.toLowerCase().includes(nameQuery))
    );
  }, [rows, filterId, filterName]);

  const sortedRows = useMemo(() => sortRows(visibleRows, sortBy), [visibleRows, sortBy]);
  const groups = useMemo(() => groupRows(sortedRows, groupBy), [sortedRows, groupBy]);
  const isGrouped = groupBy !== 'none';
  const allCollapsed = isGrouped && groups.length > 0 && groups.every((g) => collapsedGroups.has(g.key));

  function toggleGroup(key) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAllGroups() {
    setCollapsedGroups(allCollapsed ? new Set() : new Set(groups.map((g) => g.key)));
  }

  function renderRow(row) {
    const dateStr = row.date.slice(0, 10);
    return (
      <tr
        key={row.id}
        className="dash__row"
        onClick={() => setSelectedRow(row)}
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedRow(row); }}
      >
        <td className="mono" data-label="Employee ID">{row.worker.biostarUserId}</td>
        <td data-label="Worker">{row.worker.name}</td>
        <td className="mono" data-label="Date">{formatDate(dateStr)}</td>
        <td data-label="Shift">{row.shift.name}</td>
        <td className="mono" data-label="In">{formatTime(row.checkIn)}</td>
        <td className="mono" data-label="Out">{formatTime(row.checkOut)}</td>
        <td className="mono" data-label="Hours">{row.hoursWorked ?? '—'}</td>
        <td data-label="Status">
          <span className={`status status--${row.status === 'no-checkout' ? 'pending' : row.status === 'late' ? 'late' : 'ok'}`}>
            {STATUS_LABEL[row.status] || row.status}
          </span>
          {row.hasMultiplePunches && (
            <span className="status status--flag" title="More than one check-in or check-out was recorded — open for details">
              ⚠ Multiple punches
            </span>
          )}
        </td>
      </tr>
    );
  }

  function renderTable(rowsToRender) {
    return (
      <table className="dash__table">
        <thead>
          <tr>
            <th>Employee ID</th>
            <th>Worker</th>
            <th>Date</th>
            <th>Shift</th>
            <th>In</th>
            <th>Out</th>
            <th>Hours</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>{rowsToRender.map(renderRow)}</tbody>
      </table>
    );
  }

  return (
    <div className="dash">
      <header className="dash__header">
        <div className="dash__title">CASUALS ATTENDANCE</div>
        <div className="dash__controls">
          <label>
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button className="dash__refresh" onClick={handleRefresh} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Refresh'}
          </button>
          <button className="dash__export" onClick={handleExport}>Export CSV</button>
          <button className="dash__signout" onClick={onLogout}>Sign out</button>
        </div>
      </header>

      <div className="dash__toolbar">
        <label>
          Employee ID
          <input
            type="text"
            placeholder="Filter by ID…"
            value={filterId}
            onChange={(e) => setFilterId(e.target.value)}
          />
        </label>
        <label>
          Name
          <input
            type="text"
            placeholder="Filter by name…"
            value={filterName}
            onChange={(e) => setFilterName(e.target.value)}
          />
        </label>
        <label>
          Sort by
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </label>
        <label>
          Group by
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
            {GROUP_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </label>
        {isGrouped && groups.length > 0 && (
          <button className="dash__toggle-all" onClick={toggleAllGroups}>
            {allCollapsed ? 'Expand All' : 'Collapse All'}
          </button>
        )}
      </div>

      {error && <div className="dash__error" role="alert">{error}</div>}
      {!loading && !error && total > 500 && (
        <div className="dash__error" role="status">
          Showing the first 500 of {total} records for this range — narrow the date range to see all of them.
        </div>
      )}

      {loading ? (
        <div className="dash__empty">Loading attendance records…</div>
      ) : sortedRows.length === 0 ? (
        <div className="dash__empty">No attendance records match the current filters.</div>
      ) : !isGrouped ? (
        renderTable(sortedRows)
      ) : (
        <div className="dash__accordion">
          {groups.map((group) => {
            const collapsed = collapsedGroups.has(group.key);
            return (
              <div className="dash__group" key={group.key}>
                <button
                  className="dash__group-header"
                  onClick={() => toggleGroup(group.key)}
                  aria-expanded={!collapsed}
                >
                  <span className={`dash__chevron ${collapsed ? 'dash__chevron--collapsed' : ''}`}>▾</span>
                  <span className="dash__group-label">{group.label}</span>
                  <span className="dash__group-count">{group.rows.length}</span>
                </button>
                {!collapsed && renderTable(group.rows)}
              </div>
            );
          })}
        </div>
      )}

      {selectedRow && (
        <PunchHistoryModal
          token={token}
          summary={selectedRow}
          onClose={() => setSelectedRow(null)}
        />
      )}

      <style>{`
        .dash {
          min-height: 100vh;
          background: #0F1B2C;
          color: #E8EDF2;
          font-family: 'IBM Plex Sans', system-ui, sans-serif;
          padding: 32px 40px;
          box-sizing: border-box;
        }
        .dash__header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 16px;
          border-bottom: 1px solid #24354F;
          padding-bottom: 20px;
          margin-bottom: 20px;
        }
        .dash__title {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 14px;
          letter-spacing: 0.06em;
          color: #3E8E7E;
        }
        .dash__controls {
          display: flex;
          align-items: flex-end;
          gap: 16px;
          flex-wrap: wrap;
        }
        .dash__controls label, .dash__toolbar label {
          display: flex;
          flex-direction: column;
          font-size: 12px;
          color: #8A99AC;
          gap: 4px;
        }
        .dash__controls input,
        .dash__toolbar input,
        .dash__toolbar select {
          background: #16243A;
          border: 1px solid #24354F;
          color: #E8EDF2;
          padding: 7px 8px;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 13px;
        }
        .dash__toolbar {
          display: flex;
          align-items: flex-end;
          gap: 16px;
          flex-wrap: wrap;
          margin-bottom: 24px;
          padding-bottom: 20px;
          border-bottom: 1px solid #1B2A40;
        }
        .dash__refresh, .dash__export, .dash__signout, .dash__toggle-all {
          border: 1px solid #24354F;
          background: transparent;
          color: #E8EDF2;
          padding: 8px 14px;
          font-size: 13px;
          cursor: pointer;
          font-family: inherit;
        }
        .dash__refresh:disabled {
          opacity: 0.6;
          cursor: default;
        }
        .dash__refresh:hover:not(:disabled) {
          background: #16243A;
        }
        .dash__export {
          border-color: #3E8E7E;
          color: #3E8E7E;
        }
        .dash__export:hover {
          background: rgba(62, 142, 126, 0.12);
        }
        .dash__signout:hover, .dash__toggle-all:hover {
          background: #16243A;
        }
        .dash__error {
          color: #C9A227;
          font-size: 13px;
          margin-bottom: 16px;
        }
        .dash__empty {
          color: #8A99AC;
          font-size: 14px;
          padding: 40px 0;
          text-align: center;
        }
        .dash__accordion {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .dash__group {
          border: 1px solid #1B2A40;
        }
        .dash__group-header {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 10px;
          background: #16243A;
          border: none;
          color: #E8EDF2;
          padding: 10px 14px;
          font-size: 13px;
          font-family: inherit;
          cursor: pointer;
          text-align: left;
        }
        .dash__chevron {
          display: inline-block;
          color: #3E8E7E;
          transition: transform 0.15s ease;
        }
        .dash__chevron--collapsed {
          transform: rotate(-90deg);
        }
        .dash__group-label {
          font-family: 'IBM Plex Mono', monospace;
          flex: 1;
        }
        .dash__group-count {
          color: #8A99AC;
          font-size: 12px;
        }
        .dash__table {
          width: 100%;
          border-collapse: collapse;
          font-size: 14px;
        }
        .dash__table th {
          text-align: left;
          font-size: 12px;
          font-weight: 500;
          color: #8A99AC;
          padding: 10px 12px;
          border-bottom: 1px solid #24354F;
        }
        .dash__table td {
          padding: 12px;
          border-bottom: 1px solid #1B2A40;
        }
        .dash__row {
          cursor: pointer;
        }
        .dash__row:hover td, .dash__row:focus td {
          background: #16243A;
        }
        .dash__row:focus {
          outline: none;
        }
        .dash__row:focus td:first-child {
          box-shadow: inset 3px 0 0 #3E8E7E;
        }
        .mono {
          font-family: 'IBM Plex Mono', monospace;
        }
        .status {
          font-size: 12px;
          padding: 3px 8px;
          border: 1px solid transparent;
          display: inline-block;
        }
        .status--ok {
          color: #3E8E7E;
          border-color: #2A5F53;
        }
        .status--late {
          color: #C9A227;
          border-color: #8A6E1B;
        }
        .status--pending {
          color: #8A99AC;
          border-color: #3A4A61;
        }
        .status--flag {
          color: #C9A227;
          border-color: #8A6E1B;
          margin-left: 6px;
        }

        @media (max-width: 640px) {
          .dash { padding: 20px; }
          .dash__table thead { display: none; }
          .dash__table, .dash__table tbody, .dash__table tr, .dash__table td {
            display: block;
            width: 100%;
          }
          .dash__table tr {
            border-bottom: 1px solid #24354F;
            padding: 10px 0;
          }
          .dash__table td {
            border-bottom: none;
            padding: 3px 0;
          }
          .dash__table td:before {
            content: attr(data-label);
            color: #8A99AC;
            font-size: 11px;
            display: inline-block;
            width: 90px;
          }
        }
      `}</style>
    </div>
  );
}
