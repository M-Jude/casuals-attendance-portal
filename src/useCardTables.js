import { useEffect } from 'react';

// On phones, `.table` rows are laid out as cards (portal.css). Each card
// field needs its column heading as a caption, so this copies the heading
// text onto every cell as data-label — for every page at once, including
// rows rendered later — instead of each table labelling its own cells.
// Cells under an empty heading (action buttons) and cells spanning several
// columns get `card-full` so they take the card's full width.
//
// Report tables stay as real tables (they scroll sideways instead).

const SORT_ARROWS = /[▲▼↕]/g;

function labelTable(table) {
  const headings = [...table.querySelectorAll(':scope > thead > tr:first-child > th')].flatMap((th) => {
    const text = th.textContent.replace(SORT_ARROWS, '').trim();
    return Array(th.colSpan || 1).fill(text);
  });
  if (!headings.length) return;
  for (const tr of table.querySelectorAll(':scope > tbody > tr')) {
    let col = 0;
    for (const td of tr.children) {
      const span = td.colSpan || 1;
      const label = span > 1 ? '' : headings[col] || '';
      if (td.getAttribute('data-label') !== label) td.setAttribute('data-label', label);
      td.classList.toggle('card-full', !label);
      col += span;
    }
  }
}

export default function useCardTables(ref) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    let frame = 0;
    const run = () => {
      frame = 0;
      root.querySelectorAll('table.table:not(.report-table)').forEach(labelTable);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(run); };
    run();
    // Only child-list changes are watched, so setting labels can't retrigger it.
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref]);
}
