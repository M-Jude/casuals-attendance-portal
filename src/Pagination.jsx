import { useEffect, useMemo, useState } from 'react';

const PAGE_SIZES = [25, 50, 100, 200];

function readSize(id, fallback) {
  try {
    const v = parseInt(localStorage.getItem(`pageSize:${id}`), 10);
    return PAGE_SIZES.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Client-side paging for a list that's already loaded.
 *   id        — remembers the chosen page size per list (this browser only)
 *   resetKey  — back to page 1 whenever this changes (filters, sort, range)
 * Returns { pageItems, pager } — render `pager` where the controls go.
 */
export function usePagination(items, { id, defaultSize = 50, resetKey = '', noun = 'rows' } = {}) {
  const [size, setSize] = useState(() => readSize(id, defaultSize));
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(items.length / size));

  useEffect(() => { setPage(1); }, [resetKey, size]);
  // A list that shrank (a filter, an item removed) keeps a valid page.
  useEffect(() => { if (page > pages) setPage(pages); }, [page, pages]);

  const pageItems = useMemo(() => items.slice((page - 1) * size, page * size), [items, page, size]);

  function changeSize(n) {
    setSize(n);
    try { localStorage.setItem(`pageSize:${id}`, String(n)); } catch { /* per-viewer convenience only */ }
  }

  const pager = (
    <Pagination total={items.length} page={Math.min(page, pages)} pages={pages} size={size} onPage={setPage} onSize={changeSize} noun={noun} />
  );
  return { pageItems, pager, page, size };
}

// Page numbers to show: first, last, and a window around the current page.
function pageList(page, pages) {
  const set = new Set([1, pages, page - 1, page, page + 1]);
  if (page <= 3) [2, 3, 4].forEach((p) => set.add(p));
  if (page >= pages - 2) [pages - 1, pages - 2, pages - 3].forEach((p) => set.add(p));
  const list = [...set].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  const out = [];
  list.forEach((p, i) => {
    if (i > 0 && p - list[i - 1] > 1) out.push('…');
    out.push(p);
  });
  return out;
}

export default function Pagination({ total, page, pages, size, onPage, onSize, noun = 'rows' }) {
  if (total === 0) return null;
  const first = (page - 1) * size + 1;
  const last = Math.min(total, page * size);
  return (
    <nav className="pager" aria-label="Pagination">
      <span className="pager__info">
        {first}–{last} of {total} {noun}
      </span>
      {pages > 1 && (
        <span className="pager__pages">
          <button type="button" className="pager__btn" onClick={() => onPage(page - 1)} disabled={page === 1} aria-label="Previous page">‹</button>
          {pageList(page, pages).map((p, i) => (p === '…'
            ? <span key={`gap${i}`} className="pager__gap">…</span>
            : (
              <button
                type="button"
                key={p}
                className={`pager__btn ${p === page ? 'pager__btn--active' : ''}`}
                aria-current={p === page ? 'page' : undefined}
                onClick={() => onPage(p)}
              >
                {p}
              </button>
            )))}
          <button type="button" className="pager__btn" onClick={() => onPage(page + 1)} disabled={page === pages} aria-label="Next page">›</button>
        </span>
      )}
      <label className="pager__size">
        Per page
        <select value={size} onChange={(e) => onSize(parseInt(e.target.value, 10))}>
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
    </nav>
  );
}
