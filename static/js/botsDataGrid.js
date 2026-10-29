// A table that pages from the server (Phase 6 unit U2, 2026-10-29): only the rows near the viewport are drawn,
// each page of 100 is fetched when it is first needed, a header click sorts on the server, a filter box per
// column narrows on the server, and the loaded rows copy as tab-separated text. Built from DOM nodes only:
// a cell is always set with textContent, so a value from a file or a query can never become markup.
import { ROW_HEIGHT, PAGE_SIZE, windowRange, pagesNeeded, nextSort, sortMark, cleanFilters, formatCell, isNumeric, toTsv, rowCountLabel } from './botsDataModel.js';

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

// fetchPage({offset, limit, sort, filter}) -> {columns, rows, row_count}. `columns` seeds the header.
// onStatus(text) hears the row count. Returns {node, reload, destroy, copy, loadedRows}.
export function mountGrid(host, { columns, fetchPage, pageSize = PAGE_SIZE, onStatus, onError } = {}) {
  const root = el('div', 'bots-grid');
  root.setAttribute('role', 'table');
  const head = el('div', 'bots-grid-head');
  head.setAttribute('role', 'row');
  const filters = el('div', 'bots-grid-filters');
  filters.setAttribute('role', 'row');
  const scroller = el('div', 'bots-grid-scroll');
  scroller.tabIndex = 0;
  scroller.setAttribute('aria-label', 'Result rows');
  const spacer = el('div', 'bots-grid-spacer');
  const body = el('div', 'bots-grid-body');
  body.setAttribute('role', 'rowgroup');
  spacer.append(body);
  scroller.append(spacer);
  root.append(head, filters, scroller);
  host.append(root);

  const names = [...columns];
  const state = { sort: [], filter: {}, total: null, pages: new Map(), pending: new Map(), generation: 0, alive: true };
  const widths = names.map((name, i) => Math.min(280, Math.max(96, name.length * 9 + 44)));
  const template = () => widths.map(w => `${w}px`).join(' ');
  const totalWidth = () => widths.reduce((a, b) => a + b, 0);

  names.forEach((name, i) => {
    const cell = el('button', 'bots-grid-th');
    cell.type = 'button';
    cell.setAttribute('role', 'columnheader');
    cell.append(el('span', 'bots-grid-th-name', name), el('span', 'bots-grid-sort', ''));
    cell.addEventListener('click', () => { state.sort = nextSort(state.sort, name); paintHead(); reload(); });
    head.append(cell);
    const box = el('input', 'bots-grid-filter');
    box.type = 'search'; box.placeholder = 'Filter'; box.setAttribute('aria-label', `Filter ${name}`);
    let timer = 0;
    box.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { state.filter[name] = box.value; reload(); }, 250);
    });
    const slot = el('div', 'bots-grid-filter-cell');
    slot.append(box);
    filters.append(slot);
  });
  const applyWidths = () => {
    for (const row of [head, filters]) { row.style.gridTemplateColumns = template(); row.style.width = `${totalWidth()}px`; }
    body.style.width = `${totalWidth()}px`;
  };
  function paintHead() {
    [...head.children].forEach((cell, i) => {
      const mark = sortMark(state.sort, names[i]);
      cell.setAttribute('aria-sort', mark);
      cell.querySelector('.bots-grid-sort').textContent = mark === 'ascending' ? '↑' : mark === 'descending' ? '↓' : '';
    });
  }
  applyWidths();
  paintHead();

  const query = page => ({ offset: page * pageSize, limit: pageSize, sort: state.sort, filter: cleanFilters(state.filter) });
  async function ensure(page) {
    if (state.pages.has(page) || state.pending.has(page) || !state.alive) return;
    const generation = state.generation;
    const job = fetchPage(query(page)).then(result => {
      if (!state.alive || generation !== state.generation) return;
      state.pages.set(page, result.rows);
      if (result.row_count !== undefined && result.row_count !== state.total) { state.total = result.row_count; sizeSpacer(); onStatus?.(rowCountLabel(state.total)); }
      draw();
    }).catch(error => { if (state.alive && generation === state.generation) onError?.(error); })
      .finally(() => state.pending.delete(page));
    state.pending.set(page, job);
    await job;
  }
  function sizeSpacer() { spacer.style.height = `${Math.max(1, (state.total || 0) * ROW_HEIGHT)}px`; }

  function draw() {
    if (!state.alive) return;
    const total = state.total ?? pageSize;
    const range = windowRange(scroller.scrollTop, scroller.clientHeight || 300, total);
    const rows = [];
    for (let i = range.first; i <= range.last; i++) {
      const data = state.pages.get(Math.floor(i / pageSize))?.[i % pageSize];
      const row = el('div', 'bots-grid-row');
      row.setAttribute('role', 'row');
      row.style.top = `${i * ROW_HEIGHT}px`;
      row.style.height = `${ROW_HEIGHT}px`;
      row.style.gridTemplateColumns = template();
      row.dataset.index = String(i);
      if (data) {
        data.forEach((value, c) => {
          const cell = el('div', `bots-grid-cell${isNumeric(value) ? ' num' : ''}${value === null ? ' null' : ''}`, value === null ? '' : formatCell(value));
          cell.setAttribute('role', 'cell');
          if (value === null) cell.title = 'empty';
          row.append(cell);
        });
      } else row.classList.add('loading');
      rows.push(row);
    }
    body.replaceChildren(...rows);
    for (const page of pagesNeeded(range, pageSize)) ensure(page);
  }
  scroller.addEventListener('scroll', () => requestAnimationFrame(draw));
  // The header and filters slide sideways with the body.
  scroller.addEventListener('scroll', () => { head.style.transform = filters.style.transform = `translateX(${-scroller.scrollLeft}px)`; });

  function reload() {
    state.generation++;
    state.pages.clear(); state.pending.clear();
    state.total = null;
    scroller.scrollTop = 0;
    sizeSpacer();
    draw();
  }
  reload();

  return {
    node: root,
    reload,
    loadedRows() { return [...state.pages.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, rows]) => rows); },
    async copy() {
      const text = toTsv(names, this.loadedRows());
      try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
    },
    destroy() { state.alive = false; root.remove(); },
  };
}
