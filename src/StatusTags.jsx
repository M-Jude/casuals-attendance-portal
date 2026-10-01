import { TAG_LABEL, statusTags } from './shiftStatus';

// Late in / Early out pills for a shift row — nothing at all otherwise.
// `tags` may be passed directly (report rows carry them as "late-in,early-out").
export default function StatusTags({ row, tags }) {
  const list = tags ?? statusTags(row);
  if (!list.length) return null;
  return (
    <span className="tags">
      {list.map((t) => <span key={t} className={`tag tag--${t}`}>{TAG_LABEL[t] || t}</span>)}
    </span>
  );
}
