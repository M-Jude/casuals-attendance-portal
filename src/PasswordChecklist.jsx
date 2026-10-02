import { MAX_BYTES, RULES } from './passwordPolicy';

// Live list of the password rules, ticked off as they're met.
export default function PasswordChecklist({ password, id }) {
  const tooLong = new TextEncoder().encode(password || '').length > MAX_BYTES;
  return (
    <ul className="pw-checklist" id={id} aria-live="polite">
      {RULES.map((r) => {
        const met = r.test(password || '');
        return (
          <li key={r.id} className={met ? 'pw-checklist__item pw-checklist__item--met' : 'pw-checklist__item'}>
            <span aria-hidden="true">{met ? '✓' : '○'}</span> {r.label}
            <span className="visually-hidden">{met ? ' (done)' : ' (needed)'}</span>
          </li>
        );
      })}
      {tooLong && <li className="pw-checklist__item pw-checklist__item--bad">✕ No more than {MAX_BYTES} characters</li>}
    </ul>
  );
}
