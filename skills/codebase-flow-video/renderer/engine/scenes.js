/*
 * Scene library: animated "visuals" that show what the code does instead of boxes and arrows.
 *
 *   window.FlowScenes[type].build(g, spec, ctx) -> { dur, draw(lt) }
 *
 * g is an SVG group in screen space, spec is the scene's "visual" object from the storyboard,
 * ctx carries the style, the drawing box and helpers. draw(lt) gets local seconds since the
 * scene started and must be a pure function of lt (frames are rendered out of order).
 */
(() => {
  'use strict';
  const SVGNS = 'http://www.w3.org/2000/svg';
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const prog = (t, s, d) => clamp01((t - s) / d);
  const lerp = (a, b, p) => a + (b - a) * p;
  // ---------- motion system ----------
  // Strong custom curves (emil-design-eng / animate) and Apple-style springs. The spring's bounce is the
  // style's personality: calm (fintech, health, enterprise) never bounces, snappy (consumer, playful) does.
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = (t) => ((ax * t + bx) * t + cx) * t, sy = (t) => ((ay * t + by) * t + cy) * t, dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
    return (x) => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 8; i++) { const e = sx(t) - x, d = dx(t); if (Math.abs(e) < 1e-5 || Math.abs(d) < 1e-6) break; t -= e / d; }
      return sy(Math.max(0, Math.min(1, t)));
    };
  }
  const EASE = { out: bezier(0.23, 1, 0.32, 1), inOut: bezier(0.77, 0, 0.175, 1), drawer: bezier(0.32, 0.72, 0, 1) };
  // Apple-style spring: duration fixed by the caller (progress 0..1), bounce 0..0.3. Damping ratio = 1 - bounce.
  function spring(bounce) {
    const z = Math.max(0.05, 1 - bounce), w0 = 2 * Math.PI;
    if (z >= 1) return (p) => (p <= 0 ? 0 : p >= 1 ? 1 : 1 - Math.exp(-w0 * p) * (1 + w0 * p));
    const wd = w0 * Math.sqrt(1 - z * z);
    return (p) => (p <= 0 ? 0 : p >= 1 ? 1 : 1 - Math.exp(-z * w0 * p) * (Math.cos(wd * p) + ((z * w0) / wd) * Math.sin(wd * p)));
  }
  const PERSONALITY = { calm: { bounce: 0, stagger: 0.09 }, standard: { bounce: 0.15, stagger: 0.07 }, snappy: { bounce: 0.25, stagger: 0.055 } };
  let popCurve = spring(0.15);
  const outCubic = EASE.out;
  const inOut = EASE.inOut;
  const outBack = (p) => popCurve(p);
  window.FlowMotion = { EASE, spring, PERSONALITY, pop: (p) => popCurve(p),
    setPersonality(m) { popCurve = spring((PERSONALITY[m] || PERSONALITY.standard).bounce); } };

  function el(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  // Shared drawing kit bound to one scene's context.
  function kit(ctx) {
    const { style, U } = ctx;
    const C = style.colors;
    const S = (v) => v * U;
    const measure = (s, size, weight, font) => { ctx.measureCtx.font = `${weight} ${size}px ${font || style.font.family}`; return ctx.measureCtx.measureText(s).width; };
    const wrap = (s, size, weight, maxW, font) => {
      const words = String(s).split(/\s+/).filter(Boolean);
      const lines = [];
      let cur = '';
      for (const w of words) {
        const next = cur ? cur + ' ' + w : w;
        if (measure(next, size, weight, font) <= maxW || !cur) cur = next; else { lines.push(cur); cur = w; }
      }
      if (cur) lines.push(cur);
      return lines;
    };
    // Multi-line text. Returns { el, h, w, lines }.
    const text = (g, s, x, y, o = {}) => {
      const size = o.size || S(26), weight = o.weight || 600, lh = (o.lh || 1.25) * size, font = o.font || style.font.family;
      let lines = o.maxW ? wrap(s, size, weight, o.maxW, font) : [String(s)];
      if (o.maxLines && lines.length > o.maxLines) {
        // Cut the last kept line by characters, not words, so a long first word never collapses to a bare "…".
        const rest = lines.slice(o.maxLines - 1).join(' ');
        lines = lines.slice(0, o.maxLines - 1);
        let cut = rest;
        while (cut.length > 1 && measure(cut.replace(/\s+$/, '') + '…', size, weight, font) > o.maxW) cut = cut.slice(0, -1);
        lines.push(cut.replace(/\s+$/, '') + '…');
      }
      const t = el('text', { x, y: y + size * 0.82, fill: o.fill || C.text, 'font-family': font, 'font-size': size, 'font-weight': weight,
        'text-anchor': o.anchor || 'start', 'letter-spacing': o.spacing }, g);
      lines.forEach((l, i) => { const ts = el('tspan', { x, dy: i ? lh : 0 }, t); ts.textContent = l; });
      const w = Math.max(...lines.map((l) => measure(l, size, weight, font)), 0);
      return { el: t, h: lines.length * lh, w, lines };
    };
    const vivid = style.look !== 'flat';
    const light = style.theme === 'light';
    const P = ctx.paint;
    // Cards are glass when the look is vivid: translucent fill, top sheen, light edge. Shadows become soft glows.
    const rect = (g, x, y, w, h, o = {}) => {
      const rx = o.r ?? S(style.radius);
      const fill = o.fill || C.card;
      if (vivid && fill === C.shadow) {
        return el('rect', { x: x + S(6), y: y + S(10), width: w - S(12), height: h - S(6), rx, fill: o.glow || (light ? '#000' : style.accent), opacity: o.glow ? 0.35 : (light ? 0.10 : 0.3), filter: 'url(#softGlow)' }, g);
      }
      const glass = vivid && (fill === C.card || fill === C.pill);
      const r = el('rect', { x, y, width: w, height: h, rx, fill: glass ? fill : (vivid && /^#/.test(fill) && !o.flat ? P.grad(fill) : fill),
        stroke: glass && (!o.stroke || o.stroke === C.border) ? 'url(#glassEdge)' : (o.stroke || 'none'), 'stroke-width': o.sw || S(2), 'stroke-dasharray': o.dash,
        'fill-opacity': o.fo ?? (glass ? (light ? 0.74 : 0.58) : undefined), 'stroke-opacity': o.so }, g);
      if (glass && h > S(24)) el('rect', { x: x + 1, y: y + 1, width: Math.max(0, w - 2), height: Math.max(0, Math.min(h - 2, h * 0.55)), rx, fill: 'url(#glassSheen)', 'pointer-events': 'none' }, g);
      return r;
    };
    // A gradient disc with a white icon and a soft coloured glow: the vivid badge used for actors, tools, outcomes.
    const badge = (g, name, cx, cy, r, color) => {
      const bg = el('g', {}, g);
      if (vivid) el('circle', { cx, cy: cy + r * 0.18, r: r * 1.05, fill: color, opacity: 0.45, filter: 'url(#softGlow)' }, bg);
      el('circle', { cx, cy, r, fill: vivid ? P.grad(color) : color, 'fill-opacity': vivid ? 1 : 0.16 }, bg);
      if (vivid) el('circle', { cx, cy: cy - r * 0.35, r: r * 0.62, fill: '#fff', opacity: 0.16 }, bg);
      icon(bg, name, cx, cy, r * 1.05, vivid ? '#FFFFFF' : color);
      return bg;
    };
    const mark = (node, name) => { node.setAttribute('data-block', String(name || 'block').slice(0, 40)); return node; };
    function icon(g, name, cx, cy, size, color) {
      const s = el('g', { transform: `translate(${cx - size / 2},${cy - size / 2}) scale(${size / 24})`, fill: 'none', stroke: color,
        'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
      s.innerHTML = ctx.icons[name] || ctx.icons.gear;
      return s;
    }
    // A rounded label pill centred at (cx, cy). Returns { g, w, h }.
    const pill = (g, s, cx, cy, o = {}) => {
      const size = o.size || S(20), padX = size * 0.8, maxW = o.maxW || S(360);
      const lines = wrap(s, size, o.weight || 650, maxW - padX * 2).slice(0, o.maxLines || 2);
      const w = Math.min(maxW, Math.max(...lines.map((l) => measure(l, size, o.weight || 650))) + padX * 2 + (o.icon ? size * 1.4 : 0));
      const h = lines.length * size * 1.25 + size * 0.9;
      const pg = el('g', { transform: `translate(${cx},${cy})` }, g);
      const filled = !!o.fill && o.fill !== C.pill;
      el('rect', { x: -w / 2, y: -h / 2, width: w, height: h, rx: Math.min(h / 2, S(22)), fill: filled ? (vivid ? P.grad(o.fill) : o.fill) : C.pill,
        'fill-opacity': filled ? 1 : (vivid ? (light ? 0.86 : 0.78) : 1), stroke: filled && vivid ? 'url(#glassEdge)' : (o.stroke || ctx.style.accent), 'stroke-width': S(2) }, pg);
      if (vivid) el('rect', { x: -w / 2 + 1, y: -h / 2 + 1, width: w - 2, height: h * 0.5, rx: Math.min(h / 2, S(22)), fill: 'url(#glassSheen)' }, pg);
      const tx = o.icon ? -w / 2 + padX + size * 1.4 : -w / 2 + padX;
      if (o.icon) icon(pg, o.icon, -w / 2 + padX + size * 0.55, 0, size * 1.05, o.iconColor || o.stroke || style.accent);
      const t = el('text', { x: tx, y: -h / 2 + size * 0.45 + size * 0.82, fill: o.color || C.text, 'font-family': style.font.family,
        'font-size': size, 'font-weight': o.weight || 650 }, pg);
      lines.forEach((l, i) => { const ts = el('tspan', { x: tx, dy: i ? size * 1.25 : 0 }, t); ts.textContent = l; });
      return { g: pg, w, h };
    };
    const show = (node, op, tf) => {
      node.setAttribute('opacity', clamp01(op).toFixed(3));
      node.setAttribute('display', op > 0.001 ? 'inline' : 'none');
      if (tf !== undefined) node.setAttribute('transform', tf);
    };
    const tone = (t) => (t === 'good' || t === true ? style.good : t === 'bad' || t === false ? style.bad : t === 'warn' ? style.warn : style.accent);
    return { S, C, measure, wrap, text, rect, icon, pill, show, tone, el, badge, mark, vivid, light };
  }

  const pop = (lt, at, d = 0.45) => outBack(prog(lt, at, d));
  const fadeIn = (lt, at, d = 0.35) => prog(lt, at, d);
  // Point on a quadratic curve from a to b bulging by `bend` (pixels, perpendicular).
  function arc(a, b, bend) {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const c = { x: mx - (dy / len) * bend, y: my + (dx / len) * bend };
    return { c, at: (p) => ({ x: (1 - p) * (1 - p) * a.x + 2 * (1 - p) * p * c.x + p * p * b.x, y: (1 - p) * (1 - p) * a.y + 2 * (1 - p) * p * c.y + p * p * b.y }),
      d: `M${a.x},${a.y} Q${c.x},${c.y} ${b.x},${b.y}` };
  }
  const box = (ctx) => ctx.box;
  const landscape = (ctx) => ctx.box.w > ctx.box.h * 1.25;

  const SCENES = {};

  // ---------------------------------------------------------------- agents
  // Agents think, message each other and call tools. An activity log narrates each step.
  SCENES.agents = {
    build(g, spec, ctx) {
      const K = kit(ctx), { S, C } = K, B = box(ctx);
      const agents = spec.agents || [];
      const tools = spec.tools || [];
      const steps = spec.steps || [];
      const showLog = B.w > B.h * 1.6 && spec.log !== false;
      const stage = showLog ? { x: B.x, y: B.y, w: B.w * 0.64, h: B.h } : { ...B };
      const toolRow = tools.length ? S(110) : 0;
      const area = { x: stage.x, y: stage.y, w: stage.w, h: stage.h - toolRow };
      const n = agents.length;
      const R = Math.min(S(n > 4 ? 52 : 64), area.w / (n * 3.2), area.h / 5.2);
      const pos = new Map();
      const cx = area.x + area.w / 2, cy = area.y + area.h / 2 + S(8);
      const tall = area.h > area.w * 1.1;
      // Keep at least ~3 avatar radii between agents so names never collide.
      const rx = Math.max(R * 3.4, Math.min(area.w / 2 - R * 2.4, S(420)));
      const ry = Math.max(R * 3.2, Math.min(area.h / 2 - R * 2.2, tall ? area.h * 0.3 : S(230)));
      // Topology decides the layout: one agent that talks to all the others sits in the middle (hub),
      // otherwise agents stand on an arc in the order they first appear.
      const partners = new Map(agents.map((a) => [a.id, new Set()]));
      steps.forEach((st) => { if (st.to && partners.has(st.to) && partners.has(st.from) && st.to !== st.from) { partners.get(st.from).add(st.to); partners.get(st.to).add(st.from); } });
      const hub = n >= 4 ? agents.find((a) => partners.get(a.id).size === n - 1 && agents.filter((b) => b.id !== a.id).every((b) => partners.get(b.id).size <= 2)) : null;
      const others = hub ? agents.filter((a) => a.id !== hub.id) : agents;
      agents.forEach((a, i) => {
        let x, y;
        if (hub) {
          if (a.id === hub.id) { x = cx; y = cy; }
          else { const k = others.indexOf(a), ang = -Math.PI / 2 + (k / others.length) * Math.PI * 2; x = cx + Math.cos(ang) * rx; y = cy + Math.sin(ang) * ry; }
        } else if (n === 1) { x = cx; y = cy; }
        else if (n === 2) { x = cx + (i ? 1 : -1) * rx * 0.75; y = cy; }
        else { const ang = Math.PI + (i / (n - 1)) * Math.PI; x = cx + Math.cos(ang) * rx; y = cy + Math.sin(ang) * ry * 0.85 + ry * 0.35; }
        pos.set(a.id, { x, y, r: R, color: a.color || (a.kind === 'user' ? ctx.style.kinds.actor : [ctx.style.accent, ctx.style.accent2, ctx.style.kinds.ai, ctx.style.kinds.store, ctx.style.kinds.decision][i % 5]) });
      });
      const tw = Math.min(S(230), (stage.w - S(20) * (tools.length + 1)) / Math.max(1, tools.length));
      // Tools sit just under the agents (not pinned to the bottom of a tall frame).
      const lowest = Math.max(...agents.map((a) => pos.get(a.id).y)) + R + S(n > 1 ? 110 : 90);
      const toolY = Math.min(stage.y + stage.h - toolRow / 2, lowest + S(40));
      tools.forEach((t, i) => {
        const total = tools.length * tw + (tools.length - 1) * S(20);
        const x = stage.x + stage.w / 2 - total / 2 + i * (tw + S(20)) + tw / 2;
        pos.set(t.id, { x, y: toolY, tool: true, w: tw, h: S(64), color: t.color || ctx.style.kinds.external });
      });

      const gLinks = el('g', {}, g), gNodes = el('g', {}, g), gFx = el('g', {}, g), gLog = el('g', {}, g);
      // Agent avatars.
      const nodes = new Map();
      agents.forEach((a) => {
        const p = pos.get(a.id);
        const ng = el('g', {}, gNodes);
        K.mark(ng, a.name);
        const glow = el('circle', { cx: p.x, cy: p.y, r: p.r * 1.45, fill: p.color, 'fill-opacity': 0.18 }, ng);
        const ring = el('circle', { cx: p.x, cy: p.y, r: p.r + S(8), fill: 'none', stroke: p.color, 'stroke-width': S(3) }, ng);
        if (K.vivid) K.badge(ng, a.icon || (a.kind === 'user' ? 'user' : 'robot'), p.x, p.y, p.r, p.color);
        else {
          el('circle', { cx: p.x, cy: p.y, r: p.r, fill: C.card, stroke: p.color, 'stroke-width': S(3) }, ng);
          K.icon(ng, a.icon || (a.kind === 'user' ? 'user' : 'robot'), p.x, p.y, p.r * 0.95, p.color);
        }
        K.text(ng, a.name, p.x, p.y + p.r + S(14), { size: S(24), weight: 700, anchor: 'middle' });
        if (a.role) K.text(ng, a.role, p.x, p.y + p.r + S(44), { size: S(18), weight: 500, fill: C.muted, anchor: 'middle', maxW: S(220), maxLines: 1 });
        nodes.set(a.id, { g: ng, glow, ring, p });
      });
      tools.forEach((t) => {
        const p = pos.get(t.id);
        const ng = K.mark(el('g', {}, gNodes), t.name);
        const card = K.rect(ng, p.x - p.w / 2, p.y - p.h / 2, p.w, p.h, { fill: C.card, stroke: C.border });
        if (K.vivid) K.badge(ng, t.icon || 'gear', p.x - p.w / 2 + S(32), p.y, S(19), p.color);
        else K.icon(ng, t.icon || 'gear', p.x - p.w / 2 + S(32), p.y, S(28), p.color);
        K.text(ng, t.name, p.x - p.w / 2 + S(56), p.y - S(13), { size: S(20), weight: 650, maxW: p.w - S(66), maxLines: 1 });
        const spin = el('g', {}, ng);
        el('circle', { cx: p.x + p.w / 2 - S(22), cy: p.y, r: S(10), fill: 'none', stroke: p.color, 'stroke-width': S(3), 'stroke-dasharray': `${S(22)} ${S(60)}` }, spin);
        const done = K.icon(ng, 'check', p.x + p.w / 2 - S(22), p.y, S(22), ctx.style.good);
        nodes.set(t.id, { g: ng, card, spin, done, p });
      });

      // Steps.
      const T0 = 0.7;
      const slot = (s) => (s.type === 'think' ? 1.5 : s.type === 'tool' ? 2.0 : 1.7) * ctx.motion;
      let t = T0;
      const items = steps.map((s) => {
        const it = { s, start: t, dur: slot(s) };
        t += it.dur;
        const a = pos.get(s.from), b = s.to ? pos.get(s.to) : null;
        const color = a ? a.color : ctx.style.accent;
        if ((s.type === 'think' || !b) && a) {
          const bx = a.x, by = a.y - a.r - S(70);
          it.bubble = K.pill(gFx, s.text || '…', bx, by, { stroke: color, size: S(19), maxW: S(320), icon: 'sparkles' });
          it.dots = el('g', {}, gFx);
          [0, 1, 2].forEach((k) => el('circle', { cx: bx + (k - 1) * S(16), cy: by, r: S(5), fill: color }, it.dots));
        } else if (a && b) {
          const from = { x: a.x, y: a.y }, to = { x: b.x, y: b.y };
          const path = arc(from, to, (b.tool ? 0.12 : 0.22) * Math.hypot(to.x - from.x, to.y - from.y) * (s.from < (s.to || '') ? 1 : -1));
          it.path = path;
          it.line = el('path', { d: path.d, fill: 'none', stroke: color, 'stroke-width': S(3), 'stroke-dasharray': s.type === 'tool' ? `${S(8)} ${S(8)}` : 'none',
            'stroke-linecap': 'round', opacity: 0 }, gLinks);
          it.len = it.line.getTotalLength();
          it.msg = K.pill(gFx, s.text || '', 0, 0, { stroke: color, size: S(18), maxW: S(300), icon: s.type === 'tool' ? 'bolt' : s.type === 'result' ? 'check' : 'message' });
          it.color = color;
        }
        return it;
      });

      // Activity log (landscape only).
      const logEntries = [];
      if (showLog) {
        const lx = B.x + B.w * 0.67, ly = B.y + S(10), lw = B.w * 0.33, lh = B.h - S(20);
        K.rect(gLog, lx, ly, lw, lh, { fill: C.card, stroke: C.border });
        K.text(gLog, spec.logTitle || 'Activity', lx + S(24), ly + S(20), { size: S(20), weight: 750, fill: C.text });
        const rowH = S(78);
        items.forEach((it, i) => {
          const rg = el('g', {}, gLog);
          const who = agents.find((a) => a.id === it.s.from)?.name || it.s.from;
          const to = it.s.to ? (agents.find((a) => a.id === it.s.to) || tools.find((x) => x.id === it.s.to))?.name : null;
          const ic = { think: 'sparkles', tool: 'bolt', result: 'check', handoff: 'send' }[it.s.type] || 'message';
          K.icon(rg, ic, lx + S(40), S(26), S(24), pos.get(it.s.from)?.color || ctx.style.accent);
          K.text(rg, to ? `${who} → ${to}` : who, lx + S(66), S(8), { size: S(17), weight: 750, maxW: lw - S(84), maxLines: 1 });
          K.text(rg, it.s.text || '', lx + S(66), S(34), { size: S(16), weight: 500, fill: C.muted, maxW: lw - S(84), maxLines: 1 });
          logEntries.push({ g: rg, i, top: ly + S(60), rowH, maxRows: Math.floor((lh - S(70)) / rowH) });
        });
      }

      const dur = t + 0.6;
      return {
        dur,
        draw(lt) {
          // Avatars and tools pop in, staggered.
          [...nodes.values()].forEach((nd, i) => {
            const a = pop(lt, 0.05 + i * 0.08);
            const p = nd.p;
            K.show(nd.g, clamp01(a * 1.5), `translate(${p.x},${p.y}) scale(${0.94 + 0.06 * a}) translate(${-p.x},${-p.y + (1 - clamp01(a)) * -S(18)})`);
          });
          // Which participants are active right now?
          const active = new Set();
          items.forEach((it) => { if (lt >= it.start && lt < it.start + it.dur) { active.add(it.s.from); if (it.s.to) active.add(it.s.to); } });
          nodes.forEach((nd, id) => {
            const on = active.has(id) ? 1 : 0;
            if (nd.ring) nd.ring.setAttribute('stroke-opacity', (on * (0.6 + 0.4 * Math.sin(lt * 6))).toFixed(3));
            if (nd.glow) nd.glow.setAttribute('fill-opacity', (0.08 + on * 0.22).toFixed(3));
          });
          tools.forEach((tl) => {
            const nd = nodes.get(tl.id);
            const it = items.find((x) => x.s.to === tl.id && lt >= x.start && lt < x.start + x.dur + 0.6);
            const working = it && lt < it.start + it.dur * 0.75;
            nd.card.setAttribute('stroke', it ? nd.p.color : C.border);
            K.show(nd.spin, working ? 1 : 0, `rotate(${(lt * 360) % 360} ${nd.p.x + nd.p.w / 2 - S(22)} ${nd.p.y})`);
            K.show(nd.done, it && !working ? 1 : 0);
          });
          items.forEach((it) => {
            const k = prog(lt, it.start, it.dur);
            const vis = lt >= it.start - 0.05 && lt < it.start + it.dur + 0.25;
            if (it.bubble) {
              const op = vis ? fadeIn(lt, it.start, 0.25) * (1 - prog(lt, it.start + it.dur - 0.05, 0.3)) : 0;
              const typing = k < 0.4;
              K.show(it.dots, typing ? op : 0);
              it.dots.childNodes.forEach((c, j) => c.setAttribute('opacity', (0.35 + 0.65 * Math.abs(Math.sin(lt * 5 - j * 0.6))).toFixed(3)));
              K.show(it.bubble.g, typing ? 0 : op);
            }
            if (it.line) {
              const draw = outCubic(prog(lt, it.start, it.dur * 0.35));
              it.line.setAttribute('opacity', (lt >= it.start ? 0.85 * (1 - prog(lt, it.start + it.dur, 0.5)) + 0.15 * (lt >= it.start + it.dur ? 1 : 0) : 0).toFixed(3));
              it.line.style.strokeDasharray = it.s.type === 'tool' ? `${S(8)} ${S(8)}` : `${it.len} ${it.len}`;
              if (it.s.type !== 'tool') it.line.style.strokeDashoffset = it.len * (1 - draw);
              const mk = inOut(prog(lt, it.start + it.dur * 0.15, it.dur * 0.6));
              const q = it.path.at(mk);
              const op = vis ? fadeIn(lt, it.start + it.dur * 0.1, 0.2) * (1 - prog(lt, it.start + it.dur - 0.1, 0.3)) : 0;
              K.show(it.msg.g, op, `translate(${q.x},${q.y - S(4)})`);
            }
          });
          logEntries.forEach((e) => {
            const it = items[e.i];
            const shown = lt >= it.start;
            const firstVisible = Math.max(0, items.filter((x) => lt >= x.start).length - e.maxRows);
            const row = e.i - firstVisible;
            const op = shown && row >= 0 ? fadeIn(lt, it.start, 0.3) * (lt < it.start + it.dur ? 1 : 0.55) : 0;
            K.show(e.g, op, `translate(0,${e.top + row * e.rowH + (1 - fadeIn(lt, it.start, 0.3)) * S(14)})`);
          });
        },
      };
    },
  };

  // ---------------------------------------------------------------- chat
  // A chat window: user asks, assistant types and streams its answer, optional sources.
  SCENES.chat = {
    build(g, spec, ctx) {
      const K = kit(ctx), { S, C } = K, B = box(ctx);
      const ww = landscape(ctx) ? Math.min(B.w * 0.62, S(980)) : B.w * 0.96;
      let wh = B.h * 0.98;
      let wx = B.x + B.w / 2 - ww / 2, wy = B.y;
      const frameG = el('g', {}, g);
      const headH = S(72);
      el('line', { x1: wx, y1: wy + headH, x2: wx + ww, y2: wy + headH, stroke: C.border, 'stroke-width': S(2) }, g);
      el('circle', { cx: wx + S(40), cy: wy + headH / 2, r: S(20), fill: ctx.style.accent, 'fill-opacity': 0.18 }, g);
      K.icon(g, spec.botIcon || 'sparkles', wx + S(40), wy + headH / 2, S(22), ctx.style.accent);
      K.text(g, spec.title || 'Assistant', wx + S(72), wy + headH / 2 - S(14), { size: S(22), weight: 750 });
      el('circle', { cx: wx + ww - S(36), cy: wy + headH / 2, r: S(7), fill: ctx.style.good }, g);

      const clip = el('clipPath', { id: `chatclip${ctx.uid}` }, g);
      el('rect', { x: wx, y: wy + headH, width: ww, height: wh - headH, rx: S(ctx.style.radius) }, clip);
      const body = el('g', { 'clip-path': `url(#chatclip${ctx.uid})` }, g);
      const content = el('g', {}, body);
      const padX = S(28), bubbleMax = ww * 0.74;
      let y = wy + headH + S(24), t = 0.5;
      const msgs = (spec.messages || []).map((m) => {
        const role = /^(user|customer|human|you)$/i.test(m.from || '') ? 'user' : /^(system|tool|event)$/i.test(m.from || '') ? 'system' : 'bot';
        const mg = K.mark(el('g', {}, content), (m.text || '').slice(0, 24));
        const size = S(role === 'system' ? 17 : 21);
        const lines = K.wrap(m.text, size, 550, bubbleMax - S(40));
        const words = m.text.split(/\s+/).filter(Boolean).length;
        let h, x, w;
        if (role === 'system') {
          const pw = Math.min(ww * 0.8, K.measure(m.text, size, 600) + S(56));
          h = S(40); w = pw; x = wx + ww / 2 - pw / 2;
          K.rect(mg, x, y, w, h, { r: h / 2, fill: C.pill, stroke: C.border });
          K.icon(mg, m.icon || 'search', x + S(24), y + h / 2, S(18), C.muted);
          K.text(mg, m.text, x + S(42), y + h / 2 - size * 0.62, { size, weight: 600, fill: C.muted, maxW: w - S(50), maxLines: 1 });
        } else {
          w = Math.min(bubbleMax, Math.max(...lines.map((l) => K.measure(l, size, 550))) + S(40));
          h = lines.length * size * 1.32 + S(28);
          x = role === 'user' ? wx + ww - padX - w : wx + padX + S(48);
          if (role === 'bot') {
            if (K.vivid) K.badge(mg, spec.botIcon || 'sparkles', wx + padX + S(18), y + S(20), S(17), ctx.style.accent);
            else { el('circle', { cx: wx + padX + S(18), cy: y + S(20), r: S(18), fill: ctx.style.accent, 'fill-opacity': 0.18 }, mg); K.icon(mg, spec.botIcon || 'sparkles', wx + padX + S(18), y + S(20), S(18), ctx.style.accent); }
          }
          K.rect(mg, x, y, w, h, { r: S(20), fill: role === 'user' ? ctx.style.accent : C.pill, stroke: role === 'user' ? 'none' : C.border });
          const tx = el('text', { x: x + S(20), y: y + S(14) + size * 0.85, 'font-family': ctx.style.font.family, 'font-size': size, 'font-weight': 550,
            fill: role === 'user' ? '#fff' : C.text }, mg);
          lines.forEach((l, i) => { const ts = el('tspan', { x: x + S(20), dy: i ? size * 1.32 : 0 }, tx); ts.textContent = l; });
          m._tspans = [...tx.childNodes];
          m._lines = lines;
        }
        const typing = role === 'bot' ? 0.9 * ctx.motion : 0;
        const stream = role === 'bot' ? Math.max(0.6, words / 11) : 0;
        const entry = { m, role, g: mg, y, h, start: t, typing, stream, words };
        if (role === 'bot') {
          entry.dots = el('g', {}, content);
          K.rect(entry.dots, wx + padX + S(48), y, S(90), S(44), { r: S(22), fill: C.pill, stroke: C.border });
          [0, 1, 2].forEach((k) => el('circle', { cx: wx + padX + S(72) + k * S(21), cy: y + S(22), r: S(5.5), fill: C.muted }, entry.dots));
        }
        y += h + S(16);
        if (m.sources?.length) {
          let sx = wx + padX + S(48);
          entry.chips = m.sources.slice(0, 4).map((src, k) => {
            const cw = Math.min(S(260), K.measure(src, S(16), 650) + S(52));
            if (sx + cw > wx + ww - padX) { sx = wx + padX + S(48); y += S(46); }
            const cg = el('g', {}, content);
            K.rect(cg, sx, y, cw, S(36), { r: S(18), fill: C.card, stroke: ctx.style.accent2 || ctx.style.accent });
            K.icon(cg, 'file', sx + S(20), y + S(18), S(16), ctx.style.accent2 || ctx.style.accent);
            K.text(cg, src, sx + S(36), y + S(7), { size: S(16), weight: 650, maxW: cw - S(44), maxLines: 1 });
            sx += cw + S(10);
            return { g: cg, k };
          });
          y += S(52);
        }
        t += (role === 'system' ? 0.9 : role === 'user' ? 1.1 : typing + stream + 0.5) * ctx.motion;
        entry.end = t;
        entry.bottom = y;
        return entry;
      });
      // Size the window to the conversation (up to the full box), centred vertically, then draw its frame behind.
      wh = Math.min(B.h * 0.98, Math.max(S(380), y - wy + S(20)));
      const shift = 0; // the engine centres the scene using bounds()
      K.rect(frameG, wx, wy + S(10), ww, wh, { fill: C.shadow });
      K.rect(frameG, wx, wy, ww, wh, { fill: C.card, stroke: C.border });
      clip.firstChild.setAttribute('height', wh - headH);
      const viewBottom = wy + wh - S(20);
      const dur = t + 0.6;
      return {
        dur,
        bounds: () => ({ x: wx, y: wy + shift, w: ww, h: wh + S(10) }),
        draw(lt) {
          let bottom = wy + headH;
          msgs.forEach((e) => {
            const appearAt = e.start + e.typing;
            const vis = lt >= e.start;
            if (vis) bottom = Math.max(bottom, e.role === 'bot' && lt < appearAt ? e.y + S(60) : e.bottom);
            if (e.dots) K.show(e.dots, lt >= e.start && lt < appearAt ? 1 : 0);
            const a = pop(lt, appearAt, 0.4);
            K.show(e.g, lt >= appearAt ? clamp01(a * 1.6) : 0, `translate(0,${(1 - clamp01(a)) * S(18)})`);
            if (e.m._tspans && e.role === 'bot') {
              const shownWords = Math.floor(e.words * prog(lt, appearAt, e.stream));
              let used = 0;
              e.m._tspans.forEach((ts, i) => {
                const ws = e.m._lines[i].split(' ');
                const take = Math.max(0, Math.min(ws.length, shownWords - used));
                ts.textContent = ws.slice(0, take).join(' ');
                used += ws.length;
              });
              // An empty <text> reports a bogus box at the origin; hide it until the first word streams in.
              e.m._tspans[0].parentNode.setAttribute('display', shownWords > 0 ? 'inline' : 'none');
            }
            (e.chips || []).forEach((c) => {
              const at = appearAt + e.stream + 0.1 + c.k * 0.15;
              const ca = pop(lt, at, 0.35);
              K.show(c.g, lt >= at ? clamp01(ca * 1.6) : 0);
            });
          });
          const scroll = Math.max(0, bottom - viewBottom);
          content.setAttribute('transform', `translate(0,${-scroll})`);
        },
      };
    },
  };

  // ---------------------------------------------------------------- request
  // A request travels from a client to the server, which runs its checks, saves, and answers.
  SCENES.request = {
    build(g, spec, ctx) {
      const K = kit(ctx), { S, C } = K, B = box(ctx), L = landscape(ctx);
      const cols = [spec.client || { label: 'Customer', icon: 'user' }, spec.server || { label: 'Server', icon: 'server' }];
      if (spec.store) cols.push(spec.store);
      const checks = spec.checks || [];
      // The server card holds the story (its checks), so it gets the width; side cards stay compact.
      const serverW = L ? Math.min(S(520), B.w * 0.46) : B.w * 0.84;
      const sideW = L ? Math.min(S(240), B.w * 0.19) : B.w * 0.5;
      const rowH = S(52);
      const serverH = S(96) + checks.length * rowH + S(16);
      const sideH = S(150);
      const centers = [];
      if (L) {
        const gap = (B.w - serverW - sideW * (cols.length - 1)) / cols.length;
        let x = B.x + gap / 2;
        cols.forEach((c, i) => { const w = i === 1 ? serverW : sideW; centers.push({ x: x + w / 2, y: B.y + B.h / 2, w, h: i === 1 ? serverH : sideH }); x += w + gap; });
      } else {
        const total = sideH * (cols.length - 1) + serverH;
        const gap = (B.h - total) / (cols.length + 0.5);
        let y = B.y + gap;
        cols.forEach((c, i) => { const h = i === 1 ? serverH : sideH; centers.push({ x: B.x + B.w / 2, y: y + h / 2, w: i === 1 ? serverW : sideW, h }); y += h + gap; });
      }
      const gCards = el('g', {}, g), gFx = el('g', {}, g);
      const cards = cols.map((c, i) => {
        const p = centers[i];
        const cg = K.mark(el('g', {}, gCards), c.label);
        const color = c.color || (i === 0 ? ctx.style.kinds.actor : i === 1 ? ctx.style.accent : ctx.style.kinds.store);
        K.rect(cg, p.x - p.w / 2, p.y - p.h / 2 + S(8), p.w, p.h, { fill: C.shadow });
        const frame = K.rect(cg, p.x - p.w / 2, p.y - p.h / 2, p.w, p.h, { fill: C.card, stroke: C.border });
        if (i === 1) {
          K.icon(cg, c.icon || 'server', p.x - p.w / 2 + S(38), p.y - p.h / 2 + S(44), S(30), color);
          K.text(cg, c.label, p.x - p.w / 2 + S(66), p.y - p.h / 2 + S(28), { size: S(23), weight: 750, maxW: p.w - S(80), maxLines: 1 });
        } else {
          if (K.vivid) K.badge(cg, c.icon || (i === 0 ? 'user' : 'database'), p.x, p.y - S(22), S(30), color);
          else { el('circle', { cx: p.x, cy: p.y - S(22), r: S(34), fill: color, 'fill-opacity': 0.16 }, cg); K.icon(cg, c.icon || (i === 0 ? 'user' : 'database'), p.x, p.y - S(22), S(34), color); }
          K.text(cg, c.label, p.x, p.y + S(22), { size: S(21), weight: 700, anchor: 'middle', maxW: p.w - S(20), maxLines: 2 });
        }
        return { g: cg, frame, p, color };
      });
      const sp = centers[1];
      const rows = checks.map((ck, k) => {
        const ry = sp.y - sp.h / 2 + S(88) + k * rowH;
        const rg = el('g', {}, gCards);
        const ok = ck.ok !== false;
        const pend = el('circle', { cx: sp.x - sp.w / 2 + S(38), cy: ry + rowH / 2, r: S(11), fill: 'none', stroke: C.muted, 'stroke-width': S(2.5) }, rg);
        const mark = K.icon(rg, ok ? 'check' : 'x', sp.x - sp.w / 2 + S(38), ry + rowH / 2, S(24), K.tone(ok));
        const fit = K.wrap(ck.label, S(19), 600, sp.w - S(84)).length > 1;
        const label = K.text(rg, ck.label, sp.x - sp.w / 2 + S(64), ry + rowH / 2 - (fit ? S(23) : S(12)), { size: S(fit ? 17 : 19), weight: 600, maxW: sp.w - S(84), maxLines: 2, lh: 1.15 });
        return { rg, pend, mark, label, ok };
      });
      const failAt = rows.findIndex((r) => !r.ok);
      const lastCheck = failAt >= 0 ? failAt : rows.length - 1;
      const edge = (a, b) => (L ? [{ x: a.p.x + a.p.w / 2, y: a.p.y }, { x: b.p.x - b.p.w / 2, y: b.p.y }] : [{ x: a.p.x, y: a.p.y + a.p.h / 2 }, { x: b.p.x, y: b.p.y - b.p.h / 2 }]);
      const lines = [];
      for (let i = 0; i < cards.length - 1; i++) {
        const [a, b] = edge(cards[i], cards[i + 1]);
        lines.push(el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: C.edge, 'stroke-width': S(3), 'stroke-dasharray': `${S(6)} ${S(8)}` }, gCards));
      }
      const mv = ctx.motion;
      const tl = { req: 0.7, checks: 0.7 + 1.0 * mv };
      const checkGap = 0.55 * mv;
      tl.save = tl.checks + (lastCheck + 1) * checkGap + 0.1;
      const willSave = spec.store && failAt < 0;
      tl.resp = willSave ? tl.save + 1.9 * mv : tl.save + 0.1;
      const dur = tl.resp + 1.3 * mv + 0.4;
      const reqPill = K.pill(gFx, spec.request || 'Request', 0, 0, { stroke: cards[0].color, icon: 'send', size: S(19), maxW: S(280) });
      const savePill = willSave ? K.pill(gFx, spec.save || 'Saved', 0, 0, { stroke: cards[2].color, icon: 'database', size: S(18), maxW: S(240) }) : null;
      const resp = spec.response || { label: failAt >= 0 ? 'Rejected' : 'Done', ok: failAt < 0 };
      const respPill = K.pill(gFx, resp.label, 0, 0, { stroke: K.tone(resp.ok !== false), icon: resp.ok === false ? 'x' : 'check', size: S(19), maxW: S(300) });
      const travel = (pillObj, a, b, start, d, lt) => {
        const k = inOut(prog(lt, start, d));
        const op = lt >= start && lt <= start + d + 0.15 ? Math.min(fadeIn(lt, start, 0.15), 1 - prog(lt, start + d, 0.15)) : 0;
        K.show(pillObj.g, op, `translate(${lerp(a.x, b.x, k)},${lerp(a.y, b.y, k) - (L ? S(34) : 0)}) `);
      };
      return {
        dur,
        draw(lt) {
          cards.forEach((c, i) => {
            const a = pop(lt, 0.05 + i * 0.12);
            K.show(c.g, clamp01(a * 1.6), `translate(${c.p.x},${c.p.y}) scale(${0.95 + 0.05 * a}) translate(${-c.p.x},${-c.p.y + (1 - clamp01(a)) * -S(18)})`);
          });
          lines.forEach((ln, i) => ln.setAttribute('opacity', fadeIn(lt, 0.3 + i * 0.1).toFixed(3)));
          const [c0, c1] = edge(cards[0], cards[1]);
          travel(reqPill, c0, c1, tl.req, 0.9 * mv, lt);
          cards[1].frame.setAttribute('stroke', lt >= tl.checks - 0.1 && lt < tl.resp + 0.3 ? cards[1].color : C.border);
          rows.forEach((r, k) => {
            const at = tl.checks + k * checkGap;
            const reached = k <= lastCheck && lt >= at;
            r.pend.setAttribute('opacity', reached ? 0 : (k > lastCheck ? 0.35 : 1));
            K.show(r.mark, reached ? pop(lt, at, 0.3) : 0);
            r.label.el.setAttribute('opacity', k > lastCheck ? 0.4 : 1);
          });
          if (willSave) {
            const [s0, s1] = edge(cards[1], cards[2]);
            travel(savePill, s0, s1, tl.save, 0.85 * mv, lt);
            cards[2].frame.setAttribute('stroke', lt >= tl.save + 0.8 * mv && lt < tl.save + 1.6 * mv ? cards[2].color : C.border);
          }
          travel(respPill, c1, c0, tl.resp, 1.0 * mv, lt);
          if (lt > tl.resp + 1.0 * mv) K.show(respPill.g, 1, `translate(${cards[0].p.x},${cards[0].p.y + (L ? cards[0].p.h / 2 + S(40) : -cards[0].p.h / 2 - S(36))})`);
        },
      };
    },
  };

  // ---------------------------------------------------------------- pipeline
  // One record travels through stages; each stage adds, changes, removes or checks a field.
  SCENES.pipeline = {
    build(g, spec, ctx) {
      const K = kit(ctx), { S, C } = K, B = box(ctx), L = landscape(ctx);
      const stages = spec.stages || [];
      const n = stages.length + (spec.output ? 1 : 0);
      const gLine = el('g', {}, g), gSt = el('g', {}, g), gCard = el('g', {}, g);
      const stPos = [];
      const cardW = L ? Math.min(S(380), B.w * 0.32) : Math.min(S(420), B.w * 0.58);
      if (L) {
        const y = B.y + B.h * 0.8;
        const gap = B.w / n;
        for (let i = 0; i < n; i++) stPos.push({ x: B.x + gap * (i + 0.5), y });
      } else {
        const x = B.x + S(70);
        const gap = B.h / n;
        for (let i = 0; i < n; i++) stPos.push({ x, y: B.y + gap * (i + 0.5) });
      }
      el('path', { d: `M${stPos[0].x},${stPos[0].y} L${stPos[n - 1].x},${stPos[n - 1].y}`, stroke: C.edge, 'stroke-width': S(4), 'stroke-linecap': 'round' }, gLine);
      const prog_ = el('path', { d: `M${stPos[0].x},${stPos[0].y} L${stPos[n - 1].x},${stPos[n - 1].y}`, stroke: ctx.style.accent, 'stroke-width': S(5), 'stroke-linecap': 'round' }, gLine);
      const totalLen = Math.hypot(stPos[n - 1].x - stPos[0].x, stPos[n - 1].y - stPos[0].y);
      const all = [...stages, ...(spec.output ? [{ ...spec.output, effect: 'output' }] : [])];
      const stG = all.map((st, i) => {
        const p = stPos[i];
        const sg = K.mark(el('g', {}, gSt), st.label);
        const color = st.effect === 'output' ? ctx.style.good : st.color || ctx.style.accent;
        const disc = el('circle', { cx: p.x, cy: p.y, r: S(34), fill: C.card, 'fill-opacity': K.vivid ? 0.7 : 1, stroke: C.border, 'stroke-width': S(3) }, sg);
        K.icon(sg, st.icon || ({ add: 'sparkles', change: 'refresh', remove: 'filter', check: 'shield', filter: 'filter', output: 'check' }[st.effect] || 'gear'), p.x, p.y, S(30), color);
        if (L) K.text(sg, st.label, p.x, p.y + S(46), { size: S(19), weight: 700, anchor: 'middle', maxW: B.w / n - S(16), maxLines: 2 });
        else K.text(sg, st.label, p.x + S(50), p.y - S(12), { size: S(19), weight: 700, maxW: B.w - cardW - S(140), maxLines: 2 });
        return { sg, disc, p, color };
      });

      // The record card. Field rows are laid out per stage state.
      const fields = (spec.item?.fields || []).map(([k, v]) => ({ k, v, state: 'base' }));
      const rowH = S(40), headH = S(58);
      const rowsMax = fields.length + all.filter((s) => s.effect === 'add').length;
      const cardH = headH + rowsMax * rowH + S(18);
      const card = K.mark(el('g', {}, gCard), spec.item?.title || 'record');
      K.rect(card, 0, S(8), cardW, cardH, { fill: C.shadow });
      const cardRect = K.rect(card, 0, 0, cardW, cardH, { fill: C.card, stroke: ctx.style.accent });
      K.icon(card, spec.item?.icon || 'file', S(30), headH / 2, S(24), ctx.style.accent);
      K.text(card, spec.item?.title || 'Record', S(54), headH / 2 - S(13), { size: S(21), weight: 750, maxW: cardW - S(70), maxLines: 1 });
      el('line', { x1: 0, y1: headH, x2: cardW, y2: headH, stroke: C.border, 'stroke-width': S(2) }, card);
      // Every row that ever exists, with when it appears/changes/disappears.
      const rowDefs = fields.map((f) => ({ k: f.k, v: f.v, born: -1 }));
      const T0 = 0.8, per = 1.5 * ctx.motion;
      all.forEach((st, i) => {
        const at = T0 + i * per + per * 0.55;
        if (st.effect === 'add' && st.field) rowDefs.push({ k: st.field, v: st.value ?? '', born: at });
        else if ((st.effect === 'change') && st.field) { const r = rowDefs.find((x) => x.k === st.field); if (r) { r.changeAt = at; r.v2 = st.value ?? ''; } }
        else if (st.effect === 'remove' && st.field) { const r = rowDefs.find((x) => x.k === st.field); if (r) r.diesAt = at; }
        else if (st.effect === 'check') st._checkAt = at;
      });
      const rows = rowDefs.map((r) => {
        const rg = el('g', {}, card);
        const hl = K.rect(rg, S(8), -S(4), cardW - S(16), rowH - S(4), { r: S(8), fill: ctx.style.accent, fo: 0.16 });
        K.text(rg, r.k, S(22), S(4), { size: S(17), weight: 550, fill: C.muted, maxW: cardW * 0.42, maxLines: 1 });
        const v1 = K.text(rg, String(r.v), cardW * 0.46, S(4), { size: S(18), weight: 700, maxW: cardW * 0.5, maxLines: 1 });
        const v2 = r.v2 !== undefined ? K.text(rg, String(r.v2), cardW * 0.46, S(4), { size: S(18), weight: 700, fill: ctx.style.accent, maxW: cardW * 0.5, maxLines: 1 }) : null;
        const strike = el('line', { x1: S(18), y1: rowH / 2 - S(4), x2: cardW - S(18), y2: rowH / 2 - S(4), stroke: ctx.style.bad, 'stroke-width': S(2.5) }, rg);
        return { ...r, rg, hl, v1, v2, strike };
      });
      const badges = all.map((st) => (st.effect === 'check' ? K.pill(card, st.badge || 'Checked', cardW - S(80), -S(4), { stroke: ctx.style.good, icon: 'check', size: S(15), maxW: S(200) }) : null));
      const dur = T0 + all.length * per + 0.6;
      const cardAt = (i) => {
        const p = stPos[Math.max(0, Math.min(n - 1, i))];
        return L ? { x: p.x - cardW / 2, y: B.y + Math.max(S(10), (B.h * 0.8 - S(60) - cardH) / 2) } : { x: B.x + B.w - cardW - S(10), y: Math.min(Math.max(B.y, p.y - cardH / 2), B.y + B.h - cardH) };
      };
      return {
        dur,
        draw(lt) {
          stG.forEach((s, i) => {
            const a = pop(lt, 0.05 + i * 0.07);
            K.show(s.sg, clamp01(a * 1.5));
            const here = lt >= T0 + i * per && lt < T0 + (i + 1) * per;
            const passed = lt >= T0 + i * per + per * 0.5;
            s.disc.setAttribute('stroke', here || passed ? s.color : C.border);
            s.disc.setAttribute('fill', here ? s.color : C.card);
            s.disc.setAttribute('fill-opacity', here ? 0.18 : 1);
          });
          const seg = (lt - T0) / per;
          const i0 = Math.floor(seg), f = inOut(clamp01((seg - i0) / 0.45));
          const a = cardAt(i0), prev = cardAt(Math.max(0, i0 - 1));
          const pos = seg < 0 ? cardAt(0) : { x: lerp(prev.x, a.x, i0 <= 0 ? 1 : f), y: lerp(prev.y, a.y, i0 <= 0 ? 1 : f) };
          const ca = pop(lt, 0.3, 0.5);
          K.show(card, clamp01(ca * 1.6), `translate(${pos.x},${pos.y})`);
          const pr = clamp01((lt - T0) / (per * (n - 1)));
          prog_.style.strokeDasharray = `${totalLen} ${totalLen}`;
          prog_.style.strokeDashoffset = totalLen * (1 - pr);
          let y = headH + S(12);
          rows.forEach((r) => {
            const born = r.born < 0 ? 1 : prog(lt, r.born, 0.4);
            const dying = r.diesAt ? prog(lt, r.diesAt + 0.5, 0.4) : 0;
            const live = born * (1 - dying);
            if (live <= 0.001) { K.show(r.rg, 0); return; }
            K.show(r.rg, live, `translate(0,${y})`);
            y += rowH * live;
            const flash = Math.max(r.born > 0 ? 1 - prog(lt, r.born + 0.4, 0.8) : 0, r.changeAt ? (lt >= r.changeAt ? 1 - prog(lt, r.changeAt + 0.4, 0.8) : 0) : 0);
            r.hl.setAttribute('fill-opacity', (0.22 * flash).toFixed(3));
            if (r.v2) { const c = prog(lt, r.changeAt, 0.35); r.v1.el.setAttribute('opacity', (1 - c).toFixed(3)); r.v2.el.setAttribute('opacity', c.toFixed(3)); }
            r.strike.setAttribute('opacity', r.diesAt ? prog(lt, r.diesAt, 0.3).toFixed(3) : 0);
          });
          badges.forEach((bd, i) => { if (bd) K.show(bd.g, prog(lt, all[i]._checkAt, 0.3), `translate(${cardW - S(80) - bd.w / 4},${-S(4)})`); });
          cardRect.setAttribute('stroke', lt > T0 + (n - 1) * per + per * 0.5 && spec.output ? ctx.style.good : ctx.style.accent);
        },
      };
    },
  };

  // ---------------------------------------------------------------- decision
  // An item reaches a question and goes one of several ways.
  SCENES.decision = {
    build(g, spec, ctx) {
      const K = kit(ctx), { S, C } = K, B = box(ctx), L = landscape(ctx);
      const opts = spec.options || [];
      const n = opts.length;
      const gate = { x: B.x + B.w / 2, y: B.y + B.h * (L ? 0.3 : 0.24) };
      const gw = Math.min(S(520), B.w * 0.7), gh = S(96);
      const gLines = el('g', {}, g), gGate = el('g', {}, g), gOpts = el('g', {}, g), gFx = el('g', {}, g);
      K.mark(gGate, 'question');
      K.rect(gGate, gate.x - gw / 2, gate.y - gh / 2 + S(8), gw, gh, { fill: C.shadow });
      const gateRect = K.rect(gGate, gate.x - gw / 2, gate.y - gh / 2, gw, gh, { fill: C.card, stroke: ctx.style.kinds.decision, sw: S(3) });
      el('rect', { x: gate.x - gw / 2 + S(24), y: gate.y - S(16), width: S(32), height: S(32), rx: S(5), fill: ctx.style.kinds.decision, 'fill-opacity': 0.25,
        transform: `rotate(45 ${gate.x - gw / 2 + S(40)} ${gate.y})` }, gGate);
      K.icon(gGate, 'branch', gate.x - gw / 2 + S(40), gate.y, S(22), ctx.style.kinds.decision);
      K.text(gGate, spec.question || 'Which way?', gate.x - gw / 2 + S(76), gate.y - S(16), { size: S(24), weight: 750, maxW: gw - S(96), maxLines: 2 });
      const cols = L ? n : Math.min(n, 2), nrows = Math.ceil(n / cols);
      const ow = Math.min(S(340), (B.w - S(32) * (cols - 1)) / cols);
      const oh = S(110);
      const rowY = (r) => (L ? B.y + B.h * 0.8 : B.y + B.h * 0.62 + r * (oh + S(70)));
      const optPos = opts.map((o, i) => {
        const r = Math.floor(i / cols), c = i % cols, inRow = Math.min(cols, n - r * cols);
        return { x: B.x + B.w / 2 + (c - (inRow - 1) / 2) * (ow + S(32)), y: rowY(r) };
      });
      const optG = opts.map((o, i) => {
        const p = optPos[i];
        const og = K.mark(el('g', {}, gOpts), o.outcome || o.label);
        const color = K.tone(o.tone || (o.ok === false ? 'bad' : o.ok === true ? 'good' : null));
        const frame = K.rect(og, p.x - ow / 2, p.y - oh / 2, ow, oh, { fill: C.card, stroke: C.border });
        if (K.vivid) K.badge(og, o.icon || (o.ok === false ? 'x' : 'check'), p.x - ow / 2 + S(44), p.y, S(24), color);
        else { el('circle', { cx: p.x - ow / 2 + S(44), cy: p.y, r: S(26), fill: color, 'fill-opacity': 0.16 }, og); K.icon(og, o.icon || (o.ok === false ? 'x' : 'check'), p.x - ow / 2 + S(44), p.y, S(26), color); }
        K.text(og, o.outcome || o.label, p.x - ow / 2 + S(82), p.y - (o.sub ? S(26) : S(14)), { size: S(21), weight: 750, maxW: ow - S(96), maxLines: 2 });
        if (o.sub) K.text(og, o.sub, p.x - ow / 2 + S(82), p.y + S(6), { size: S(17), weight: 500, fill: C.muted, maxW: ow - S(96), maxLines: 1 });
        const from = { x: gate.x, y: gate.y + gh / 2 }, to = { x: p.x, y: p.y - oh / 2 };
        const d = `M${from.x},${from.y} C${from.x},${(from.y + to.y) / 2} ${to.x},${(from.y + to.y) / 2} ${to.x},${to.y}`;
        const path = el('path', { d, fill: 'none', stroke: C.edge, 'stroke-width': S(3.5), 'stroke-linecap': 'round' }, gLines);
        const len = path.getTotalLength();
        // With more than two outcomes, neighbouring labels sit at alternating heights so they never collide.
        const row = Math.floor(i / cols);
        const frac = nrows > 1 ? (row === 0 ? 0.55 : 0.93) : n > 2 ? (i % 2 ? 0.74 : 0.4) : 0.5;
        const mid = path.getPointAtLength(len * frac);
        const lab = o.label && o.outcome ? K.pill(gLines, o.label, mid.x, mid.y, { stroke: color, size: S(17), maxW: Math.min(S(220), ow * 0.9) }) : null;
        if (lab) K.mark(lab.g, `${o.label} (label)`);
        return { og, frame, color, path, len, lab, p };
      });
      const item = K.pill(gFx, spec.item || 'Item', 0, 0, { stroke: ctx.style.accent, icon: spec.itemIcon || 'file', size: S(20), maxW: S(320) });
      const mv = ctx.motion;
      const chosen = spec.chosen === undefined || spec.chosen === 'all' ? opts.map((_, i) => i) : [].concat(spec.chosen);
      const T0 = 0.9, dropD = 0.8 * mv, goD = 1.2 * mv;
      const runs = chosen.map((ci, k) => ({ ci, start: T0 + dropD + 0.4 + k * (goD + 0.45) }));
      const dur = (runs.length ? runs[runs.length - 1].start + goD : T0 + dropD) + 0.9;
      return {
        dur,
        draw(lt) {
          K.show(gGate, clamp01(pop(lt, 0.05) * 1.5));
          optG.forEach((o, i) => {
            const a = pop(lt, 0.25 + i * 0.1);
            K.show(o.og, clamp01(a * 1.5));
            const run = runs.find((r) => r.ci === i);
            const lit = run && lt >= run.start;
            const draw = outCubic(prog(lt, 0.3 + i * 0.1, 0.5));
            o.path.style.strokeDasharray = `${o.len} ${o.len}`;
            o.path.style.strokeDashoffset = o.len * (1 - draw);
            o.path.setAttribute('stroke', lit ? o.color : C.edge);
            o.frame.setAttribute('stroke', lit && lt >= run.start + goD * 0.9 ? o.color : C.border);
            if (o.lab) K.show(o.lab.g, fadeIn(lt, 0.6 + i * 0.1) * (lit || !runs.length ? 1 : 0.55));
          });
          gateRect.setAttribute('stroke-width', (S(3) + S(3) * Math.max(0, Math.sin(Math.PI * prog(lt, T0 + dropD - 0.1, 0.5)))).toFixed(2));
          // The item drops into the gate, then travels each chosen path.
          let pos, op = 0;
          if (lt < T0 + dropD + 0.4) {
            const k = inOut(prog(lt, T0, dropD));
            pos = { x: gate.x, y: lerp(B.y + S(20), gate.y - gh / 2 - S(34), k) };
            op = fadeIn(lt, T0, 0.2);
          } else {
            const run = [...runs].reverse().find((r) => lt >= r.start) || runs[0];
            if (run) {
              const o = optG[run.ci];
              const k = inOut(prog(lt, run.start, goD));
              pos = o.path.getPointAtLength(o.len * k);
              pos = { x: pos.x, y: pos.y - S(34) * k };
              op = lt < run.start + goD + 0.3 ? 1 : 1 - prog(lt, run.start + goD + 0.3, 0.2);
              if (runs.indexOf(run) === runs.length - 1 && lt >= run.start + goD) op = 1;
            } else pos = { x: gate.x, y: gate.y };
          }
          K.show(item.g, op, `translate(${pos.x},${pos.y})`);
        },
      };
    },
  };

  // ---------------------------------------------------------------- checklist
  SCENES.checklist = {
    build(g, spec, ctx) {
      const K = kit(ctx), { S, C } = K, B = box(ctx);
      const items = spec.items || [];
      const w = Math.min(S(760), B.w * 0.92);
      const rowH = S(64), headH = spec.subject ? S(110) : S(80);
      const h = headH + items.length * rowH + (spec.result ? S(90) : S(20));
      const x = B.x + B.w / 2 - w / 2, y = B.y + Math.max(0, (B.h - h) / 2);
      const cg = el('g', { 'data-asset': spec.title || 'checklist' }, g);
      K.rect(cg, x, y + S(8), w, h, { fill: C.shadow });
      K.rect(cg, x, y, w, h, { fill: C.card, stroke: C.border });
      K.icon(cg, spec.icon || 'shield', x + S(42), y + S(42), S(30), ctx.style.accent);
      K.text(cg, spec.title || 'Checks', x + S(74), y + S(24), { size: S(26), weight: 800, maxW: w - S(100), maxLines: 1 });
      if (spec.subject) K.pill(cg, spec.subject, x + S(74) + Math.min(w - S(120), K.measure(spec.subject, S(18), 650) + S(40)) / 2, y + S(82), { stroke: C.border, size: S(18), maxW: w - S(120), icon: 'file', iconColor: C.muted });
      const mv = ctx.motion, T0 = 0.6, gap = 0.6 * mv;
      const rows = items.map((it, k) => {
        const ry = y + headH + k * rowH;
        const rg = el('g', {}, cg);
        el('line', { x1: x + S(24), y1: ry, x2: x + w - S(24), y2: ry, stroke: C.border, 'stroke-width': S(1.5) }, rg);
        const ring = el('circle', { cx: x + S(48), cy: ry + rowH / 2, r: S(16), fill: 'none', stroke: C.muted, 'stroke-width': S(2.5), 'stroke-dasharray': `${S(30)} ${S(80)}` }, rg);
        const okv = it.ok === undefined ? true : it.ok;
        const mark = el('g', {}, rg);
        el('circle', { cx: x + S(48), cy: ry + rowH / 2, r: S(17), fill: K.tone(okv), 'fill-opacity': 0.18 }, mark);
        K.icon(mark, okv === true ? 'check' : okv === 'warn' ? 'alert' : 'x', x + S(48), ry + rowH / 2, S(22), K.tone(okv));
        K.text(rg, it.label, x + S(84), ry + rowH / 2 - S(14), { size: S(22), weight: 600, maxW: w - S(120), maxLines: 1 });
        return { rg, ring, mark, at: T0 + k * gap, cx: x + S(48), cy: ry + rowH / 2 };
      });
      const end = T0 + items.length * gap;
      const res = spec.result ? K.pill(cg, spec.result.label, x + w / 2, y + h - S(46), { stroke: K.tone(spec.result.ok !== false), icon: spec.result.ok === false ? 'x' : 'check', size: S(22), maxW: w - S(80) }) : null;
      return {
        dur: end + (res ? 1.2 : 0.4) + 0.4,
        draw(lt) {
          K.show(cg, clamp01(pop(lt, 0.05) * 1.6));
          rows.forEach((r) => {
            const checking = lt >= r.at - gap * 0.9 && lt < r.at;
            K.show(r.ring, checking ? 1 : lt < r.at ? 0.5 : 0, `rotate(${(lt * 400) % 360} ${r.cx} ${r.cy})`);
            const a = pop(lt, r.at, 0.35);
            K.show(r.mark, lt >= r.at ? clamp01(a * 1.5) : 0, `translate(${r.cx},${r.cy}) scale(${0.88 + 0.12 * a}) translate(${-r.cx},${-r.cy})`);
          });
          if (res) K.show(res.g, clamp01(pop(lt, end + 0.2) * 1.5));
        },
      };
    },
  };

  // ---------------------------------------------------------------- queue
  // Jobs wait in a queue; workers pick them up; a failing job retries or lands in dead letters.
  SCENES.queue = {
    build(g, spec, ctx) {
      const K = kit(ctx), { S, C } = K, B = box(ctx), L = landscape(ctx);
      const jobs = (spec.jobs || ['Job 1', 'Job 2', 'Job 3', 'Job 4']).slice(0, 6);
      const nw = Math.max(1, Math.min(4, typeof spec.workers === 'number' ? spec.workers : (spec.workers || []).length || 2));
      const names = Array.isArray(spec.workers) ? spec.workers : Array.from({ length: nw }, (_, i) => `Worker ${i + 1}`);
      const failIdx = spec.retry || spec.deadLetter ? Math.min(1, jobs.length - 1) : -1;
      const tileW = S(200), tileH = S(52);
      const qx = L ? B.x + B.w * 0.08 : B.x + B.w * 0.08, qy = L ? B.y + B.h * 0.18 : B.y + B.h * 0.06;
      // The queue is as tall as its jobs, so it never sits as a large empty box.
      const qw = L ? Math.min(B.w * 0.3, tileW + S(120)) : B.w * 0.84;
      const qh = L ? Math.min(B.h * 0.64, S(84) + jobs.length * (tileH + S(10))) : Math.min(B.h * 0.3, S(84) + Math.ceil(jobs.length / 3) * (tileH + S(10)));
      const wx = L ? B.x + B.w * 0.5 : B.x + B.w * 0.08;
      const ww = L ? B.w * 0.22 : B.w * 0.84 / nw - S(12), wh = L ? Math.min(S(150), (B.h * 0.76 - S(16) * (nw - 1)) / nw) : S(120);
      const wy = L ? B.y + B.h * 0.5 - (nw * wh + S(16) * (nw - 1)) / 2 : B.y + B.h * 0.44;
      // Done and dead-letter lanes are sized to the tiles they will hold; tiles shrink to the lane width.
      const nDone = jobs.length - (spec.deadLetter && failIdx >= 0 ? 1 : 0);
      const dx = L ? B.x + B.w * 0.78 : B.x + B.w * 0.08, dy = L ? B.y + B.h * 0.18 : B.y + B.h * 0.7;
      const dw = L ? B.w * 0.2 : B.w * 0.84;
      const tsc = Math.min(0.8, (dw - S(24)) / tileW);
      // Lane titles wrap to two smaller lines on narrow lanes instead of truncating.
      const two = (t) => K.wrap(t, S(19), 800, dw - S(64)).length > 1;
      const laneTitle = (gg, t, x, y) => K.text(gg, t, x, two(t) ? y - S(4) : y, { size: S(two(t) ? 16 : 19), weight: 800, maxW: dw - S(64), maxLines: 2, lh: 1.1 });
      const dHead = S(70) + (two(spec.done || 'Done') ? S(14) : 0);
      const dh = L ? Math.min(B.h * 0.64, dHead + nDone * (tileH * tsc + S(8)) + S(6)) : B.h * 0.22;
      const base = el('g', {}, g), gJobs = el('g', {}, g);
      K.rect(base, qx, qy, qw, qh, { fill: C.card, stroke: C.border, dash: `${S(8)} ${S(6)}` });
      K.text(base, spec.label || 'Queue', qx + S(20), qy + S(14), { size: S(19), weight: 800, fill: C.muted });
      const workers = names.slice(0, nw).map((nm, i) => {
        const x = L ? wx : wx + i * (ww + S(12)), y = L ? wy + i * (wh + S(16)) : wy;
        const wg = K.mark(el('g', {}, base), nm);
        const frame = K.rect(wg, x, y, ww, wh, { fill: C.card, stroke: C.border });
        const gear = K.icon(wg, 'gear', x + S(36), y + wh / 2, S(30), ctx.style.accent);
        K.text(wg, nm, x + S(64), y + wh / 2 - S(13), { size: S(19), weight: 700, maxW: ww - S(74), maxLines: 1 });
        return { frame, gear, x, y, cx: x + S(36), cy: y + wh / 2, slot: { x: x + ww / 2, y: y + wh / 2 } };
      });
      K.rect(base, dx, dy, dw, dh, { fill: C.card, stroke: ctx.style.good, so: 0.6 });
      K.icon(base, 'check', dx + S(32), dy + S(32), S(24), ctx.style.good);
      laneTitle(base, spec.done || 'Done', dx + S(56), dy + S(18));
      let dead = null;
      if (spec.deadLetter) {
        const ddx = L ? dx : B.x + B.w * 0.08, ddy = L ? dy + dh + S(14) : dy + dh + S(14);
        const deadHead = S(62) + (two(spec.deadLabel || 'Needs attention') ? S(14) : 0);
        const ddh = deadHead + tileH * tsc + S(10);
        dead = { x: ddx, y: ddy, w: dw, h: ddh, head: deadHead };
        K.rect(base, ddx, ddy, dw, ddh, { fill: C.card, stroke: ctx.style.bad, so: 0.7 });
        K.icon(base, 'alert', ddx + S(32), ddy + S(33), S(22), ctx.style.bad);
        laneTitle(base, spec.deadLabel || 'Needs attention', ddx + S(56), ddy + S(20));
      }
      const mv = ctx.motion;
      const slots = (i) => (L ? { x: qx + qw / 2, y: qy + S(66) + i * (tileH + S(10)) + tileH / 2 } : { x: qx + S(20) + tileW / 2 + (i % 3) * (tileW + S(10)), y: qy + S(66) + Math.floor(i / 3) * (tileH + S(10)) + tileH / 2 });
      const doneSlot = (i) => (L ? { x: dx + dw / 2, y: dy + dHead + i * (tileH * tsc + S(8)) + tileH * tsc / 2 } : { x: dx + S(20) + tileW / 2 + (i % 3) * (tileW + S(10)), y: dy + S(70) + Math.floor(i / 3) * (tileH + S(8)) });
      // Timeline per job: arrive in queue, picked by worker, processed, done (or retry / dead).
      const plan = jobs.map((label, i) => {
        const arrive = 0.5 + i * 0.35 * mv;
        const pick = 1.6 * mv + Math.floor(i / nw) * 1.7 * mv + (i % nw) * 0.25;
        const w = i % nw;
        const fail = i === failIdx;
        return { label, arrive, pick, w, fail, done: pick + 1.2 * mv };
      });
      plan.forEach((p) => {
        if (p.fail) {
          p.back = p.done; // returns to queue
          p.pick2 = p.back + 0.9 * mv;
          p.done2 = p.pick2 + 1.2 * mv;
          p.end = spec.deadLetter ? p.done2 : p.done2;
        }
      });
      let doneCount = 0;
      plan.slice().sort((a, b) => (a.fail ? a.done2 : a.done) - (b.fail ? b.done2 : b.done)).forEach((p) => { if (!(p.fail && spec.deadLetter)) p.doneIndex = doneCount++; });
      const tiles = plan.map((p, i) => {
        const tg = el('g', {}, gJobs);
        const fr = K.rect(tg, -tileW / 2, -tileH / 2, tileW, tileH, { r: S(12), fill: C.pill, stroke: ctx.style.accent2 || ctx.style.accent });
        K.icon(tg, spec.jobIcon || 'mail', -tileW / 2 + S(24), 0, S(20), ctx.style.accent2 || ctx.style.accent);
        K.text(tg, p.label, -tileW / 2 + S(44), -S(11), { size: S(17), weight: 650, maxW: tileW - S(52), maxLines: 1 });
        return { tg, fr, p, i };
      });
      const end = Math.max(...plan.map((p) => (p.fail ? p.done2 : p.done))) + 0.8;
      const moveTo = (a, b, start, d, lt) => { const k = inOut(prog(lt, start, d)); return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) }; };
      return {
        dur: end,
        draw(lt) {
          K.show(base, clamp01(pop(lt, 0.05) * 1.6));
          const busy = new Set();
          tiles.forEach(({ tg, fr, p, i }) => {
            const q = slots(i), w = workers[p.w].slot;
            // Jobs slide a short way into their slot from inside the queue, never from beyond the frame.
            const entry = L ? { x: q.x - S(56), y: q.y } : { x: q.x, y: q.y - S(40) };
            const d = dead && p.fail && spec.deadLetter ? { x: dead.x + dead.w / 2, y: dead.y + dead.head + tileH * tsc / 2 } : doneSlot(p.doneIndex ?? 0);
            let pos, op = 1, color = ctx.style.accent2 || ctx.style.accent;
            if (lt < p.arrive) { op = 0; pos = entry; }
            else if (lt < p.pick) pos = moveTo(entry, q, p.arrive, 0.5, lt);
            else if (lt < p.done) { pos = moveTo(q, w, p.pick, 0.5, lt); if (lt > p.pick + 0.4) busy.add(p.w); }
            else if (!p.fail) pos = moveTo(w, d, p.done, 0.6, lt);
            else if (lt < p.pick2) { pos = moveTo(w, slots(jobs.length), p.back, 0.6, lt); color = ctx.style.bad; }
            else if (lt < p.done2) { pos = moveTo(slots(jobs.length), w, p.pick2, 0.5, lt); if (lt > p.pick2 + 0.4) busy.add(p.w); color = ctx.style.warn; }
            else { pos = moveTo(w, d, p.done2, 0.6, lt); color = spec.deadLetter ? ctx.style.bad : ctx.style.good; }
            const doneNow = (!p.fail && lt >= p.done + 0.6) || (p.fail && lt >= p.done2 + 0.6 && !spec.deadLetter);
            if (doneNow) color = ctx.style.good;
            fr.setAttribute('stroke', color);
            // Shrink while travelling into the lane so the tile lands at the lane's size.
            const into = !p.fail ? prog(lt, p.done, 0.6) : lt >= p.done2 ? prog(lt, p.done2, 0.6) : 0;
            const scl = lerp(1, L ? tsc : 0.8, inOut(into));
            K.show(tg, op * fadeIn(lt, p.arrive, 0.25), `translate(${pos.x},${pos.y}) scale(${scl})`);
          });
          workers.forEach((wk, i) => {
            wk.frame.setAttribute('stroke', busy.has(i) ? ctx.style.accent : C.border);
            wk.gear.setAttribute('transform', `${wk.gear.getAttribute('transform').replace(/ rotate\([^)]*\)/, '')} rotate(${busy.has(i) ? (lt * 240) % 360 : 0} 12 12)`);
          });
        },
      };
    },
  };

  // ---------------------------------------------------------------- screen
  // A real screenshot in a device frame, with highlights that point at what matters.
  SCENES.screen = {
    build(g, spec, ctx) {
      const K = kit(ctx), { S, C } = K, B = box(ctx);
      const img = ctx.images[spec.src] || { w: 1440, h: 900 };
      const device = spec.device || (img.h > img.w * 1.3 ? 'phone' : 'browser');
      const bar = device === 'browser' ? S(44) : 0;
      const pad = device === 'phone' ? S(18) : 0;
      const maxW = B.w * 0.94, maxH = B.h * 0.96 - bar - pad * 2;
      const sc = Math.min(maxW / img.w, maxH / img.h);
      const iw = img.w * sc, ih = img.h * sc;
      const fw = iw + pad * 2, fh = ih + bar + pad * 2;
      const fx = B.x + B.w / 2 - fw / 2, fy = B.y + B.h / 2 - fh / 2;
      const frame = el('g', {}, g);
      K.rect(frame, fx, fy + S(10), fw, fh, { r: device === 'phone' ? S(46) : S(14), fill: C.shadow });
      K.rect(frame, fx, fy, fw, fh, { r: device === 'phone' ? S(46) : S(14), fill: device === 'phone' ? '#0B0B0F' : C.card, stroke: C.border });
      if (device === 'browser') {
        ['#FF5F57', '#FEBC2E', '#28C840'].forEach((c, i) => el('circle', { cx: fx + S(24) + i * S(20), cy: fy + bar / 2, r: S(6), fill: c }, frame));
        if (spec.url) { K.rect(frame, fx + S(96), fy + S(9), Math.min(fw - S(120), S(520)), bar - S(18), { r: S(8), fill: C.pill }); K.text(frame, spec.url, fx + S(112), fy + S(12), { size: S(15), weight: 500, fill: C.muted, maxW: Math.min(fw - S(150), S(490)), maxLines: 1 }); }
      }
      const clip = el('clipPath', { id: `scr${ctx.uid}` }, g);
      el('rect', { x: fx + pad, y: fy + bar + pad, width: iw, height: ih, rx: device === 'phone' ? S(32) : 0 }, clip);
      const inner = el('g', { 'clip-path': `url(#scr${ctx.uid})` }, g);
      const image = el('image', { href: img.url || '', x: fx + pad, y: fy + bar + pad, width: iw, height: ih, preserveAspectRatio: 'xMidYMid slice' }, inner);
      const zoomG = el('g', {}, g);
      const hls = (spec.highlights || []).map((h, i) => {
        const hg = el('g', {}, zoomG);
        const x = fx + pad + h.x * iw, y = fy + bar + pad + h.y * ih, w = h.w * iw, hh = h.h * ih;
        K.rect(hg, x, y, w, hh, { r: S(10), fill: 'none', stroke: ctx.style.accent, sw: S(4) });
        // Label beside small targets (buttons) when there is room, otherwise above or below; never on top of them.
        let lab = null;
        if (h.label) {
          const pw = Math.min(S(320), K.measure(h.label, S(18), 650) + S(36));
          const right = x + w + S(14) + pw <= fx + fw - S(8) && w < iw * 0.45;
          const lx = right ? x + w + S(14) + pw / 2 : Math.min(Math.max(x + w / 2, fx + pw / 2 + S(8)), fx + fw - pw / 2 - S(8));
          const ly = right ? y + hh / 2 : y > fy + bar + S(60) ? y - S(26) : y + hh + S(26);
          lab = K.pill(hg, h.label, lx, ly, { stroke: ctx.style.accent, size: S(18), maxW: S(320), fill: ctx.style.accent, color: '#FFFFFF' });
          K.mark(lab.g, `${h.label} (label)`);
        }
        return { hg, at: 0.9 + i * 1.1 * ctx.motion, lab };
      });
      const dur = Math.max(2.6, 0.9 + hls.length * 1.1 * ctx.motion + 1.0);
      const cx = fx + fw / 2, cy = fy + fh / 2;
      return {
        dur,
        draw(lt) {
          const a = pop(lt, 0.05, 0.6);
          K.show(frame, clamp01(a * 1.5), `translate(${cx},${cy}) scale(${0.92 + 0.08 * a}) translate(${-cx},${-cy})`);
          const z = 1 + 0.05 * clamp01(lt / dur);
          inner.setAttribute('opacity', clamp01(a * 1.5).toFixed(3));
          const zt = `translate(${cx},${cy}) scale(${z * (0.92 + 0.08 * a)}) translate(${-cx},${-cy})`;
          image.setAttribute('transform', zt);
          zoomG.setAttribute('transform', zt);
          hls.forEach((h) => K.show(h.hg, clamp01(pop(lt, h.at, 0.4) * 1.4)));
        },
      };
    },
  };

  // ---------------------------------------------------------------- code
  // Real code from the repo, revealed line by line with the key lines highlighted.
  SCENES.code = {
    build(g, spec, ctx) {
      const K = kit(ctx), { S, C } = K, B = box(ctx);
      const lines = (spec.lines || []).slice(0, 16);
      const size = S(lines.length > 12 ? 19 : 22), lh = size * 1.55;
      const w = Math.min(B.w * 0.96, S(1100)), barH = S(48);
      const h = barH + lines.length * lh + S(36) + (spec.note ? S(64) : 0);
      const x = B.x + B.w / 2 - w / 2, y = B.y + Math.max(0, (B.h - h) / 2);
      const cg = el('g', { 'data-asset': spec.file || 'code' }, g);
      K.rect(cg, x, y + S(10), w, h, { r: S(14), fill: C.shadow });
      K.rect(cg, x, y, w, h, { r: S(14), fill: ctx.style.theme === 'light' ? '#0F172A' : C.card, stroke: C.border });
      ['#FF5F57', '#FEBC2E', '#28C840'].forEach((c, i) => el('circle', { cx: x + S(24) + i * S(20), cy: y + barH / 2, r: S(6), fill: c }, cg));
      if (spec.file) K.text(cg, spec.file, x + S(96), y + barH / 2 - S(10), { size: S(16), weight: 600, fill: '#94A3B8', font: ctx.style.mono, maxW: w - S(120), maxLines: 1 });
      const hl = new Set(spec.highlight || []);
      const start = spec.startLine || 1;
      const rows = lines.map((ln, i) => {
        const ry = y + barH + S(18) + i * lh;
        const rg = el('g', {}, cg);
        const band = K.rect(rg, x + S(8), ry - S(2), w - S(16), lh, { r: S(6), fill: ctx.style.accent, fo: 0 });
        K.text(rg, String(start + i), x + S(56), ry + (lh - size) / 2 - S(3), { size, weight: 500, fill: '#64748B', font: ctx.style.mono, anchor: 'end' });
        K.text(rg, ln.replace(/\t/g, '  '), x + S(76), ry + (lh - size) / 2 - S(3), { size, weight: 500, fill: '#E2E8F0', font: ctx.style.mono, maxW: w - S(96), maxLines: 1 });
        return { rg, band, hl: hl.has(start + i) };
      });
      const per = Math.min(0.18, 2.2 / Math.max(1, lines.length)) * ctx.motion;
      const T0 = 0.5, typed = T0 + lines.length * per;
      const note = spec.note ? K.pill(cg, spec.note, x + w / 2, y + h - S(40), { stroke: ctx.style.accent, icon: 'sparkles', size: S(19), maxW: w - S(60) }) : null;
      return {
        dur: typed + 1.6 + (note ? 0.8 : 0),
        draw(lt) {
          K.show(cg, clamp01(pop(lt, 0.05) * 1.6));
          rows.forEach((r, i) => {
            K.show(r.rg, fadeIn(lt, T0 + i * per, 0.2), `translate(${(1 - fadeIn(lt, T0 + i * per, 0.2)) * S(-12)},0)`);
            r.band.setAttribute('fill-opacity', r.hl ? (0.22 * prog(lt, typed + 0.2, 0.4)).toFixed(3) : 0);
          });
          if (note) K.show(note.g, clamp01(pop(lt, typed + 0.7) * 1.5));
        },
      };
    },
  };

  // ---------------------------------------------------------------- headline
  // Kinetic title card: a glowing emblem, light lines drawing outwards, big gradient words revealed one by one.
  // variant "orb": the words move through a glass lens with small orbs circling it.
  SCENES.headline = {
    build(g, spec, ctx) {
      const K = kit(ctx), { S, C } = K, B = box(ctx);
      const cx = B.x + B.w / 2, orb = spec.variant === 'orb';
      const words = String(spec.text || '').split(/\s+/).filter(Boolean);
      const size = Math.min(S(orb ? 96 : 104), (B.w * 0.86) / Math.max(4, String(spec.text || '').length * 0.5));
      const lines = K.wrap(spec.text || '', size, 800, B.w * (orb ? 0.62 : 0.9)).slice(0, 2);
      const subSize = size * 0.42;
      const blockH = lines.length * size * 1.08 + (spec.sub ? subSize * 1.6 : 0);
      const cy = B.y + B.h / 2 + (orb ? 0 : S(40));
      const top = cy - blockH / 2;
      const gid = `hg${ctx.uid}`;
      const lg = el('linearGradient', { id: gid, x1: 0, y1: 0, x2: 1, y2: 0.3 }, g);
      el('stop', { offset: '0%', 'stop-color': C.text }, lg);
      el('stop', { offset: '55%', 'stop-color': ctx.style.accent2 || ctx.style.accent }, lg);
      el('stop', { offset: '100%', 'stop-color': ctx.style.accent }, lg);
      const deco = el('g', {}, g);
      let orbG = null, moons = [];
      if (orb) {
        const R = Math.min(B.w, B.h) * 0.36;
        orbG = el('g', {}, deco);
        const rg = el('radialGradient', { id: `og${ctx.uid}`, cx: '50%', cy: '40%', r: '60%' }, g);
        el('stop', { offset: '0%', 'stop-color': '#fff', 'stop-opacity': 0.10 }, rg);
        el('stop', { offset: '70%', 'stop-color': ctx.style.accent, 'stop-opacity': 0.10 }, rg);
        el('stop', { offset: '100%', 'stop-color': ctx.style.accent, 'stop-opacity': 0.35 }, rg);
        el('circle', { cx, cy, r: R * 1.5, fill: 'none', stroke: ctx.style.accent2 || ctx.style.accent, 'stroke-opacity': 0.35, 'stroke-width': S(2.5) }, orbG);
        el('circle', { cx, cy, r: R, fill: `url(#og${ctx.uid})`, stroke: ctx.style.accent2 || ctx.style.accent, 'stroke-width': S(3), filter: 'url(#softGlow)' }, orbG);
        el('circle', { cx, cy, r: R, fill: `url(#og${ctx.uid})`, stroke: '#fff', 'stroke-opacity': 0.35, 'stroke-width': S(1.5) }, orbG);
        el('ellipse', { cx: cx - R * 0.3, cy: cy - R * 0.55, rx: R * 0.35, ry: R * 0.12, fill: '#fff', opacity: 0.18 }, orbG);
        moons = [0, 1].map((k) => ({ r: S(k ? 34 : 46), el: el('circle', { r: S(k ? 34 : 46), fill: `url(#og${ctx.uid})`, stroke: ctx.style.accent2 || ctx.style.accent, 'stroke-width': S(2) }, deco), R: R * 1.5, a0: k ? 2.2 : -0.7 }));
      }
      // Emblem and light lines above the words.
      const ey = top - S(orb ? 0 : 70);
      const emblem = el('g', {}, deco);
      let lineL = null, lineR = null, ll = 0;
      if (!orb) {
        el('circle', { cx, cy: ey, r: S(44), fill: ctx.style.accent, opacity: 0.5, filter: 'url(#softGlow)' }, emblem);
        if (spec.icon) K.badge(emblem, spec.icon, cx, ey, S(30), ctx.style.accent);
        else el('path', { d: sparkle(cx, ey, S(34)), fill: '#fff', filter: 'url(#softGlow)' }, emblem), el('path', { d: sparkle(cx, ey, S(30)), fill: K.vivid ? ctx.paint.grad(ctx.style.accent2 || ctx.style.accent) : '#fff' }, emblem);
        ll = Math.min(B.w * 0.32, S(420));
        const mk = (dir) => el('line', { x1: cx + dir * S(58), y1: ey, x2: cx + dir * (S(58) + ll), y2: ey, stroke: ctx.style.accent2 || ctx.style.accent, 'stroke-width': S(2.5), 'stroke-linecap': 'round', opacity: 0.85 }, deco);
        lineL = mk(-1); lineR = mk(1);
      }
      // Words: each is its own tspan so it can rise in on its own beat.
      // Emphasis comes from size and weight, not gradient text; depth from an offset, blurred shadow.
      const textG = el('g', { 'data-asset': 'headline' }, g);
      textG.style.filter = K.vivid ? `drop-shadow(0 ${S(6)}px ${S(28)}px ${ctx.style.accent}88)` : '';
      emblem.setAttribute('data-asset', 'emblem');
      const wordEls = [];
      let wi = 0;
      lines.forEach((ln, li) => {
        const t = el('text', { x: cx, y: top + size * 0.86 + li * size * 1.04, 'text-anchor': 'middle', fill: C.text, 'font-family': ctx.style.font.family, 'font-size': size, 'font-weight': 800, 'letter-spacing': -size * 0.03 }, textG);
        ln.split(' ').forEach((w, k) => { const ts = el('tspan', {}, t); ts.textContent = (k ? ' ' : '') + w; wordEls.push({ ts, i: wi++ }); });
      });
      const sub = spec.sub ? K.text(textG, spec.sub, cx, top + lines.length * size * 1.08 + subSize * 0.4, { size: subSize, weight: 500, fill: C.muted, anchor: 'middle', maxW: B.w * 0.8, maxLines: 2 }) : null;
      const per = Math.min(0.11, 1.0 / Math.max(1, words.length)) * ctx.motion;
      const T0 = 0.45, wordsEnd = T0 + 0.3 + wordEls.length * per;
      const dur = Math.max(2.8, wordsEnd + 1.6);
      return {
        dur,
        draw(lt) {
          const a = outBack(prog(lt, 0.05, 0.6));
          K.show(emblem, clamp01(a * 1.4), `translate(${cx},${ey}) scale(${0.82 + 0.18 * a}) rotate(${(1 - clamp01(a)) * -20}) translate(${-cx},${-ey})`);
          if (lineL) {
            const d = outCubic(prog(lt, 0.3, 0.8));
            lineL.setAttribute('x2', cx - S(58) - ll * d); lineR.setAttribute('x2', cx + S(58) + ll * d);
            lineL.setAttribute('opacity', (0.85 * d).toFixed(3)); lineR.setAttribute('opacity', (0.85 * d).toFixed(3));
          }
          if (orbG) {
            const o = outCubic(prog(lt, 0, 0.8));
            K.show(orbG, o, `translate(${cx},${cy}) scale(${0.9 + 0.1 * o + 0.015 * Math.sin(lt * 1.5)}) translate(${-cx},${-cy})`);
            moons.forEach((m, k) => { const ang = m.a0 + lt * (k ? -0.35 : 0.28); m.el.setAttribute('cx', cx + Math.cos(ang) * m.R); m.el.setAttribute('cy', cy + Math.sin(ang) * m.R * 0.8); m.el.setAttribute('opacity', o.toFixed(3)); });
          }
          wordEls.forEach((w) => {
            const k = outCubic(prog(lt, T0 + w.i * per, 0.45));
            w.ts.setAttribute('opacity', k.toFixed(3));
            w.ts.setAttribute('dy', 0);
          });
          // Orb: the words zoom through the lens.
          const z = orb ? 0.75 + 0.3 * outCubic(prog(lt, T0, dur - T0)) : 1;
          textG.setAttribute('transform', `translate(${cx},${cy}) scale(${z}) translate(${-cx},${-cy}) translate(0,${(1 - outCubic(prog(lt, T0, 0.6))) * S(18)})`);
          if (sub) sub.el.setAttribute('opacity', prog(lt, wordsEnd - 0.1, 0.5).toFixed(3));
        },
      };
    },
  };

  // ---------------------------------------------------------------- showcase
  // The product in a glass window tilted in 3D (real screenshot or a dashboard built from the spec),
  // with callout cards popping out around it and blurred ghost panels behind for depth.
  SCENES.showcase = {
    html: true,
    build(g, spec, ctx) {
      const B = box(ctx), st = ctx.style, C = st.colors, U = ctx.U;
      const light = st.theme === 'light';
      const glassBg = light ? 'rgba(255,255,255,0.72)' : 'rgba(10,18,40,0.58)';
      const edge = light ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.16)';
      const tall = B.h > B.w * 1.05;
      const root = ctx.html;
      const mk = (tag, css, parent, html) => { const e = document.createElement(tag); e.style.cssText = css; if (html !== undefined) e.innerHTML = html; (parent || root).appendChild(e); return e; };
      const iconSvg = (name, color, size) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ctx.icons[name] || ctx.icons.sparkles}</svg>`;
      const grad = (c) => `linear-gradient(135deg, ${c}, ${st.accent2 || c})`;
      const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
      const img = spec.src ? ctx.images[spec.src] : null;
      const aspect = img ? img.w / img.h : (tall ? 0.62 : 1.6);
      const hasCallouts = (spec.callouts || []).length > 0;
      // Callouts go left/right only on wide frames; square and vertical frames put them above and below.
      const sideways = B.w > B.h * 1.6;
      let ww = Math.min(B.w * (tall ? 0.94 : hasCallouts && sideways ? 0.74 : 0.9), B.h * (hasCallouts && !sideways ? 0.78 : 0.9) * aspect), wh = ww / aspect;
      if (wh > B.h * 0.9) { wh = B.h * 0.9; ww = wh * aspect; }
      // The UI inside is laid out at a fixed design width and scaled with the window, so it always fills it.
      const UI = ww / (tall ? 620 : 1100);
      const px = (v) => `${(v * UI).toFixed(1)}px`;
      const wx = B.x + (B.w - ww) / 2;
      let wy = B.y + (B.h - wh) / 2, wyFix = null;
      // Ghost panels: blurred copies of glass behind the window, drifting for parallax depth.
      const ghosts = [-1, 1].map((d) => mk('div', `position:absolute;left:${wx + d * ww * 0.62}px;top:${wy + wh * 0.12}px;width:${ww * 0.55}px;height:${wh * 0.7}px;border-radius:${px(18)};background:${glassBg};border:1px solid ${edge};filter:blur(${px(6)});opacity:.45`));
      const persp = mk('div', `position:absolute;left:0;top:0;width:100%;height:100%;perspective:${(B.w * 1.6).toFixed(0)}px;perspective-origin:50% 45%`);
      const win = mk('div', `position:absolute;left:${wx}px;top:${wy}px;width:${ww}px;height:${wh}px;border-radius:${px(20)};overflow:hidden;background:${glassBg};border:1px solid ${edge};backdrop-filter:blur(${px(14)}) saturate(1.4);box-shadow:0 0 ${px(120)} ${st.accent}55, 0 ${px(30)} ${px(80)} rgba(0,0,0,.45);transform-style:preserve-3d;font-family:${st.font.family};color:${C.text}`, persp);
      if (img) {
        mk('div', `height:${px(40)};display:flex;align-items:center;gap:${px(8)};padding:0 ${px(16)};background:${light ? 'rgba(255,255,255,.6)' : 'rgba(255,255,255,.04)'};border-bottom:1px solid ${edge}`, win,
          `<i style="width:${px(11)};height:${px(11)};border-radius:50%;background:#FF5F57"></i><i style="width:${px(11)};height:${px(11)};border-radius:50%;background:#FEBC2E"></i><i style="width:${px(11)};height:${px(11)};border-radius:50%;background:#28C840"></i><span style="margin-left:${px(14)};font-size:${px(14)};color:${C.muted}">${esc(spec.url || '')}</span>`);
        mk('img', `display:block;width:100%;height:calc(100% - ${px(40)});object-fit:cover;object-position:top`, win).src = img.url;
      } else {
        // A dashboard mock-up built from spec.ui: sidebar, greeting, headline, action chips and widget cards.
        const ui = spec.ui || {};
        const side = tall ? 0 : ww * 0.2;
        const sb = side ? mk('div', `position:absolute;left:0;top:0;bottom:0;width:${side}px;padding:${px(22)} ${px(16)};box-sizing:border-box;border-right:1px solid ${edge};background:${light ? 'rgba(255,255,255,.35)' : 'rgba(255,255,255,.025)'}`, win) : null;
        if (sb) {
          mk('div', `display:flex;align-items:center;gap:${px(8)};font-weight:800;font-size:${px(18)};margin-bottom:${px(22)}`, sb, `${iconSvg('sparkles', st.accent2 || st.accent, px(18))}<span>${esc(ui.app || '')}</span>`);
          (ui.nav || []).slice(0, 7).forEach((n, i) => mk('div', `display:flex;align-items:center;gap:${px(10)};padding:${px(9)} ${px(10)};border-radius:${px(10)};margin-bottom:${px(4)};font-size:${px(14)};font-weight:600;color:${i === 0 ? C.text : C.muted};background:${i === 0 ? (light ? 'rgba(59,130,246,.12)' : 'rgba(59,130,246,.18)') : 'transparent'}`, sb,
            `${iconSvg((n && n.icon) || ['chart', 'file', 'bell', 'message', 'users', 'gear', 'calendar'][i % 7], i === 0 ? st.accent2 || st.accent : C.muted, px(16))}<span>${esc((n && n.label) || n)}</span>`));
        }
        const main = mk('div', `position:absolute;left:${side}px;right:0;top:0;bottom:0;padding:${px(28)} ${px(30)};box-sizing:border-box;overflow:hidden`, win);
        if (tall && ui.app) mk('div', `display:flex;align-items:center;gap:${px(8)};font-weight:800;font-size:${px(18)};margin-bottom:${px(16)}`, main, `${iconSvg('sparkles', st.accent2 || st.accent, px(18))}<span>${esc(ui.app)}</span>`);
        if (ui.greeting) mk('div', `font-size:${px(tall ? 26 : 30)};font-weight:700;line-height:1.15`, main).textContent = ui.greeting;
        if (ui.headline) mk('div', `font-size:${px(tall ? 26 : 30)};font-weight:700;line-height:1.15;color:${st.accent2 || st.accent};margin-bottom:${px(16)}`, main).textContent = ui.headline;
        if ((ui.actions || []).length) {
          const row = mk('div', `display:flex;flex-wrap:wrap;gap:${px(8)};margin-bottom:${px(18)}`, main);
          ui.actions.slice(0, 4).forEach((a, i) => mk('span', `padding:${px(7)} ${px(14)};border-radius:999px;font-size:${px(13)};font-weight:650;${i === 0 ? `background:${grad(st.accent)};color:#fff` : `border:1px solid ${edge};color:${C.text};background:${light ? 'rgba(255,255,255,.6)' : 'rgba(255,255,255,.05)'}`}`, row).textContent = a);
        }
        const widgets = (ui.widgets || []).slice(0, tall ? 4 : 6);
        const cols = tall ? 1 : Math.min(3, Math.max(1, widgets.length > 4 ? 3 : widgets.length >= 2 ? 2 : 1));
        const grid = mk('div', `display:grid;grid-template-columns:repeat(${cols},1fr);gap:${px(14)}`, main);
        widgets.forEach((w, i) => {
          const card = mk('div', `padding:${px(16)};border-radius:${px(14)};background:${light ? 'rgba(255,255,255,.7)' : 'rgba(255,255,255,.045)'};border:1px solid ${edge};min-height:${px(92)};box-sizing:border-box`, grid);
          mk('div', `font-size:${px(14)};font-weight:650;color:${C.muted};margin-bottom:${px(8)}`, card).textContent = w.title || '';
          if (w.type === 'ring') {
            const pct = Math.max(0, Math.min(100, Number(w.value) || 0)), r = 30, cpx = 2 * Math.PI * r;
            mk('div', `display:flex;align-items:center;gap:${px(14)}`, card, `<svg width="${px(76)}" height="${px(76)}" viewBox="0 0 76 76"><circle cx="38" cy="38" r="${r}" fill="none" stroke="${light ? '#E5E7EB' : 'rgba(255,255,255,.1)'}" stroke-width="7"/><circle cx="38" cy="38" r="${r}" fill="none" stroke="${st.accent2 || st.accent}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${(cpx * pct) / 100} ${cpx}" transform="rotate(-90 38 38)"/></svg><b style="font-size:${px(26)}">${pct}%</b>`);
          } else if (w.type === 'list') {
            (w.items || []).slice(0, 3).forEach((it) => mk('div', `display:flex;align-items:center;gap:${px(8)};font-size:${px(13.5)};margin:${px(5)} 0;color:${C.text}`, card, `<i style="width:${px(7)};height:${px(7)};border-radius:50%;background:${st.accent2 || st.accent}"></i>${esc(it)}`));
          } else if (w.type === 'chart') {
            const vals = (w.items || [3, 5, 4, 7, 6, 8]).map(Number).slice(0, 8), mx = Math.max(...vals, 1);
            mk('div', `display:flex;align-items:flex-end;gap:${px(6)};height:${px(52)}`, card, vals.map((v) => `<i style="flex:1;height:${(v / mx) * 100}%;border-radius:${px(4)};background:${grad(st.accent)}"></i>`).join(''));
          } else if (w.type === 'chat') {
            mk('div', `display:flex;align-items:center;justify-content:space-between;padding:${px(10)} ${px(12)};border-radius:${px(12)};border:1px solid ${edge};font-size:${px(13.5)};color:${C.muted}`, card, `<span>${esc(w.value || 'Ask anything…')}</span>${iconSvg('send', st.accent2 || st.accent, px(16))}`);
          } else {
            mk('div', `font-size:${px(30)};font-weight:800;line-height:1.1`, card).textContent = w.value ?? '';
            if (w.sub) mk('div', `font-size:${px(13)};color:${C.muted};margin-top:${px(4)}`, card).textContent = w.sub;
          }
        });
      }
      // Fit the window to its content (a mock-up has no reason to show empty glass), keeping it centred.
      if (!img) {
        // The layer that shows and hides is the engine's overlay around this root.
        const host = root.parentNode && root.parentNode.classList && root.parentNode.classList.contains('overlay') ? root.parentNode : root;
        const was = host.style.display;
        host.style.display = 'block';
        const main = win.lastElementChild;
        const need = Math.max(...[...main.children].map((c) => c.offsetTop + c.offsetHeight), 0) + parseFloat(px(32));
        host.style.display = was;
        const fitH = Math.max(Math.min(wh, need), ww / 2.4);
        if (fitH < wh) {
          wh = fitH;
          const ny = B.y + (B.h - wh) / 2;
          win.style.top = `${ny}px`; win.style.height = `${wh}px`;
          ghosts.forEach((gh) => { gh.style.top = `${ny + wh * 0.12}px`; gh.style.height = `${wh * 0.7}px`; });
          wyFix = ny;
        }
      }
      // Light sweep across the glass.
      const sweep = mk('div', `position:absolute;top:-20%;bottom:-20%;width:${ww * 0.25}px;left:0;background:linear-gradient(100deg, transparent, rgba(255,255,255,${light ? 0.35 : 0.10}), transparent);pointer-events:none`, win);
      // Callouts float outside the window edges.
      if (wyFix !== null) wy = wyFix;
      const perSide = {};
      const callouts = (spec.callouts || []).slice(0, 4).map((c, i) => {
        const side = c.side || (!sideways ? (i % 2 ? 'bottom' : 'top') : i % 2 ? 'right' : 'left');
        const k = (perSide[side] = (perSide[side] ?? -1) + 1);
        const cpx = (v) => `${(v * U).toFixed(1)}px`;
        const cw = Math.min(260 * U, B.w * (sideways ? 0.24 : 0.42));
        const el2 = mk('div', `position:absolute;width:${cw}px;box-sizing:border-box;padding:${cpx(16)} ${cpx(18)};border-radius:${cpx(18)};background:${glassBg};border:1px solid ${edge};backdrop-filter:blur(${cpx(12)});box-shadow:0 0 ${cpx(50)} ${st.accent}55;font-family:${st.font.family};color:${C.text};display:flex;gap:${cpx(12)};align-items:flex-start`, persp,
          `<i style="flex:none;display:grid;place-items:center;width:${cpx(38)};height:${cpx(38)};border-radius:50%;background:${grad(st.accent)}">${iconSvg(c.icon || 'sparkles', '#fff', cpx(20))}</i><div><div style="font-weight:750;font-size:${cpx(18)};line-height:1.25">${esc(c.title || c.text || '')}</div>${c.text && c.title ? `<div style="font-size:${cpx(14.5)};color:${C.muted};margin-top:${cpx(3)};line-height:1.3">${esc(c.text)}</div>` : ''}</div>`);
        el2.setAttribute('data-block', String(c.title || c.text || 'callout').slice(0, 40));
        const fy = c.y ?? [0.16, 0.62][k] ?? 0.4;
        let x, y;
        if (side === 'left') { x = wx - cw * 0.8; y = wy + wh * fy - 30 * U; }
        else if (side === 'right') { x = wx + ww - cw * 0.2; y = wy + wh * fy - 30 * U; }
        else if (side === 'top') { x = wx + ww * (c.x ?? [0.3, 0.7][k] ?? 0.5) - cw / 2; y = wy - 102 * U; }
        else { x = wx + ww * (c.x ?? [0.7, 0.3][k] ?? 0.5) - cw / 2; y = wy + wh - 12 * U; }
        el2.style.left = `${Math.max(B.x - 10 * U, Math.min(B.x + B.w - cw + 10 * U, x))}px`;
        el2.style.top = `${y}px`;
        return { el: el2, at: 0.9 + i * 0.75 * ctx.motion, side };
      });
      // The window is not a block: callouts are meant to overlap its edges; only callouts colliding with each other count.
      win.setAttribute('data-asset', 'product window');
      const dur = Math.max(3.4, 1.2 + callouts.length * 0.75 * ctx.motion + 1.4);
      return {
        dur, html: root, noFit: true,
        draw(lt) {
          const p = lt / dur;
          const e = outCubic(prog(lt, 0, 1.0));
          const ry = (tall ? -10 : -20) * (1 - e) + (tall ? -4 : -8) + 6 * p;
          const rx = 12 * (1 - e) + 5 - 2 * p;
          const sc = 0.92 + 0.06 * e + 0.03 * p;
          win.style.transform = `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) scale(${sc.toFixed(4)})`;
          win.style.opacity = clamp01(e * 1.6).toFixed(3);
          ghosts.forEach((gh, k) => { gh.style.transform = `translateX(${((k ? 1 : -1) * (1 - e) * 60 + (k ? -1 : 1) * p * 24) * U}px)`; gh.style.opacity = (0.45 * e).toFixed(3); });
          sweep.style.transform = `translateX(${(-0.3 + 1.6 * prog(lt, 0.6, 1.8)) * ww}px) skewX(-12deg)`;
          callouts.forEach((c) => {
            const k = outBack(prog(lt, c.at, 0.5));
            const o = clamp01(k * 1.5);
            const dx = c.side === 'left' ? -1 : c.side === 'right' ? 1 : 0, dy = c.side === 'top' ? -1 : c.side === 'bottom' ? 1 : 0;
            c.el.style.opacity = o.toFixed(3);
            c.el.style.transform = `translate(${(1 - clamp01(k)) * dx * 30 * U}px, ${((1 - clamp01(k)) * dy * 30 + Math.sin(lt * 1.2 + c.at) * 3) * U}px) scale(${(0.94 + 0.06 * clamp01(k)).toFixed(4)})`;
          });
        },
      };
    },
  };

  function sparkle(cx, cy, r) {
    const k = r * 0.22;
    return `M${cx},${cy - r} C${cx + k * 0.4},${cy - k} ${cx + k},${cy - k * 0.4} ${cx + r},${cy} C${cx + k},${cy + k * 0.4} ${cx + k * 0.4},${cy + k} ${cx},${cy + r} C${cx - k * 0.4},${cy + k} ${cx - k},${cy + k * 0.4} ${cx - r},${cy} C${cx - k},${cy - k * 0.4} ${cx - k * 0.4},${cy - k} ${cx},${cy - r} Z`;
  }
  SCENES.sparklePath = sparkle;

  window.FlowScenes = SCENES;
})();
