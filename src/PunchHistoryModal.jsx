import { useEffect, useState } from 'react';
import StatusTags from './StatusTags';
import { isGuessed, GUESSED_TITLE } from './shiftStatus';

function formatDateTime(ts) {
  return new Date(ts).toLocaleString([], {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    timeZone: 'Africa/Kampala'
  });
}

function formatDate(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString([], {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC'
  });
}

// Devices here don't label punches, so a punch's role comes from which
// shift window it fell in (see sync/shiftEngine.js).
function punchRole(p) {
  if (p.changeover) return 'Changeover (Day → Night)';
  if (p.usedAsCheckIn && p.usedAsCheckOut) return 'Check-out and next check-in';
  if (p.usedAsCheckIn) return 'Check-in';
  if (p.usedAsCheckOut) return 'Check-out';
  return 'Not used (repeat badge)';
}

export default function PunchHistoryModal({ token, summary, onClose }) {
  const [punches, setPunches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError('');
      try {
        const loadFor = async (id) => {
          const params = new URLSearchParams({ summaryId: String(id) });
          const res = await fetch(`/api/attendance/punches?${params}`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          if (!res.ok) throw new Error('Request failed');
          return (await res.json()).punches;
        };
        let data;
        if (summary.parts) {
          // A Day + Night double shift: both shifts' badges, the Day's
          // check-out / Night's check-in being the changeover.
          const [day, night] = await Promise.all(summary.parts.map((p) => loadFor(p.id)));
          const byId = new Map();
          for (const p of day) byId.set(p.id, { ...p, usedAsCheckOut: false, changeover: p.usedAsCheckOut });
          for (const p of night) {
            const prev = byId.get(p.id);
            byId.set(p.id, {
              ...p,
              usedAsCheckIn: !!prev?.usedAsCheckIn,
              usedAsCheckOut: p.usedAsCheckOut,
              changeover: !!prev?.changeover || p.usedAsCheckIn
            });
          }
          data = [...byId.values()].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        } else {
          data = await loadFor(summary.id);
        }
        if (!cancelled) setPunches(data);
      } catch {
        if (!cancelled) setError('Could not load punch history.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [token, summary]);

  // Escape closes it, and the page behind stays put while it's open.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
    };
  }, [onClose]);

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div className="modal-backdrop" onClick={handleBackdropClick} role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="punch-modal-title">
        <div className="modal__header">
          <div>
            <div id="punch-modal-title" className="modal__title">{summary.worker.name}</div>
            <div className="modal__subtitle">
              {formatDate(summary.date.slice(0, 10))} · {summary.shift.name} shift{summary.parts ? ' — double shift, 2 shifts' : ''}
            </div>
          </div>
          <button className="modal__close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal__summary">
          <div className="modal__stat">
            <span className="modal__stat-label">Status</span>
            <StatusTags row={summary} />
          </div>
          <div className="modal__stat">
            <span className="modal__stat-label">Hours worked</span>
            <span className="mono">{summary.hoursWorked ?? '—'}</span>
          </div>
          <div className="modal__stat">
            <span className="modal__stat-label" title="Hours inside the scheduled shift">Within shift hours</span>
            <span className="mono">{summary.regularHours ?? '—'}</span>
          </div>
          {summary.source === 'exception' && (
            <div className="modal__note">Worked as an exception to the usual schedule for this date.</div>
          )}
          {summary.source === 'suggested' && (
            <div className="modal__note">This worker has no confirmed schedule yet — judged against the pattern their punches fit, pending HR confirmation in Schedules → Pattern review.</div>
          )}
          {summary.source === 'unscheduled' && !isGuessed(summary) && (
            <div className="modal__flag">⚠ Worked outside this worker’s schedule. A supervisor can record an exception for this date.</div>
          )}
          {isGuessed(summary) && <div className="modal__flag">⚠ Shift guessed. {GUESSED_TITLE}</div>}
          {summary.parts && (
            <div className="modal__note">
              Worked the Day and the Night back to back — counted as 2 shifts. Hours run from the Day’s clock-in to the Night’s clock-out
              (Day {summary.parts[0].hoursWorked ?? '—'} h + Night {summary.parts[1].hoursWorked ?? '—'} h).
            </div>
          )}
          {!summary.parts && (summary.checkInImplied || summary.checkOutImplied) && (
            <div className="modal__note">Double shift with no badge at the changeover — split at the scheduled handover time.</div>
          )}
          {(summary.parts || [summary]).map((p) => (
            <div key={p.id} className="modal__note">
              {summary.parts ? `${p.shift.name}: ` : ''}
              {p.changedAfterApproval
                ? '⚠ Changed after approval — the approved values stand until it is re-approved.'
                : p.approvedAt
                  ? `Approved ${formatDateTime(p.approvedAt)}.`
                  : 'Not yet approved.'}
              {p.supervisorComment ? ` Supervisor: “${p.supervisorComment}”` : ''}
            </div>
          ))}
          {summary.hasMultiplePunches && (
            <div className="modal__flag">⚠ Multiple check-ins or check-outs were recorded for this shift — see below.</div>
          )}
        </div>

        <div className="modal__body">
          {loading ? (
            <div className="modal__empty">Loading punch history…</div>
          ) : error ? (
            <div className="modal__error">{error}</div>
          ) : punches.length === 0 ? (
            <div className="modal__empty">No punches found.</div>
          ) : (
            <ul className="punch-list">
              {punches.map((p) => {
                const used = p.usedAsCheckIn || p.usedAsCheckOut || p.changeover;
                return (
                  <li key={p.id} className={`punch-item ${used ? 'punch-item--used' : 'punch-item--ignored'}`}>
                    <span className="punch-item__time mono">{formatDateTime(p.timestamp)}</span>
                    <span className="punch-item__tag">{punchRole(p)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <style>{`
        .modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(15, 23, 42, 0.45);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          z-index: 1000;
          font-family: var(--font);
        }
        .modal {
          width: 100%;
          max-width: 480px;
          max-height: 85vh;
          overflow-y: auto;
          background: var(--panel);
          border: 1px solid var(--line);
          border-radius: 12px;
          box-shadow: var(--shadow-lg);
          color: var(--text);
        }
        .modal__header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          padding: 20px 24px;
          border-bottom: 1px solid var(--line);
        }
        .modal__title {
          font-size: 17px;
          font-weight: 600;
        }
        .modal__subtitle {
          font-size: 13px;
          color: var(--muted);
          margin-top: 2px;
        }
        .modal__close {
          background: none;
          border: none;
          color: var(--muted);
          font-size: 22px;
          line-height: 1;
          cursor: pointer;
          padding: 0;
        }
        .modal__close:hover {
          color: var(--text);
        }
        .modal__note {
          width: 100%;
          font-size: 12px;
          color: var(--muted);
        }
        .modal__summary {
          display: flex;
          gap: 24px;
          padding: 16px 24px;
          border-bottom: 1px solid var(--line);
          flex-wrap: wrap;
        }
        .modal__stat {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .modal__stat-label {
          font-size: 11px;
          color: var(--muted);
        }
        .modal__flag {
          width: 100%;
          font-size: 13px;
          color: var(--warn);
          margin-top: 4px;
        }
        .modal__body {
          padding: 8px 24px 20px;
        }
        .modal__empty, .modal__error {
          color: var(--muted);
          font-size: 14px;
          padding: 24px 0;
          text-align: center;
        }
        .modal__error {
          color: var(--warn);
        }
        .punch-list {
          list-style: none;
          margin: 0;
          padding: 0;
        }
        .punch-item {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 0;
          border-bottom: 1px solid var(--line-soft);
          font-size: 13px;
        }
        .punch-item:last-child {
          border-bottom: none;
        }
        .punch-item__time {
          flex: 0 0 auto;
          color: var(--text);
        }
        .punch-item__tag {
          margin-left: auto;
          font-size: 11px;
          padding: 2px 8px;
          border: 1px solid transparent;
          border-radius: 999px;
        }
        .punch-item--used .punch-item__tag {
          color: var(--accent);
          background: var(--accent-bg);
          border-color: var(--accent-line);
        }
        .punch-item--ignored .punch-item__tag {
          color: var(--warn);
          background: var(--warn-bg);
          border-color: var(--warn-line);
        }
        .mono {
          font-family: var(--font-num); font-variant-numeric: tabular-nums;
        }
        .status {
          font-size: 12px;
          font-weight: 500;
          padding: 3px 10px;
          border: 1px solid transparent;
          border-radius: 999px;
          display: inline-block;
          width: fit-content;
        }
        .status--ok {
          color: var(--accent);
          background: var(--accent-bg);
          border-color: var(--accent-line);
        }
        .status--late {
          color: var(--warn);
          background: var(--warn-bg);
          border-color: var(--warn-line);
        }
        .status--pending {
          color: var(--muted);
          background: var(--panel-2);
          border-color: var(--line-strong);
        }
        .status--early {
          color: var(--info);
          background: var(--info-bg);
          border-color: var(--info-line);
        }
        .status--critical {
          color: var(--critical);
          background: var(--critical-bg);
          border-color: var(--critical-line);
        }

        /* Phones: slides up from the bottom as a sheet. */
        @media (max-width: 760px) {
          .modal-backdrop { align-items: flex-end; padding: 0; animation: fade-in 0.15s ease-out; }
          .modal {
            max-width: none; max-height: 90vh; border: none;
            border-radius: 22px 22px 0 0;
            padding-bottom: env(safe-area-inset-bottom);
            overscroll-behavior: contain;
            animation: sheet-up 0.24s cubic-bezier(0.2, 0.9, 0.3, 1);
          }
          .modal__header { position: sticky; top: 0; z-index: 1; background: var(--panel); padding: 22px 18px 14px; }
          .modal__header::before {
            content: ''; position: absolute; top: 8px; left: 50%; margin-left: -20px;
            width: 40px; height: 5px; border-radius: 3px; background: var(--line-strong);
          }
          .modal__close {
            width: 36px; height: 36px; border-radius: 50%;
            background: var(--panel-2); font-size: 22px;
          }
          .modal__summary { padding: 14px 18px; gap: 16px 22px; }
          .modal__body { padding: 4px 18px 20px; }
          .punch-item { padding: 13px 0; font-size: 14px; flex-wrap: wrap; }
        }
      `}</style>
    </div>
  );
}
