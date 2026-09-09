import { useEffect, useState } from 'react';

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

const EVENT_LABEL = { 'check-in': 'Check-in', 'check-out': 'Check-out', other: 'Other' };

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
        const params = new URLSearchParams({
          workerId: String(summary.worker.id),
          shiftId: String(summary.shift.id),
          date: summary.date.slice(0, 10)
        });
        const res = await fetch(`/api/attendance/punches?${params}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Request failed');
        const { punches: data } = await res.json();
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
              {formatDate(summary.date.slice(0, 10))} · {summary.shift.name} shift
            </div>
          </div>
          <button className="modal__close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal__summary">
          <div className="modal__stat">
            <span className="modal__stat-label">Status</span>
            <span className={`status status--${summary.status === 'no-checkout' ? 'pending' : summary.status === 'late' ? 'late' : 'ok'}`}>
              {summary.status === 'on-time' ? 'On time' : summary.status === 'late' ? 'Late' : 'No checkout'}
            </span>
          </div>
          <div className="modal__stat">
            <span className="modal__stat-label">Hours worked</span>
            <span className="mono">{summary.hoursWorked ?? '—'}</span>
          </div>
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
                const used = p.usedAsCheckIn || p.usedAsCheckOut;
                return (
                  <li key={p.id} className={`punch-item ${used ? 'punch-item--used' : 'punch-item--ignored'}`}>
                    <span className="punch-item__time mono">{formatDateTime(p.timestamp)}</span>
                    <span className="punch-item__type">{EVENT_LABEL[p.eventType] || p.eventType}</span>
                    <span className="punch-item__tag">
                      {p.eventType === 'other'
                        ? null
                        : used
                          ? 'Used'
                          : 'Ignored (duplicate)'}
                    </span>
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
          background: rgba(15, 27, 44, 0.7);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          z-index: 1000;
          font-family: 'IBM Plex Sans', system-ui, sans-serif;
        }
        .modal {
          width: 100%;
          max-width: 480px;
          max-height: 85vh;
          overflow-y: auto;
          background: #16243A;
          border: 1px solid #24354F;
          color: #E8EDF2;
        }
        .modal__header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          padding: 20px 24px;
          border-bottom: 1px solid #24354F;
        }
        .modal__title {
          font-size: 17px;
          font-weight: 600;
        }
        .modal__subtitle {
          font-size: 13px;
          color: #8A99AC;
          margin-top: 2px;
        }
        .modal__close {
          background: none;
          border: none;
          color: #8A99AC;
          font-size: 22px;
          line-height: 1;
          cursor: pointer;
          padding: 0;
        }
        .modal__close:hover {
          color: #E8EDF2;
        }
        .modal__summary {
          display: flex;
          gap: 24px;
          padding: 16px 24px;
          border-bottom: 1px solid #24354F;
          flex-wrap: wrap;
        }
        .modal__stat {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .modal__stat-label {
          font-size: 11px;
          color: #8A99AC;
        }
        .modal__flag {
          width: 100%;
          font-size: 13px;
          color: #C9A227;
          margin-top: 4px;
        }
        .modal__body {
          padding: 8px 24px 20px;
        }
        .modal__empty, .modal__error {
          color: #8A99AC;
          font-size: 14px;
          padding: 24px 0;
          text-align: center;
        }
        .modal__error {
          color: #C9A227;
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
          border-bottom: 1px solid #1B2A40;
          font-size: 13px;
        }
        .punch-item:last-child {
          border-bottom: none;
        }
        .punch-item__time {
          flex: 0 0 auto;
          color: #E8EDF2;
        }
        .punch-item__type {
          flex: 1;
          color: #8A99AC;
        }
        .punch-item__tag {
          font-size: 11px;
          padding: 2px 8px;
          border: 1px solid transparent;
        }
        .punch-item--used .punch-item__tag {
          color: #3E8E7E;
          border-color: #2A5F53;
        }
        .punch-item--ignored .punch-item__tag {
          color: #C9A227;
          border-color: #8A6E1B;
        }
        .mono {
          font-family: 'IBM Plex Mono', monospace;
        }
        .status {
          font-size: 12px;
          padding: 3px 8px;
          border: 1px solid transparent;
          display: inline-block;
          width: fit-content;
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
      `}</style>
    </div>
  );
}
