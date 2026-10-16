import { useState } from 'react';
import { formatDateTime } from './api';

// The dashboard's "Badges set aside" section: every badge set aside in the
// period (GET /api/punches/set-aside), with who did it, when and why, and
// Restore. The way back to a badge whose shift record went away with it.
// onRestore(badge) returns a promise.
export default function SetAsideBadges({ badges, onRestore }) {
  const [open, setOpen] = useState(true);
  const [busyId, setBusyId] = useState(null);

  async function restore(b) {
    setBusyId(b.id);
    try { await onRestore(b); } finally { setBusyId(null); }
  }

  return (
    <section className="dash__section">
      <button className="dash__section-header" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`dash__chevron ${open ? '' : 'dash__chevron--collapsed'}`}>▾</span>
        <span className="dash__section-title">Badges set aside<span className="dash__count">{badges.length}</span></span>
        <span className="dash__section-hint">left out of every shift as made by mistake. Restore any that were real</span>
      </button>
      {open && (
        <ul className="aside-list">
          {badges.map((b) => (
            <li key={b.id} className="aside-list__item">
              <div className="aside-list__main">
                <div>
                  <span className="aside-list__name">{b.worker.name}</span>
                  <span className="muted small mono"> {b.worker.biostarUserId}</span>
                </div>
                <div className="aside-list__badge mono">Badge {formatDateTime(b.timestamp)}</div>
                <div className="small muted">
                  Set aside{b.setAside.by ? ` by ${b.setAside.by}` : ''} on {formatDateTime(b.setAside.at)}
                  {b.setAside.reason ? <>: “{b.setAside.reason}”</> : null}
                </div>
              </div>
              {b.canRestore && (
                <button className="btn btn--small" disabled={busyId === b.id} onClick={() => restore(b)}>
                  {busyId === b.id ? 'Restoring…' : 'Restore'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
