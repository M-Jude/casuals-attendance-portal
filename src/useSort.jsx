import { useMemo, useState } from 'react';

// Click-to-sort table headings.
//
//   const { sorted, th, sortKey } = useSort(items, {
//     worker: (r) => r.worker.name,          // accessor per sortable column
//     hours: { get: (r) => r.hoursWorked, first: 'desc' }
//   });
//   <thead><tr>{th('worker', 'Worker')}{th('hours', 'Hours')}<th>Notes</th></tr></thead>
//
// A first click sorts by that column (ascending, or the column's `first`
// direction); clicking again reverses it. Empty values always sort last.
// With no column chosen, items keep the order they came in.

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function compareValues(a, b) {
  const emptyA = a === null || a === undefined || a === '';
  const emptyB = b === null || b === undefined || b === '';
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a instanceof Date && b instanceof Date) return a - b;
  return collator.compare(String(a), String(b));
}

export function sortItems(items, get, dir) {
  const sign = dir === 'desc' ? -1 : 1;
  return items
    .map((item, i) => ({ item, i, v: get(item) }))
    .sort((x, y) => {
      const emptyX = x.v === null || x.v === undefined || x.v === '';
      const emptyY = y.v === null || y.v === undefined || y.v === '';
      if (emptyX !== emptyY) return emptyX ? 1 : -1; // empties last either way
      return sign * compareValues(x.v, y.v) || x.i - y.i; // stable
    })
    .map((x) => x.item);
}

// Just the heading button — for tables that manage their own sorting.
export function SortHeading({ label, active, dir, onClick, align, title }) {
  return (
    <th aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={align === 'center' ? 'num' : undefined}>
      <button type="button" className={`th-sort ${active ? 'th-sort--active' : ''}`} onClick={onClick} title={title || `Sort by ${label}`}>
        {label}
        <span className="th-sort__arrow" aria-hidden="true">{active ? (dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    </th>
  );
}

export function useSort(items, columns, initial = null) {
  const [sort, setSort] = useState(initial); // { key, dir } | null

  const sorted = useMemo(() => {
    if (!sort || !columns[sort.key]) return items;
    const col = columns[sort.key];
    const get = typeof col === 'function' ? col : col.get;
    return sortItems(items, get, sort.dir);
    // columns is usually an inline object; the sort only needs to rerun
    // when the items or the chosen column change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, sort]);

  function toggle(key) {
    const col = columns[key];
    const first = (col && typeof col === 'object' && col.first) || 'asc';
    setSort((s) => (s && s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: first }));
  }

  function th(key, label, { align, title } = {}) {
    return (
      <SortHeading
        key={key}
        label={label}
        align={align}
        title={title}
        active={sort?.key === key}
        dir={sort?.dir}
        onClick={() => toggle(key)}
      />
    );
  }

  return { sorted, th, sortKey: sort ? `${sort.key}:${sort.dir}` : '', sort, setSort };
}
