// The Data tab of a bot's workbench (Phase 6 unit U2, 2026-10-29). Spec: phase-6-design.md section 5.2.
//
// Above: the result (latest card by default, a History menu, pin, Cancel while it runs, full screen, export).
// A draggable splitter. Below: the SQL editor (a read runs 50 ms after typing; the first run makes a card and
// later edits update it; making a table waits for Run) and the sources strip (table names and row counts).
// mount(host, ctx) resolves to {destroy, refresh, flush}; ctx = {agentId, threadId, state, advanced, flush,
// refresh, go, navigate, signal, cardId?}; cardId opens that saved result first. States: loading, a named empty, a recoverable error with Retry. Every value
// from a file or a query is set as text.
import { h, Button, IconButton, openMenu, loadBotsCss } from './botsUi.js';
import { icon } from './botsIcons.js';
import * as M from './botsDataModel.js';
import { mountSqlEditor } from './botsDataSql.js';
import { mountGrid } from './botsDataGrid.js';
import { drawChart, svgBlob, pngBlob, saveBlob } from './botsDataChart.js';

export { currentDataContext } from './botsDataModel.js';
const CSS = '/static/css/bots-data.css';
const say = async (message, type = 'info') => { try { (await import('./api.js')).toast(message, type); } catch { /* nowhere to show it */ } };
const quote = name => `"${String(name).replace(/"/g, '""')}"`;

