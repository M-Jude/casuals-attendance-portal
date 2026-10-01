// Shown when a schedule change would move a supervisor's worker record off
// their crew: HR decides whether they stay supervisor (of the new crew) or
// go back to being just a worker, which disables their portal account.
export default function SupervisorDecision({ decision, busy, onChoose, onCancel }) {
  const { name, email, fromCrew, toCrew, canKeep } = decision;
  return (
    <div className="decision" role="alertdialog" aria-label="Supervisor decision">
      <div className="decision__title">{name} is the supervisor of {fromCrew || 'their crew'}</div>
      <p className="decision__body">
        {toCrew
          ? <>This moves them to <strong>{toCrew}</strong>. A supervisor always leads the crew they rotate with — should they supervise {toCrew} now?</>
          : <>This takes them off crews. A supervisor must rotate with the crew they lead, so they can only stay on as a worker.</>}
      </p>
      <div className="decision__actions">
        {canKeep && (
          <button className="btn btn--primary btn--small" disabled={busy} onClick={() => onChoose('keep')}>
            Yes — make them supervisor of {toCrew}
          </button>
        )}
        <button className="btn btn--danger btn--small" disabled={busy} onClick={() => onChoose('demote')}>
          {canKeep ? 'No — just a worker now' : 'Continue — just a worker now'}
        </button>
        <button className="btn btn--link small" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      <p className="decision__note">
        “Just a worker” disables their portal account ({email}); their attendance keeps being recorded as normal.
        {fromCrew ? ` ${fromCrew} will need a new supervisor.` : ''}
      </p>
    </div>
  );
}
