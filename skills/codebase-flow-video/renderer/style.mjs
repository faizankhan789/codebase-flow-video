// Resolves a storyboard's look: preset <- storyboard "style" overrides (usually from detect-style.mjs).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PRESETS = JSON.parse(readFileSync(join(HERE, 'engine', 'styles.json'), 'utf8'));
const HEX = /^#[0-9a-fA-F]{6}$/;

// ---------- colour maths (WCAG relative luminance) ----------
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const lum = (hex) => {
  const [r, g, b] = rgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// Moves a colour toward white (on dark backgrounds) or black (on light) until it reaches the target contrast.
export function ensureContrast(fg, bg, target = 3) {
  if (contrast(fg, bg) >= target) return fg;
  const dark = lum(bg) < 0.4;
  const [r, g, b] = rgb(fg);
  for (let k = 0.05; k <= 1; k += 0.05) {
    const c = dark ? [r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k] : [r * (1 - k), g * (1 - k), b * (1 - k)];
    const hex = toHex(c);
    if (contrast(hex, bg) >= target) return hex;
  }
  return dark ? '#FFFFFF' : '#000000';
}

// Returns { style, fontUrl, errors, warnings }.
export function resolveStyle(sb, sbDir) {
  const errors = [], warnings = [];
  const o = sb.style || {};
  const name = o.preset || (sb.theme === 'light' ? 'daylight' : 'midnight');
  if (!PRESETS[name]) { errors.push(`style.preset "${name}" is unknown (use ${Object.keys(PRESETS).join(', ')})`); return { errors, warnings }; }
  const st = JSON.parse(JSON.stringify(PRESETS[name]));
  st.preset = name;
  delete st.about;
  const setColor = (key, val, where) => { if (val === undefined) return; if (!HEX.test(val)) errors.push(`${where} must be a hex colour like #7C5CFF`); else st[key] = val; };
  setColor('accent', sb.accent, '"accent"');
  for (const k of ['accent', 'accent2', 'good', 'bad', 'warn']) setColor(k, o[k], `style.${k}`);
  for (const [k, v] of Object.entries(o.colors || {})) { if (!(k in st.colors)) errors.push(`style.colors.${k} is not a colour slot (${Object.keys(st.colors).join(', ')})`); else st.colors[k] = v; }
  for (const [k, v] of Object.entries(o.kinds || {})) { if (!HEX.test(v)) errors.push(`style.kinds.${k} must be hex`); else st.kinds[k] = v; }
  if (o.radius !== undefined) { if (!(o.radius >= 0 && o.radius <= 40)) errors.push('style.radius must be 0-40'); else st.radius = o.radius; }
  if (o.background !== undefined) { if (!['glow-dots', 'grid', 'plain'].includes(o.background)) errors.push('style.background must be glow-dots, grid or plain'); else st.background = o.background; }
  if (o.motion !== undefined) { if (!['calm', 'standard', 'snappy'].includes(o.motion)) errors.push('style.motion must be calm, standard or snappy'); else st.motion = o.motion; }

  let fontUrl = null;
  if (o.font?.file) {
    const f = resolve(sbDir, o.font.file);
    if (!existsSync(f)) errors.push(`style.font.file not found: ${f}`);
    else { fontUrl = pathToFileURL(f).href; st.font.name = 'BrandFont'; st.font.family = `"BrandFont", ${st.font.family}`; }
  } else if (o.font?.family) {
    st.font.family = `${/[\s"]/.test(o.font.family) && !o.font.family.includes(',') ? `"${o.font.family.replace(/"/g, '')}"` : o.font.family}, ${st.font.family}`;
  }

  // Brand colours often fail on the video background; nudge them until readable and say so.
  const bg = st.colors.bg;
  for (const k of ['accent', 'accent2', 'good', 'bad', 'warn']) {
    const fixed = ensureContrast(st[k], bg, 3);
    if (fixed.toLowerCase() !== st[k].toLowerCase()) { warnings.push(`style.${k} ${st[k]} has low contrast on ${bg}; using ${fixed}`); st[k] = fixed; }
  }
  for (const [k, v] of Object.entries(st.kinds)) st.kinds[k] = ensureContrast(v, bg, 2.6);
  return { style: st, fontUrl, errors, warnings };
}

export function listStyles() {
  return Object.entries(PRESETS).map(([k, v]) => `${k.padEnd(11)} ${v.theme.padEnd(5)} ${v.accent}  ${v.about}`);
}
