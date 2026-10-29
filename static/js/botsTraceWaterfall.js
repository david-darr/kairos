import { h, Button } from './botsUi.js';
import { cost, duration, geometry, ticks } from './botsUsageModel.js';

export function waterfall(tree) {
  const root = h('div', { class: 'bots-trace-waterfall' });
  const origin = tree.at, span = Math.max(tree.duration_s, .001), axis = h('div', { class: 'bots-trace-axis' });
  for (const value of ticks(span)) {
    const tick = h('span', { text: duration(value) });
    tick.style.left = `${Math.min(100, value / span * 100)}%`;
    axis.append(tick);
  }
  root.append(axis);
  function draw(node, depth = 0) {
    const children = h('div', { class: 'bots-trace-children' });
    const label = h('span', { text: node.name });
    const bar = h('span', { class: `bots-trace-bar ${node.ok === false ? 'error' : node.kind === 'step' ? 'step' : 'tool'}` });
    const g = geometry(node.at, node.duration_s, origin, span);
    bar.style.left = `${g.left}%`; bar.style.width = `${g.width}%`;
    bar.title = `${duration(node.duration_s)} · ${cost(node.cost_usd)}${node.tokens ? ` · ${JSON.stringify(node.tokens)}` : ''}`;
    const row = h('div', { class: 'bots-trace-row' }, [label, h('div', { class: 'bots-trace-lane' }, [bar])]);
    label.style.paddingInlineStart = `${depth * 12}px`;
    for (const key of ['slowest', 'costliest']) if (node[key]) label.append(h('small', { class: 'bots-trace-badge', text: key === 'slowest' ? 'Slowest' : 'Costliest' }));
    if (node.children?.length) {
      const toggle = Button({ label: 'Collapse', onClick: () => { children.hidden = !children.hidden; toggle.textContent = children.hidden ? 'Expand' : 'Collapse'; } });
      label.append(toggle);
      for (const child of node.children) children.append(draw(child, depth + 1));
    }
    return h('div', {}, [row, children]);
  }
  root.append(draw(tree));
  return root;
}
