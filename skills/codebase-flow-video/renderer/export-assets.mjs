// Exports the graphics used in a video: per scene a full frame (PNG and SVG) and every element
// (avatars, cards, callouts, badges...) as a standalone SVG and a transparent PNG.
//
// Called by render.mjs --export svg,png. Files go to <out>/assets/<format>/scene-NN/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const slug = (s) => String(s || 'element').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'element';

export async function exportAssets(page, info, fmt, outDir, kinds) {
  const base = join(outDir, 'assets', fmt);
  const manifest = [];
  for (let i = 0; i < info.marks.length; i++) {
    const t = info.marks[i].end - 0.6;
    await page.evaluate((x) => window.__seek(x), t);
    const dir = join(base, `scene-${String(i + 1).padStart(2, '0')}`);
    mkdirSync(dir, { recursive: true });
    const entry = { scene: i + 1, frame: {}, elements: [] };
    if (kinds.png) { await page.screenshot({ path: join(dir, 'frame.png') }); entry.frame.png = 'frame.png'; }
    // Everything drawn in SVG, plus a list of the visible elements with a standalone SVG for each.
    const data = await page.evaluate(() => {
      const svg = document.querySelector('#stage > svg');
      const ser = new XMLSerializer();
      const defs = svg.querySelector('defs');
      const visible = (n) => {
        const r = n.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        for (let e = n; e && e !== document.body; e = e.parentElement || e.parentNode) {
          if (e.getAttribute && (e.getAttribute('display') === 'none')) return false;
          const cs = e.nodeType === 1 ? getComputedStyle(e) : null;
          if (cs && (cs.display === 'none' || parseFloat(cs.opacity) < 0.05)) return false;
        }
        return true;
      };
      const els = [...document.querySelectorAll('#stage [data-block], #stage [data-asset]')].filter(visible).map((n, k) => {
        const r = n.getBoundingClientRect(), pad = 16;
        const box = { x: Math.max(0, r.left - pad), y: Math.max(0, r.top - pad), w: r.width + pad * 2, h: r.height + pad * 2 };
        let svgText = null;
        if (n instanceof SVGElement) {
          const m = n.parentNode.getCTM();
          svgText = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.x} ${box.y} ${box.w} ${box.h}" width="${Math.round(box.w)}" height="${Math.round(box.h)}">` +
            (defs ? ser.serializeToString(defs) : '') +
            `<g transform="matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})">${ser.serializeToString(n).replace(/ opacity="[^"]*"/, '').replace(/ display="none"/g, '')}</g></svg>`;
        }
        n.setAttribute('data-export-id', String(k));
        return { name: n.getAttribute('data-block') || n.getAttribute('data-asset'), box, svgText, html: !(n instanceof SVGElement) };
      });
      return { frame: ser.serializeToString(svg), els };
    });
    if (kinds.svg) { writeFileSync(join(dir, 'frame.svg'), data.frame); entry.frame.svg = 'frame.svg'; entry.frame.note = 'frame.svg holds the SVG layer; captions and 3D product windows are HTML and appear only in frame.png'; }
    const used = new Set();
    for (const [k, e] of data.els.entries()) {
      let name = slug(e.name);
      while (used.has(name)) name += '-2';
      used.add(name);
      const item = { name: e.name, box: e.box };
      if (kinds.svg && e.svgText) { writeFileSync(join(dir, `${name}.svg`), e.svgText); item.svg = `${name}.svg`; }
      if (kinds.png) {
        // Isolate the element: hide everything else and drop the background, then capture with transparency.
        await page.evaluate((id) => {
          document.documentElement.style.background = 'transparent';
          document.body.style.background = 'transparent';
          const stage = document.getElementById('stage');
          stage.dataset.prevVis = stage.style.visibility || '';
          stage.style.visibility = 'hidden';
          const n = document.querySelector(`[data-export-id="${id}"]`);
          n.style.visibility = 'visible';
        }, String(k));
        await page.screenshot({ path: join(dir, `${name}.png`), clip: { x: e.box.x, y: e.box.y, width: e.box.w, height: e.box.h }, omitBackground: true });
        await page.evaluate((id) => {
          const stage = document.getElementById('stage');
          stage.style.visibility = stage.dataset.prevVis;
          document.querySelector(`[data-export-id="${id}"]`).style.visibility = '';
        }, String(k));
        item.png = `${name}.png`;
      }
      entry.elements.push(item);
    }
    await page.evaluate(() => document.querySelectorAll('[data-export-id]').forEach((n) => n.removeAttribute('data-export-id')));
    manifest.push(entry);
  }
  writeFileSync(join(base, 'index.json'), JSON.stringify(manifest, null, 2));
  return { dir: base, scenes: manifest.length, elements: manifest.reduce((s, m) => s + m.elements.length, 0) };
}
