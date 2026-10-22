// The context rail's local graph (Library Vault Polish, 2026-10-22): this
// note, the notes it links with at depth 1 (or 2), drawn on rings. A static
// layout, so reduced motion needs nothing special. Click a node to open it.

const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function mountLocalGraph(host, store, id, { depth = 1, onOpen, height = 210 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'vault-local-canvas';
  canvas.setAttribute('role', 'img');
  host.replaceChildren(canvas);
  const list = document.createElement('ul');
  list.className = 'vault-sr-only';
  host.append(list);
  let nodes = [], edges = [], hovered = null, width = 0, disposed = false;

  function build() {
    const hops = store.neighbourhood(id, depth);
    const rings = new Map();
    for (const [nodeId, d] of hops) { if (!rings.has(d)) rings.set(d, []); rings.get(d).push(nodeId); }
    nodes = [];
    const cx = width / 2, cy = height / 2;
    const radius = d => d === 0 ? 0 : (Math.min(width, height) / 2 - 18) * (depth === 1 ? 1 : d / depth);
    for (const [d, ids] of rings) {
      ids.sort();
      ids.forEach((nodeId, i) => {
        const angle = (i / ids.length) * Math.PI * 2 - Math.PI / 2 + (d % 2 ? 0 : Math.PI / ids.length);
        nodes.push({ id: nodeId, d, x: cx + Math.cos(angle) * radius(d), y: cy + Math.sin(angle) * radius(d), name: store.note(nodeId)?.name || nodeId });
      });
    }
    const inGraph = new Set(nodes.map(n => n.id));
    edges = [];
    for (const n of nodes) for (const target of store.outlinks.get(n.id) || []) if (inGraph.has(target)) edges.push([n.id, target]);
    canvas.setAttribute('aria-label', `${nodes.length - 1} linked notes around ${store.note(id)?.name || id}`);
    list.replaceChildren(...nodes.filter(n => n.id !== id).map(n => { const li = document.createElement('li'); li.textContent = n.name; return li; }));
  }

  function draw() {
    if (disposed) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const at = new Map(nodes.map(n => [n.id, n]));
    ctx.lineWidth = 1;
    for (const [a, b] of edges) {
      const p = at.get(a), q = at.get(b);
      ctx.strokeStyle = `rgba(${token('--ink-rgb')}, ${a === id || b === id ? .5 : .22})`;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }
    for (const n of nodes) {
      const r = n.id === id ? 7 : 4.5;
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = n.id === id ? token('--text') : n.d === 1 ? token('--point') : token('--text-faint');
      ctx.fill();
      if (n.id === hovered || n.id === id || nodes.length <= 9) {
        ctx.font = `${n.id === id ? 12 : 11}px Jost, Segoe UI, sans-serif`;
        ctx.fillStyle = token(n.id === hovered || n.id === id ? '--text' : '--text-dim');
        const label = n.name.length > 22 ? n.name.slice(0, 21) + '…' : n.name;
        const w = ctx.measureText(label).width;
        const x = Math.max(4, Math.min(width - w - 4, n.x - w / 2));
        ctx.fillText(label, x, n.y + (n.y > height / 2 ? 18 : -10));
      }
    }
  }

  function resize() {
    width = host.getBoundingClientRect().width || 260;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
    build(); draw();
  }

  const hit = event => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    let best = null, bestDist = 14;
    for (const n of nodes) { const d = Math.hypot(n.x - x, n.y - y); if (d < bestDist) { best = n; bestDist = d; } }
    return best;
  };
  canvas.addEventListener('pointermove', event => {
    const n = hit(event); const next = n?.id ?? null;
    canvas.style.cursor = n && n.id !== id ? 'pointer' : 'default';
    if (next !== hovered) { hovered = next; draw(); }
  });
  canvas.addEventListener('pointerleave', () => { hovered = null; draw(); });
  canvas.addEventListener('click', event => { const n = hit(event); if (n && n.id !== id) onOpen?.(n.id); });
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  return {
    setDepth(next) { depth = next; build(); draw(); },
    destroy() { disposed = true; observer.disconnect(); },
  };
}
