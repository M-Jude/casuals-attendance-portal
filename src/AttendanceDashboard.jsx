import { useEffect, useState, useCallback, useMemo } from 'react';

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
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString([], { day: '2-digit', month: 'short' });
}

// Groups raw punch events into one row per worker per day. Prefers BioStar's
// own check-in/check-out classification when a device reports it, but falls
// back to the day's earliest/latest punch when it doesn't — this BioStar
// deployment's devices mostly report an unclassified punch type, so without
// the fallback every row would show blank In/Out times.
function groupByWorkerAndDay(logs) {
  const groups = new Map();

  for (const log of logs) {
    const day = new Date(log.timestamp).toDateString();
    const key = `${log.casualWorkerId}-${day}`;

    if (!groups.has(key)) {
      groups.set(key, {
        workerId: log.worker.biostarUserId,
        workerName: log.worker.name,
        date: log.timestamp,
        punches: []
      });
    }
    groups.get(key).punches.push(log);
  }

  return Array.from(groups.values()).map((row) => {
    const punches = [...row.punches].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const taggedIn = punches.filter((p) => p.eventType === 'check-in');
    const taggedOut = punches.filter((p) => p.eventType === 'check-out');

    const checkIn = taggedIn.length > 0 ? taggedIn[0].timestamp : punches[0].timestamp;
    const checkOut = taggedOut.length > 0
      ? taggedOut[taggedOut.length - 1].timestamp
      : (punches.length > 1 ? punches[punches.length - 1].timestamp : null);

    return { workerId: row.workerId, workerName: row.workerName, date: row.date, checkIn, checkOut };
  });
}

// Shared by the table and the CSV export so they can never disagree.
function getStatus(row) {
  if (row.checkIn && !row.checkOut) return 'No checkout';
  if (row.checkIn && new Date(row.checkIn).getHours() >= 9) return 'Late';
  return 'On time';
}

const STATUS_RANK = { Late: 0, 'No checkout': 1, 'On time': 2 };

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
      sorted.sort((a, b) => new Date(a.date) - new Date(b.date));
      break;
    case 'date-desc':
      sorted.sort((a, b) => new Date(b.date) - new Date(a.date));
      break;
    case 'name-asc':
      sorted.sort((a, b) => a.workerName.localeCompare(b.workerName));
      break;
    case 'name-desc':
      sorted.sort((a, b) => b.workerName.localeCompare(a.workerName));
      break;
    case 'id-asc':
      sorted.sort((a, b) => a.workerId.localeCompare(b.workerId, undefined, { numeric: true }));
      break;
    case 'id-desc':
      sorted.sort((a, b) => b.workerId.localeCompare(a.workerId, undefined, { numeric: true }));
      break;
    case 'status':
      sorted.sort((a, b) => STATUS_RANK[getStatus(a)] - STATUS_RANK[getStatus(b)]);
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
    const key = groupBy === 'date' ? new Date(row.date).toDateString() : row.workerId;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: groupBy === 'date' ? formatDate(row.date) : `${row.workerName} (${row.workerId})`,
        sortKey: groupBy === 'date' ? new Date(row.date).getTime() : row.workerName.toLowerCase(),
        rows: []
      });
    }
    groups.get(key).rows.push(row);
  }

  const list = Array.from(groups.values());
  list.sort((a, b) => {
    if (groupBy === 'date') return b.sortKey - a.sortKey; // newest date first
    return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0; // name A-Z
  });
  return list;
}

function toCSVField(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export default function AttendanceDashboard({ token, onLogout }) {
  const [from, setFrom] = useState(daysAgoISO(7));
  const [to, setTo] = useState(todayISO());
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);

  const [filterId, setFilterId] = useState('');
  const [filterName, setFilterName] = useState('');
  const [sortBy, setSortBy] = useState('date-desc');
  const [groupBy, setGroupBy] = useState('date');
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());

  const loadAttendance = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const params = new URLSearchParams({ from, to });
      const res = await fetch(`/api/attendance?${params}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (res.status === 401) {
        onLogout();
        return;
      }
      if (!res.ok) throw new Error('Request failed');

      const logs = await res.json();
      setRows(groupByWorkerAndDay(logs));
    } catch {
      setError('Could not load attendance records. Try again.');
    } finally {
      setLoading(false);
    }
  }, [from, to, token, onLogout]);

  useEffect(() => {
    loadAttendance();
  }, [loadAttendance]);

  // Triggers a fresh pull from BioStar (the same job the hourly cron runs),
  // then reloads the currently selected date range so new punches show up
  // without waiting for the next scheduled sync.
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

      await loadAttendance();
    } catch (err) {
      setError(err.message || 'Could not sync with BioStar. Try again.');
    } finally {
      setSyncing(false);
    }
  }

  const visibleRows = useMemo(() => {
    const idQuery = filterId.trim().toLowerCase();
    const nameQuery = filterName.trim().toLowerCase();
    if (!idQuery && !nameQuery) return rows;
    return rows.filter(
      (r) =>
        (!idQuery || r.workerId.toLowerCase().includes(idQuery)) &&
        (!nameQuery || r.workerName.toLowerCase().includes(nameQuery))
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

  // Exports exactly what's currently on screen (filtered + sorted) — no
  // separate BioStar/API round trip, so the CSV can never disagree with the
  // table. Accordion collapse state is purely visual, so export ignores it.
  function handleExport() {
    const header = ['Employee ID', 'Worker', 'Date', 'In', 'Out', 'Status'];
    const lines = [header.map(toCSVField).join(',')];

    for (const row of sortedRows) {
      lines.push(
        [row.workerId, row.workerName, formatDate(row.date), formatTime(row.checkIn), formatTime(row.checkOut), getStatus(row)]
          .map(toCSVField)
          .join(',')
      );
    }

    // Leading BOM so Excel (which otherwise assumes Windows-1252) reads the
    // file as UTF-8 instead of mangling the em dash into "â€”".
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `casuals-attendance_${from}_to_${to}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function renderRow(row, i) {
    const status = getStatus(row);
    return (
      <tr key={i}>
        <td className="mono" data-label="Employee ID">{row.workerId}</td>
        <td data-label="Worker">{row.workerName}</td>
        <td className="mono" data-label="Date">{formatDate(row.date)}</td>
        <td className="mono" data-label="In">{formatTime(row.checkIn)}</td>
        <td className="mono" data-label="Out">{formatTime(row.checkOut)}</td>
        <td data-label="Status">
          <span
            className={
              status === 'No checkout'
                ? 'status status--pending'
                : status === 'Late'
                  ? 'status status--late'
                  : 'status status--ok'
            }
          >
            {status}
          </span>
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
            <th>In</th>
            <th>Out</th>
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
        .dash__table tr:hover td {
          background: #16243A;
        }
        .mono {
          font-family: 'IBM Plex Mono', monospace;
        }
        .status {
          font-size: 12px;
          padding: 3px 8px;
          border: 1px solid transparent;
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
