import { reapproveCheckbox, recalcResult, useConfirm } from './confirm';
import { useToast } from './toast';
import { formatDateTime } from './api';

// Setting a badge aside (a badge made by mistake) and restoring it — shared by
// the punch history, Approvals and the dashboard's "Badges set aside" list.
// The API (routes/punches.js) has the final say on who may change which
// badge.

// Roles that may set badges aside and restore them.
export const BADGE_EDITORS = ['sysadmin', 'hr', 'admin_assistant', 'supervisor'];

// The badge's date in Kampala.
const dayOf = (ts) => new Date(new Date(ts).getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);

// The "re-approve automatically" checkbox for setting a badge aside.
export const setAsideCheckbox = (ts) => reapproveCheckbox(dayOf(ts));

// The same for a restore: ticked for HR and the System Admin; unticked for
// others, so what a restore changes goes back for approval.
export function restoreCheckbox(ts, user) {
  const box = reapproveCheckbox(dayOf(ts));
  return box && { ...box, defaultChecked: ['hr', 'sysadmin'].includes(user?.role) };
}

// api: makeApi()'s helper. onChanged(action) runs after a badge is set aside
// or restored ('set-aside' / 'restore'), including by Undo.
export function useBadgeAside(api, user, onChanged) {
  const confirm = useConfirm();
  const toast = useToast();

  async function post(id, action, body) {
    const result = await api(`/api/punches/${id}/${action}`, { method: 'POST', body });
    onChanged?.(action);
    return result;
  }

  // Sets the badge aside (the caller has asked why); the success message
  // offers Undo, which restores it with the same choice about re-approval.
  async function setAside(id, reason, autoReapprove) {
    const result = await post(id, 'set-aside', { reason, autoReapprove });
    toast.success(`Badge set aside.${recalcResult(result.recalculated)}`, {
      action: {
        label: 'Undo',
        onClick: async () => {
          try {
            const undone = await post(id, 'restore', { autoReapprove });
            toast.success(`Badge restored.${recalcResult(undone.recalculated)}`);
          } catch (err) {
            toast.error(`Couldn’t restore the badge: ${err.message}`);
          }
        }
      }
    });
    return result;
  }

  // Asks, then restores. p: { id, timestamp, setAside: { reason } }.
  async function restore(p, workerName) {
    const ok = await confirm({
      title: `Restore ${workerName ? `${workerName}’s` : 'the'} badge of ${formatDateTime(p.timestamp)}?`,
      body: <p>It was set aside{p.setAside?.reason ? `: “${p.setAside.reason}”` : ''}. {workerName ? `${workerName}’s` : 'Their'} shifts are worked out again with it.</p>,
      checkbox: restoreCheckbox(p.timestamp, user),
      confirmLabel: 'Restore'
    });
    if (!ok) return false;
    try {
      const result = await post(p.id, 'restore', { autoReapprove: ok.checked === true });
      toast.success(`Badge restored.${recalcResult(result.recalculated)}`);
      return true;
    } catch (err) {
      toast.error(`Couldn’t restore the badge: ${err.message}`);
      return false;
    }
  }

  return { setAside, restore };
}
