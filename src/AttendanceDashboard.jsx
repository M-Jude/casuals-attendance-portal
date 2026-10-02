import { useEffect, useState, useCallback, useMemo } from 'react';
import PunchHistoryModal from './PunchHistoryModal';
import AttendanceAnalytics from './AttendanceAnalytics';
import { statusTags, isGuessed, GUESSED_TITLE } from './shiftStatus';
import { doubleShiftRuns, doubleShiftTitle, normalizeDoubles, mergeDoubles, recordsOf } from './doubleShift';
import StatusTags from './StatusTags';
import { SortHeading, sortItems } from './useSort';
import { downloadAuthenticated } from './downloadFile';
import { usePagination } from './Pagination';
import { useBusy, useToast } from './toast';

// The dashboard loads every record in the range (in chunks) so the overview
// covers all of it; the table then pages through them on screen.
const LOAD_CHUNK = 5000;
const MAX_LOADED = 50000;

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

function approvalState(row) {
  // A merged Day + Night line: each shift is approved by its own supervisor.
  if (row.parts) {
    const [a, b] = row.parts.map(approvalState);
    if (a.key === b.key) return a;
    const title = `Day: ${a.title}. Night: ${b.title}. Each shift is approved by its own supervisor.`;
    if (a.key === 'changed' || b.key === 'changed') return { key: 'changed', label: 'Changed', title };
    return { key: 'pending', label: `${a.key === 'approved' ? 'Day' : 'Night'} approved`, title };
  }
  if (row.changedAfterApproval) {
    return { key: 'changed', label: 'Changed', title: 'Changed after approval — the approved values stand until re-approved' };
  }
  if (row.approvedAt) return { key: 'approved', label: 'Approved', title: `Approved ${new Date(row.approvedAt).toLocaleString()}` };
  return { key: 'pending', label: 'Waiting', title: 'Not yet approved' };
}

// Sort fields, shared by the "Order by" dropdown and the clickable column
// headings. A sort is "<field>-<asc|desc>". Mirrored by sortRows() in
// reports/attendancePdf.js so the PDF comes out in the same order.
const STATUS_ORDER_KEY = { 'late-in,early-out': 0, 'late-in': 1, 'early-out': 2 }; // Late in / Early out first
const SORT_FIELDS = {
  date: { get: (r) => r.date, label: ['Date (oldest first)', 'Date (newest first)'], first: 'desc' },
  name: { get: (r) => r.worker.name, label: ['Name (A–Z)', 'Name (Z–A)'] },
  id: { get: (r) => r.worker.biostarUserId, label: ['Employee ID (A–Z)', 'Employee ID (Z–A)'] },
  shift: { get: (r) => r.shift.name, label: ['Shift (Day first)', 'Shift (Night first)'] },
  in: { get: (r) => r.checkIn, label: ['Clock in (earliest first)', 'Clock in (latest first)'] },
  out: { get: (r) => r.checkOut, label: ['Clock out (earliest first)', 'Clock out (latest first)'] },
  hours: { get: (r) => r.hoursWorked, label: ['Hours (fewest first)', 'Hours (most first)'], first: 'desc' },
  status: { get: (r) => STATUS_ORDER_KEY[statusTags(r).join(',')], label: ['Status (Late in / Early out first)', 'Status (Early out first)'] },
  approval: { get: (r) => approvalState(r).label, label: ['Approval (A–Z)', 'Approval (Z–A)'] }
};
// What the dropdown always offers; any other sort chosen from a heading is
// added to it while active.
const SORT_OPTIONS = ['date-desc', 'date-asc', 'name-asc', 'name-desc', 'id-asc', 'id-desc', 'status-asc'];
function sortLabel(value) {
  const [field, dir] = value.split('-');
  return SORT_FIELDS[field]?.label[dir === 'desc' ? 1 : 0] || value;
}

const GROUP_OPTIONS = [
  { value: 'date', label: 'By date' },
  { value: 'worker', label: 'By employee' },
  { value: 'none', label: 'No grouping' }
];

