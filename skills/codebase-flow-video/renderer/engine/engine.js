/*
 * Flow-video engine.
 *
 * Everything on screen is a pure function of time `t`, so the renderer can step
 * frame by frame (window.__seek) and get identical output every run.
 *
 *   window.__setup(storyboard, { width, height, icons, style, images, fontUrl }) -> Promise<{ duration, marks, warnings }>
 *
 * Scenes with a "visual" are drawn by scenes.js (agents, chat, request, ...); other scenes use the flow map.
 *   window.__seek(t)
 */
(() => {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg';

  const THEMES = {
    dark: {
      bg: '#0A0F1E', glow: '#18214A', dot: '#1C2546', card: '#121A30', border: '#26325A',
      text: '#EEF2FD', muted: '#8E98BA', edge: '#34406A', shadow: 'rgba(0,0,0,0.45)',
      pill: '#18213D', panel: 'rgba(10,15,30,0.78)',
    },
    light: {
      bg: '#F6F7FB', glow: '#E4E8F7', dot: '#D8DDEB', card: '#FFFFFF', border: '#DDE2EF',
      text: '#111827', muted: '#5A6380', edge: '#B9C1D6', shadow: 'rgba(20,30,60,0.10)',
      pill: '#FFFFFF', panel: 'rgba(246,247,251,0.86)',
    },
  };
  let KIND_COLORS = {
    actor: '#4EA8FF', step: null, decision: '#FFB547', store: '#22C7A9',
    external: '#A0A8C3', ai: '#FF5CA8', output: '#34D399',
  };
  const KIND_ICONS = {
    actor: 'user', step: 'gear', decision: 'branch', store: 'database',
    external: 'cloud', ai: 'sparkles', output: 'check',
  };

  // World-space node geometry. The camera scales the world to the screen.
  const NODE_W = 360, PAD_X = 22, PAD_Y = 20, BADGE = 56, BADGE_GAP = 16;
  const LABEL_SIZE = 26, LABEL_LH = 32, SUB_SIZE = 18, SUB_LH = 24;
  const GAP_RANK = { LR: 150, TB: 120 }, GAP_NODE = { LR: 56, TB: 48 };
  let FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

  // Timing (seconds).
  const T0 = {
    intro: 4.2, cam: 1.1, nodeStart: 0.55, nodeGap: 0.22, nodeDur: 0.6,
    edgeLead: 0.2, edgeDur: 0.7, packetGap: 0.75, packetDur: 1.4,
    capIn: 0.45, capFade: 0.4, tail: 1.0, minRead: 2.6, wordsPerSec: 3.2,
    activeFade: 0.5, outroCam: 1.6, outroHold: 5.0, endCard: 3.8,
  };
  let T = { ...T0 };
  const MOTION = { calm: 1.15, standard: 1, snappy: 0.85 };
  const DIM = 0.32;
  // Node labels smaller than this many screen pixels (at 1080p) are hard to read on a phone.
  const MIN_LABEL_PX = 19;

  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const prog = (t, start, dur) => clamp01((t - start) / dur);
  const lerp = (a, b, p) => a + (b - a) * p;
  const ease = {
    outCubic: (p) => 1 - Math.pow(1 - p, 3),
    inOutCubic: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    outBack: (p) => { const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); },
  };
  const wordCount = (s) => (s || '').trim().split(/\s+/).filter(Boolean).length;

  function el(tag, attrs = {}, parent) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function div(id, parent, cls = 'overlay') {
    const d = document.createElement('div');
    if (id) d.id = id;
    d.className = cls;
    parent.appendChild(d);
    return d;
  }

  // ---------- state ----------
  let W, H, ICONS, theme, accent, orient, base, style, RADIUS = 18, IMAGES = {};
  let visuals = [], hasMap = true, recap = null;
  let nodes, nodeById, edges, scenes, packets, warnings;
  let outro, duration, view;
  let dom;

  // ---------- text measuring ----------
  let measureCtx;
  function wrap(text, size, weight, maxW) {
    measureCtx.font = `${weight} ${size}px ${FONT}`;
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? cur + ' ' + w : w;
      if (measureCtx.measureText(next).width <= maxW || !cur) cur = next;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  // ---------- layout: layered graph ----------
  function layout() {
    const out = new Map(nodes.map((n) => [n.id, []]));
    const inn = new Map(nodes.map((n) => [n.id, []]));
    edges.forEach((e) => { out.get(e.from).push(e); });

    // Mark back edges (loops such as retries) with a DFS so ranking stays acyclic.
    const state = new Map();
    const dfs = (u) => {
      state.set(u, 1);
      for (const e of out.get(u)) {
        const s = state.get(e.to);
        if (s === 1) e.back = true;
        else if (!s) dfs(e.to);
      }
      state.set(u, 2);
    };
    nodes.forEach((n) => { if (!state.get(n.id)) dfs(n.id); });
    edges.forEach((e) => { if (!e.back) inn.get(e.to).push(e); });

    // Longest-path ranking over forward edges.
    const indeg = new Map(nodes.map((n) => [n.id, inn.get(n.id).length]));
    const rank = new Map(nodes.map((n) => [n.id, 0]));
    const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
    while (queue.length) {
      const u = queue.shift();
      for (const e of out.get(u)) {
        if (e.back) continue;
        rank.set(e.to, Math.max(rank.get(e.to), rank.get(u) + 1));
        indeg.set(e.to, indeg.get(e.to) - 1);
        if (indeg.get(e.to) === 0) queue.push(e.to);
      }
    }
    nodes.forEach((n) => { n.rank = rank.get(n.id); });

    // Edges spanning several ranks get invisible waypoints, one per skipped rank, so
    // they take their own lane instead of running behind the nodes in between.
    const DUMMY = 24;
    const all = [...nodes];
    const segs = [];
    edges.forEach((e, i) => {
      e.via = [];
      if (e.back) return;
      let prev = nodeById.get(e.from);
      for (let r = prev.rank + 1; r < nodeById.get(e.to).rank; r++) {
        const d = { id: `__via${i}_${r}`, rank: r, dummy: true, h: DUMMY };
        all.push(d);
        e.via.push(d);
        segs.push([prev, d]);
        prev = d;
      }
      segs.push([prev, nodeById.get(e.to)]);
    });

    const nRanks = Math.max(...nodes.map((n) => n.rank)) + 1;
    const layers = Array.from({ length: nRanks }, () => []);
    all.forEach((n) => layers[n.rank].push(n));
    layers.forEach((l) => l.forEach((n, i) => { n.order = i; }));
    const preds = new Map(all.map((n) => [n, []]));
    const succs = new Map(all.map((n) => [n, []]));
    segs.forEach(([a, b]) => { succs.get(a).push(b); preds.get(b).push(a); });

    // Barycenter sweeps to reduce crossings.
    for (let iter = 0; iter < 8; iter++) {
      const down = iter % 2 === 0;
      const order = down ? layers.map((_, i) => i) : layers.map((_, i) => nRanks - 1 - i);
      for (const r of order) {
        const layer = layers[r];
        layer.forEach((n) => {
          const nb = (down ? preds : succs).get(n);
          n.bary = nb.length ? nb.reduce((s, m) => s + m.order, 0) / nb.length : n.order;
        });
        layer.sort((a, b) => a.bary - b.bary || a.order - b.order);
        layer.forEach((n, i) => { n.order = i; });
      }
    }

    // Cross-axis position (y in LR, x in TB): start packed and centred, then pull each
    // node toward its neighbours so straight chains stay straight.
    const lr = orient === 'LR';
    const size = (n) => (lr ? n.h : n.dummy ? DUMMY : NODE_W);
    const gap = lr ? GAP_NODE.LR : GAP_NODE.TB;
    const place = (layer, desired) => {
      for (let i = 0; i < layer.length; i++) {
        const n = layer[i];
        n.c = desired[i];
        if (i > 0) {
          const p = layer[i - 1];
          n.c = Math.max(n.c, p.c + (size(p) + size(n)) / 2 + gap);
        }
      }
      const shift = layer.reduce((s, n, i) => s + (desired[i] - n.c), 0) / layer.length;
      layer.forEach((n) => { n.c += shift; });
    };
    layers.forEach((layer) => {
      const total = layer.reduce((s, n) => s + size(n), 0) + gap * (layer.length - 1);
      let c = -total / 2;
      layer.forEach((n) => { n.c = c + size(n) / 2; c += size(n) + gap; });
    });
    for (let iter = 0; iter < 8; iter++) {
      const down = iter % 2 === 0;
      const order = down ? layers.map((_, i) => i) : layers.map((_, i) => nRanks - 1 - i);
      for (const r of order) {
        const layer = layers[r];
        const desired = layer.map((n) => {
          const nb = [...preds.get(n), ...succs.get(n)];
          return nb.length ? nb.reduce((s, m) => s + m.c, 0) / nb.length : n.c;
        });
        place(layer, desired);
      }
    }

    // Main-axis position, then copy into x/y (node x/y are centres).
    let m = 0;
    layers.forEach((layer) => {
      const depth = lr ? NODE_W : Math.max(...layer.filter((n) => !n.dummy).map((n) => n.h), DUMMY);
      layer.forEach((n) => {
        if (lr) { n.x = m + NODE_W / 2; n.y = n.c; } else { n.x = n.c; n.y = m + depth / 2; }
      });
      m += depth + (lr ? GAP_RANK.LR : GAP_RANK.TB);
    });
  }

  // Smooth curve through points with tangents along the main axis at every point.
  function curveThrough(pts) {
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (orient === 'LR') {
        const dx = Math.max(40, (b.x - a.x) * 0.5);
        d += ` C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
      } else {
        const dy = Math.max(40, (b.y - a.y) * 0.5);
        d += ` C${a.x},${a.y + dy} ${b.x},${b.y - dy} ${b.x},${b.y}`;
      }
    }
    return d;
  }

  function edgePath(e) {
    const a = nodeById.get(e.from), b = nodeById.get(e.to);
    const via = e.via.map((d) => ({ x: d.x, y: d.y }));
    if (orient === 'LR') {
      if (e.back) {
        const lift = 80 + 0.15 * Math.abs(a.x - b.x);
        const top = Math.min(a.y - a.h / 2, b.y - b.h / 2) - lift;
        const sx = a.x, sy = a.y - a.h / 2, ex = b.x, ey = b.y - b.h / 2 - 8;
        return `M${sx},${sy} C${sx},${top} ${ex},${top} ${ex},${ey}`;
      }
      return curveThrough([{ x: a.x + NODE_W / 2, y: a.y }, ...via, { x: b.x - NODE_W / 2 - 8, y: b.y }]);
    }
    if (e.back) {
      const lift = 80 + 0.12 * Math.abs(a.y - b.y);
      const right = Math.max(a.x, b.x) + NODE_W / 2 + lift;
      const sx = a.x + NODE_W / 2, sy = a.y, ex = b.x + NODE_W / 2 + 8, ey = b.y;
      return `M${sx},${sy} C${right},${sy} ${right},${ey} ${ex},${ey}`;
    }
    return curveThrough([{ x: a.x, y: a.y + a.h / 2 }, ...via, { x: b.x, y: b.y - b.h / 2 - 8 }]);
  }

  // ---------- camera ----------
  function bbox(ids) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    ids.forEach((id) => {
      const n = nodeById.get(id);
      x0 = Math.min(x0, n.x - NODE_W / 2); x1 = Math.max(x1, n.x + NODE_W / 2);
      y0 = Math.min(y0, n.y - n.h / 2); y1 = Math.max(y1, n.y + n.h / 2);
    });
    // Back edges arc outside nodes; include them when both ends are in view.
    edges.forEach((e) => {
      if (!e.back || !ids.includes(e.from) || !ids.includes(e.to)) return;
      const len = e.len;
      for (let i = 0; i <= 8; i++) {
        const p = e.path.getPointAtLength((len * i) / 8);
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      }
    });
    return { x0, y0, x1, y1 };
  }
  function fit(ids, maxScale) {
    const b = bbox(ids);
    const pad = 70;
    const bw = b.x1 - b.x0 + pad * 2, bh = b.y1 - b.y0 + pad * 2;
    const s = Math.min(view.w / bw, view.h / bh, maxScale);
    return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, s };
  }
  function camLerp(a, b, p) {
    return { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), s: Math.exp(lerp(Math.log(a.s), Math.log(b.s), p)) };
  }

  // ---------- DOM ----------
  function buildDom(sb) {
    const stage = document.getElementById('stage');
    stage.innerHTML = '';
    stage.style.width = W + 'px';
    stage.style.height = H + 'px';
    stage.style.fontFamily = FONT;
    document.body.style.background = theme.bg;

    const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` }, stage);
    const defs = el('defs', {}, svg);
    const rg = el('radialGradient', { id: 'bgGlow', cx: '50%', cy: '42%', r: '75%' }, defs);
    el('stop', { offset: '0%', 'stop-color': theme.glow }, rg);
    el('stop', { offset: '100%', 'stop-color': theme.bg }, rg);
    const pat = el('pattern', { id: 'dots', width: 44, height: 44, patternUnits: 'userSpaceOnUse' }, defs);
    if (style.background === 'grid') el('path', { d: 'M44 0 L0 0 0 44', fill: 'none', stroke: theme.dot, 'stroke-width': 1.5 }, pat);
    else if (style.background !== 'plain') el('circle', { cx: 2, cy: 2, r: 1.8, fill: theme.dot }, pat);
    const pg = el('radialGradient', { id: 'packetGlow' }, defs);
    el('stop', { offset: '0%', 'stop-color': '#fff', 'stop-opacity': 0.9 }, pg);
    el('stop', { offset: '100%', 'stop-color': '#fff', 'stop-opacity': 0 }, pg);

    el('rect', { x: 0, y: 0, width: W, height: H, fill: 'url(#bgGlow)' }, svg);
    if (style.background === 'grid') {
      const gp = el('pattern', { id: 'screenGrid', width: base / 18, height: base / 18, patternUnits: 'userSpaceOnUse' }, defs);
      el('path', { d: `M${base / 18} 0 L0 0 0 ${base / 18}`, fill: 'none', stroke: theme.dot, 'stroke-width': 1 }, gp);
    }
    const bgPattern = el('rect', { x: 0, y: 0, width: W, height: H, fill: style.background === 'grid' ? 'url(#screenGrid)' : 'none' }, svg);
    const world = el('g', {}, svg);
    el('rect', { x: -20000, y: -20000, width: 40000, height: 40000, fill: 'url(#dots)' }, world);
    const gEdges = el('g', {}, world);
    const gLabels = el('g', {}, world);
    const gNodes = el('g', {}, world);
    const gPackets = el('g', {}, world);

    edges.forEach((e) => {
      const d = edgePath(e);
      e.path = el('path', { d, fill: 'none', stroke: theme.edge, 'stroke-width': 3.5, 'stroke-linecap': 'round' }, gEdges);
      e.hl = el('path', { d, fill: 'none', stroke: nodeById.get(e.from).color, 'stroke-width': 4, 'stroke-linecap': 'round' }, gEdges);
      e.len = e.path.getTotalLength();
      [e.path, e.hl].forEach((p) => { p.style.strokeDasharray = `${e.len} ${e.len}`; });
      const end = e.path.getPointAtLength(e.len), pre = e.path.getPointAtLength(Math.max(0, e.len - 2));
      const ang = (Math.atan2(end.y - pre.y, end.x - pre.x) * 180) / Math.PI;
      e.arrow = el('path', {
        d: 'M-4,-9 L12,0 L-4,9 Z', fill: theme.edge,
        transform: `translate(${end.x},${end.y}) rotate(${ang})`,
      }, gEdges);
      if (e.label) {
        const mid = e.path.getPointAtLength(e.len * (e.back ? 0.5 : 0.45));
        const g = el('g', { transform: `translate(${mid.x},${mid.y})` }, gLabels);
        measureCtx.font = `700 18px ${FONT}`;
        const tw = measureCtx.measureText(e.label).width;
        el('rect', {
          x: -tw / 2 - 12, y: -16, width: tw + 24, height: 32, rx: 16,
          fill: theme.pill, stroke: nodeById.get(e.from).color, 'stroke-width': 2,
        }, g);
        const tx = el('text', {
          x: 0, y: 6, 'text-anchor': 'middle', fill: theme.text,
          'font-family': FONT, 'font-size': 18, 'font-weight': 700,
        }, g);
        tx.textContent = e.label;
        e.labelG = g;
      }
    });

    nodes.forEach((n) => {
      const g = el('g', {}, gNodes);
      const inner = el('g', { transform: `translate(${-NODE_W / 2},${-n.h / 2})` }, g);
      el('rect', { x: 0, y: 10, width: NODE_W, height: n.h, rx: RADIUS, fill: theme.shadow }, inner);
      n.ring = el('rect', {
        x: -6, y: -6, width: NODE_W + 12, height: n.h + 12, rx: RADIUS + 5,
        fill: 'none', stroke: n.color, 'stroke-width': 3,
      }, inner);
      el('rect', {
        x: 0, y: 0, width: NODE_W, height: n.h, rx: RADIUS, fill: theme.card,
        stroke: n.kind === 'decision' ? n.color : theme.border, 'stroke-width': 2,
        'stroke-dasharray': n.kind === 'external' ? '8 6' : 'none',
      }, inner);
      const by = n.h / 2 - BADGE / 2;
      if (n.kind === 'decision') {
        el('rect', {
          x: PAD_X + 8, y: by + 8, width: BADGE - 16, height: BADGE - 16, rx: 6,
          transform: `rotate(45 ${PAD_X + BADGE / 2} ${by + BADGE / 2})`, fill: n.color, 'fill-opacity': 0.18,
        }, inner);
      } else {
        el('rect', { x: PAD_X, y: by, width: BADGE, height: BADGE, rx: 14, fill: n.color, 'fill-opacity': 0.16 }, inner);
      }
      const icon = el('g', {
        transform: `translate(${PAD_X + 12},${by + 12}) scale(${(BADGE - 24) / 24})`,
        fill: 'none', stroke: n.color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }, inner);
      icon.innerHTML = ICONS[n.icon] || ICONS[KIND_ICONS[n.kind]];

      const tx0 = PAD_X + BADGE + BADGE_GAP;
      const textH = n.lines.length * LABEL_LH + (n.subLines.length ? 6 + n.subLines.length * SUB_LH : 0);
      let ty = n.h / 2 - textH / 2;
      n.lines.forEach((line) => {
        const t = el('text', {
          x: tx0, y: ty + LABEL_SIZE * 0.95, fill: theme.text,
          'font-family': FONT, 'font-size': LABEL_SIZE, 'font-weight': 650,
        }, inner);
        t.textContent = line;
        ty += LABEL_LH;
      });
      if (n.subLines.length) ty += 6;
      n.subLines.forEach((line) => {
        const t = el('text', {
          x: tx0, y: ty + SUB_SIZE * 0.95, fill: theme.muted,
          'font-family': FONT, 'font-size': SUB_SIZE, 'font-weight': 500,
        }, inner);
        t.textContent = line;
        ty += SUB_LH;
      });
      n.g = g;
    });

    // Visual scenes (screen space) and the recap list used as outro when there is no map.
    const gVisual = el('g', {}, svg);
    const gRecap = el('g', {}, svg);

    // Overlays.
    const fs = (k) => `${Math.round(base * k)}px`;
    const header = div('header', stage);
    header.style.fontSize = fs(0.022);
    header.style.color = theme.muted;
    header.style.background = theme.panel;
    header.style.padding = '.35em .8em';
    header.style.borderRadius = '2em';
    header.innerHTML = `<span class="dot" style="background:${accent}"></span><span></span>`;
    header.lastChild.textContent = sb.title;

    const capBox = div('captionBox', stage);
    capBox.style.top = `${view.capTop}px`;
    capBox.style.bottom = `${H * 0.045}px`;
    const panel = document.createElement('div');
    panel.id = 'captionPanel';
    panel.style.background = theme.panel;
    capBox.appendChild(panel);
    const kicker = document.createElement('div');
    kicker.id = 'kicker';
    kicker.style.fontSize = fs(0.021);
    kicker.style.color = accent;
    const caption = document.createElement('div');
    caption.id = 'caption';
    caption.style.fontSize = fs(W < H ? 0.05 : 0.041);
    caption.style.color = theme.text;
    panel.append(kicker, caption);

    const progress = div('progress', stage);
    progress.style.background = accent;

    const introCard = div(null, stage, 'overlay card');
    introCard.style.background = `radial-gradient(ellipse at 50% 42%, ${theme.glow}, ${theme.bg} 75%)`;
    introCard.innerHTML = '<h1></h1><div class="rule"></div><p></p>';
    introCard.querySelector('h1').textContent = sb.title;
    introCard.querySelector('p').textContent = sb.subtitle || '';
    styleCard(introCard, fs);

    const endCard = div(null, stage, 'overlay card');
    endCard.style.background = `radial-gradient(ellipse at 50% 42%, ${theme.glow}, ${theme.bg} 75%)`;
    endCard.innerHTML = '<h1></h1><div class="rule"></div><p></p>';
    endCard.querySelector('h1').textContent = sb.title;
    endCard.querySelector('p').textContent = (sb.outro && sb.outro.cta) || sb.subtitle || '';
    styleCard(endCard, fs);

    dom = { svg, world, gVisual, gRecap, bgPattern, gPackets, header, capBox, panel, kicker, caption, progress, introCard, endCard, lastCaption: null };
  }
  function styleCard(card, fs) {
    card.querySelector('h1').style.cssText = `font-size:${fs(W < H ? 0.095 : 0.078)};color:${theme.text}`;
    card.querySelector('p').style.cssText = `font-size:${fs(W < H ? 0.045 : 0.034)};color:${theme.muted}`;
    card.querySelector('.rule').style.cssText = `width:${fs(0.12)};background:${accent}`;
  }

  function buildPackets() {
    packets.forEach((p) => {
      const g = el('g', { display: 'none' }, dom.gPackets);
      p.trail = [0, 1].map((i) => el('circle', { r: 5 - i, fill: p.color, 'fill-opacity': 0.35 + i * 0.2 }, g));
      p.halo = el('circle', { r: 22, fill: p.color, 'fill-opacity': 0.22 }, g);
      p.core = el('circle', { r: 9, fill: p.color }, g);
      p.shine = el('circle', { r: 4, fill: 'url(#packetGlow)' }, g);
      p.g = g;
    });
  }

  // ---------- schedule ----------
  function schedule(sb) {
    const revealed = new Set();
    const drawn = new Set();
    let t = T.intro;
    let prevCam = null;
    const maxScale = base / 800;
    const edgeKey = (a, b) => `${a}->${b}`;
    const edgeMap = new Map(edges.map((e) => [edgeKey(e.from, e.to), e]));

    scenes.forEach((sc, i) => {
      const S = t;
      if (sc.visual) {
        // Animated scene: no camera move; any nodes it reveals appear on the map silently for the outro.
        (sc.reveal || []).forEach((id) => { if (!revealed.has(id)) { nodeById.get(id).revealAt = S; revealed.add(id); } });
        const v = buildVisual(sc, i);
        const read = Math.max(T.minRead, wordCount(sc.caption) / T.wordsPerSec);
        const dur = Math.max(v.dur + 0.5 + T.tail * 0.5, T.capIn + read + T.capFade + 0.3) + (sc.hold || 0);
        const cam = prevCam || (hasMap ? fit([...revealed].length ? [...revealed] : nodes.map((n) => n.id), maxScale) : { x: 0, y: 0, s: 1 });
        Object.assign(sc, { start: S, dur, cam, fromCam: cam, focusSet: new Set(), index: i, vis: v });
        prevCam = cam;
        t += dur;
        return;
      }
      const fresh = (sc.reveal || []).filter((id) => !revealed.has(id));
      fresh.forEach((id, k) => {
        nodeById.get(id).revealAt = S + T.nodeStart + k * T.nodeGap;
        revealed.add(id);
      });
      const nodeEnd = fresh.length
        ? S + T.nodeStart + (fresh.length - 1) * T.nodeGap + T.nodeDur
        : S + T.cam * 0.6;
      let edgeEnd = nodeEnd;
      edges.forEach((e) => {
        if (drawn.has(e) || !revealed.has(e.from) || !revealed.has(e.to)) return;
        e.drawAt = Math.max(nodeById.get(e.from).revealAt, nodeById.get(e.to).revealAt) + T.nodeDur * 0.5 + T.edgeLead;
        drawn.add(e);
        edgeEnd = Math.max(edgeEnd, e.drawAt + T.edgeDur);
      });
      const flowStart = Math.max(nodeEnd, edgeEnd) + 0.1;
      const flow = sc.flow || [];
      flow.forEach(([a, b], j) => {
        const e = edgeMap.get(edgeKey(a, b));
        packets.push({ edge: e, start: flowStart + j * T.packetGap, dur: T.packetDur, color: nodeById.get(a).color, to: b });
      });
      const animEnd = flow.length ? flowStart + (flow.length - 1) * T.packetGap + T.packetDur : Math.max(nodeEnd, edgeEnd);
      const read = Math.max(T.minRead, wordCount(sc.caption) / T.wordsPerSec);
      const dur = Math.max(animEnd - S + T.tail, T.capIn + read + T.capFade + 0.3) + (sc.hold || 0);

      let focus = sc.focus && sc.focus.length ? sc.focus : [...new Set([...(sc.reveal || []), ...flow.flat()])];
      if (!focus.length) focus = [...revealed];
      const cam = fit(focus, maxScale);
      const px = (LABEL_SIZE * cam.s * 1080) / base;
      if (px < MIN_LABEL_PX) {
        warnings.push(`scene ${i + 1}: labels render at ${px.toFixed(0)}px (min ${MIN_LABEL_PX}); focus spans too much (${focus.length} nodes). Narrow "focus", move far-away nodes closer with a local box, or split the scene.`);
      }
      Object.assign(sc, { start: S, dur, cam, fromCam: prevCam || cam, focusSet: new Set(focus), index: i });
      prevCam = cam;
      t += dur;
    });

    // Outro: pull back to the whole map and run data through every edge (or, with no map, a recap).
    const all = nodes.map((n) => n.id);
    if (!hasMap) {
      const oCap = (sb.outro && sb.outro.caption) || '';
      const holdR = Math.max(T.outroHold, T.capIn + wordCount(oCap) / T.wordsPerSec + T.capFade + 0.6, 1.2 + scenes.length * 0.25);
      outro = { start: t, cam: { x: 0, y: 0, s: 1 }, fromCam: { x: 0, y: 0, s: 1 }, caption: oCap,
        kicker: (sb.outro && sb.outro.kicker) || 'The full picture', endStart: t + 0.6 + holdR };
      buildRecap();
      duration = outro.endStart + T.endCard;
      return;
    }
    nodes.forEach((n) => { if (n.revealAt === undefined) n.revealAt = t + 0.3; });
    edges.forEach((e) => { if (e.drawAt === undefined) e.drawAt = t + 0.6; });
    const oCaption = (sb.outro && sb.outro.caption) || '';
    const hold = Math.max(T.outroHold, T.capIn + wordCount(oCaption) / T.wordsPerSec + T.capFade + 0.6);
    outro = {
      start: t, cam: fit(all, maxScale), fromCam: prevCam, caption: oCaption,
      kicker: (sb.outro && sb.outro.kicker) || 'The full picture', endStart: t + T.outroCam + hold,
    };
    const flowFrom = t + T.outroCam * 0.6;
    edges.forEach((e) => {
      if (e.back) return;
      const r = nodeById.get(e.from).rank;
      for (let s = flowFrom + r * 0.35; s + T.packetDur < outro.endStart; s += 2.4) {
        packets.push({ edge: e, start: s, dur: T.packetDur, color: nodeById.get(e.from).color, to: e.to });
      }
    });
    duration = outro.endStart + T.endCard;
  }

  // ---------- visual scenes ----------
  function buildVisual(sc, i) {
    const lib = window.FlowScenes || {};
    const kind = lib[sc.visual.type];
    const g = el('g', { display: 'none' }, dom.gVisual);
    const inner = el('g', {}, g);
    if (!kind) { warnings.push(`scene ${i + 1}: unknown visual type "${sc.visual.type}"`); return { g, dur: 1, draw() {} }; }
    const headerH = H * 0.08;
    const boxv = { x: W * 0.05, y: headerH + base * 0.01, w: W * 0.9, h: view.capTop - headerH - base * 0.03 };
    // Phones: lay the scene out in a narrower virtual box, then scale it up, so text reads larger.
    const k = W < H ? 1.5 : W === H ? 1.15 : 1;
    const vbox = { x: boxv.x + (boxv.w - boxv.w / k) / 2, y: boxv.y + (boxv.h - boxv.h / k) / 2, w: boxv.w / k, h: boxv.h / k };
    const ctx = { style, U: base / 1080, box: vbox, icons: ICONS, images: IMAGES, measureCtx, motion: MOTION[style.motion] || 1, uid: `v${i}` };
    const v = kind.build(inner, sc.visual, ctx);
    // Fit: measure what the scene draws over its run and scale it to fill the box (up to 1.6x),
    // so the same scene reads well in 16:9, 1:1 and 9:16.
    g.setAttribute('display', 'inline');
    let bb = null;
    if (v.bounds) bb = v.bounds();
    else {
      for (const f of [0.35, 0.6, 0.8, 1]) {
        v.draw(v.dur * f);
        const b = inner.getBBox();
        if (!b.width || !b.height) continue;
        bb = bb ? { x: Math.min(bb.x, b.x), y: Math.min(bb.y, b.y), x2: Math.max(bb.x2, b.x + b.width), y2: Math.max(bb.y2, b.y + b.height) } : { x: b.x, y: b.y, x2: b.x + b.width, y2: b.y + b.height };
      }
      if (bb) bb = { x: bb.x, y: bb.y, w: bb.x2 - bb.x, h: bb.y2 - bb.y };
    }
    g.setAttribute('display', 'none');
    if (bb && bb.w > 0 && bb.h > 0) {
      const s = Math.min(boxv.w / bb.w, boxv.h / bb.h, 1.6 * k);
      const cx = boxv.x + boxv.w / 2, cy = boxv.y + boxv.h / 2;
      inner.setAttribute('transform', `translate(${cx},${cy}) scale(${s}) translate(${-(bb.x + bb.w / 2)},${-(bb.y + bb.h / 2)})`);
    }
    return { g, dur: v.dur, draw: v.draw };
  }

  function buildRecap() {
    // One row per scene title, appearing in sequence: a summary of the story told.
    const items = scenes.map((s, i) => s.title || s.caption.split(/[.!?]/)[0]).slice(0, 9);
    const avail = view.capTop - H * 0.1;
    const U = Math.min(base / 1080 * 1.5, avail / (items.length * 64));
    const rowH = 64 * U, w = Math.min(W * 0.84, 900 * U);
    const total = items.length * rowH;
    const top = H * 0.08 + Math.max(10 * U, (view.capTop - H * 0.08 - total) / 2);
    recap = items.map((txt, i) => {
      const g = el('g', { display: 'none' }, dom.gRecap);
      const x = W / 2 - w / 2, y = top + i * rowH;
      el('rect', { x, y: y + 6 * U, width: w, height: rowH - 12 * U, rx: Math.min(RADIUS, 24) * U, fill: theme.card, stroke: theme.border, 'stroke-width': 2 * U }, g);
      el('circle', { cx: x + 34 * U, cy: y + rowH / 2, r: 15 * U, fill: accent, 'fill-opacity': 0.2 }, g);
      const num = el('text', { x: x + 34 * U, y: y + rowH / 2 + 6 * U, 'text-anchor': 'middle', fill: accent, 'font-family': FONT, 'font-size': 17 * U, 'font-weight': 800 }, g);
      num.textContent = String(i + 1);
      const tx = el('text', { x: x + 64 * U, y: y + rowH / 2 + 8 * U, fill: theme.text, 'font-family': FONT, 'font-size': 23 * U, 'font-weight': 650 }, g);
      tx.textContent = txt.length > 60 ? txt.slice(0, 59) + '…' : txt;
      return { g, at: outro.start + 0.3 + i * 0.22 };
    });
  }

  // ---------- public API ----------
  async function loadAssets(opts) {
    if (opts.fontUrl) {
      const ff = new FontFace(style.font.name || 'BrandFont', `url(${opts.fontUrl})`);
      try { document.fonts.add(await ff.load()); } catch (e) { warnings.push(`font could not be loaded: ${e.message}`); }
    }
    await document.fonts.ready;
    IMAGES = {};
    await Promise.all(Object.entries(opts.images || {}).map(([src, url]) => new Promise((res) => {
      const im = new Image();
      im.onload = () => { IMAGES[src] = { url, w: im.naturalWidth, h: im.naturalHeight }; res(); };
      im.onerror = () => { warnings.push(`image could not be loaded: ${src}`); res(); };
      im.src = url;
    })));
  }

  window.__setup = async (sb, opts) => {
    W = opts.width; H = opts.height; ICONS = opts.icons;
    base = Math.min(W, H);
    warnings = [];
    style = opts.style || { colors: THEMES[sb.theme] || THEMES.dark, accent: sb.accent || '#7C5CFF', kinds: KIND_COLORS, font: { family: FONT }, radius: 18, background: 'glow-dots', motion: 'standard' };
    theme = style.colors;
    accent = style.accent;
    KIND_COLORS = { step: null, ...style.kinds };
    FONT = style.font.family;
    RADIUS = style.radius ?? 18;
    const m = MOTION[style.motion] || 1;
    T = Object.fromEntries(Object.entries(T0).map(([k, v]) => [k, ['wordsPerSec', 'minRead'].includes(k) ? v : v * m]));
    orient = W > H ? 'LR' : 'TB';
    packets = [];
    visuals = [];
    recap = null;
    await loadAssets(opts);

    const capFrac = W < H ? 0.26 : 0.27;
    const headerH = H * 0.08;
    view = { w: W * 0.92, h: H * (1 - capFrac) - headerH, cy: headerH + (H * (1 - capFrac) - headerH) / 2, capTop: H * (1 - capFrac) };

    measureCtx = document.createElement('canvas').getContext('2d');
    const textW = NODE_W - PAD_X * 2 - BADGE - BADGE_GAP;
    hasMap = (sb.nodes || []).length > 0;
    nodes = (sb.nodes || []).map((src) => {
      const kind = src.kind || 'step';
      const n = {
        id: src.id, label: src.label, sub: src.sub || '', kind,
        icon: src.icon || KIND_ICONS[kind],
        color: src.color || KIND_COLORS[kind] || accent,
      };
      n.lines = wrap(n.label, LABEL_SIZE, 650, textW);
      n.subLines = n.sub ? wrap(n.sub, SUB_SIZE, 500, textW) : [];
      if (n.lines.length > 3) warnings.push(`node "${n.id}": label wraps to ${n.lines.length} lines; shorten it (aim <= 5 words).`);
      const textH = n.lines.length * LABEL_LH + (n.subLines.length ? 6 + n.subLines.length * SUB_LH : 0);
      n.h = Math.max(BADGE + PAD_Y * 2, textH + PAD_Y * 2);
      return n;
    });
    nodeById = new Map(nodes.map((n) => [n.id, n]));
    edges = (sb.edges || []).filter((e) => e.from !== e.to).map((e) => ({ from: e.from, to: e.to, label: e.label || '' }));
    scenes = sb.scenes.map((s) => ({ ...s }));

    if (hasMap) layout();
    buildDom(sb);
    schedule(sb);
    buildPackets();
    window.__seek(0);

    const marks = scenes.map((s) => ({ index: s.index, start: s.start, end: s.start + s.dur }));
    return { duration, marks, intro: T.intro, outroStart: outro.start, endStart: outro.endStart, warnings };
  };

  window.__seek = (t) => {
    // Which segment are we in?
    let sc = null;
    for (const s of scenes) if (t >= s.start && t < s.start + s.dur) sc = s;
    const inOutro = t >= outro.start;

    // Visual scenes cover the map; the map fades out under them.
    let visOp = 0;
    scenes.forEach((s) => {
      if (!s.vis) return;
      const local = t - s.start;
      const op = t >= s.start - 0.01 && t < s.start + s.dur ? Math.min(prog(local, 0, 0.45), 1 - prog(local, s.dur - 0.45, 0.45)) : 0;
      s.vis.g.setAttribute('display', op > 0 ? 'inline' : 'none');
      if (op > 0) { s.vis.g.setAttribute('opacity', op.toFixed(3)); s.vis.draw(Math.max(0, local - 0.15)); }
      visOp = Math.max(visOp, op);
    });
    // The map is hidden for a visual scene (full strength once the fade-in is done) and before the first map scene.
    const mapScene = sc && !sc.vis;
    let mapOp = hasMap ? 1 : 0;
    if (hasMap && !inOutro) {
      if (sc && sc.vis) mapOp = 1 - visOp;
      if (!mapScene && sc && sc.vis) mapOp = Math.min(mapOp, 1 - visOp);
      const firstMap = scenes.find((s) => !s.vis);
      if (!firstMap || t < firstMap.start) mapOp = sc && sc.vis ? 0 : mapOp;
    }
    dom.world.setAttribute('opacity', mapOp.toFixed(3));
    if (recap) recap.forEach((r) => { const a = prog(t, r.at, 0.45); r.g.setAttribute('display', a > 0 && t < outro.endStart + 0.6 ? 'inline' : 'none'); r.g.setAttribute('opacity', a.toFixed(3)); r.g.setAttribute('transform', `translate(0,${(1 - ease.outCubic(a)) * base * 0.02})`); });

    // Camera.
    let cam;
    if (!hasMap) cam = { x: 0, y: 0, s: 1 };
    else if (t < T.intro) cam = (scenes.find((s) => !s.vis) || scenes[0]).cam;
    else if (inOutro) cam = camLerp(outro.fromCam, outro.cam, ease.inOutCubic(prog(t, outro.start, T.outroCam)));
    else if (!sc) cam = (scenes.find((s) => !s.vis) || scenes[0]).cam;
    else cam = camLerp(sc.fromCam, sc.cam, ease.inOutCubic(prog(t, sc.start, T.cam)));
    const tx = W / 2 - cam.x * cam.s, ty = view.cy - cam.y * cam.s;
    dom.world.setAttribute('transform', `translate(${tx},${ty}) scale(${cam.s})`);

    // Activeness: focused nodes are full strength, the rest dim.
    const prevScene = sc && sc.index > 0 ? scenes[sc.index - 1] : null;
    const activeness = (id) => {
      if (inOutro) {
        const last = scenes[scenes.length - 1];
        return lerp(last.focusSet.has(id) ? 1 : 0, 1, prog(t, outro.start, T.activeFade));
      }
      if (!sc) return 1;
      const now = sc.focusSet.has(id) ? 1 : 0;
      const before = prevScene ? (prevScene.focusSet.has(id) ? 1 : 0) : 1;
      return lerp(before, now, prog(t, sc.start, T.activeFade));
    };

    const pulses = new Map();
    packets.forEach((p) => {
      const arrive = p.start + p.dur;
      const k = prog(t, arrive - 0.05, 0.4);
      if (k > 0 && k < 1) pulses.set(p.to, Math.max(pulses.get(p.to) || 0, Math.sin(Math.PI * k)));
    });

    nodes.forEach((n) => {
      const a = prog(t, n.revealAt, T.nodeDur);
      if (a <= 0) { n.g.setAttribute('display', 'none'); return; }
      n.g.setAttribute('display', 'inline');
      const act = activeness(n.id);
      const op = clamp01(a * 1.8) * lerp(DIM, 1, act);
      const s = (0.6 + 0.4 * ease.outBack(a)) * (1 + 0.06 * (pulses.get(n.id) || 0));
      n.g.setAttribute('transform', `translate(${n.x},${n.y}) scale(${s})`);
      n.g.setAttribute('opacity', op.toFixed(3));
      n.ring.setAttribute('stroke-opacity', (act * 0.85 * (sc || inOutro ? 1 : 0)).toFixed(3));
    });

    edges.forEach((e) => {
      const p = ease.outCubic(prog(t, e.drawAt, T.edgeDur));
      const vis = p > 0 ? 'inline' : 'none';
      const act = Math.min(activeness(e.from), activeness(e.to));
      const off = e.len * (1 - p);
      e.path.setAttribute('display', vis);
      e.hl.setAttribute('display', vis);
      e.path.style.strokeDashoffset = off;
      e.hl.style.strokeDashoffset = off;
      e.path.setAttribute('opacity', lerp(0.45, 1, act).toFixed(3));
      e.hl.setAttribute('opacity', (act * 0.9).toFixed(3));
      e.arrow.setAttribute('opacity', (clamp01((p - 0.85) / 0.15) * lerp(0.45, 1, act)).toFixed(3));
      e.arrow.setAttribute('fill', act > 0.5 ? nodeById.get(e.from).color : theme.edge);
      if (e.labelG) e.labelG.setAttribute('opacity', (prog(t, e.drawAt + T.edgeDur * 0.6, 0.3) * lerp(0.4, 1, act)).toFixed(3));
    });

    packets.forEach((p) => {
      if (t < p.start || t > p.start + p.dur) { p.g.setAttribute('display', 'none'); return; }
      p.g.setAttribute('display', 'inline');
      const k = ease.inOutCubic(prog(t, p.start, p.dur));
      const at = (q) => p.edge.path.getPointAtLength(p.edge.len * clamp01(q));
      const pt = at(k);
      [p.halo, p.core, p.shine].forEach((c) => { c.setAttribute('cx', pt.x); c.setAttribute('cy', pt.y); });
      [0.06, 0.035].forEach((d, i) => {
        const q = at(k - d);
        p.trail[i].setAttribute('cx', q.x); p.trail[i].setAttribute('cy', q.y);
      });
      const fade = Math.min(prog(t, p.start, 0.15), 1 - prog(t, p.start + p.dur - 0.15, 0.15));
      p.g.setAttribute('opacity', fade.toFixed(3));
    });

    // Caption.
    let capText = '', kick = '', capOp = 0;
    if (sc) {
      capText = sc.caption;
      kick = sc.title || `Step ${sc.index + 1} of ${scenes.length}`;
      capOp = prog(t, sc.start + T.capIn, 0.35) * (1 - prog(t, sc.start + sc.dur - T.capFade, T.capFade));
    } else if (inOutro && t < outro.endStart && outro.caption) {
      capText = outro.caption;
      kick = outro.kicker;
      capOp = prog(t, outro.start + T.capIn, 0.35) * (1 - prog(t, outro.endStart - T.capFade, T.capFade));
    }
    const key = kick + '|' + capText;
    if (key !== dom.lastCaption) {
      dom.kicker.textContent = kick;
      dom.caption.textContent = capText;
      dom.lastCaption = key;
    }
    dom.capBox.style.opacity = capOp.toFixed(3);
    dom.capBox.style.transform = `translateY(${(1 - capOp) * base * 0.015}px)`;
    dom.panel.style.visibility = capText ? 'visible' : 'hidden';

    // Chrome: header, progress, title cards.
    dom.header.style.opacity = (prog(t, T.intro - 0.4, 0.6) * (1 - prog(t, outro.endStart, 0.4))).toFixed(3);
    dom.progress.style.width = `${(clamp01(t / duration) * 100).toFixed(3)}%`;
    const introOp = t < T.intro ? 1 - prog(t, T.intro - 0.7, 0.7) : 0;
    dom.introCard.style.opacity = introOp.toFixed(3);
    const rise = (start) => (1 - ease.outCubic(prog(t, start, 0.9))) * base * 0.03;
    dom.introCard.style.transform = `translateY(${rise(0.1)}px)`;
    dom.introCard.style.display = introOp > 0 ? 'flex' : 'none';
    const endOp = prog(t, outro.endStart, 0.6);
    dom.endCard.style.opacity = endOp.toFixed(3);
    dom.endCard.style.display = endOp > 0 ? 'flex' : 'none';
    dom.endCard.style.transform = `translateY(${rise(outro.endStart)}px)`;
  };
})();
