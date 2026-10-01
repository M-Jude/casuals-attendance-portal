import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDateTime } from './api';

const POLL_MS = 60 * 1000;

export default function NotificationsBell({ api, onNavigate }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const ref = useRef(null);

  const load = useCallback(() => {
    api('/api/notifications')
      .then(({ notifications, unread: n }) => {
        setItems(notifications);
        setUnread(n);
      })
      .catch(() => {});
  }, [api]);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function openItem(n) {
    if (!n.readAt) await api(`/api/notifications/${n.id}/read`, { method: 'POST' }).catch(() => {});
    setOpen(false);
    if (n.link) onNavigate(n.link);
    load();
  }

  async function markAll() {
    await api('/api/notifications/read-all', { method: 'POST' }).catch(() => {});
    load();
  }

  return (
    <div className="bell" ref={ref}>
      <button className="bell__button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`Notifications, ${unread} unread`}>
        Notifications
        {unread > 0 && <span className="bell__badge">{unread}</span>}
      </button>
      {open && (
        <div className="bell__panel" role="dialog" aria-label="Notifications">
          <div className="bell__head">
            <span>{unread} unread</span>
            {unread > 0 && <button className="btn btn--link small" onClick={markAll}>Mark all read</button>}
          </div>
          {items.length === 0 ? (
            <div className="empty small">No notifications yet.</div>
          ) : (
            items.map((n) => (
              <button key={n.id} className={`bell__item ${n.readAt ? '' : 'bell__item--unread'}`} onClick={() => openItem(n)}>
                <div className="bell__item-title">{n.title}</div>
                <div className="bell__item-body">{n.body}</div>
                <div className="bell__item-time">{formatDateTime(n.createdAt)}</div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
