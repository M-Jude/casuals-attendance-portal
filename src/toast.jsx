import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

// Pop-up messages ("toasts") that confirm an action worked, or say why it
// didn't, wherever on the page the button was. Success and info messages
// fade after a few seconds; errors stay until closed (or for longer), so
// they can be read.
//
//   const toast = useToast();
//   toast.success('Saved.');  toast.error(err.message);  toast.info('Already done.');
//   toast.success('Badge set aside.', { action: { label: 'Undo', onClick: undo } });
//
// A message with an action button stays up longer (ACTION_DURATION), so
// there's time to use it; using it closes the message.

const ToastContext = createContext(null);
const DURATION = { success: 4500, info: 6000, warn: 9000, error: 10000 };
const ACTION_DURATION = 12000;
let nextId = 1;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const show = useCallback((kind, message, { action = null } = {}) => {
    if (!message) return;
    const id = nextId++;
    // The same message twice in a row (e.g. a repeated error) replaces the
    // first rather than stacking up.
    setToasts((list) => [...list.filter((t) => t.message !== message).slice(-3), { id, kind, message, action }]);
    timers.current.set(id, setTimeout(() => dismiss(id), action ? Math.max(ACTION_DURATION, DURATION[kind]) : DURATION[kind]));
  }, [dismiss]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const api = useMemo(() => ({
    success: (m, o) => show('success', m, o),
    info: (m, o) => show('info', m, o),
    warn: (m, o) => show('warn', m, o),
    error: (m, o) => show('error', m, o)
  }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <span className="toast__icon" aria-hidden="true">{{ success: '✓', info: 'i', warn: '!', error: '✕' }[t.kind]}</span>
            <span className="toast__msg">{t.message}</span>
            {t.action && (
              <button className="toast__action" onClick={() => { dismiss(t.id); t.action.onClick(); }}>{t.action.label}</button>
            )}
            <button className="toast__close" onClick={() => dismiss(t.id)} aria-label="Dismiss message">×</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>.');
  return ctx;
}

// Stops an action running twice at once (a double click, or a second click
// while the first request is still out). guard(key, fn) runs fn unless an
// action with that key is already running; isBusy(key) is for disabling the
// button meanwhile. The key lets each row of a list have its own button.
//
//   const { guard, isBusy } = useBusy();
//   <button disabled={isBusy(row.id)} onClick={() => guard(row.id, () => save(row))}>
export function useBusy() {
  const running = useRef(new Set());
  const [busyKeys, setBusyKeys] = useState(() => new Set());

  const guard = useCallback(async (key, fn) => {
    if (typeof key === 'function') { fn = key; key = 'default'; }
    if (running.current.has(key)) return undefined;
    running.current.add(key);
    setBusyKeys(new Set(running.current));
    try {
      return await fn();
    } finally {
      running.current.delete(key);
      setBusyKeys(new Set(running.current));
    }
  }, []);

  const isBusy = useCallback((key = 'default') => busyKeys.has(key), [busyKeys]);
  return { guard, isBusy, busy: busyKeys.size > 0 };
}

// The server's "that was already done" answers (a repeat of an action that
// already succeeded) — worth an info message and a refresh, not an error.
export function isAlreadyDone(err) {
  return err?.data?.code === 'ALREADY_DONE';
}
