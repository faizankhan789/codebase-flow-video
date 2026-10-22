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
    intro: 4.2, cam: 1.1, nodeStart: 0.55, nodeGap: 0.16, nodeDur: 0.6,
    edgeLead: 0.2, edgeDur: 0.7, packetGap: 0.75, packetDur: 1.4,
    capIn: 0.45, capFade: 0.4, tail: 1.0, minRead: 2.6, wordsPerSec: 3.2,
    activeFade: 0.5, outroCam: 1.6, outroHold: 5.0, endCard: 3.8, chapter: 2.4,
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
    // Strong custom curves from the shared motion system (scenes.js): ease-out for entrances, ease-in-out for travel.
    outCubic: (p) => window.FlowMotion.EASE.out(p),
    inOutCubic: (p) => window.FlowMotion.EASE.inOut(p),
    outBack: (p) => window.FlowMotion.pop(p),
  };
  // ---------- colour ----------
  const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const rgbHex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  function toHsl(hex) {
    const [r, g, b] = hexRgb(hex).map((v) => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, s, l];
  }
  function fromHsl(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return rgbHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
  }
  const shift = (hex, dh, dl = 0, ds = 0) => { if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex; const [h, s, l] = toHsl(hex); return fromHsl((h + dh + 360) % 360, Math.max(0, Math.min(1, s + ds)), Math.max(0, Math.min(1, l + dl))); };
  const rgba = (hex, a) => { if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex; const [r, g, b] = hexRgb(hex); return `rgba(${r},${g},${b},${a})`; };

  // Shared paints (gradients) registered once in <defs>; scenes get them through ctx.paint.
  const paint = {
    defs: null, cache: new Map(),
    grad(color) {
      const key = `g${color.replace('#', '')}`;
      if (!this.cache.has(key)) {
        const g = el('linearGradient', { id: key, x1: 0, y1: 0, x2: 1, y2: 1 }, this.defs);
        el('stop', { offset: '0%', 'stop-color': shift(color, -16, 0.1, 0.05) }, g);
        el('stop', { offset: '100%', 'stop-color': shift(color, 24, -0.06, 0.05) }, g);
        this.cache.set(key, `url(#${key})`);
      }
      return this.cache.get(key);
    },
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
  let visuals = [], hasMap = true, recap = null, chapters = [];
  const TRANSITIONS = { calm: ['rise', 'fade', 'rise', 'zoom'], standard: ['rise', 'zoom', 'slide', 'rise'], snappy: ['slide', 'zoom', 'rise', 'slide'] };
  let nodes, nodeById, edges, scenes, packets, warnings, notes, clipErrors, capFit;
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

    paint.defs = defs;
    paint.cache = new Map();
    const dark = style.theme !== 'light';
    const sheen = el('linearGradient', { id: 'glassSheen', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el('stop', { offset: '0%', 'stop-color': '#fff', 'stop-opacity': dark ? 0.13 : 0.55 }, sheen);
    el('stop', { offset: '45%', 'stop-color': '#fff', 'stop-opacity': dark ? 0.03 : 0.15 }, sheen);
    el('stop', { offset: '100%', 'stop-color': '#fff', 'stop-opacity': 0 }, sheen);
    const edge = el('linearGradient', { id: 'glassEdge', x1: 0, y1: 0, x2: 0.4, y2: 1 }, defs);
    el('stop', { offset: '0%', 'stop-color': '#fff', 'stop-opacity': dark ? 0.38 : 0.95 }, edge);
    el('stop', { offset: '100%', 'stop-color': '#fff', 'stop-opacity': dark ? 0.06 : 0.35 }, edge);
    const blurF = el('filter', { id: 'blobBlur', x: '-50%', y: '-50%', width: '200%', height: '200%' }, defs);
    el('feGaussianBlur', { stdDeviation: base * 0.085 }, blurF);
    el('feColorMatrix', { type: 'saturate', values: 1.35 }, blurF);
    const glowF = el('filter', { id: 'softGlow', x: '-40%', y: '-40%', width: '180%', height: '180%' }, defs);
    el('feGaussianBlur', { stdDeviation: 14 }, glowF);
    const vig = el('radialGradient', { id: 'vignette', cx: '50%', cy: '45%', r: '75%' }, defs);
    el('stop', { offset: '60%', 'stop-color': theme.bg, 'stop-opacity': 0 }, vig);
    el('stop', { offset: '100%', 'stop-color': theme.bg, 'stop-opacity': dark ? 0.7 : 0.35 }, vig);

    el('rect', { x: 0, y: 0, width: W, height: H, fill: style.look === 'flat' ? 'url(#bgGlow)' : theme.bg }, svg);
    // Aurora: large blurred colour fields that drift slowly; cards are translucent, so colour shows through.
    const blobs = [];
    if (style.look !== 'flat') {
      // On light backgrounds the colour stays in the corners as a pale wash, so the frame still reads as its background colour.
      const gB = el('g', { filter: 'url(#blobBlur)', opacity: dark ? 0.7 : 0.32 }, svg);
      // Colour fields sit in the corners so the centre (where text lives) stays calm and the colours do not mix to grey.
      const cols = style.blobs || [accent, style.accent2 || accent, shift(accent, -45, -0.05), shift(style.accent2 || accent, 40, 0.02)];
      const spots = [[0.04, 0.08, 0.34], [0.97, 0.14, 0.3], [0.9, 0.98, 0.36], [0.06, 0.94, 0.27], [0.55, 0.02, 0.18]];
      cols.slice(0, 5).forEach((c, i) => {
        const [bx, by, br] = spots[i];
        blobs.push({ el: el('circle', { r: br * Math.max(W, H) * (dark ? 1 : 0.72), fill: dark ? c : shift(c, 0, 0.08), 'fill-opacity': i === 4 ? 0.5 : 0.85 }, gB), bx, by, i });
      });
      el('rect', { x: 0, y: 0, width: W, height: H, fill: 'url(#vignette)' }, svg);
      // Depth: faint orbit rings with a travelling light, and slow drifting particles.
      const gD = el('g', { opacity: dark ? 1 : 0.8 }, svg);
      const rings = [[0.92, 0.1, 0.34], [0.06, 0.92, 0.3]].map(([rxp, ryp, rr], i) => {
        const r = rr * base;
        el('circle', { cx: W * rxp, cy: H * ryp, r, fill: 'none', stroke: dark ? '#fff' : accent, 'stroke-opacity': dark ? 0.07 : 0.12, 'stroke-width': 1.5 }, gD);
        el('circle', { cx: W * rxp, cy: H * ryp, r: r * 0.72, fill: 'none', stroke: dark ? '#fff' : accent, 'stroke-opacity': dark ? 0.045 : 0.08, 'stroke-width': 1, 'stroke-dasharray': '3 9' }, gD);
        const dot = el('circle', { r: base * 0.006, fill: i ? (style.accent2 || accent) : accent, opacity: 0.9 }, gD);
        return { cx: W * rxp, cy: H * ryp, r, dot, sp: i ? -0.16 : 0.12 };
      });
      let seed = 11;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const particles = Array.from({ length: 42 }, () => ({ x: rnd() * W, y: rnd() * H, r: (0.8 + rnd() * 2.2) * base / 1080, sp: 6 + rnd() * 14, ph: rnd() * 6,
        el: null, a: 0.12 + rnd() * 0.3 }));
      particles.forEach((pt) => { pt.el = el('circle', { r: pt.r, fill: dark ? '#fff' : accent, opacity: pt.a }, gD); });
      // Light lines: thin horizontal streaks with a travelling glint (cinematic launch look).
      const streaks = style.lines ? [0.16, 0.5, 0.84].map((fy, i) => {
        const y = H * fy;
        const lgId = `streak${i}`;
        const lg = el('linearGradient', { id: lgId, x1: 0, y1: 0, x2: 1, y2: 0 }, defs);
        el('stop', { offset: '0%', 'stop-color': accent, 'stop-opacity': 0 }, lg);
        el('stop', { offset: '50%', 'stop-color': style.accent2 || accent, 'stop-opacity': 0.5 }, lg);
        el('stop', { offset: '100%', 'stop-color': accent, 'stop-opacity': 0 }, lg);
        el('rect', { x: 0, y: y - 0.75, width: W, height: 1.5, fill: `url(#${lgId})`, opacity: 0.35 }, gD);
        const glint = el('ellipse', { cy: y, rx: base * 0.08, ry: 2.2, fill: style.accent2 || accent, opacity: 0.9, filter: 'url(#softGlow)' }, gD);
        return { glint, sp: (i % 2 ? -1 : 1) * W * 0.06, x0: W * (0.2 + 0.3 * i) };
      }) : [];
      blobs.decor = { rings, particles, streaks };
    }
    if (style.background === 'grid') {
      const gp = el('pattern', { id: 'screenGrid', width: base / 18, height: base / 18, patternUnits: 'userSpaceOnUse' }, defs);
      el('path', { d: `M${base / 18} 0 L0 0 0 ${base / 18}`, fill: 'none', stroke: theme.dot, 'stroke-width': 1 }, gp);
    }
    const bgPattern = el('rect', { x: 0, y: 0, width: W, height: H, fill: style.background === 'grid' ? 'url(#screenGrid)' : 'none' }, svg);
    const world = el('g', {}, svg);
    el('rect', { x: -20000, y: -20000, width: 40000, height: 40000, fill: 'url(#dots)', opacity: style.look === 'flat' ? 1 : 0.55 }, world);
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
        measureCtx.font = `700 18px ${FONT}`;
        const tw = measureCtx.measureText(e.label).width;
        // Put the label where it does not cover any box: try points along the edge, nearest the middle first.
        const hitsNode = (p) => nodes.some((n) => Math.abs(p.x - n.x) < NODE_W / 2 + tw / 2 + 18 && Math.abs(p.y - n.y) < n.h / 2 + 24);
        const tries = e.back ? [0.5, 0.4, 0.6, 0.3, 0.7] : [0.45, 0.35, 0.55, 0.28, 0.62, 0.2, 0.7];
        let mid = null;
        for (const f of tries) { const p = e.path.getPointAtLength(e.len * f); if (!hitsNode(p)) { mid = p; break; } }
        if (!mid) { mid = e.path.getPointAtLength(e.len * tries[0]); warnings.push(`edge ${e.from} -> ${e.to}: label "${e.label}" has no free spot and overlaps a box; shorten it or move the boxes apart`); }
        const g = el('g', { transform: `translate(${mid.x},${mid.y})` }, gLabels);
        el('rect', {
          x: -tw / 2 - 12, y: -16, width: tw + 24, height: 32, rx: 16,
          fill: theme.pill, stroke: nodeById.get(e.from).color, 'stroke-width': 2,
        }, g);
        const tx = el('text', {
          x: 0, y: 6, 'text-anchor': 'middle', fill: theme.text,
          'font-family': FONT, 'font-size': 18, 'font-weight': 700,
        }, g);
        tx.textContent = e.label;
        e.labelG = g; e.mid = mid; e.labelW = tw + 24;
      }
    });

    nodes.forEach((n) => {
      const g = el('g', { 'data-asset': n.label }, gNodes);
      const inner = el('g', { transform: `translate(${-NODE_W / 2},${-n.h / 2})` }, g);
      const flat = style.look === 'flat';
      if (flat) el('rect', { x: 0, y: 10, width: NODE_W, height: n.h, rx: RADIUS, fill: theme.shadow }, inner);
      else el('rect', { x: 6, y: 14, width: NODE_W - 12, height: n.h - 6, rx: RADIUS, fill: n.color, opacity: 0.32, filter: 'url(#softGlow)' }, inner);
      n.ring = el('rect', {
        x: -6, y: -6, width: NODE_W + 12, height: n.h + 12, rx: RADIUS + 5,
        fill: 'none', stroke: n.color, 'stroke-width': 3,
      }, inner);
      el('rect', {
        x: 0, y: 0, width: NODE_W, height: n.h, rx: RADIUS, fill: theme.card, 'fill-opacity': flat ? 1 : (style.theme === 'light' ? 0.72 : 0.6),
        stroke: n.kind === 'decision' ? n.color : flat ? theme.border : 'url(#glassEdge)', 'stroke-width': 2,
        'stroke-dasharray': n.kind === 'external' ? '8 6' : 'none',
      }, inner);
      if (!flat) el('rect', { x: 1, y: 1, width: NODE_W - 2, height: n.h * 0.6, rx: RADIUS, fill: 'url(#glassSheen)' }, inner);
      const by = n.h / 2 - BADGE / 2;
      if (n.kind === 'decision') {
        el('rect', {
          x: PAD_X + 8, y: by + 8, width: BADGE - 16, height: BADGE - 16, rx: 6,
          transform: `rotate(45 ${PAD_X + BADGE / 2} ${by + BADGE / 2})`, fill: flat ? n.color : paint.grad(n.color), 'fill-opacity': flat ? 0.18 : 1,
        }, inner);
      } else {
        el('rect', { x: PAD_X, y: by, width: BADGE, height: BADGE, rx: 14, fill: flat ? n.color : paint.grad(n.color), 'fill-opacity': flat ? 0.16 : 1 }, inner);
      }
      const icon = el('g', {
        transform: `translate(${PAD_X + 12},${by + 12}) scale(${(BADGE - 24) / 24})`,
        fill: 'none', stroke: flat ? n.color : '#FFFFFF', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
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
    const glassCss = style.look === 'flat' ? `background:${theme.panel}` :
      `background:${rgba(theme.card, style.theme === 'light' ? 0.62 : 0.48)};backdrop-filter:blur(${Math.round(base * 0.018)}px) saturate(1.5);-webkit-backdrop-filter:blur(${Math.round(base * 0.018)}px) saturate(1.5);border:1px solid rgba(255,255,255,${style.theme === 'light' ? 0.7 : 0.14});box-shadow:0 ${base * 0.012}px ${base * 0.04}px rgba(0,0,0,${style.theme === 'light' ? 0.10 : 0.35})`;
    header.style.cssText += glassCss;
    header.style.padding = '.35em .8em';
    header.style.borderRadius = '2em';
    header.innerHTML = `<span class="dot" style="background:${accent}"></span><span></span>`;
    header.lastChild.textContent = sb.title;

    const capBox = div('captionBox', stage);
    capBox.style.top = `${view.capTop}px`;
    capBox.style.bottom = `${H * 0.045}px`;
    const panel = document.createElement('div');
    panel.id = 'captionPanel';
    panel.style.cssText += glassCss;
    capBox.appendChild(panel);
    const kicker = document.createElement('div');
    kicker.id = 'kicker';
    kicker.style.fontSize = fs(W < H ? 0.034 : 0.027);
    kicker.style.color = shift(accent, 0, style.theme === 'light' ? -0.12 : 0.16);
    const caption = document.createElement('div');
    caption.id = 'caption';
    caption.style.fontSize = fs(W < H ? 0.05 : 0.041);
    caption.style.color = theme.text;
    panel.append(kicker, caption);
    capFit = new Map();

    const progress = div('progress', stage);
    progress.style.background = `linear-gradient(90deg, ${accent}, ${style.accent2 || accent})`;

    const cardBg = style.look === 'flat' ? `radial-gradient(ellipse at 50% 42%, ${theme.glow}, ${theme.bg} 75%)` : 'transparent';
    const chipIcon = (name, col) => `<i style="background:linear-gradient(135deg, ${shift(col, -16, 0.1)}, ${shift(col, 24, -0.06)})"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.sparkles}</svg></i>`;
    const introCard = div(null, stage, 'overlay card');
    introCard.style.background = cardBg;
    introCard.innerHTML = '<div class="glass"><h1></h1><div class="rule"></div><p></p><div class="chips"></div></div>';
    introCard.querySelector('h1').textContent = sb.title;
    introCard.querySelector('p').textContent = sb.subtitle || '';
    const palette = [accent, style.accent2 || accent, (style.kinds || {}).ai || accent, (style.kinds || {}).store || accent, (style.kinds || {}).decision || accent];
    ((sb.intro && sb.intro.highlights) || []).slice(0, 5).forEach((h, i) => {
      const c = document.createElement('span');
      c.className = 'chip';
      c.innerHTML = `${chipIcon(h.icon, palette[i % 5])}<span></span>`;
      c.lastChild.textContent = h.label || h;
      introCard.querySelector('.chips').appendChild(c);
    });
    styleCard(introCard, fs, glassCss);

    const endCard = div(null, stage, 'overlay card');
    endCard.style.background = cardBg;
    const emblem = style.look !== 'flat' && style.emblem === 'sparkle';
    const sp = window.FlowScenes && window.FlowScenes.sparklePath;
    endCard.innerHTML = (emblem && sp ? `<svg class="emblem" viewBox="-60 -60 120 120"><defs><linearGradient id="emG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="${style.accent2 || accent}"/></linearGradient><radialGradient id="emH"><stop offset="0" stop-color="${style.accent2 || accent}" stop-opacity=".85"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient></defs><circle r="58" fill="url(#emH)"/><path d="${sp(0, 0, 44)}" fill="url(#emG)"/></svg>` : '') +
      '<div class="glass"><h1></h1><div class="rule"></div><p></p></div>';
    endCard.querySelector('h1').textContent = sb.title;
    endCard.querySelector('p').textContent = (sb.outro && sb.outro.cta) || sb.subtitle || '';
    styleCard(endCard, fs, glassCss);
    const emEl = endCard.querySelector('.emblem');
    if (emEl) emEl.style.cssText = `width:${fs(W < H ? 0.36 : 0.28)};height:${fs(W < H ? 0.36 : 0.28)};margin-bottom:${fs(-0.05)};filter:drop-shadow(0 0 ${fs(0.03)} ${style.accent2 || accent})`;

    // Chapter card: shown before each chapter on videos with several pipelines.
    const chapterCard = div(null, stage, 'overlay card');
    chapterCard.style.background = 'transparent';
    chapterCard.innerHTML = '<div class="glass"><h1></h1><div class="rule"></div><p></p></div>';
    styleCard(chapterCard, fs, glassCss);

    // Journey chip (top right): the item the story follows and where we are in it.
    const journey = div('journey', stage);
    journey.style.cssText += `${glassCss};font-size:${fs(0.02)};color:${theme.muted};padding:.35em .9em .35em .35em;border-radius:2em`;
    if (sb.journey) {
      journey.innerHTML = `${chipIcon(sb.journey.icon || 'file', accent)}<b></b><span class="step"></span>`;
      journey.querySelector('b').textContent = sb.journey.item;
      journey.querySelector('b').style.color = theme.text;
      const i = journey.querySelector('i');
      i.style.cssText += `;display:inline-grid;place-items:center;width:1.7em;height:1.7em;border-radius:50%`;
      i.querySelector('svg').style.cssText = 'width:58%;height:58%';
    } else journey.style.display = 'none';

    dom = { capSize: parseFloat(caption.style.fontSize), kickSize: parseFloat(kicker.style.fontSize), chapterCard, journey, blobs, svg, world, gVisual, gRecap, bgPattern, gPackets, header, capBox, panel, kicker, caption, progress, introCard, endCard, lastCaption: null };
  }
  function styleCard(card, fs, glassCss) {
    const vivid = style.look !== 'flat';
    const lt = style.theme === 'light';
    const h1 = card.querySelector('h1');
    h1.style.cssText = `font-size:${fs(W < H ? 0.09 : 0.074)};color:${theme.text}` +
      (vivid ? `;letter-spacing:-.03em;text-shadow:0 ${fs(0.006)} ${fs(0.03)} ${rgba(accent, lt ? 0.18 : 0.45)}` : '');
    card.querySelector('p').style.cssText = `font-size:${fs(W < H ? 0.042 : 0.031)};color:${theme.muted}`;
    card.querySelector('.rule').style.cssText = `width:${fs(0.12)};background:linear-gradient(90deg, ${accent}, ${style.accent2 || accent})`;
    const g = card.querySelector('.glass');
    g.style.cssText = vivid ? `${glassCss};padding:${fs(0.05)} ${fs(0.06)};border-radius:${fs(0.035)};max-width:86%;box-sizing:border-box` : '';
    const chips = card.querySelector('.chips');
    if (chips) chips.style.cssText = `display:flex;flex-wrap:wrap;justify-content:center;gap:${fs(0.014)};margin-top:${fs(0.035)}`;
    card.querySelectorAll('.chip').forEach((c) => {
      c.style.cssText = `display:inline-flex;align-items:center;gap:${fs(0.012)};padding:${fs(0.009)} ${fs(0.02)} ${fs(0.009)} ${fs(0.009)};border-radius:999px;font-size:${fs(0.024)};font-weight:650;color:${theme.text};background:rgba(255,255,255,${lt ? 0.6 : 0.07});border:1px solid rgba(255,255,255,${lt ? 0.85 : 0.14})`;
      const i = c.querySelector('i');
      i.style.cssText += `;display:inline-grid;place-items:center;width:${fs(0.042)};height:${fs(0.042)};border-radius:50%`;
      i.querySelector('svg').style.cssText = 'width:58%;height:58%';
    });
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

    chapters = [];
    const distinct = new Set(scenes.map((s) => s.chapter).filter(Boolean));
    let lastChapter = null, visN = 0;
    scenes.forEach((sc, i) => {
      // A new chapter (pipeline) gets its own title card before its first scene.
      if (distinct.size > 1 && sc.chapter && sc.chapter !== lastChapter) {
        chapters.push({ start: t, dur: T.chapter, title: sc.chapter, sub: sc.chapterSub || '', num: chapters.length + 1 });
        t += T.chapter;
      }
      if (sc.chapter) lastChapter = sc.chapter;
      sc.trans = sc.visual ? (sc.transition || (TRANSITIONS[style.motion] || TRANSITIONS.standard)[visN++ % 4]) : null;
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
    // Without a caption (headline, showcase) the scene uses the full height.
    const bottom = sc.caption ? view.capTop - base * 0.02 : H - base * 0.07;
    const boxv = { x: W * 0.05, y: headerH + base * 0.03, w: W * 0.9, h: bottom - headerH - base * 0.03 };
    // Phones: lay the scene out in a narrower virtual box, then scale it up, so text reads larger.
    const k = W < H ? 1.5 : W === H ? 1.15 : 1;
    const vbox = { x: boxv.x + (boxv.w - boxv.w / k) / 2, y: boxv.y + (boxv.h - boxv.h / k) / 2, w: boxv.w / k, h: boxv.h / k };
    let html = null;
    if (kind.html) {
      // HTML layer (for real CSS 3D): sits over the SVG, under the captions.
      html = document.createElement('div');
      html.className = 'overlay';
      html.style.cssText += `left:0;top:0;width:${W}px;height:${H}px;display:none`;
      document.getElementById('stage').insertBefore(html, dom.capBox);
    }
    // The frame guard scales this wrapper if anything in the HTML layer would leave the frame.
    const htmlInner = html ? Object.assign(document.createElement('div'), { style: `position:absolute;left:0;top:0;width:${W}px;height:${H}px;transform-origin:0 0` }) : null;
    if (html) html.appendChild(htmlInner);
    const ctx = { style, U: base / 1080, box: kind.html ? boxv : vbox, icons: ICONS, images: IMAGES, measureCtx, motion: MOTION[style.motion] || 1, uid: `v${i}`, paint, html: htmlInner };
    const v = kind.build(inner, sc.visual, ctx);
    const safe = { l: W * 0.025, t: headerH, r: W * 0.975, b: sc.caption ? view.capTop - base * 0.01 : H - base * 0.025 };
    if (v.noFit) return { g, inner, html, htmlInner, safe, dur: v.dur, draw: v.draw };
    // Fit: measure what the scene draws over its run and scale it to fill the box (up to 1.6x),
    // so the same scene reads well in 16:9, 1:1 and 9:16.
    g.setAttribute('display', 'inline');
    let bb = null;
    if (v.bounds) bb = v.bounds();
    else {
      for (const f of [0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 1]) {
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
    return { g, inner, safe, dur: v.dur, draw: v.draw };
  }

  // ---------- frame guard ----------
  // Hard rule: nothing that carries content (cards, text, avatars, images, screenshots) may be cut by the
  // frame or slide under the header or caption, in any aspect ratio. Every scene is sampled across its
  // whole run; if anything crosses its safe area, the scene is scaled and shifted until it fits. Whatever
  // still crosses the frame after that is reported as an error and the render stops.
  const stageScale = () => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: r.left, y: r.top, k: r.width / W || 1 }; };
  const effOpacity = (n) => {
    let o = 1;
    for (let e = n; e && e.id !== 'stage'; e = e.parentNode) {
      if (!e.getAttribute) continue;
      if (e.getAttribute('display') === 'none' || (e.style && e.style.display === 'none') || e.getAttribute('data-deco') !== null) return 0;
      const a = e.getAttribute('opacity'); if (a) o *= parseFloat(a);
      if (e.style && e.style.opacity !== '') o *= parseFloat(e.style.opacity);
    }
    return o;
  };
  // Content elements under root, with their rectangles in stage pixels.
  function contentRects(root) {
    const st = stageScale();
    const out = [];
    const svgSel = 'text, image, rect, circle, ellipse, [data-block]';
    const nodes = root instanceof SVGElement ? [...root.querySelectorAll(svgSel)] : [...root.querySelectorAll('*')].filter((n) =>
      n.hasAttribute('data-block') || n.tagName === 'IMG' || n.tagName === 'svg' || [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()));
    for (const n of nodes) {
      if (n instanceof SVGElement && n.tagName !== 'text' && n.tagName !== 'image' && !n.hasAttribute('data-block')) {
        // Shapes count when they are drawn surfaces (cards, avatars), not invisible hit areas or soft glows.
        const fill = n.getAttribute('fill'), stroke = n.getAttribute('stroke');
        if ((!fill || fill === 'none' || fill === 'transparent') && (!stroke || stroke === 'none')) continue;
        if (n.getAttribute('filter')) continue;
      }
      const op = effOpacity(n);
      if (op < 0.35) continue;
      const r = n.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      out.push({ n, op, l: (r.left - st.x) / st.k, t: (r.top - st.y) / st.k, r: (r.right - st.x) / st.k, b: (r.bottom - st.y) / st.k });
    }
    return out;
  }
  const describe = (n) => {
    const tag = n.closest && (n.closest('[data-block]') || n.closest('[data-asset]'));
    const name = tag ? tag.getAttribute('data-block') || tag.getAttribute('data-asset') : (n.textContent || '').trim().slice(0, 40);
    return name ? `"${name}"` : `a ${n.tagName.toLowerCase()}`;
  };
  function sceneUnion(vis) {
    let U = null;
    for (let f = 0.05; f <= 1.0001; f += 0.05) {
      vis.draw(vis.dur * Math.min(1, f));
      const rects = contentRects(vis.g).concat(vis.html ? contentRects(vis.html) : []);
      for (const q of rects) U = U ? { l: Math.min(U.l, q.l), t: Math.min(U.t, q.t), r: Math.max(U.r, q.r), b: Math.max(U.b, q.b) } : { l: q.l, t: q.t, r: q.r, b: q.b };
    }
    return U;
  }
  function guardFrame() {
    const M = Math.max(2, base * 0.006);
    scenes.forEach((s, i) => {
      const vis = s.vis;
      if (!vis) return;
      vis.g.setAttribute('display', 'inline');
      if (vis.html) vis.html.style.display = 'block';
      const sf = vis.safe;
      const U = sceneUnion(vis);
      if (U && (U.l < sf.l - 1 || U.t < sf.t - 1 || U.r > sf.r + 1 || U.b > sf.b + 1)) {
        // Scale about the union and move it inside the safe area (centred on the axis that has room).
        const k = Math.min(1, (sf.r - sf.l) / (U.r - U.l), (sf.b - sf.t) / (U.b - U.t));
        const w = (U.r - U.l) * k, h = (U.b - U.t) * k;
        const nx = Math.min(Math.max(U.l, sf.l), sf.r - w), ny = Math.min(Math.max(U.t, sf.t), sf.b - h);
        const fixL = k < 1 ? sf.l + ((sf.r - sf.l) - w) / 2 : nx, fixT = k < 1 ? sf.t + ((sf.b - sf.t) - h) / 2 : ny;
        const tx = fixL - U.l * k, ty = fixT - U.t * k;
        vis.inner.setAttribute('transform', `translate(${tx},${ty}) scale(${k}) ${vis.inner.getAttribute('transform') || ''}`);
        if (vis.htmlInner) vis.htmlInner.style.transform = `translate(${tx}px,${ty}px) scale(${k}) ${vis.htmlInner.style.transform || ''}`;
        notes.push(`scene ${i + 1} (${s.visual.type}): content reached past the frame or caption; ${k < 0.995 ? `scaled to ${(k * 100).toFixed(0)}% and ` : ''}moved inside the safe area`);
      }
      // Verify: after the fix, nothing may cross the frame itself.
      const bad = new Map();
      for (let f = 0.05; f <= 1.0001; f += 0.05) {
        vis.draw(vis.dur * Math.min(1, f));
        for (const q of contentRects(vis.g).concat(vis.html ? contentRects(vis.html) : []))
          if (q.l < M - 1 || q.t < M - 1 || q.r > W - M + 1 || q.b > H - M + 1) bad.set(describe(q.n), true);
      }
      bad.forEach((_, name) => clipErrors.push(`scene ${i + 1} (${s.visual.type}): ${name} is cut by the frame`));
      vis.g.setAttribute('display', 'none');
      if (vis.html) vis.html.style.display = 'none';
    });
  }
  // Header, captions, intro, chapter cards, recap and end card: sampled over the whole timeline.
  function checkChrome() {
    const M = Math.max(2, base * 0.006);
    const times = [T.intro * 0.6];
    scenes.forEach((s) => times.push(s.start + s.dur * 0.3, s.start + s.dur * 0.75));
    chapters.forEach((c) => times.push(c.start + c.dur * 0.5));
    times.push(outro.start + 1.2, outro.endStart - 0.1, outro.endStart + T.endCard * 0.6);
    const stage = document.getElementById('stage');
    const bad = new Set();
    for (const t of times) {
      if (!(t >= 0 && t < duration)) continue;
      window.__seek(t);
      const roots = [...stage.children].filter((c) => c.tagName !== 'svg' && !scenes.some((s) => s.vis && s.vis.html === c));
      // Map nodes are kept in frame by the camera edge fade in __seek.
      for (const root of roots.concat([dom.gRecap])) {
        for (const q of contentRects(root)) {
          if (q.l < M - 1 || q.t < M - 1 || q.r > W - M + 1 || q.b > H - M + 1) bad.add(`${describe(q.n)} at ${t.toFixed(1)}s`);
        }
      }
    }
    [...bad].slice(0, 12).forEach((b) => clipErrors.push(`${b} is cut by the frame`));
  }

  // Samples every animated scene and reports blocks (cards, avatars, labels) that cover each other.
  function checkOverlaps() {
    const opacityOf = (n, stop) => { let o = 1; for (let e = n; e && e !== stop; e = e.parentNode) { if (e.getAttribute && e.getAttribute('display') === 'none') return 0; const a = e.getAttribute && e.getAttribute('opacity'); if (a !== null && a !== undefined && a !== '') o *= parseFloat(a); } return o; };
    scenes.forEach((s, i) => {
      if (!s.vis) return;
      const found = new Set();
      s.vis.g.setAttribute('display', 'inline');
      if (s.vis.html) s.vis.html.style.display = 'block';
      for (const f of [0.55, 0.8, 1]) {
        s.vis.draw(s.vis.dur * f);
        const cssOp = (n) => { let o = 1; for (let e = n; e && e !== s.vis.html; e = e.parentElement) o *= parseFloat(e.style.opacity || 1); return o; };
        const htmlBlocks = s.vis.html ? [...s.vis.html.querySelectorAll('[data-block]')].map((n) => ({ n, r: n.getBoundingClientRect(), op: cssOp(n) })) : [];
        const blocks = [...s.vis.g.querySelectorAll('[data-block]')].map((n) => ({ n, r: n.getBoundingClientRect(), op: opacityOf(n, s.vis.g) })).concat(htmlBlocks)
          .filter((b) => b.op > 0.2 && b.r.width > 2 && b.r.height > 2);
        for (let a = 0; a < blocks.length; a++) for (let b = a + 1; b < blocks.length; b++) {
          const A = blocks[a], Bk = blocks[b];
          if (A.n.contains(Bk.n) || Bk.n.contains(A.n)) continue;
          const ix = Math.min(A.r.right, Bk.r.right) - Math.max(A.r.left, Bk.r.left), iy = Math.min(A.r.bottom, Bk.r.bottom) - Math.max(A.r.top, Bk.r.top);
          if (ix <= 4 || iy <= 4) continue;
          const minArea = Math.min(A.r.width * A.r.height, Bk.r.width * Bk.r.height);
          if ((ix * iy) / minArea > 0.12) found.add(`"${A.n.getAttribute('data-block')}" and "${Bk.n.getAttribute('data-block')}"`);
        }
      }
      s.vis.g.setAttribute('display', 'none');
      if (s.vis.html) s.vis.html.style.display = 'none';
      found.forEach((pair) => warnings.push(`scene ${i + 1} (${s.visual.type}): ${pair} overlap; shorten text, use fewer items, or split the scene`));
    });
  }

  function buildRecap() {
    // One row per scene title, appearing in sequence: a summary of the story told.
    // Headline scenes are section titles, not steps; the recap lists the steps.
    let items = scenes.filter((s) => s.visual?.type !== 'headline').map((s) => s.title || (s.caption || '').split(/[.!?]/)[0] || s.visual?.callouts?.[0]?.title || '').filter(Boolean);
    if (!items.length) items = scenes.map((s) => s.visual?.text || '').filter(Boolean);
    items = items.slice(0, 9);
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
      // Truncate by measured width so a long title never runs past its row or the frame.
      measureCtx.font = `650 ${23 * U}px ${FONT}`;
      const maxW = w - 64 * U - 24 * U;
      let cut = txt;
      if (measureCtx.measureText(cut).width > maxW) { while (cut.length > 1 && measureCtx.measureText(cut + '…').width > maxW) cut = cut.slice(0, -1); cut = cut.replace(/\s+$/, '') + '…'; }
      tx.textContent = cut;
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
    warnings = []; notes = []; clipErrors = [];
    if (window.FlowMotion) window.FlowMotion.setPersonality((opts.style && opts.style.motion) || 'standard');
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
    chapters.forEach((c) => {
      const m = div(null, document.getElementById('stage'), 'overlay');
      m.style.cssText += `left:${(c.start / duration) * 100}%;bottom:0;width:3px;height:${Math.max(6, base * 0.01)}px;background:${theme.text};opacity:.55`;
    });
    guardFrame();
    checkOverlaps();
    checkChrome();
    window.__seek(0);

    const marks = scenes.map((s) => ({ index: s.index, start: s.start, end: s.start + s.dur }));
    return { duration, marks, intro: T.intro, outroStart: outro.start, endStart: outro.endStart, warnings, notes, clipErrors, chapters: chapters.map((c) => ({ start: c.start, end: c.start + c.dur, title: c.title })) };
  };

  window.__seek = (t) => {
    // Which segment are we in?
    let sc = null;
    for (const s of scenes) if (t >= s.start && t < s.start + s.dur) sc = s;
    const inOutro = t >= outro.start;

    // Background colour fields, rings and particles drift slowly (pure function of t).
    if (dom.blobs.decor) {
      dom.blobs.decor.streaks.forEach((s) => s.glint.setAttribute('cx', ((((s.x0 + t * s.sp) % (W * 1.2)) + W * 1.2) % (W * 1.2) - W * 0.1).toFixed(1)));
      dom.blobs.decor.rings.forEach((r) => { const a = t * r.sp; r.dot.setAttribute('cx', (r.cx + Math.cos(a) * r.r).toFixed(1)); r.dot.setAttribute('cy', (r.cy + Math.sin(a) * r.r).toFixed(1)); });
      dom.blobs.decor.particles.forEach((pt) => {
        const y = ((pt.y - t * pt.sp) % H + H) % H;
        pt.el.setAttribute('cx', (pt.x + Math.sin(t * 0.4 + pt.ph) * 8).toFixed(1));
        pt.el.setAttribute('cy', y.toFixed(1));
      });
    }
    dom.blobs.forEach((b) => {
      const k = b.i * 1.7;
      b.el.setAttribute('cx', (W * (b.bx + 0.07 * Math.sin(t * 0.11 + k))).toFixed(1));
      b.el.setAttribute('cy', (H * (b.by + 0.06 * Math.cos(t * 0.09 + k * 1.3))).toFixed(1));
    });
    const chap = chapters.find((c) => t >= c.start && t < c.start + c.dur);

    // Visual scenes cover the map; the map fades out under them. Each enters and leaves with its transition.
    let visOp = 0;
    scenes.forEach((s) => {
      if (!s.vis) return;
      const local = t - s.start;
      const live = t >= s.start - 0.01 && t < s.start + s.dur;
      // Exit is faster than entry (about 60%), and a short blur bridges the change.
      const ein = ease.outCubic(prog(local, 0, 0.55)), eout = ease.inOutCubic(prog(local, s.dur - 0.32, 0.32));
      const op = live ? Math.min(prog(local, 0, 0.42), 1 - prog(local, s.dur - 0.32, 0.32)) : 0;
      const blur = live ? (1 - ein) * base * 0.006 + eout * base * 0.006 : 0;
      const blurCss = blur > 0.2 ? `blur(${blur.toFixed(1)}px)` : '';
      s.vis.g.setAttribute('display', op > 0 ? 'inline' : 'none');
      if (s.vis.html) {
        s.vis.html.style.display = op > 0 ? 'block' : 'none';
        if (op > 0) {
          s.vis.html.style.opacity = op.toFixed(3);
          s.vis.html.style.filter = blurCss;
          s.vis.html.style.transform = s.trans === 'slide' ? `translateX(${((1 - ein) * 0.07 - eout * 0.05) * W}px)`
            : s.trans === 'zoom' ? `scale(${0.93 + 0.07 * ein + 0.03 * eout})` : s.trans === 'rise' ? `translateY(${((1 - ein) * 0.045 - eout * 0.03) * base}px)` : '';
        }
      }
      if (op > 0) {
        s.vis.g.setAttribute('opacity', op.toFixed(3));
        const cx = W / 2, cy = view.cy;
        const tf = s.trans === 'slide' ? `translate(${((1 - ein) * 0.07 - eout * 0.05) * W},0)`
          : s.trans === 'zoom' ? `translate(${cx},${cy}) scale(${0.93 + 0.07 * ein + 0.03 * eout}) translate(${-cx},${-cy})`
          : s.trans === 'rise' ? `translate(0,${((1 - ein) * 0.045 - eout * 0.03) * base})` : '';
        s.vis.g.setAttribute('transform', tf);
        s.vis.g.style.filter = blurCss;
        s.vis.draw(Math.max(0, local - 0.15));
      }
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
    if (chap) mapOp = 0;
    else {
      const near = chapters.find((c) => t >= c.start + c.dur && t < c.start + c.dur + 0.5);
      if (near && sc && !sc.vis) mapOp *= prog(t, near.start + near.dur, 0.5);
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
      const s = (0.94 + 0.06 * ease.outBack(a)) * (1 + 0.06 * (pulses.get(n.id) || 0));
      // Camera edge fade: a box the camera has only partly in frame fades out instead of showing cut off.
      const hw = (NODE_W / 2 + 8) * cam.s * s, hh = (n.h / 2 + 8) * cam.s * s;
      const sx = tx + n.x * cam.s, sy = ty + n.y * cam.s, m = base * 0.012;
      // over < 0: distance still inside the frame; it fades over the last 3% before touching the edge.
      const over = Math.max(m - (sx - hw), (sx + hw) - (W - m), m - (sy - hh), (sy + hh) - (H - m));
      const edgeFade = clamp01(-over / (base * 0.03));
      n.g.setAttribute('transform', `translate(${n.x},${n.y}) scale(${s})`);
      n.g.setAttribute('opacity', (op * edgeFade).toFixed(3));
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
      if (e.labelG) {
        const sx = tx + e.mid.x * cam.s, sy = ty + e.mid.y * cam.s, hw = e.labelW / 2 * cam.s, hh = 16 * cam.s, m = base * 0.012;
        const over = Math.max(m - (sx - hw), (sx + hw) - (W - m), m - (sy - hh), (sy + hh) - (H - m));
        e.labelG.setAttribute('opacity', (prog(t, e.drawAt + T.edgeDur * 0.6, 0.3) * lerp(0.4, 1, act) * clamp01(-over / (base * 0.03))).toFixed(3));
      }
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
      capText = sc.caption || "";
      kick = sc.title || '';
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
      // Long captions shrink until the panel fits its box, so no line is ever cut by the frame.
      dom.kicker.style.display = kick ? 'block' : 'none';
      let k = capFit.get(key);
      if (k === undefined) {
        k = 1;
        const fitIn = () => { dom.caption.style.fontSize = `${dom.capSize * k}px`; dom.kicker.style.fontSize = `${dom.kickSize * Math.max(k, 0.8)}px`; };
        fitIn();
        while (k > 0.5 && dom.panel.offsetHeight > dom.capBox.clientHeight + 1) { k *= 0.94; fitIn(); }
        capFit.set(key, k);
      }
      dom.caption.style.fontSize = `${dom.capSize * k}px`;
      dom.kicker.style.fontSize = `${dom.kickSize * Math.max(k, 0.8)}px`;
    }
    dom.capBox.style.opacity = capOp.toFixed(3);
    dom.capBox.style.transform = `translateY(${(1 - capOp) * base * 0.015}px)`;
    dom.panel.style.visibility = capText ? 'visible' : 'hidden';
    dom.kicker.style.display = kick ? 'block' : 'none';

    // Chrome: header, progress, title cards.
    dom.header.style.opacity = (prog(t, T.intro - 0.4, 0.6) * (1 - prog(t, outro.endStart, 0.4))).toFixed(3);
    dom.progress.style.width = `${(clamp01(t / duration) * 100).toFixed(3)}%`;
    const introOp = t < T.intro ? 1 - prog(t, T.intro - 0.7, 0.7) : 0;
    dom.introCard.style.opacity = introOp.toFixed(3);
    dom.introCard.querySelectorAll('.chip').forEach((c, i) => {
      const a = ease.outCubic(prog(t, 0.9 + i * 0.09, 0.5));
      c.style.opacity = a.toFixed(3);
      c.style.transform = `translateY(${(1 - a) * base * 0.02}px)`;
    });
    // Chapter card.
    if (chap) {
      const cp = Math.min(prog(t, chap.start, 0.45), 1 - prog(t, chap.start + chap.dur - 0.4, 0.4));
      if (dom.chapterCard.dataset.n !== String(chap.num)) {
        dom.chapterCard.dataset.n = String(chap.num);
        dom.chapterCard.querySelector('h1').textContent = chap.title;
        dom.chapterCard.querySelector('p').textContent = chap.sub;
      }
      dom.chapterCard.style.display = 'flex';
      dom.chapterCard.style.opacity = cp.toFixed(3);
      dom.chapterCard.style.transform = `scale(${(0.96 + 0.04 * ease.outCubic(prog(t, chap.start, 0.6))).toFixed(4)})`;
    } else dom.chapterCard.style.display = 'none';
    // Journey chip: the followed item and the current step.
    if (dom.journey.style.display !== 'none' || sc) {
      const stepEl = dom.journey.querySelector('.step');
      if (stepEl) {
        const n = sc ? sc.index + 1 : 0;
        const txt = n ? ` · step ${n} of ${scenes.length}` : '';
        if (stepEl.textContent !== txt) stepEl.textContent = txt;
        dom.journey.style.opacity = (prog(t, T.intro - 0.4, 0.6) * (chap ? 0.35 : 1) * (1 - prog(t, outro.start, 0.4))).toFixed(3);
      }
    }
    const rise = (start) => (1 - ease.outCubic(prog(t, start, 0.9))) * base * 0.03;
    dom.introCard.style.transform = `translateY(${rise(0.1)}px)`;
    dom.introCard.style.display = introOp > 0 ? 'flex' : 'none';
    const endOp = prog(t, outro.endStart, 0.6);
    dom.endCard.style.opacity = endOp.toFixed(3);
    dom.endCard.style.display = endOp > 0 ? 'flex' : 'none';
    dom.endCard.style.transform = `translateY(${rise(outro.endStart)}px)`;
    const em = dom.endCard.querySelector('.emblem');
    if (em && endOp > 0) {
      const k = ease.outBack(prog(t, outro.endStart, 0.9));
      em.style.transform = `scale(${(0.4 + 0.6 * k + 0.03 * Math.sin(t * 3)).toFixed(4)}) rotate(${((1 - clamp01(k)) * -60).toFixed(1)}deg)`;
    }
  };
})();
