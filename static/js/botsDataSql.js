// The SQL editor for the data panel (Phase 6 unit U2, 2026-10-29): a plain textarea with a colour overlay
// behind it (no editor library). tokenizeSql() is lossless (the pieces join back to the exact text), so the
// overlay lines up with the caret. Colours come from the Bots tokens in static/css/bots-data.css.

export const KEYWORDS = new Set(['select', 'from', 'where', 'group', 'by', 'order', 'having', 'limit', 'offset', 'as', 'and', 'or', 'not',
  'in', 'is', 'null', 'like', 'between', 'case', 'when', 'then', 'else', 'end', 'join', 'left', 'right', 'inner', 'outer', 'cross', 'full',
  'on', 'using', 'union', 'all', 'distinct', 'with', 'recursive', 'values', 'create', 'or', 'replace', 'table', 'view', 'temp', 'temporary',
  'asc', 'desc', 'exists', 'over', 'partition', 'cast', 'collate', 'glob', 'escape', 'except', 'intersect', 'if', 'true', 'false']);
export const FUNCTIONS = new Set(['count', 'sum', 'avg', 'min', 'max', 'round', 'abs', 'length', 'lower', 'upper', 'substr', 'replace', 'trim',
  'coalesce', 'ifnull', 'nullif', 'strftime', 'date', 'time', 'datetime', 'julianday', 'typeof', 'cast', 'random', 'row_number', 'rank',
  'dense_rank', 'ntile', 'lag', 'lead', 'group_concat', 'total', 'instr', 'printf', 'iif', 'json_extract']);

// [{type, text}] for keyword, function, string, number, comment, ident, punct and space.
export function tokenizeSql(text) {
  const out = [];
  const s = String(text ?? '');
  let i = 0;
  const push = (type, end) => { out.push({ type, text: s.slice(i, end) }); i = end; };
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { let j = i + 1; while (j < s.length && /\s/.test(s[j])) j++; push('space', j); }
    else if (s.startsWith('--', i)) { const j = s.indexOf('\n', i); push('comment', j < 0 ? s.length : j); }
    else if (s.startsWith('/*', i)) { const j = s.indexOf('*/', i + 2); push('comment', j < 0 ? s.length : j + 2); }
    else if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === ch) { if (s[j + 1] === ch) { j += 2; continue; } j++; break; }
        j++;
      }
      push(ch === "'" ? 'string' : 'ident', j);
    }
    else if (ch === '[') { const j = s.indexOf(']', i); push('ident', j < 0 ? s.length : j + 1); }
    else if (/[0-9]/.test(ch)) { let j = i + 1; while (j < s.length && /[0-9a-zA-Z._]/.test(s[j])) j++; push('number', j); }
    else if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_$]/.test(s[j])) j++;
      const word = s.slice(i, j).toLowerCase();
      let k = j;
      while (k < s.length && s[k] === ' ') k++;
      push(KEYWORDS.has(word) ? 'keyword' : (FUNCTIONS.has(word) && s[k] === '(' ? 'function' : 'ident'), j);
    }
    else push('punct', i + 1);
  }
  return out;
}

export function untokenize(tokens) { return tokens.map(t => t.text).join(''); }

// Mount the editor: a wrapper holding the colour layer (a <pre>) and the real textarea above it.
// onInput(text) runs on every change; onRun() on Ctrl or Cmd + Enter. Returns {node, textarea, setValue, getValue, focus, destroy}.
export function mountSqlEditor(host, { value = '', placeholder = '', onInput, onRun, label = 'SQL query' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'bots-sql';
  const layer = document.createElement('pre');
  layer.className = 'bots-sql-layer';
  layer.setAttribute('aria-hidden', 'true');
  const code = document.createElement('code');
  layer.append(code);
  const field = document.createElement('textarea');
  field.className = 'bots-sql-input';
  field.spellcheck = false;
  field.autocapitalize = 'off';
  field.setAttribute('aria-label', label);
  field.placeholder = placeholder;
  field.value = value;
  wrap.append(layer, field);
  host.append(wrap);

  const paint = () => {
    const frag = document.createDocumentFragment();
    for (const token of tokenizeSql(field.value)) {
      if (token.type === 'space' || token.type === 'punct' || token.type === 'ident') { frag.append(document.createTextNode(token.text)); continue; }
      const span = document.createElement('span');
      span.className = `bots-sql-${token.type}`;
      span.textContent = token.text;
      frag.append(span);
    }
    // A trailing newline needs a visible line or the layer ends one row short of the textarea.
    frag.append(document.createTextNode('\n'));
    code.replaceChildren(frag);
  };
  const sync = () => { layer.scrollTop = field.scrollTop; layer.scrollLeft = field.scrollLeft; };
  const onKey = event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onRun?.(); }
    else if (event.key === 'Tab' && !event.shiftKey && !event.altKey) {
      // Two spaces, like a code field; Escape then Tab leaves the field for keyboard users.
      if (field.dataset.escaped === '1') { field.dataset.escaped = ''; return; }
      event.preventDefault();
      const { selectionStart: a, selectionEnd: b } = field;
      field.setRangeText('  ', a, b, 'end');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (event.key === 'Escape') field.dataset.escaped = '1';
  };
  field.addEventListener('input', () => { paint(); onInput?.(field.value); });
  field.addEventListener('scroll', sync);
  field.addEventListener('keydown', onKey);
  paint();
  return {
    node: wrap, textarea: field,
    setValue(next) { field.value = next; paint(); sync(); },
    getValue() { return field.value; },
    focus() { field.focus({ preventScroll: true }); },
    destroy() { wrap.remove(); },
  };
}