function sortRows(rows, sortBy) {
  const [field, dir] = sortBy.split('-');
  const f = SORT_FIELDS[field];
  return f ? sortItems(rows, f.get, dir === 'desc' ? 'desc' : 'asc') : [...rows];
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

export default function AttendanceDashboard({ token, user, onLogout }) {
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
  const toast = useToast();
  const { guard, isBusy } = useBusy();
  const [selectedRow, setSelectedRow] = useState(null); // the summary row behind an open modal
  const [pdfBusy, setPdfBusy] = useState(false);

  const [filterId, setFilterId] = useState('');
  const [filterName, setFilterName] = useState('');
  const [filterShift, setFilterShift] = useState('');
  const [filterApproval, setFilterApproval] = useState('');
  const [sortBy, setSortBy] = useState('date-desc');
  const [groupBy, setGroupBy] = useState('date');
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());
  // Phones open straight onto the records; the overview is a tap away.
  const [analyticsOpen, setAnalyticsOpen] = useState(() => !window.matchMedia('(max-width: 760px)').matches);
  const [filtersOpen, setFiltersOpen] = useState(false); // the extra filters, on phones

  const loadSummaries = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const all = [];
      let totalCount = 0;
      do {
        const params = new URLSearchParams({ from, to, limit: String(LOAD_CHUNK), offset: String(all.length) });
        const res = await fetch(`/api/attendance/summary?${params}`, {
          headers: { Authorization: `Bearer ${token}` }
        });

        if (res.status === 401) {
          onLogout();
          return;
        }
        if (!res.ok) throw new Error('Request failed');

        const { summaries, total: t } = await res.json();
        totalCount = t;
        all.push(...summaries);
        if (summaries.length === 0) break;
      } while (all.length < totalCount && all.length < MAX_LOADED);
      setRows(all);
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
  const handleRefresh = () => guard('sync', async () => {
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
      if (res.status === 409) {
        // Someone else's sync (or the hourly one) is already running.
        toast.info('A BioStar sync is already running. Wait a minute for it to finish, then reload the page to see the new figures.');
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Sync failed');
      }

      await loadSummaries();
      toast.success('Synced with BioStar — attendance is up to date.');
    } catch (err) {
      const message = err.message || 'Could not sync with BioStar. Try again.';
      setError(message);
      toast.error(message);
    } finally {
      setSyncing(false);
    }
  });

  const handleExport = () => guard('csv', async () => {
    setError('');
    const params = new URLSearchParams({ from, to });
    try {
      await downloadAuthenticated(`/api/attendance/export?${params}`, token, `casuals-attendance_${from}_to_${to}.csv`);
      toast.success('CSV downloaded.');
    } catch (err) {
      const message = err.message || 'Could not export CSV. Try again.';
      setError(message);
      toast.error(message);
    }
  });

  // The PDF is built server-side over the whole date range (not just the 500
  // rows the table loads), but takes the on-screen filters/sort/group so the
  // report matches what's being looked at.
  const handleDownloadPdf = () => guard('pdf', async () => {
    setError('');
    setPdfBusy(true);
    const params = new URLSearchParams({ from, to, sortBy, groupBy });
    if (filterId.trim()) params.set('id', filterId.trim());
    if (filterName.trim()) params.set('name', filterName.trim());
    try {
      await downloadAuthenticated(`/api/attendance/report.pdf?${params}`, token, `casuals-attendance-report_${from}_to_${to}.pdf`);
      toast.success('PDF report downloaded.');
    } catch (err) {
      const message = err.message || 'Could not generate the PDF report. Try again.';
      setError(message);
      toast.error(message);
    } finally {
      setPdfBusy(false);
    }
  });

  // Shifts worked back to back are double shifts. A Day + that evening's
  // Night is one line, from the Day's clock-in to the Night's clock-out (its
  // hours shared between the two stored shifts for the analytics); a Night +
  // the next morning's Day stays two lines. Found from every loaded row, so
  // filtering to one shift still marks them.
  const records = useMemo(() => normalizeDoubles(rows), [rows]);
  const lines = useMemo(() => mergeDoubles(records), [records]);
  const doubleShifts = useMemo(() => doubleShiftRuns(records), [records]);
  const isDoubleRow = useCallback((r) => !!r.parts || doubleShifts.has(r.id), [doubleShifts]);

  const visibleRows = useMemo(() => {
    const idQuery = filterId.trim().toLowerCase();
    const nameQuery = filterName.trim().toLowerCase();
    return lines.filter(
      (r) =>
        (!idQuery || r.worker.biostarUserId.toLowerCase().includes(idQuery)) &&
        (!nameQuery || r.worker.name.toLowerCase().includes(nameQuery)) &&
        (!filterShift || (filterShift === 'double' ? isDoubleRow(r) : r.parts ? true : r.shift.name === filterShift)) &&
        (!filterApproval || approvalState(r).key === filterApproval)
    );
  }, [lines, filterId, filterName, filterShift, filterApproval, isDoubleRow]);

  const sortedRows = useMemo(() => sortRows(visibleRows, sortBy), [visibleRows, sortBy]);
  const [sortField, sortDir] = sortBy.split('-');
  // Clicking a heading: that column in its natural first direction, or the
  // other direction if it's already the sort.
  function sortByHeading(field) {
    setSortBy(sortField === field ? `${field}-${sortDir === 'asc' ? 'desc' : 'asc'}` : `${field}-${SORT_FIELDS[field].first || 'asc'}`);
  }
  const allGroups = useMemo(() => groupRows(sortedRows, groupBy), [sortedRows, groupBy]);
  const isGrouped = groupBy !== 'none';
  const allCollapsed = isGrouped && allGroups.length > 0 && allGroups.every((g) => collapsedGroups.has(g.key));

  // Page through the rows in display order (group by group), then regroup
  // the page — a group that spills over a page break is marked continued.
  const displayRows = useMemo(() => allGroups.flatMap((g) => g.rows), [allGroups]);
  const groupOf = useMemo(() => {
    const m = new Map();
    for (const g of allGroups) for (const r of g.rows) m.set(r.id, g);
    return m;
  }, [allGroups]);
  const { pageItems: pageRows, pager } = usePagination(displayRows, {
    id: 'dashboard',
    defaultSize: 100,
    noun: 'records',
    resetKey: [from, to, filterId, filterName, filterShift, filterApproval, sortBy, groupBy].join('|')
  });
  const groups = useMemo(() => {
    const out = [];
    for (const r of pageRows) {
      const g = groupOf.get(r.id);
      const last = out[out.length - 1];
      if (last && last.key === g.key) last.rows.push(r);
      else out.push({ key: g.key, label: g.label, total: g.rows.length, continued: g.rows[0] !== r, rows: [r] });
    }
    return out;
  }, [pageRows, groupOf]);

  const activeFilters = [filterName, filterId, filterShift, filterApproval].filter(Boolean).length;

  function toggleGroup(key) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAllGroups() {
    setCollapsedGroups(allCollapsed ? new Set() : new Set(allGroups.map((g) => g.key)));
  }

  function renderRow(row) {
    const dateStr = row.date.slice(0, 10);
    const approval = approvalState(row);
    const isDouble = isDoubleRow(row);
    const note = isGuessed(row) ? { text: 'Shift guessed', warn: true, title: GUESSED_TITLE }
      : row.source === 'unscheduled' ? { text: 'Unscheduled', warn: true, title: "Worked outside this worker's schedule — a supervisor can record an exception" }
        : row.source === 'exception' && !isDouble ? { text: 'Exception' }
          : row.source === 'suggested' ? { text: 'Schedule not confirmed', title: 'No confirmed schedule yet — judged against the pattern their punches fit, pending HR confirmation' }
            : null;
    const implied = 'No badge at the double-shift changeover — split at the scheduled time';
    return (
      <tr
        key={row.id}
        className="dash__row"
        onClick={() => setSelectedRow(row)}
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedRow(row); }}
      >
        <td data-label="Worker">
          <div className="dash__name">{row.worker.name}</div>
          <div className="dash__sub mono">{row.worker.biostarUserId}</div>
        </td>
        <td className="mono" data-label="Date">{formatDate(dateStr)}</td>
        <td data-label="Shift">
          {row.parts ? (
            <>
              <span className="shift-tag shift-tag--day">Day</span> + <span className="shift-tag shift-tag--night">Night</span>
              <div>
                <span className="tag tag--double" title="Worked the Day and the Night back to back — 2 shifts, shown as one line from the Day's clock-in to the Night's clock-out. Each shift is approved by its own supervisor.">
                  Double shift · 2 shifts
                </span>
              </div>
            </>
          ) : (
            <>
              <span className={`shift-tag shift-tag--${row.shift.name === 'Night' ? 'night' : 'day'}`}>{row.shift.name}</span>
              {isDouble && <div><span className="tag tag--double" title={doubleShiftTitle(doubleShifts.get(row.id))}>Double shift</span></div>}
            </>
          )}
          {note && <div className={`dash__sub ${note.warn ? 'dash__sub--warn' : ''}`} title={note.title}>{note.text}</div>}
        </td>
        <td className="mono" data-label="In">
          {formatTime(row.checkIn)}{row.checkInImplied && <span title={implied}> *</span>}
        </td>
        <td className="mono" data-label="Out">
          {formatTime(row.checkOut)}{row.checkOutImplied && <span title={implied}> *</span>}
        </td>
        <td className="mono" data-label="Hours">{row.hoursWorked ?? '—'}</td>
        <td data-label="Status"><StatusTags row={row} /></td>
        <td data-label="Approval">
          <span className={`approval approval--${approval.key}`} title={approval.title}>{approval.label}</span>
        </td>
      </tr>
    );
  }

  function renderTable(rowsToRender) {
    return (
      <table className="dash__table">
        <thead>
          <tr>
            {[['name', 'Worker'], ['date', 'Date'], ['shift', 'Shift'], ['in', 'In'], ['out', 'Out'], ['hours', 'Hours'], ['status', 'Status'], ['approval', 'Approval']].map(([field, label]) => (
              <SortHeading key={field} label={label} active={sortField === field} dir={sortDir} onClick={() => sortByHeading(field)} />
            ))}
          </tr>
        </thead>
        <tbody>{rowsToRender.map(renderRow)}</tbody>
      </table>
    );
  }

  return (
    <div className="dash">
      <div className="page__head">
        <div>
          <h2 className="page__title">Attendance</h2>
          <p className="page__hint">Every shift in the period, worked out from the BioStar punches. Select a row to see its badges.</p>
        </div>
        <div className="dash__actions">
          {user.role !== 'finance' && (
            <button className="btn" onClick={handleRefresh} disabled={syncing} title="Pull the latest punches from BioStar">
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
          )}
          <button className="btn" onClick={handleExport} disabled={isBusy('csv')}>{isBusy('csv') ? 'Exporting…' : 'Export CSV'}</button>
          <button className="btn btn--primary" onClick={handleDownloadPdf} disabled={pdfBusy}>
            {pdfBusy ? 'Preparing…' : 'Download PDF'}
          </button>
        </div>
      </div>

      <div className="dash__filters">
        <div className="dash__filter-group">
          <label className="field">
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field">
            To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        <button
          type="button"
          className="btn dash__filters-toggle"
          onClick={() => setFiltersOpen((v) => !v)}
          aria-expanded={filtersOpen}
        >
          {filtersOpen ? 'Hide filters' : 'More filters'}
          {activeFilters > 0 && <span className="dash__count">{activeFilters}</span>}
        </button>
        <div className="dash__filter-divider" aria-hidden="true" />
        <div className={`dash__filter-group dash__filter-group--grow dash__filter-group--more ${filtersOpen ? 'is-open' : ''}`}>
          <label className="field field--grow">
            Name
            <input type="search" placeholder="Search by name…" value={filterName} onChange={(e) => setFilterName(e.target.value)} />
          </label>
          <label className="field">
            Employee ID
            <input type="search" placeholder="e.g. C0662026" value={filterId} onChange={(e) => setFilterId(e.target.value)} style={{ width: 140 }} />
          </label>
          <label className="field">
            Shift
            <select value={filterShift} onChange={(e) => setFilterShift(e.target.value)}>
              <option value="">Day &amp; Night</option>
              <option value="Day">Day</option>
              <option value="Night">Night</option>
              <option value="double">Double shifts only</option>
            </select>
          </label>
          {user.role !== 'finance' && (
            <label className="field">
              Approval
              <select value={filterApproval} onChange={(e) => setFilterApproval(e.target.value)}>
                <option value="">Any</option>
                <option value="pending">Waiting</option>
                <option value="approved">Approved</option>
                <option value="changed">Changed after approval</option>
              </select>
            </label>
          )}
        </div>
      </div>

      {error && <div className="dash__error" role="alert">{error}</div>}
      {!loading && !error && total > rows.length && (
        <div className="dash__error" role="status">
          Showing the first {rows.length} of {total} records for this range — narrow the date range to see all of them.
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
          {analyticsOpen && <AttendanceAnalytics rows={recordsOf(sortedRows)} />}
        </section>
      )}

      <section className="dash__section">
        <div className="dash__records-head">
          <div className="dash__section-title">
            Records
            {!loading && <span className="dash__count">{sortedRows.length}</span>}
          </div>
          <div className="dash__records-tools">
            <label className="dash__inline-field">
              Order by
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                {(SORT_OPTIONS.includes(sortBy) ? SORT_OPTIONS : [...SORT_OPTIONS, sortBy]).map((v) => <option key={v} value={v}>{sortLabel(v)}</option>)}
              </select>
            </label>
            <label className="dash__inline-field">
              Group
              <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                {GROUP_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
              </select>
            </label>
            {isGrouped && groups.length > 0 && (
              <button className="btn btn--small" onClick={toggleAllGroups}>
                {allCollapsed ? 'Expand all' : 'Collapse all'}
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="dash__empty">Loading attendance records…</div>
        ) : sortedRows.length === 0 ? (
          <div className="dash__empty">No attendance records match the current filters.</div>
        ) : !isGrouped ? (
          <>
            {renderTable(pageRows)}
            {pager}
          </>
        ) : (
          <>
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
                      <span className="dash__group-label">{group.label}{group.continued && <span className="dash__group-cont"> (continued)</span>}</span>
                      <span className="dash__group-count">
                        {group.rows.length === group.total ? group.total : `${group.rows.length} of ${group.total} on this page`}
                      </span>
                    </button>
                    {!collapsed && renderTable(group.rows)}
                  </div>
                );
              })}
            </div>
            {pager}
          </>
        )}
      </section>

      {selectedRow && (
        <PunchHistoryModal
          token={token}
          summary={selectedRow}
          onClose={() => setSelectedRow(null)}
        />
      )}

      <style>{`
        .dash { color: var(--text); }
        .dash__actions { display: flex; gap: 10px; flex-wrap: wrap; }

        /* One calm filter card: the period on the left, filters beside it. */
        .dash__filters {
          display: flex;
          align-items: flex-start;
          flex-wrap: wrap;
          gap: 18px;
          padding: 18px 22px;
          margin-bottom: 28px;
          background: var(--panel);
          border: 1px solid var(--line);
          border-radius: var(--radius);
          box-shadow: var(--shadow);
        }
        .dash__filter-group { display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap; }
        .dash__filter-group--grow { flex: 1; }
        .dash__filter-divider { align-self: stretch; width: 1px; background: var(--line); }

        .dash__error {
          color: var(--warn);
          background: var(--warn-bg);
          border: 1px solid var(--warn-line);
          border-radius: var(--radius-sm);
          padding: 12px 16px;
          font-size: 13.5px;
          margin-bottom: 20px;
        }
        .dash__empty {
          color: var(--muted);
          font-size: 14px;
          padding: 56px 0;
          text-align: center;
          background: var(--panel);
          border: 1px dashed var(--line-strong);
          border-radius: var(--radius);
        }

        .dash__section { margin-bottom: 36px; }
        .dash__section-header {
          display: flex;
          align-items: center;
          gap: 10px;
          background: none;
          border: none;
          color: var(--text);
          padding: 0;
          margin-bottom: 16px;
          cursor: pointer;
          text-align: left;
        }
        .dash__section-title {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 18px;
          font-weight: 700;
          letter-spacing: -0.01em;
        }
        .dash__section-hint { font-size: 13px; font-weight: 400; color: var(--faint); }
        .dash__count {
          font-size: 12.5px;
          font-weight: 600;
          color: var(--accent);
          background: var(--accent-bg);
          border-radius: 999px;
          padding: 2px 10px;
        }
        .dash__records-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          flex-wrap: wrap;
          margin-bottom: 16px;
        }
        .dash__records-tools { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
        .dash__inline-field { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
        .dash__inline-field select {
          background: var(--panel);
          border: 1px solid var(--line-strong);
          border-radius: var(--radius-sm);
          color: var(--text);
          padding: 6px 10px;
          font-size: 13.5px;
        }

        .dash__accordion { display: flex; flex-direction: column; gap: 14px; }
        .dash__group {
          border: 1px solid var(--line);
          border-radius: var(--radius);
          background: var(--panel);
          box-shadow: var(--shadow);
          overflow: hidden;
        }
        .dash__group-header {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 10px;
          background: var(--panel-2);
          border: none;
          border-bottom: 1px solid var(--line-soft);
          color: var(--text);
          padding: 13px 18px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          text-align: left;
        }
        .dash__group-header:hover { background: var(--hover); }
        .dash__chevron { display: inline-block; color: var(--accent); transition: transform 0.15s ease; }
        .dash__chevron--collapsed { transform: rotate(-90deg); }
        .dash__group-label { flex: 1; }
        .dash__group-count { color: var(--muted); font-size: 12.5px; font-weight: 500; }

        .dash__table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
        .dash > .dash__section > .dash__table {
          background: var(--panel);
          border: 1px solid var(--line);
          border-radius: var(--radius);
          box-shadow: var(--shadow);
          overflow: hidden;
          border-collapse: separate;
          border-spacing: 0;
        }
        .dash__table th {
          text-align: left;
          font-size: 11.5px;
          font-weight: 600;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--faint);
          padding: 11px 18px;
          border-bottom: 1px solid var(--line-soft);
        }
        .dash__table td { padding: 12px 18px; border-bottom: 1px solid var(--line-soft); vertical-align: middle; }
        .dash__table tbody tr:last-child td { border-bottom: none; }
        .dash__row { cursor: pointer; transition: background 0.12s ease; }
        .dash__row:hover td, .dash__row:focus td { background: var(--hover); }
        .dash__row:focus { outline: none; }
        .dash__row:focus td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
        .dash__name { font-weight: 600; }
        .dash__sub { font-size: 12px; color: var(--faint); margin-top: 2px; }
        .dash__sub--warn { color: var(--warn); }
        .dash__flags { font-size: 12px; color: var(--warn); margin-top: 4px; cursor: help; }
        .dash__flags::before { content: '⚠ '; }
        .mono { font-family: var(--font-num); font-variant-numeric: tabular-nums; }

        .shift-tag {
          display: inline-block;
          font-size: 12px;
          font-weight: 600;
          padding: 2px 10px;
          border-radius: 999px;
        }
        .shift-tag--day { color: #8C5300; background: #FAEBC8; }
        .shift-tag--night { color: #3F3AB8; background: #E2E3F8; }

        .status {
          font-size: 12px;
          font-weight: 600;
          padding: 3px 11px;
          border: 1px solid transparent;
          border-radius: 999px;
          display: inline-block;
          white-space: nowrap;
        }
        .status--ok { color: var(--accent); background: var(--accent-bg); }
        .status--late { color: var(--warn); background: var(--warn-bg); }
        .status--pending { color: var(--muted); background: var(--panel-2); border-color: var(--line); }
        .status--early { color: var(--info); background: var(--info-bg); }
        .status--critical { color: var(--critical); background: var(--critical-bg); }

        .approval { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; white-space: nowrap; }
        .approval::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
        .approval--approved { color: var(--accent); }
        .approval--pending { color: var(--faint); }
        .approval--changed { color: var(--warn); }

        .dash__filters-toggle { display: none; }

        @media (max-width: 900px) {
          .dash__actions { flex: 1 1 100%; display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 8px; }
          .dash__actions .btn { padding-left: 8px; padding-right: 8px; }
          .dash__filters { padding: 14px; gap: 12px; margin-bottom: 20px; border-radius: 16px; }
          .dash__filter-divider { display: none; }
          .dash__filter-group { flex: 1 1 100%; gap: 12px; }
          .dash__filter-group .field { flex: 1 1 calc(50% - 6px); min-width: 0; }
          .dash__filter-group .field--grow { flex-basis: 100%; }
          .dash__filter-group .field input { width: 100% !important; }
          .dash__filters-toggle { display: inline-flex; flex: 1 1 100%; }
          .dash__filter-group--more:not(.is-open) { display: none; }
          .dash__section { margin-bottom: 26px; }
          .dash__section-header { min-height: 40px; margin-bottom: 12px; }
          .dash__section-hint { display: none; }
          .dash__records-tools { flex: 1 1 100%; gap: 10px; }
          .dash__inline-field { flex: 1 1 calc(50% - 5px); }
          .dash__inline-field select { flex: 1; min-width: 0; min-height: 42px; font-size: 16px; }
          .dash__group-header { min-height: 50px; padding: 12px 16px; }
        }

        /* Each shift is a card: worker on top, the times in a three-column
           grid, late/early tags along the bottom. */
        @media (max-width: 760px) {
          .dash__table thead { display: none; }
          .dash__table, .dash__table tbody { display: block; width: 100%; }
          .dash > .dash__section > .dash__table { background: none; border: none; box-shadow: none; overflow: visible; }
          .dash > .dash__section > .dash__table tbody { display: flex; flex-direction: column; gap: 10px; }
          .dash__table tr {
            display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 12px;
            padding: 14px 16px;
          }
          .dash > .dash__section > .dash__table tr {
            background: var(--panel); border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow);
          }
          .dash__group .dash__table tr { border-bottom: 1px solid var(--line-soft); }
          .dash__group .dash__table tr:last-child { border-bottom: none; }
          .dash__table td { display: block; border: none; padding: 0; min-width: 0; background: none !important; }
          .dash__table td::before {
            content: attr(data-label); display: block; margin-bottom: 2px;
            font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--faint);
          }
          .dash__table td:empty { display: none; }
          .dash__table td[data-label='Worker'] { grid-column: 1 / 3; order: 0; }
          .dash__table td[data-label='Worker']::before { display: none; }
          .dash__table td[data-label='Worker'] .dash__name { font-size: 15.5px; }
          .dash__table td[data-label='Approval'] { order: 1; justify-self: end; align-self: start; }
          .dash__table td[data-label='Approval']::before { display: none; }
          .dash__table td[data-label='Date'] { order: 2; }
          .dash__table td[data-label='Shift'] { order: 3; }
          .dash__table td[data-label='Hours'] { order: 4; }
          .dash__table td[data-label='In'] { order: 5; }
          .dash__table td[data-label='Out'] { order: 6; }
          .dash__table td[data-label='Status'] { order: 7; grid-column: 1 / -1; }
          .dash__table td[data-label='Status']::before { display: none; }
          .dash__row:active { background: var(--hover); }
          .dash__row:focus td:first-child { box-shadow: none; }
        }
      `}</style>
    </div>
  );
}