export async function mount(host, ctx = {}) {
  loadBotsCss(CSS);
  const agentId = ctx.agentId;
  const api = M.dataApi(agentId);
  const st = { cards: [], sources: [], card: null, result: null, seq: 0, runId: '', timer: 0, dead: false, full: false, view: 'result',
    abort: null, grid: null, chartSvg: null, editor: null, note: '' };
  let split = (() => { try { return Number(localStorage.getItem(M.SPLIT.key)) || M.SPLIT.defaultQuery; } catch { return M.SPLIT.defaultQuery; } })();

  const root = h('div', { class: 'bots-data', 'data-state': 'loading' });
  const bar = h('div', { class: 'bots-data-bar' });
  const resultArea = h('div', { class: 'bots-data-result', 'aria-live': 'polite' });
  const handle = h('div', { class: 'bots-data-split', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize the query box', tabindex: '0' });
  const queryArea = h('div', { class: 'bots-data-query' });
  const sourcesArea = h('div', { class: 'bots-data-sources' });
  root.append(bar, resultArea, handle, queryArea, sourcesArea);
  host.append(root);

  // -- the editor ------------------------------------------------------------------------------
  const status = h('span', { class: 'bots-data-status' });
  const runButton = Button({ label: 'Run', iconName: 'play', variant: 'primary', onClick: () => runNow(st.editor.getValue(), { force: true }) });
  const queryBar = h('div', { class: 'bots-data-query-bar' }, [h('span', { class: 'bots-caps', text: 'Query' }), status, runButton]);
  const editorHost = h('div', { class: 'bots-data-editor' });
  queryArea.append(queryBar, editorHost);
  st.editor = mountSqlEditor(editorHost, {
    placeholder: 'SELECT * FROM my_table LIMIT 20', value: '',
    onInput: text => { publish(); onType(text); }, onRun: () => runNow(st.editor.getValue(), { force: true }),
  });

  function onType(text) {
    clearTimeout(st.timer);
    if (!text.trim()) { status.textContent = ''; return; }
    if (!M.isLiveSafe(text)) { status.textContent = 'Press Run to make this table'; return; }
    status.textContent = '';
    st.timer = setTimeout(() => runNow(text), M.RUN_DELAY_MS);
  }
  function publish() {
    const draft = st.editor?.getValue() || '';
    M.setDataContext(agentId, { cardId: st.card?.id || '', draftSql: draft.trim() && draft !== st.card?.sql ? draft : '' });
  }

  // -- splitter ----------------------------------------------------------------------------------
  const applySplit = () => {
    const total = root.clientHeight - bar.offsetHeight - sourcesArea.offsetHeight - handle.offsetHeight;
    split = M.clampSplit(split, total > 0 ? total : 600);
    queryArea.style.height = `${split}px`;
    handle.setAttribute('aria-valuenow', String(split));
    handle.setAttribute('aria-valuemin', String(M.SPLIT.minQuery));
  };
  const saveSplit = () => { try { localStorage.setItem(M.SPLIT.key, String(split)); } catch { /* memory only */ } };
  handle.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const total = root.clientHeight - bar.offsetHeight - sourcesArea.offsetHeight - handle.offsetHeight;
    split = M.splitKey(split, event.key, total); applySplit(); saveSplit();
  });
  handle.addEventListener('pointerdown', event => {
    event.preventDefault();
    handle.setPointerCapture?.(event.pointerId);
    const startY = event.clientY, startSplit = split;
    const move = e => { split = startSplit + (startY - e.clientY); applySplit(); };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); saveSplit(); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up);
  });
  let splitFrame = 0;
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { cancelAnimationFrame(splitFrame); splitFrame = requestAnimationFrame(() => applySplit()); }) : null;
  resizeObserver?.observe(root);

  // -- the top bar ------------------------------------------------------------------------------
  function drawBar() {
    const card = st.card;
    const title = h('div', { class: 'bots-data-title' }, [h('span', { class: 'bots-data-title-text', text: card?.title || 'Data' }),
      st.result && !st.result.running && !st.result.error && st.result.row_count !== undefined && st.result.row_count !== null
        ? h('span', { class: 'bots-data-count', text: M.rowCountLabel(st.result.row_count) }) : null]);
    const history = h('button', { type: 'button', class: 'bots-btn', 'aria-haspopup': 'menu', disabled: st.cards.length ? undefined : true }, ['History', icon('chevron-down', { size: 14 })]);
    history.addEventListener('click', () => openMenu(history, [
      { heading: 'Saved results' },
      ...M.historyItems(st.cards, card?.id).slice(0, 40).map(item => ({ label: item.label, iconName: item.pinned ? 'pin' : undefined, checked: item.current, onSelect: () => openCard(st.cards.find(c => c.id === item.id)) })),
    ]));
    const pin = IconButton({ iconName: 'pin', label: card?.pinned ? 'Unpin this result' : 'Pin this result', onClick: togglePin, disabled: !card });
    pin.setAttribute('aria-pressed', card?.pinned ? 'true' : 'false');
    const exportButton = h('button', { type: 'button', class: 'bots-btn', 'aria-haspopup': 'menu', disabled: card ? undefined : true }, [icon('download', { size: 16 }), 'Export']);
    exportButton.addEventListener('click', () => openMenu(exportButton, exportItems(), { align: 'end' }));
    const full = IconButton({ iconName: 'panel-right', label: st.full ? 'Leave full screen' : 'Full screen', onClick: toggleFull });
    full.setAttribute('aria-pressed', st.full ? 'true' : 'false');
    bar.replaceChildren(title, h('div', { class: 'bots-data-tools' }, [history, pin, exportButton, full]));
  }
  function exportItems() {
    const items = [{ heading: 'Download' },
      { label: 'CSV file', iconName: 'download', onSelect: () => exportFile('csv') },
      { label: 'Excel file', iconName: 'download', onSelect: () => exportFile('xlsx') }];
    if (st.chartSvg) items.push({ label: 'Chart as PNG', iconName: 'image', onSelect: async () => { try { saveBlob(await pngBlob(st.chartSvg), `${slug()}.png`); } catch (e) { say(e.message, 'error'); } } },
      { label: 'Chart as SVG', iconName: 'image', onSelect: () => saveBlob(svgBlob(st.chartSvg), `${slug()}.svg`) });
    if (st.result?.columns) items.push({ separator: true }, { label: 'Copy rows as text', iconName: 'copy', onSelect: copyRows });
    return items;
  }
  async function copyRows() {
    let ok;
    if (st.grid) ok = await st.grid.copy();
    else { try { await navigator.clipboard.writeText(M.toTsv(st.result.columns, st.result.rows)); ok = true; } catch { ok = false; } }
    say(ok ? 'Copied' : 'Could not copy', 'info');
  }
  const slug = () => (st.card?.title || 'result').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'result';
  async function exportFile(format) {
    if (!st.card) return;
    try { saveBlob(await api.exportFile(st.card.id, format), `${slug()}.${format}`); } catch (error) { say(M.failure(error).message, 'error'); }
  }
  function toggleFull() {
    st.full = !st.full;
    root.classList.toggle('is-fullscreen', st.full);
    drawBar(); applySplit();
    if (st.full) root.focus?.();
  }
  const onKey = event => { if (event.key === 'Escape' && st.full && !document.querySelector('.bots-menu')) { event.stopPropagation(); toggleFull(); } };
  document.addEventListener('keydown', onKey, true);

  async function togglePin() {
    if (!st.card) return;
    try { replaceCard(await api.patchCard(st.card.id, { pinned: !st.card.pinned })); } catch (error) { say(M.failure(error).message, 'error'); }
  }
  function replaceCard(card) {
    st.card = card;
    const at = st.cards.findIndex(c => c.id === card.id);
    if (at >= 0) st.cards[at] = card; else st.cards.unshift(card);
    drawBar(); publish();
  }

  // -- running --------------------------------------------------------------------------------------
  async function runNow(sql, { force = false, spec } = {}) {
    clearTimeout(st.timer);
    if (!sql.trim()) return;
    if (!force && !M.isLiveSafe(sql)) return;
    const seq = ++st.seq;
    if (st.runId) api.cancel(st.runId).catch(() => {});
    st.abort?.abort();
    st.abort = typeof AbortController === 'function' ? new AbortController() : null;
    st.runId = M.newRunId();
    const runId = st.runId;
    st.result = { running: true, runId };
    st.view = 'result';
    drawResult(); drawBar();
    try {
      const body = { sql, run_id: runId };
      if (st.card) body.card_id = st.card.id;
      if (spec !== undefined) body.spec = spec;
      const res = await api.run(body, st.abort?.signal);
      if (seq !== st.seq || st.dead) return;
      st.runId = '';
      st.result = res;
      replaceCard(res.card);
      status.textContent = '';
      await refreshSources();
      drawResult(); drawBar();
    } catch (error) {
      if (seq !== st.seq || st.dead || error?.name === 'AbortError') return;
      st.runId = '';
      st.result = { error: M.failure(error) };
      drawResult(); drawBar();
    }
  }
  async function cancelRun() {
    if (!st.runId) return;
    const id = st.runId;
    st.seq++;
    st.abort?.abort();
    api.cancel(id).catch(() => {});
    st.runId = '';
    st.result = { error: { message: 'You stopped this query.', line: null, hint: '' } };
    drawResult(); drawBar();
  }

  async function openCard(card) {
    if (!card) return;
    clearTimeout(st.timer);
    st.seq++;
    st.card = card;
    st.view = 'result';
    st.editor.setValue(card.sql);
    st.result = { running: true };
    drawResult(); drawBar(); publish();
    try {
      const first = await api.page({ card_id: card.id, offset: 0, limit: M.PAGE_SIZE });
      if (st.card !== card || st.dead) return;
      st.result = { columns: first.columns, rows: first.rows, row_count: first.row_count, card };
      if (card.spec) { try { st.result.chart = await api.chart(card.id); } catch (error) { st.result.chart_error = M.failure(error).message; } }
    } catch (error) {
      if (st.card !== card || st.dead) return;
      st.result = { error: M.failure(error) };
    }
    drawResult(); drawBar();
  }

  // -- the result area -----------------------------------------------------------------------------
  function clearGrid() { st.grid?.destroy(); st.grid = null; st.chartSvg = null; }
  function drawResult() {
    clearGrid();
    const result = st.result, card = st.card;
    const kind = !result ? 'empty' : M.resultKind(card, result);
    root.dataset.kind = kind;
    if (kind === 'empty') {
      resultArea.replaceChildren(empty());
    } else if (kind === 'running') {
      resultArea.replaceChildren(h('div', { class: 'bots-data-running', role: 'status' }, [h('span', { class: 'bots-spinner', 'aria-hidden': 'true' }), h('span', { text: 'Running' }),
        Button({ label: 'Cancel', onClick: cancelRun })]));
    } else if (kind === 'failed') {
      const f = result.error;
      resultArea.replaceChildren(h('div', { class: 'bots-data-failed', role: 'alert' }, [
        h('div', { class: 'bots-data-failed-head' }, [icon('triangle-alert', { size: 16 }), h('span', { text: 'This query did not run' })]),
        h('p', { class: 'bots-data-failed-msg', text: f.message }),
        f.line ? h('p', { class: 'bots-data-failed-line', text: `Line ${f.line}` }) : null,
        f.hint ? h('p', { class: 'bots-data-failed-hint', text: f.hint }) : null,
      ]));
    } else if (kind === 'text') {
      const box = h('div', { class: 'bots-data-text' });
      import('./botsWidget.js').then(m => { if (st.result === result) box.replaceChildren(m.markdownNodes(String(result.rows[0][0]))); }).catch(() => { box.textContent = String(result.rows[0][0]); });
      resultArea.replaceChildren(box);
    } else {
      drawTableOrChart(kind, result, card);
    }
  }
  function empty() {
    const none = !st.sources.length && !st.cards.length;
    return h('div', { class: 'bots-data-empty' }, [
      h('p', { class: 'bots-data-empty-title', text: none ? 'No data yet' : 'Nothing is showing' }),
      h('p', { class: 'bots-data-empty-hint', text: none ? 'Ask your bot to load a file, or load one yourself below. Then ask a question with SQL.' : 'Pick a saved result from History, or write a query below.' }),
    ]);
  }
  function drawTableOrChart(kind, result, card) {
    const parts = [];
    const chartResult = result.chart;
    if (kind === 'chart' && chartResult && st.view !== 'table') {
      const box = h('div', { class: 'bots-data-chart' });
      st.chartSvg = drawChart(box, chartResult, { width: 560, height: 300, label: card?.title || 'Chart' });
      parts.push(viewToggle(), box);
      if (chartResult.note) parts.push(h('p', { class: 'bots-data-note', text: chartResult.note }));
    } else {
      if (kind === 'chart') parts.push(viewToggle());
      if (result.chart_error) parts.push(h('p', { class: 'bots-data-note', text: result.chart_error }));
      const gridHost = h('div', { class: 'bots-data-grid' });
      parts.push(gridHost);
      if (!result.columns || !result.columns.length) { gridHost.append(h('p', { class: 'bots-data-note', text: 'The query ran and returned no columns.' })); }
      else {
        st.grid = mountGrid(gridHost, {
          columns: result.columns,
          fetchPage: query => api.page({ card_id: card.id, ...query }),
          onError: error => say(M.failure(error).message, 'error'),
        });
      }
      if (result.created) parts.push(h('p', { class: 'bots-data-note', text: `Made the ${result.created.kind} ${result.created.name}.` }));
    }
    parts.push(chartBuilder(result, card));
    resultArea.replaceChildren(...parts);
  }
  function viewToggle() {
    const mk = (id, label) => {
      const b = h('button', { type: 'button', role: 'tab', class: 'bots-data-tab', 'aria-selected': st.view === id ? 'true' : 'false', text: label });
      b.addEventListener('click', () => { st.view = id; drawResult(); });
      return b;
    };
    return h('div', { class: 'bots-data-views', role: 'tablist', 'aria-label': 'Result view' }, [mk('result', 'Chart'), mk('table', 'Table')]);
  }
  // Pick how to draw the result: a type, then the columns it needs. None goes back to a plain table.
  function chartBuilder(result, card) {
    if (!card || !result.columns || !result.columns.length) return h('span');
    const current = card.spec || null;
    const typeSelect = h('select', { class: 'bots-data-select', 'aria-label': 'Chart type' }, [h('option', { value: '', text: 'Table only' }), ...M.CHART_TYPES.map(t => h('option', { value: t, text: M.CHART_LABELS[t] }))]);
    typeSelect.value = current?.type || '';
    const cols = (label, selected, allowNone = false) => {
      const s = h('select', { class: 'bots-data-select', 'aria-label': label }, [allowNone ? h('option', { value: '', text: `${label}: none` }) : null, ...result.columns.map(c => h('option', { value: c, text: `${label}: ${c}` }))]);
      s.value = selected || (allowNone ? '' : result.columns[0]);
      return s;
    };
    const x = cols('X', current?.x), y = cols('Y', current?.y, true);
    const agg = h('select', { class: 'bots-data-select', 'aria-label': 'Combine' }, M.AGGS.map(a => h('option', { value: a, text: a })));
    agg.value = current?.agg || 'sum';
    const apply = async () => {
      if (!typeSelect.value) { try { replaceCard(await api.patchCard(card.id, { clear_spec: true })); st.result = { ...result, chart: undefined }; drawResult(); } catch (e) { say(M.failure(e).message, 'error'); } return; }
      const spec = { type: typeSelect.value, x: x.value, agg: agg.value, ...(y.value ? { y: y.value } : {}) };
      if (['histogram'].includes(spec.type)) { delete spec.y; spec.bins = current?.bins || 20; }
      await runNow(card.sql, { force: true, spec });
    };
    // Choosing a type for the first time fills in sensible columns (a text one for X, a number for Y).
    typeSelect.addEventListener('change', () => {
      if (!current && typeSelect.value) {
        const d = M.defaultSpec(typeSelect.value, result.columns, result.rows);
        if (d) { x.value = d.x; y.value = d.y || ''; agg.value = d.agg || 'sum'; }
      }
      apply();
    });
    for (const control of [x, y, agg]) control.addEventListener('change', apply);
    const row = h('div', { class: 'bots-data-builder' }, [typeSelect, ...(typeSelect.value ? [x, y, agg] : [])]);
    typeSelect.addEventListener('change', () => { row.replaceChildren(typeSelect, ...(typeSelect.value ? [x, y, agg] : [])); });
    return row;
  }

  // -- sources -----------------------------------------------------------------------------------------
  function drawSources() {
    const chips = st.sources.map(source => {
      const chip = h('button', { type: 'button', class: 'bots-data-source', title: source.columns.map(c => `${c.name} ${c.type}`).join(', ') }, [
        h('span', { class: 'bots-data-source-name', text: source.name }), h('span', { class: 'bots-data-source-rows', text: source.rows === null ? '' : Number(source.rows).toLocaleString('en-US') })]);
      chip.addEventListener('click', () => { const sql = `SELECT * FROM ${quote(source.name)} LIMIT 100`; st.editor.setValue(sql); publish(); runNow(sql, { force: true }); });
      return chip;
    });
    const input = h('input', { type: 'text', class: 'bots-data-load-input', placeholder: 'File in your folder, or an https link', 'aria-label': 'Load data from' });
    const load = Button({ label: 'Load', onClick: async () => {
      const source = input.value.trim();
      if (!source) return;
      load.disabled = true;
      try {
        const res = await api.load({ source });
        input.value = '';
        st.sources = res.sources; st.cards = res.cards || st.cards;
        say(`Loaded ${res.loaded.map(l => l.table).join(', ')}`, 'info');
        drawSources(); if (!st.result) drawResult();
      } catch (error) { say(M.failure(error).message, 'error'); } finally { load.disabled = false; }
    } });
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); load.click(); } });
    sourcesArea.replaceChildren(
      h('div', { class: 'bots-data-sources-head' }, [h('span', { class: 'bots-caps', text: 'Tables' }), h('span', { class: 'bots-data-hint', text: chips.length ? '' : 'None loaded yet' })]),
      h('div', { class: 'bots-data-chips' }, chips),
      h('div', { class: 'bots-data-load' }, [input, load]));
    applySplit();
  }
  async function refreshSources() {
    try { const o = await api.overview(); if (st.dead) return; st.sources = o.sources; st.cards = o.cards; drawSources(); } catch { /* the strip keeps what it had */ }
  }

  // -- loading, error ----------------------------------------------------------------------------
  async function load(initial) {
    root.dataset.state = 'loading';
    if (initial) resultArea.replaceChildren(h('p', { class: 'bots-data-loading', role: 'status', text: 'Loading' }));
    try {
      const o = await api.overview();
      if (st.dead) return;
      st.sources = o.sources; st.cards = o.cards;
      root.dataset.state = 'ready';
      drawSources(); drawBar();
      const wanted = ctx.cardId && st.cards.find(c => c.id === ctx.cardId);
      if (wanted && st.card?.id !== wanted.id) await openCard(wanted);
      else if (!st.card && st.cards.length) await openCard(M.latestCard(st.cards));
      else if (!st.cards.length) { st.result = null; drawResult(); }
    } catch (error) {
      if (st.dead) return;
      root.dataset.state = 'error';
      resultArea.replaceChildren(h('div', { class: 'bots-data-failed', role: 'alert' }, [
        h('p', { class: 'bots-data-failed-msg', text: 'The data panel could not load.' }),
        Button({ label: 'Try again', onClick: () => load(true) }),
      ]));
    }
  }
  drawBar();
  applySplit();
  await load(true);

  ctx.signal?.addEventListener?.('abort', () => handle2.destroy(), { once: true });
  const handle2 = {
    async refresh() { await load(false); },
    async flush() {},
    destroy() {
      if (st.dead) return;
      st.dead = true;
      clearTimeout(st.timer);
      st.abort?.abort();
      if (st.runId) api.cancel(st.runId).catch(() => {});
      resizeObserver?.disconnect();
      document.removeEventListener('keydown', onKey, true);
      clearGrid();
      M.setDataContext(agentId, null);
      root.remove();
    },
  };
  return handle2;
}

export default mount;
