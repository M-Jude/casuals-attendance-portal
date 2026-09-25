import { useEffect, useState, useCallback, useMemo } from 'react';
import PunchHistoryModal from './PunchHistoryModal';
import ShiftRosterUploadModal from './ShiftRosterUploadModal';
import AttendanceAnalytics from './AttendanceAnalytics';
import { STATUS_LABEL, STATUS_RANK, statusClassName } from './shiftStatus';
import { downloadAuthenticated } from './downloadFile';

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
  // Defaults to just today + yesterday — a fast "what's happening now" view.
  // Everything below (analytics, table, exports) is derived from from/to, so
  // widening or narrowing this range cascades through all of it automatically.
  const [from, setFrom] = useState(daysAgoISO(1));
  const [to, setTo] = useState(todayISO());
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [selectedRow, setSelectedRow] = useState(null); // the summary row behind an open modal
  const [rosterModalOpen, setRosterModalOpen] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);

  const [filterId, setFilterId] = useState('');
  const [filterName, setFilterName] = useState('');
  const [sortBy, setSortBy] = useState('date-desc');
  const [groupBy, setGroupBy] = useState('date');
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());
  const [analyticsOpen, setAnalyticsOpen] = useState(true);

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

  async function handleExport() {
    setError('');
    const params = new URLSearchParams({ from, to });
    try {
      await downloadAuthenticated(`/api/attendance/export?${params}`, token, `casuals-attendance_${from}_to_${to}.csv`);
    } catch (err) {
      setError(err.message || 'Could not export CSV. Try again.');
    }
  }

  // The PDF is built server-side over the whole date range (not just the 500
  // rows the table loads), but takes the on-screen filters/sort/group so the
  // report matches what's being looked at.
  async function handleDownloadPdf() {
    setError('');
    setPdfBusy(true);
    const params = new URLSearchParams({ from, to, sortBy, groupBy });
    if (filterId.trim()) params.set('id', filterId.trim());
    if (filterName.trim()) params.set('name', filterName.trim());
    try {
      await downloadAuthenticated(`/api/attendance/report.pdf?${params}`, token, `casuals-attendance-report_${from}_to_${to}.pdf`);
    } catch (err) {
      setError(err.message || 'Could not generate the PDF report. Try again.');
    } finally {
      setPdfBusy(false);
    }
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
    const rosterMismatch = row.rosteredShift && row.rosteredShift.id !== row.shift.id;
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
        <td data-label="Shift">
          {row.shift.name}
          {rosterMismatch && (
            <div className="dash__roster-note" title="The roster expected a different shift than what the punches show">
              rostered: {row.rosteredShift.name}
            </div>
          )}
        </td>
        <td className="mono" data-label="In">{formatTime(row.checkIn)}</td>
        <td className="mono" data-label="Out">{formatTime(row.checkOut)}</td>
        <td className="mono" data-label="Hours">{row.hoursWorked ?? '—'}</td>
        <td data-label="Status">
          <span className={`status status--${statusClassName(row.status)}`}>
            {STATUS_LABEL[row.status] || row.status}
          </span>
          {row.earlyCheckOut && (
            <span className="status status--flag" title="Checked out well before the shift's scheduled end">
              ⚠ Early checkout
            </span>
          )}
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
      <header className="dash__topbar">
        <h1 className="dash__title">UCAA-ARK GROUP CASUALS MANAGEMENT SYSTEM</h1>
        <button className="dash__signout" onClick={onLogout}>Sign out</button>
      </header>

      <div className="dash__controlbar">
        <div className="dash__controlgroup">
          <div className="dash__controlgroup-label">Period</div>
          <div className="dash__controlgroup-row">
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
          </div>
        </div>

        <div className="dash__controlgroup">
          <div className="dash__controlgroup-label">Actions</div>
          <div className="dash__controlgroup-row">
            <button className="dash__roster" onClick={() => setRosterModalOpen(true)}>Upload Roster</button>
            <button className="dash__export" onClick={handleExport}>Export CSV</button>
            <button className="dash__pdf" onClick={handleDownloadPdf} disabled={pdfBusy}>
              {pdfBusy ? 'Preparing PDF…' : 'Download PDF'}
            </button>
          </div>
        </div>
      </div>

      <div className="dash__toolbar">
        <div className="dash__toolbar-label">Filter &amp; organize</div>
        <div className="dash__toolbar-row">
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
      </div>

      {error && <div className="dash__error" role="alert">{error}</div>}
      {!loading && !error && total > 500 && (
        <div className="dash__error" role="status">
          Showing the first 500 of {total} records for this range — narrow the date range to see all of them.
        </div>
      )}

      {!loading && sortedRows.length > 0 && (
        <section className="dash__section">
          <button
            className="dash__section-header"
            onClick={() => setAnalyticsOpen((v) => !v)}
            aria-expanded={analyticsOpen}
          >
            <span className={`dash__chevron ${analyticsOpen ? '' : 'dash__chevron--collapsed'}`}>▾</span>
            <span className="dash__section-title">Overview</span>
            <span className="dash__section-hint">at a glance for the selected period</span>
          </button>
          {analyticsOpen && <AttendanceAnalytics rows={sortedRows} />}
        </section>
      )}

      <section className="dash__section">
        <div className="dash__section-title-static">
          Detailed records
          {!loading && (
            <span className="dash__section-hint">
              {sortedRows.length} record{sortedRows.length === 1 ? '' : 's'}
            </span>
          )}
        </div>

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
      </section>

      {selectedRow && (
        <PunchHistoryModal
          token={token}
          summary={selectedRow}
          onClose={() => setSelectedRow(null)}
        />
      )}

      {rosterModalOpen && (
        <ShiftRosterUploadModal
          token={token}
          onClose={() => setRosterModalOpen(false)}
          onUploaded={loadSummaries}
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
        /* Identity bar — brand + the one account-level action. Deliberately
           quiet: everything a user actually works with lives further down. */
        .dash__topbar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 16px;
          padding-bottom: 16px;
          margin-bottom: 20px;
          border-bottom: 1px solid #24354F;
        }
        .dash__title {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 14px;
          font-weight: 400;
          letter-spacing: 0.06em;
          color: #3E8E7E;
          margin: 0;
        }
        .dash__signout {
          border: none;
          background: none;
          color: #66768A;
          font-size: 12px;
          cursor: pointer;
          font-family: inherit;
          padding: 4px 0;
        }
        .dash__signout:hover {
          color: #E8EDF2;
        }

        /* Control bar — two clearly separated clusters: "what period am I
           looking at" (left) and "what can I do with it" (right). */
        .dash__controlbar {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          flex-wrap: wrap;
          gap: 24px;
          padding-bottom: 20px;
          margin-bottom: 20px;
          border-bottom: 1px solid #1B2A40;
        }
        .dash__controlgroup {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .dash__controlgroup-label, .dash__toolbar-label {
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #66768A;
        }
        .dash__controlgroup-row, .dash__toolbar-row {
          display: flex;
          align-items: flex-end;
          gap: 12px;
          flex-wrap: wrap;
        }
        .dash__controlgroup-row label, .dash__toolbar-row label {
          display: flex;
          flex-direction: column;
          font-size: 12px;
          color: #8A99AC;
          gap: 4px;
        }
        .dash__controlgroup-row input,
        .dash__toolbar-row input,
        .dash__toolbar-row select {
          background: #16243A;
          border: 1px solid #24354F;
          color: #E8EDF2;
          padding: 7px 8px;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 13px;
        }

        /* View controls — filtering/sorting/grouping the data already
           loaded for the period above; sits right against what it governs. */
        .dash__toolbar {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-bottom: 24px;
          padding-bottom: 20px;
          border-bottom: 1px solid #1B2A40;
        }

        .dash__refresh, .dash__roster, .dash__pdf, .dash__export, .dash__toggle-all {
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
        .dash__roster:hover {
          background: #16243A;
        }
        .dash__pdf {
          background: #3E8E7E;
          border-color: #3E8E7E;
          color: #0F1B2C;
          font-weight: 600;
        }
        .dash__pdf:hover:not(:disabled) {
          background: #4EA391;
        }
        .dash__pdf:disabled {
          opacity: 0.6;
          cursor: default;
        }
        .dash__export {
          border-color: #3E8E7E;
          color: #3E8E7E;
        }
        .dash__export:hover {
          background: rgba(62, 142, 126, 0.12);
        }
        .dash__toggle-all:hover {
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

        /* Content sections — "Overview" (collapsible) and "Detailed
           records" each get their own labelled zone so it's clear which
           question each part of the page answers. */
        .dash__section {
          margin-bottom: 32px;
        }
        .dash__section-header {
          width: 100%;
          display: flex;
          align-items: baseline;
          gap: 10px;
          background: none;
          border: none;
          border-bottom: 1px solid #24354F;
          color: #E8EDF2;
          padding: 0 0 12px;
          margin-bottom: 20px;
          font-family: inherit;
          cursor: pointer;
          text-align: left;
        }
        .dash__section-title {
          font-size: 15px;
          font-weight: 700;
        }
        .dash__section-title-static {
          display: flex;
          align-items: baseline;
          gap: 10px;
          border-bottom: 1px solid #24354F;
          padding-bottom: 12px;
          margin-bottom: 20px;
          font-size: 15px;
          font-weight: 700;
        }
        .dash__section-hint {
          font-size: 11px;
          font-weight: 400;
          color: #66768A;
          margin-left: auto;
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
        .status--early {
          color: #5B8DC9;
          border-color: #2E4E77;
        }
        .status--critical {
          color: #C9535A;
          border-color: #7A3236;
        }
        .status--flag {
          color: #C9A227;
          border-color: #8A6E1B;
          margin-left: 6px;
        }
        .dash__roster-note {
          font-size: 11px;
          color: #C9535A;
          margin-top: 2px;
        }

        @media (max-width: 640px) {
          .dash { padding: 20px; }
          .dash__controlbar { flex-direction: column; gap: 20px; }
          .dash__section-hint { margin-left: 0; }
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
