import { useMemo, useState } from 'react';
import { STATUS_LABEL } from './shiftStatus';
import { STATUS_ORDER, computeAnalytics, pct } from './attendanceStats';
import { useSort } from './useSort';

// Same palette as the status pills in AttendanceDashboard.jsx's .status--*
// classes, named by status instead of by intent so the two can't drift.
const STATUS_COLOR = {
  'on-time': '#0F8A76',
  early: '#3B7DD8',
  late: '#E0A21B',
  'no-checkout': '#94A3B8',
  'no-checkin': '#CBD5E1',
  'no-show': '#D9534F',
  'in-progress': '#8B5CF6'
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

const MAX_CHART_DAYS = 62;

function DailyChart({ days }) {
  if (days.length === 0 || days.length > MAX_CHART_DAYS) return null;

  const W = 900;
  const H = 150;
  const padTop = 8;
  const padBottom = 28;
  const padLeft = 30;
  const plotW = W - padLeft - 4;
  const plotH = H - padTop - padBottom;

  const totals = days.map(([, c]) => STATUS_ORDER.reduce((a, s) => a + c[s], 0));
  const maxTotal = Math.max(...totals, 1);
  const step = maxTotal <= 10 ? 2 : maxTotal <= 40 ? 10 : maxTotal <= 100 ? 20 : maxTotal <= 250 ? 50 : 100;
  const max = Math.ceil(maxTotal / step) * step || step;

  const slot = plotW / days.length;
  const barW = Math.min(34, slot * 0.62);
  const labelEvery = Math.max(1, Math.ceil(26 / slot));
  const base = padTop + plotH;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="an__chart-svg" role="img" aria-label="Records per day, stacked by status">
      {[0, 0.5, 1].map((g) => {
        const y = base - g * plotH;
        return (
          <g key={g}>
            <line x1={padLeft} y1={y} x2={W - 4} y2={y} stroke={g === 0 ? '#CBD5E1' : '#EEF1F5'} strokeWidth="1" />
            <text x={padLeft - 6} y={y + 3} fontSize="10" fill="#8795A8" textAnchor="end">{Math.round(g * max)}</text>
          </g>
        );
      })}
      {days.map(([dateStr, counts], i) => {
        const x = padLeft + i * slot + (slot - barW) / 2;
        let y = base;
        const segments = [];
        for (const s of STATUS_ORDER) {
          const v = counts[s];
          if (!v) continue;
          const h = (v / max) * plotH;
          segments.push(
            <rect key={s} x={x} y={y - h} width={barW} height={h} fill={STATUS_COLOR[s]}>
              <title>{`${shortDate(dateStr)}: ${STATUS_LABEL[s]} ${v}`}</title>
            </rect>
          );
          y -= h;
        }
        const total = totals[i];
        return (
          <g key={dateStr}>
            {segments}
            {slot > 14 && total > 0 && (
              <text x={x + barW / 2} y={y - 4} fontSize="10" fill="#334155" textAnchor="middle">{total}</text>
            )}
            {i % labelEvery === 0 && (
              <text x={x + barW / 2} y={base + 16} fontSize="10" fill="#5B6B80" textAnchor="middle">
                {shortDate(dateStr)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// A collapsible panel: closed by default, with a one-line summary in the
// header so the key numbers are visible without opening it.
function Panel({ id, title, hint, summary, open, onToggle, children }) {
  return (
    <div className={`an__panel ${open ? 'an__panel--open' : ''}`}>
      <button type="button" className="an__panel-head" onClick={() => onToggle(id)} aria-expanded={open} aria-controls={`an-panel-${id}`}>
        <span className="an__panel-chevron" aria-hidden="true">▸</span>
        <span className="an__panel-title">{title}</span>
        {hint && <span className="an__panel-hint">{hint}</span>}
        {!open && summary && <span className="an__panel-summary">{summary}</span>}
      </button>
      {open && <div className="an__panel-body" id={`an-panel-${id}`}>{children}</div>}
    </div>
  );
}

export default function AttendanceAnalytics({ rows }) {
  const stats = useMemo(() => computeAnalytics(rows), [rows]);
  const [openPanels, setOpenPanels] = useState(() => new Set()); // all collapsed to start
  // Workers needing attention: top 10 by issues, then sortable by any count.
  const { sorted: attention, th } = useSort(useMemo(() => stats.attention.slice(0, 10), [stats]), {
    worker: (w) => w.worker.name,
    late: { get: (w) => w.late, first: 'desc' },
    noCheckout: { get: (w) => w.noCheckout, first: 'desc' },
    noShow: { get: (w) => w.noShow, first: 'desc' },
    earlyOut: { get: (w) => w.earlyOut, first: 'desc' },
    shifts: { get: (w) => w.shifts, first: 'desc' }
  });
  if (rows.length === 0) return null;

  function togglePanel(id) {
    setOpenPanels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const busiest = stats.days.reduce((best, [d, c]) => {
    const n = STATUS_ORDER.reduce((a, s) => a + c[s], 0);
    return !best || n > best.n ? { d, n } : best;
  }, null);

  const punctuality = stats.completed ? `${pct(stats.punctual, stats.completed)}%` : '—';
  const cards = [
    { label: 'SHIFT RECORDS', value: String(stats.total), sub: `across ${stats.days.length} day${stats.days.length === 1 ? '' : 's'}`, accent: '#3B7DD8' },
    { label: 'WORKERS', value: String(stats.workers), sub: 'with attendance in range', accent: '#3B7DD8' },
    { label: 'COMPLETED SHIFTS', value: String(stats.completed), sub: `${pct(stats.completed, stats.total)}% have in + out`, accent: '#0F8A76' },
    { label: 'HOURS WORKED', value: stats.hoursTotal.toFixed(1), sub: stats.completed ? `avg ${stats.hoursAvg.toFixed(1)} h / shift` : 'no completed shifts', accent: '#0F8A76' },
    { label: 'PUNCTUALITY', value: punctuality, sub: `${stats.punctual} of ${stats.completed} completed shifts`, accent: STATUS_COLOR['on-time'] },
    { label: 'LATE ARRIVALS', value: String(stats.counts.late), sub: `${pct(stats.counts.late, stats.total)}% of records`, accent: STATUS_COLOR.late },
    { label: 'NO CHECKOUT', value: String(stats.counts['no-checkout']), sub: `${pct(stats.counts['no-checkout'], stats.total)}% of records`, accent: STATUS_COLOR['no-checkout'] },
    { label: 'NO-SHOWS', value: String(stats.counts['no-show']), sub: 'scheduled, no punch activity', accent: STATUS_COLOR['no-show'] }
  ];

  const shiftBits = [...stats.byShift.entries()].map(([name, n]) => `${name} shift: ${n}`);

  return (
    <div className="an">
      <div className="an__cards">
        {cards.map((c) => (
          <div className="an__card" key={c.label} style={{ '--accent': c.accent }}>
            <div className="an__card-label">{c.label}</div>
            <div className="an__card-value">{c.value}</div>
            <div className="an__card-sub">{c.sub}</div>
          </div>
        ))}
      </div>

      <div className="an__panels">
      <Panel
        id="breakdown"
        title="Attendance breakdown"
        hint="by status"
        summary={`${stats.counts['on-time'] + stats.counts.early} on time or early · ${stats.counts.late} late · ${stats.counts['no-show']} no-show${stats.counts['in-progress'] ? ` · ${stats.counts['in-progress']} in progress` : ''}`}
        open={openPanels.has('breakdown')}
        onToggle={togglePanel}
      >
        <div className="an__stackbar">
          {STATUS_ORDER.map((s) => {
            const width = pct(stats.counts[s], stats.total);
            if (!width) return null;
            return (
              <div
                key={s}
                className="an__stackbar-seg"
                style={{ width: `${width}%`, background: STATUS_COLOR[s] }}
                title={`${STATUS_LABEL[s]}: ${stats.counts[s]} (${width}%)`}
              >
                {width >= 7 && `${width}%`}
              </div>
            );
          })}
        </div>

        <div className="an__legend">
          {STATUS_ORDER.map((s) => (
            <div className="an__legend-item" key={s}>
              <span className="an__legend-dot" style={{ background: STATUS_COLOR[s] }} />
              <div>
                <div className="an__legend-label">{STATUS_LABEL[s]}</div>
                <div className="an__legend-value" style={{ color: STATUS_COLOR[s] }}>
                  {stats.counts[s]} <span>{pct(stats.counts[s], stats.total)}%</span>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="an__meta">
          {shiftBits.join('  ·  ')}
          {shiftBits.length > 0 && '  ·  '}
          Early check-outs: {stats.earlyCheckOuts}  ·  Multiple punches: {stats.multiPunch}  ·  Unscheduled: {stats.unscheduled}  ·  Not yet approved: {stats.unapproved}
        </div>
      </Panel>

      {stats.days.length > 0 && stats.days.length <= MAX_CHART_DAYS && (
        <Panel
          id="per-day"
          title="Records per day"
          hint="stacked by status"
          summary={`${stats.days.length} day${stats.days.length === 1 ? '' : 's'}${busiest ? ` · busiest ${shortDate(busiest.d)} (${busiest.n})` : ''}`}
          open={openPanels.has('per-day')}
          onToggle={togglePanel}
        >
          <DailyChart days={stats.days} />
        </Panel>
      )}

      {stats.attention.length > 0 && (
        <Panel
          id="attention"
          title="Workers needing attention"
          hint={`top ${Math.min(10, stats.attention.length)} by late arrivals, no checkouts and no-shows`}
          summary={`${stats.attention.length} worker${stats.attention.length === 1 ? '' : 's'} with issues · most: ${stats.attention[0].worker.name}`}
          open={openPanels.has('attention')}
          onToggle={togglePanel}
        >
          <table className="an__attn-table">
            <thead>
              <tr>
                {th('worker', 'Worker')}
                {th('late', 'Late', { align: 'center' })}
                {th('noCheckout', 'No checkout', { align: 'center' })}
                {th('noShow', 'No-show', { align: 'center' })}
                {th('earlyOut', 'Early out', { align: 'center' })}
                {th('shifts', 'Shifts', { align: 'center' })}
              </tr>
            </thead>
            <tbody>
              {attention.map((w) => (
                <tr key={w.worker.id}>
                  <td>
                    <div className="an__attn-name">{w.worker.name}</div>
                    <div className="an__attn-id mono">{w.worker.biostarUserId}</div>
                  </td>
                  <td className="mono" style={{ color: w.late ? STATUS_COLOR.late : undefined }}>{w.late || '—'}</td>
                  <td className="mono" style={{ color: w.noCheckout ? STATUS_COLOR['no-checkout'] : undefined }}>{w.noCheckout || '—'}</td>
                  <td className="mono" style={{ color: w.noShow ? STATUS_COLOR['no-show'] : undefined }}>{w.noShow || '—'}</td>
                  <td className="mono" style={{ color: w.earlyOut ? STATUS_COLOR.late : undefined }}>{w.earlyOut || '—'}</td>
                  <td className="mono">{w.shifts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
      </div>

      <style>{`
        .an__panels { display: flex; flex-direction: column; gap: 12px; }
        .an__panel {
          background: var(--panel);
          border: 1px solid var(--line);
          border-radius: var(--radius);
          box-shadow: var(--shadow);
          overflow: hidden;
        }
        .an__panel-head {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          padding: 14px 18px;
          background: none;
          border: none;
          color: var(--text);
          text-align: left;
          cursor: pointer;
        }
        .an__panel-head:hover { background: var(--hover); }
        .an__panel-chevron { color: var(--accent); font-size: 12px; transition: transform 0.15s ease; }
        .an__panel--open .an__panel-chevron { transform: rotate(90deg); }
        .an__panel-title { font-size: 14.5px; font-weight: 600; }
        .an__panel-hint { font-size: 12.5px; color: var(--faint); }
        .an__panel-summary { margin-left: auto; font-size: 13px; color: var(--muted); }
        .an__panel-body { padding: 4px 20px 20px; border-top: 1px solid var(--line-soft); padding-top: 18px; }
        .an__cards {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 10px;
          margin-bottom: 22px;
        }
        .an__card {
          background: var(--panel);
          border: 1px solid var(--line);
          border-top: 3px solid var(--accent, #0F8A76);
          border-radius: var(--radius);
          box-shadow: var(--shadow);
          padding: 14px 16px;
        }
        .an__card-label {
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.06em;
          color: var(--faint);
        }
        .an__card-value {
          font-size: 24px;
          font-weight: 700;
          letter-spacing: -0.01em;
          color: var(--text);
          margin-top: 4px;
        }
        .an__card-sub {
          font-size: 11px;
          color: var(--muted);
          margin-top: 4px;
        }
        .an__section {
          margin-bottom: 22px;
        }
        .an__section-title {
          font-size: 13px;
          font-weight: 600;
          color: var(--text);
          border-left: 3px solid var(--accent);
          padding-left: 9px;
          margin-bottom: 12px;
        }
        .an__section-title span {
          font-weight: 400;
          font-size: 11px;
          color: var(--faint);
          margin-left: 6px;
        }
        .an__stackbar {
          display: flex;
          height: 20px;
          overflow: hidden;
          border-radius: 3px;
          margin-bottom: 14px;
        }
        .an__stackbar-seg {
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 10px;
          font-weight: 600;
          color: var(--on-accent);
          white-space: nowrap;
        }
        .an__legend {
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          gap: 10px;
          margin-bottom: 12px;
        }
        .an__legend-item {
          display: flex;
          align-items: flex-start;
          gap: 7px;
        }
        .an__legend-dot {
          width: 9px;
          height: 9px;
          border-radius: 50%;
          margin-top: 4px;
          flex-shrink: 0;
        }
        .an__legend-label {
          font-size: 11px;
          color: var(--muted);
        }
        .an__legend-value {
          font-size: 15px;
          font-weight: 700;
        }
        .an__legend-value span {
          font-size: 10px;
          font-weight: 400;
          color: var(--faint);
          margin-left: 3px;
        }
        .an__meta {
          font-size: 11px;
          color: var(--faint);
        }
        .an__chart-svg {
          width: 100%;
          height: auto;
          display: block;
        }
        .an__attn-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }
        .an__attn-table th {
          text-align: left;
          font-size: 11px;
          font-weight: 500;
          color: var(--muted);
          padding: 0 10px 8px;
          border-bottom: 1px solid var(--line);
        }
        .an__attn-table th:not(:first-child), .an__attn-table td:not(:first-child) {
          text-align: center;
        }
        .an__attn-table td {
          padding: 9px 10px;
          border-bottom: 1px solid var(--line-soft);
        }
        .an__attn-name {
          font-weight: 600;
          color: var(--text);
        }
        .an__attn-id {
          font-size: 11px;
          color: var(--faint);
        }

        @media (max-width: 900px) {
          .an__cards { grid-template-columns: repeat(2, 1fr); }
          .an__legend { grid-template-columns: repeat(2, 1fr); }
        }
        @media (max-width: 640px) {
          .an__cards { grid-template-columns: 1fr 1fr; }
          .an__attn-table th:nth-child(6), .an__attn-table td:nth-child(6) { display: none; }
        }
      `}</style>
    </div>
  );
}
