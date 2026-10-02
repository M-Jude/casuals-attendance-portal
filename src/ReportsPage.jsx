import { useEffect, useMemo, useState } from 'react';
import { TAG_LABEL } from './shiftStatus';
import StatusTags from './StatusTags';
import { ROLE_LABEL, formatDateLabel, todayEat } from './api';
import { downloadAuthenticated } from './downloadFile';
import { usePagination } from './Pagination';
import { SortHeading, sortItems } from './useSort';
import { useToast } from './toast';

const PERIOD_LABEL = { day: 'Day', week: 'Week', month: 'Month', range: 'Date range', all: 'All time' };

// How the report dropdown is grouped. A report the API adds later that isn't
// listed here still appears, under "Other".
const TYPE_GROUPS = [
  ['Day to day', ['daily', 'timesheet', 'exceptions']],
  ['Summaries', ['summary', 'individual', 'hours', 'daily-totals', 'crew']],
  ['Registers and records', ['register', 'detailed', 'approvals']]
];
function groupTypes(types) {
  const placed = new Set(TYPE_GROUPS.flatMap(([, ids]) => ids));
  const groups = TYPE_GROUPS
    .map(([label, ids]) => [label, ids.map((id) => types.find((t) => t.id === id)).filter(Boolean)])
    .filter(([, list]) => list.length);
  const other = types.filter((t) => !placed.has(t.id));
  return other.length ? [...groups, ['Other', other]] : groups;
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function addDays(dateStr, n) {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}
function mondayOf(dateStr) {
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return addDays(dateStr, -((dow + 6) % 7));
}
function eatClock(ts) {
  return new Date(new Date(ts).getTime() + 3 * 3600000).toISOString().slice(11, 16);
}

// Mirrors reports/reportFormat.js so the preview reads like the downloads.
function formatCell(col, v) {
  if (v == null || v === '') return '—';
  switch (col.type) {
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${WEEKDAYS[new Date(`${v}T00:00:00Z`).getUTCDay()]} ${formatDateLabel(v)}` : v;
    case 'time': return eatClock(v);
    case 'datetime': return `${formatDateLabel(new Date(new Date(v).getTime() + 3 * 3600000).toISOString())} ${eatClock(v)}`;
    case 'hours': return typeof v === 'number' ? v.toFixed(2) : v;
    case 'pct': return typeof v === 'number' ? `${v % 1 ? v.toFixed(1) : v}%` : v;
    case 'minutes': return typeof v === 'number' ? `${v} min` : v;
    case 'status': return String(v).split(',').map((k) => TAG_LABEL[k] || k).join(' · ');
    default: return String(v);
  }
}
const isNumeric = (c) => ['hours', 'int', 'pct', 'minutes', 'time', 'code'].includes(c.type);

const choiceKey = (c) => (c.type === 'code' ? 'dates' : c.key);

// Pages through the data rows; a group (e.g. a worker) that starts on an
// earlier page gets its header repeated, marked continued.
function pageWithGroups(allRows, pageData) {
  const groupOf = new Map();
  let current = null;
  for (const r of allRows) {
    if (r._group) current = r;
    else groupOf.set(r, current);
  }
  const out = [];
  let last = null;
  for (const r of pageData) {
    const g = groupOf.get(r);
    if (g && g !== last) {
      out.push(out.length === 0 && allRows[allRows.indexOf(g) + 1] !== r ? { ...g, _continued: true } : g);
      last = g;
    }
    out.push(r);
  }
  return out;
}

// Status sorts Late in + Early out first, then Late in, then Early out, then blank.
const STATUS_ORDER_KEY = { 'late-in,early-out': 0, 'late-in': 1, 'early-out': 2 };
// Number columns sort biggest first on the first click.
const NUMERIC_FIRST_DESC = new Set(['hours', 'int', 'pct', 'minutes']);

function ReportTable({ section, hidden, printing }) {
  const { totals } = section;
  // With per-worker group headers, drop the columns that repeat the header.
  const grouped = section.rows.some((r) => r._group);
  const columns = (grouped ? section.columns.filter((c) => !c.hideInGroups) : section.columns)
    .filter((c) => !hidden.has(choiceKey(c)));
  // Click a heading to sort; in grouped tables (e.g. per worker) rows are
  // sorted within each group so the groups stay together.
  const [sort, setSort] = useState(null); // { key, dir }
  const sortedRows = useMemo(() => {
    const col = sort && section.columns.find((c) => c.key === sort.key);
    if (!col) return section.rows;
    const get = col.type === 'status' ? (r) => STATUS_ORDER_KEY[r[col.key] || ''] : (r) => r[col.key];
    if (!grouped) return sortItems(section.rows, get, sort.dir);
    const out = [];
    let batch = [];
    const flush = () => { out.push(...sortItems(batch, get, sort.dir)); batch = []; };
    for (const r of section.rows) {
      if (r._group) { flush(); out.push(r); } else batch.push(r);
    }
    flush();
    return out;
  }, [section.rows, section.columns, sort, grouped]);
  function toggleSort(c) {
    const first = NUMERIC_FIRST_DESC.has(c.type) ? 'desc' : 'asc';
    setSort((s) => (s && s.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: first }));
  }
  const dataRows = useMemo(() => sortedRows.filter((r) => !r._group), [sortedRows]);
  const { pageItems, pager } = usePagination(dataRows, { id: 'report-preview', defaultSize: 50, noun: 'rows', resetKey: `${section.title}|${sort ? `${sort.key}:${sort.dir}` : ''}` });
  // Printing shows every row, not just the current page.
  const shown = printing ? dataRows : pageItems;
  const rows = useMemo(() => (grouped ? pageWithGroups(sortedRows, shown) : shown), [grouped, sortedRows, shown]);
  if (columns.length === 0) return <div className="empty">All of this table’s columns are hidden.</div>;
  return (
    <>
    {!printing && pager}
    <div className="report-table-wrap">
      <table className="table report-table" data-width={columns.length > 16 ? 'grid' : columns.length > 10 ? 'wide' : columns.length > 7 ? 'medium' : undefined}>
        <thead>
          <tr>
            {columns.map((c) => (c.type === 'code' ? (
              // The register's day-by-day cells aren't sortable.
              <th key={c.key} className="num">
                {c.label.split(' ')[0]}<div className="report-table__dow">{c.label.split(' ')[1]}</div>
              </th>
            ) : (
              <SortHeading
                key={c.key}
                label={c.label}
                align={isNumeric(c) ? 'center' : undefined}
                active={sort?.key === c.key}
                dir={sort?.dir}
                onClick={() => toggleSort(c)}
              />
            )))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => r._group ? (
            <tr key={i} className="report-table__group">
              <td colSpan={columns.length}><strong>{r._group}{r._continued ? ' (continued)' : ''}</strong><span>{r._groupNote}</span></td>
            </tr>
          ) : (
            <tr key={i}>
              {columns.map((c) => {
                const v = r[c.key];
                if (c.type === 'status') {
                  // Late in / Early out only; blank otherwise.
                  return <td key={c.key}><StatusTags tags={String(v || '').split(',').filter(Boolean)} /></td>;
                }
                if (c.type === 'code') {
                  // N+ / +D (a double shift across midnight) share the DN style.
                  return <td key={c.key} className="num">{v ? <span className={`code code--${v.includes('+') ? 'DN' : v}`}>{v}</span> : ''}</td>;
                }
                return (
                  <td key={c.key} className={`${isNumeric(c) ? 'num mono' : ''} ${c.type === 'id' ? 'mono muted' : ''} ${c.key === 'worker' ? 'strong' : ''}`}>
                    {formatCell(c, v)}
                    {r._dayOffset?.[c.key] ? <span className="day-mark" title="Clocked out the next day (double shift)"> (+{r._dayOffset[c.key]})</span> : null}
                  </td>
                );
              })}
            </tr>
          ))}
          {totals && rows.length > 0 && shown[shown.length - 1] === dataRows[dataRows.length - 1] && (
            <tr className="report-table__totals">
              {columns.map((c, i) => (
                <td key={c.key} className={isNumeric(c) ? 'num mono' : ''}>
                  {i === 0 && totals[c.key] == null ? 'TOTAL' : totals[c.key] == null || totals[c.key] === '' ? '' : formatCell(c, totals[c.key])}
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
    {!printing && pager}
    </>
  );
}

function ReportPreview({ report, hidden, printing, printStamp }) {
  return (
    <div className="report">
      {printStamp && <div className="print-stamp">{printStamp}</div>}
      <div className="report__band">
        <div>
          <div className="report__org">{report.meta.orgName}</div>
          <h3 className="report__title">{report.title}</h3>
          {report.subtitle && <div className="report__subtitle">{report.subtitle}</div>}
        </div>
        <div className="report__period">
          <div className="report__org">Report period</div>
          <div className="report__period-label">{report.period.label}</div>
          <div className="report__subtitle">Generated by {report.meta.generatedBy}</div>
        </div>
      </div>

      {(report.meta.scopeNote || report.meta.filters.length > 0) && (
        <div className="report__chips">
          {report.meta.scopeNote && <span className="chip chip--info">{report.meta.scopeNote}</span>}
          {report.meta.filters.map((f) => <span className="chip" key={f}>{f}</span>)}
        </div>
      )}

      {report.kpis?.length > 0 && (
        <div className="report__kpis">
          {report.kpis.map((k) => (
            <div className={`report__kpi report__kpi--${k.tone}`} key={k.label}>
              <div className="report__kpi-label">{k.label}</div>
              <div className="report__kpi-value">{k.value}</div>
              <div className="report__kpi-sub">{k.sub}</div>
            </div>
          ))}
        </div>
      )}

      {report.sections.length === 0 && <div className="empty">No records for this period.</div>}
      {report.sections.map((s) => (
        <section className="report__section" key={s.title}>
          <h4 className="report__section-title">{s.title}{s.note && <span>{s.note}</span>}</h4>
          {s.rows.length === 0 ? <div className="empty">No records.</div> : <ReportTable section={s} hidden={hidden} printing={printing} />}
          {s.totalRows > s.rows.length && (
            <div className="small muted" style={{ marginTop: 8 }}>
              Showing the first {s.rows.length} of {s.totalRows} rows. Download the report for all of them.
            </div>
          )}
        </section>
      ))}

      {report.notes?.length > 0 && (
        <div className="report__notes">
          <div className="report__org">How to read this report</div>
          <ul>{report.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

export default function ReportsPage({ api, token, user }) {
  const [types, setTypes] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [typeId, setTypeId] = useState('summary');
  const [period, setPeriod] = useState('month');
  const [date, setDate] = useState(todayEat());
  const [month, setMonth] = useState(todayEat().slice(0, 7));
  const [from, setFrom] = useState(`${todayEat().slice(0, 7)}-01`);
  const [to, setTo] = useState(todayEat());
  const [workerText, setWorkerText] = useState('');
  const [shift, setShift] = useState('');
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const toast = useToast();
  // Hidden columns per report type, remembered in this browser.
  const [hiddenByType, setHiddenByType] = useState(() => {
    try { return JSON.parse(localStorage.getItem('reportHiddenColumns') || '{}'); } catch { return {}; }
  });
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [printedAt, setPrintedAt] = useState(null);

  useEffect(() => {
    if (!printing) return undefined;
    // Let the full, unpaged tables render before opening the print dialog.
    const t = setTimeout(() => { window.print(); setPrinting(false); }, 50);
    return () => clearTimeout(t);
  }, [printing]);

  useEffect(() => {
    api('/api/reports').then(({ reports }) => setTypes(reports)).catch((err) => setError(err.message));
    api('/api/reports/workers').then(({ workers: list }) => setWorkers(list)).catch(() => {});
  }, [api]);

  const type = types.find((t) => t.id === typeId);
  // An API that predates column choice sends no column list — hide the picker then.
  const columnChoices = type?.columns || [];
  const workerLabel = (w) => `${w.name} (${w.biostarUserId})`;
  const worker = useMemo(() => workers.find((w) => workerLabel(w) === workerText.trim()), [workers, workerText]);
  const hidden = useMemo(() => new Set(hiddenByType[typeId] || []), [hiddenByType, typeId]);

  function setHidden(keys) {
    const next = { ...hiddenByType, [typeId]: keys };
    setHiddenByType(next);
    try { localStorage.setItem('reportHiddenColumns', JSON.stringify(next)); } catch { /* per-viewer convenience only */ }
  }
  function toggleColumn(key) {
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key);
    else if (next.size < columnChoices.length - 1) next.add(key); // always keep one
    setHidden([...next]);
  }

  // Printing is logged like a download, and the printout is stamped with
  // who printed it and when.
  function printPreview() {
    setPrintedAt(new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kampala' }));
    api('/api/audit/event', { method: 'POST', body: { type: 'report.print', report: report.title, reportId: typeId, period: report.period.label } }).catch(() => {});
    setPrinting(true);
  }

  function chooseType(t) {
    setTypeId(t.id);
    if (!t.periods.includes(period)) setPeriod(t.defaultPeriod);
    setReport(null);
    setColumnsOpen(false);
    setError('');
  }

  function params(format) {
    const p = new URLSearchParams({ period, format });
    if (period === 'day' || period === 'week') p.set('date', date);
    if (period === 'month') p.set('month', month);
    if (period === 'range') { p.set('from', from); p.set('to', to); }
    if (shift && typeId !== 'approvals') p.set('shift', shift);
    if ((type?.needsWorker || type?.allowsWorker) && worker) p.set('workerId', String(worker.id));
    // The preview loads every column and hides them on screen, so ticking one
    // back on needs no reload; downloads leave them out on the server.
    if (hidden.size && format !== 'json') p.set('hide', [...hidden].join(','));
    return p;
  }

  function validate() {
    if (type?.needsWorker && !worker) return 'Choose a worker from the list.';
    if (type?.allowsWorker && workerText.trim() && !worker) return 'Choose a worker from the list, or clear the box for all workers.';
    if (period === 'range' && from > to) return 'The start date must not be after the end date.';
    return '';
  }

  async function preview() {
    const problem = validate();
    if (problem) { setError(problem); return; }
    setBusy('preview');
    setError('');
    try {
      const { report: r } = await api(`/api/reports/${typeId}?${params('json')}`);
      setReport(r);
    } catch (err) {
      setError(err.message);
      toast.error(`Couldn’t load the report: ${err.message}`);
      setReport(null);
    } finally {
      setBusy('');
    }
  }

  async function download(format) {
    const problem = validate();
    if (problem) { setError(problem); return; }
    setBusy(format);
    setError('');
    try {
      await downloadAuthenticated(`/api/reports/${typeId}?${params(format)}`, token, `report.${format}`);
      toast.success(`${format === 'xlsx' ? 'Excel' : format.toUpperCase()} report downloaded.`);
    } catch (err) {
      setError(err.message || 'Download failed.');
      toast.error(err.message || 'Download failed.');
    } finally {
      setBusy('');
    }
  }

  const weekFrom = mondayOf(date);

  return (
    <div className="page reports">
      <div className="page__head reports__controls">
        <div>
          <h2 className="page__title">Reports</h2>
          <p className="page__hint">Pick a report and a period, preview it here, then download it as PDF, Excel or CSV — or print the preview.</p>
        </div>
      </div>

      <div className="reports__main">
          {type && (
            <div className="panel reports__controls report-builder">
              <div className="report-builder__top">
                <label className="field report-builder__type">
                  Report
                  <select value={typeId} onChange={(e) => chooseType(types.find((t) => t.id === e.target.value))}>
                    {groupTypes(types).map(([group, list]) => (
                      <optgroup key={group} label={group}>
                        {list.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <p className="report-builder__desc">{type.description}</p>
              </div>

              <div className="report-builder__section">
              <div className="report-builder__label">Period and filters</div>
              <div className="segmented" role="tablist" aria-label="Period">
                {type.periods.map((p) => (
                  <button key={p} type="button" role="tab" aria-selected={period === p} onClick={() => { setPeriod(p); setReport(null); }}>
                    {PERIOD_LABEL[p]}
                  </button>
                ))}
              </div>

              <div className="form-row" style={{ marginTop: 16 }}>
                {period === 'day' && (
                  <label className="field">Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
                )}
                {period === 'week' && (
                  <label className="field">
                    Any date in the week
                    <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                  </label>
                )}
                {period === 'week' && date && (
                  <span className="small muted" style={{ paddingBottom: 9 }}>Mon {formatDateLabel(weekFrom)} – Sun {formatDateLabel(addDays(weekFrom, 6))}</span>
                )}
                {period === 'month' && (
                  <label className="field">Month<input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>
                )}
                {period === 'range' && (
                  <>
                    <label className="field">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
                    <label className="field">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
                  </>
                )}
                {period === 'all' && <span className="small muted" style={{ paddingBottom: 9 }}>Everything on record.</span>}

                {(type.needsWorker || type.allowsWorker) && (
                  <label className="field field--grow">
                    Worker
                    <input
                      list="report-workers"
                      value={workerText}
                      placeholder={type.needsWorker ? 'Start typing a name or ID…' : 'All workers — or type a name or ID'}
                      onChange={(e) => setWorkerText(e.target.value)}
                    />
                    <datalist id="report-workers">
                      {workers.map((w) => <option key={w.id} value={workerLabel(w)} />)}
                    </datalist>
                  </label>
                )}

                {typeId !== 'approvals' && (
                  <label className="field">
                    Shift
                    <select value={shift} onChange={(e) => setShift(e.target.value)}>
                      <option value="">Day and Night</option>
                      <option value="Day">Day only</option>
                      <option value="Night">Night only</option>
                    </select>
                  </label>
                )}
              </div>

              </div>

              {columnChoices.length > 0 && (
              <div className="columns-picker">
                <button type="button" className="btn btn--small" onClick={() => setColumnsOpen((v) => !v)} aria-expanded={columnsOpen}>
                  Columns ({columnChoices.length - hidden.size} of {columnChoices.length}) {columnsOpen ? '▴' : '▾'}
                </button>
                {hidden.size > 0 && <button type="button" className="btn btn--link small" onClick={() => setHidden([])}>Show all columns</button>}
                {columnsOpen && (
                  <div className="columns-picker__panel">
                    {columnChoices.map((c) => (
                      <label key={c.key} className="checkbox">
                        <input
                          type="checkbox"
                          checked={!hidden.has(c.key)}
                          disabled={!hidden.has(c.key) && columnChoices.length - hidden.size === 1}
                          onChange={() => toggleColumn(c.key)}
                        />
                        {c.label}
                      </label>
                    ))}
                    <div className="small muted columns-picker__hint">Applies to the preview and to the PDF, Excel and CSV downloads. Remembered for this report in this browser.</div>
                  </div>
                )}
              </div>
              )}

              {error && <div className="error">{error}</div>}
              <div className="report-builder__actions">
                <button className="btn btn--primary" onClick={preview} disabled={!!busy}>{busy === 'preview' ? 'Loading…' : 'Preview'}</button>
                <button className="btn" onClick={() => download('pdf')} disabled={!!busy}>{busy === 'pdf' ? 'Preparing…' : 'Download PDF'}</button>
                <button className="btn" onClick={() => download('xlsx')} disabled={!!busy}>{busy === 'xlsx' ? 'Preparing…' : 'Download Excel'}</button>
                <button className="btn" onClick={() => download('csv')} disabled={!!busy}>{busy === 'csv' ? 'Preparing…' : 'Download CSV'}</button>
                {report && <button className="btn" onClick={printPreview}>Print preview</button>}
              </div>
            </div>
          )}

          {report && (
            <ReportPreview
              report={report}
              hidden={hidden}
              printing={printing}
              printStamp={printedAt && `Printed by ${user.name || user.email} <${user.email}> (${ROLE_LABEL[user.role] || user.role}) on ${printedAt} EAT`}
            />
          )}
      </div>
    </div>
  );
}
