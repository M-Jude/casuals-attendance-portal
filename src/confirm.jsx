import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

// An in-page "are you sure?" dialog, for changes that recalculate attendance
// (schedules, cycles, exceptions, shift rules) and other actions worth a
// second look. Returns a promise of true (go ahead) or false (cancelled).
// With cancelLabel: null it's a plain notice with a single button.
// With checkbox: { label, hint, defaultChecked } it also shows a checkbox,
// and going ahead resolves to { checked } instead of true.
//
//   const confirm = useConfirm();
//   if (!(await confirm({ title, body, confirmLabel }))) return;

const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
  const [request, setRequest] = useState(null); // { title, body, confirmLabel, danger, checkbox, resolve }
  const [checked, setChecked] = useState(false);
  const confirmButton = useRef(null);
  const returnFocus = useRef(null);

  const confirm = useCallback((options) => new Promise((resolve) => {
    returnFocus.current = document.activeElement;
    setChecked(options.checkbox?.defaultChecked ?? false);
    setRequest({ confirmLabel: 'Continue', ...options, resolve });
  }), []);

  const close = useCallback((answer) => {
    setRequest((r) => { r?.resolve(answer); return null; });
    // Back to the button that opened it.
    setTimeout(() => returnFocus.current?.focus?.(), 0);
  }, []);

  useEffect(() => {
    if (!request) return undefined;
    confirmButton.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, close]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request && (
        <div className="confirm-backdrop" onClick={() => close(false)} role="presentation">
          <div
            className="confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-body"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="confirm__title" id="confirm-title">{request.title}</h2>
            <div className="confirm__body" id="confirm-body">{request.body}</div>
            {request.checkbox && (
              <label className="checkbox confirm__check">
                <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
                <span>
                  {request.checkbox.label}
                  {request.checkbox.hint && <span className="small muted" style={{ display: 'block' }}>{request.checkbox.hint}</span>}
                </span>
              </label>
            )}
            <div className="confirm__actions">
              {request.cancelLabel !== null && <button className="btn" onClick={() => close(false)}>{request.cancelLabel || 'Cancel'}</button>}
              <button ref={confirmButton} className={`btn ${request.danger ? 'btn--danger' : 'btn--primary'}`} onClick={() => close(request.checkbox ? { checked } : true)}>
                {request.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>.');
  return ctx;
}

// ---------------------------------------------------------------- wording

const DAY_MS = 86400000;
function todayEatStr() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function formatDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// What a change from `from` onwards will recalculate, in words, for the
// confirmation dialog. `who` is possessive, e.g. "Achieng Mary’s" or
// "Crew A’s 24 workers’".
export function recalcNotice(who, from) {
  const today = todayEatStr();
  if (from > today) {
    return `It takes effect from ${formatDay(from)}, so no existing attendance records change.`;
  }
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  return `${who} attendance from ${formatDay(from)} to today (${days} day${days === 1 ? '' : 's'}) will be recalculated against it. `
    + 'Shifts already approved stay as approved; any whose figures change are held for re-approval.';
}

// The "re-approve automatically" checkbox for a schedule change — only when
// it reaches existing records (from today or earlier). Ticked by default.
export function reapproveCheckbox(from) {
  if (from > todayEatStr()) return undefined;
  return {
    label: 'Re-approve changed records automatically',
    hint: 'Shifts already approved that this change alters or replaces (e.g. a Night that becomes a Day) are approved as you, instead of going back to their supervisor or HR. Untick to send them back for approval.',
    defaultChecked: true
  };
}

// What a recalculation actually did, for the success message.
export function recalcResult(r) {
  if (!r) return '';
  if (r.skipped) return ' Attendance couldn’t be recalculated because the Day and Night shifts aren’t set up yet.';
  const changed = r.created + r.updated + r.deleted;
  if (!r.computed && !changed) return ' No attendance records were affected.';
  const parts = [`${r.computed} shift record${r.computed === 1 ? '' : 's'} recalculated`];
  parts.push(changed ? `${changed} changed` : 'none changed');
  if (r.reapproved) parts.push(`${r.reapproved} approved shift${r.reapproved === 1 ? '' : 's'} re-approved automatically`);
  if (r.flaggedAfterApproval) parts.push(`${r.flaggedAfterApproval} approved shift${r.flaggedAfterApproval === 1 ? '' : 's'} now need re-approval`);
  return ` ${parts.join(', ')}.`;
}
