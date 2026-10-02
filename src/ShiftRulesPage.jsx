import { useCallback, useEffect, useState } from 'react';
import { useBusy, useToast } from './toast';
import { recalcResult, useConfirm } from './confirm';

function addMinutes(hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function isNextDay(shift, hhmm) {
  return hhmm <= shift.startTime;
}

function RuleCard({ shift, canEdit, onSave }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(shift);
  const [error, setError] = useState('');
  const toast = useToast();
  const confirm = useConfirm();
  const { guard, busy } = useBusy();
  const overnight = shift.endTime <= shift.startTime;

  useEffect(() => { setForm(shift); }, [shift]);

  async function save(e) {
    e.preventDefault();
    const ok = await confirm({
      title: `Change the ${shift.name} shift rules?`,
      body: (
        <>
          <p>
            {form.startTime}–{form.endTime}, check-ins from {form.earliestCheckIn}, check-outs until {form.latestCheckOut},
            late after {form.graceMinutes} min, early-out grace {form.earlyOutGraceMinutes} min.
          </p>
          <p>
            Everyone’s attendance for the last two weeks will be recalculated with the new rules — this can take a minute.
            Approved shifts stay as approved; any whose figures change are held for re-approval.
          </p>
        </>
      ),
      confirmLabel: 'Save and recalculate'
    });
    if (!ok) return undefined;

    return guard(async () => {
      setError('');
      try {
        const result = await onSave(form);
        setEditing(false);
        toast.success(`${shift.name} shift rules saved.${recalcResult(result?.recalculated)}`);
      } catch (err) {
        setError(err.message);
        toast.error(`Couldn’t save the ${shift.name} shift rules: ${err.message}`);
      }
    });
  }

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  return (
    <div className="card">
      <h3 className="card__title">{shift.name} shift</h3>
      <p className="card__sub">{shift.startTime} – {shift.endTime}{overnight ? ' (next morning)' : ''}</p>
      <div className="card__row">Check-ins count from <strong>{shift.earliestCheckIn}</strong>.</div>
      <div className="card__row">
        On time until <strong>{addMinutes(shift.startTime, shift.graceMinutes)}</strong>; checking in after that is <strong>late</strong>.
      </div>
      <div className="card__row">
        Checking out before <strong>{addMinutes(shift.endTime, -shift.earlyOutGraceMinutes)}</strong>{overnight ? ' (next morning)' : ''} is an <strong>early check-out</strong>.
      </div>
      <div className="card__row">
        Check-outs are accepted until <strong>{shift.latestCheckOut}</strong>{isNextDay(shift, shift.latestCheckOut) ? ' the next day' : ''}.
      </div>

      {canEdit && !editing && <button className="btn btn--small" style={{ marginTop: 12 }} onClick={() => setEditing(true)}>Edit rules…</button>}
      {editing && (
        <form onSubmit={save} style={{ marginTop: 12 }}>
          <div className="form-row">
            <label className="field">Starts<input type="time" value={form.startTime} onChange={set('startTime')} required /></label>
            <label className="field">Ends<input type="time" value={form.endTime} onChange={set('endTime')} required /></label>
            <label className="field">Check-ins from<input type="time" value={form.earliestCheckIn} onChange={set('earliestCheckIn')} required /></label>
            <label className="field">Check-outs until<input type="time" value={form.latestCheckOut} onChange={set('latestCheckOut')} required /></label>
            <label className="field">Late after (min)<input type="number" min="0" max="240" value={form.graceMinutes} onChange={set('graceMinutes')} style={{ width: 90 }} /></label>
            <label className="field">Early-out grace (min)<input type="number" min="0" max="240" value={form.earlyOutGraceMinutes} onChange={set('earlyOutGraceMinutes')} style={{ width: 90 }} /></label>
          </div>
          <div className="form-row" style={{ marginTop: 10 }}>
            <button className="btn btn--primary btn--small" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn btn--small" onClick={() => { setForm(shift); setEditing(false); }}>Cancel</button>
          </div>
          <p className="small muted">Saving recalculates the last two weeks. Already-approved records are kept and flagged for re-approval if the new rules change them.</p>
          {error && <div className="error">{error}</div>}
        </form>
      )}
    </div>
  );
}

export default function ShiftRulesPage({ api, user }) {
  const [shifts, setShifts] = useState([]);
  const [error, setError] = useState('');
  const canEdit = ['sysadmin', 'hr'].includes(user.role);

  const load = useCallback(() => {
    api('/api/shifts').then((d) => setShifts(d.shifts)).catch((err) => setError(err.message));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  async function save(shift) {
    const result = await api(`/api/shifts/${shift.id}`, {
      method: 'PUT',
      body: {
        startTime: shift.startTime,
        endTime: shift.endTime,
        earliestCheckIn: shift.earliestCheckIn,
        latestCheckOut: shift.latestCheckOut,
        graceMinutes: Number(shift.graceMinutes),
        earlyOutGraceMinutes: Number(shift.earlyOutGraceMinutes)
      }
    });
    load();
    return result;
  }

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h2 className="page__title">Shift rules</h2>
          <p className="page__hint">How every attendance record in this portal is judged. These are the same rules the reports and exports use.</p>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="cards">
        {shifts.map((s) => <RuleCard key={s.id} shift={s} canEdit={canEdit} onSave={save} />)}
      </div>

      <div className="panel">
        <h3 className="panel__title">How attendance is worked out</h3>
        <ul className="page__hint" style={{ paddingLeft: 18, margin: 0 }}>
          <li>Each worker is expected on a shift by their schedule: their crew’s cycle (e.g. Day, Day, Night, Night, off, off), permanent Day or Night, or a supervisor’s exception for that date.</li>
          <li>The first punch inside a shift’s check-in window is the check-in and the last is the check-out. Badges seconds apart count once. A missed or extra punch only affects its own shift.</li>
          <li>Night shifts are dated by the evening they start.</li>
          <li>A double shift is two shifts worked back to back — a Day and that evening’s Night, or a Night and the next morning’s Day. It counts as two shifts, and as one double shift on the date it started. A Day and that evening’s Night show as one “Day + Night” line, from the Day’s clock-in to the Night’s clock-out, on the Day’s date — each shift is still approved by its own supervisor. One badge at the changeover (17:00 or 08:00) ends the first shift and starts the second; with no badge there the split is made at the handover time and marked “implied”.</li>
          <li>Hours worked are check-out minus check-in. No meal or break time is deducted.</li>
          <li>Punches outside anyone’s schedule are still shown, marked “unscheduled”, so a supervisor can record the exception.</li>
          <li>A scheduled shift with no punches at all is a no-show.</li>
        </ul>
      </div>

      <div className="panel">
        <h3 className="panel__title">Approvals</h3>
        <ul className="page__hint" style={{ paddingLeft: 18, margin: 0 }}>
          <li>Each crew’s supervisor approves their crew’s shift once it ends, with optional comments.</li>
          <li>A shift left unapproved for 48 hours is escalated to HR and the Admin Assistant (in the portal and by email).</li>
          <li>Permanent Day and Night staff are approved by HR at the end of each month.</li>
          <li>Finance sees approved records only. Approved records are locked; if a later punch changes one, it is flagged and needs re-approval.</li>
        </ul>
      </div>
    </div>
  );
}
