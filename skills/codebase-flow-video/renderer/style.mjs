// Resolves a storyboard's look: preset <- storyboard "style" overrides (usually from detect-style.mjs).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PRESETS = JSON.parse(readFileSync(join(HERE, 'engine', 'styles.json'), 'utf8'));
const HEX = /^#[0-9a-fA-F]{6}$/;
// Colour slots also accept rgb()/rgba() (presets use rgba for panels and shadows); nothing else, so a
// storyboard value can never break out of the inline CSS or HTML the engine builds with it.
const COLOR = /^(#[0-9a-fA-F]{6}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\))$/;
// Font family names: letters, digits, spaces, hyphens and commas only.
const FONT = /^[\w\s\-,]{1,80}$/;

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
  const dark = contrast('#FFFFFF', bg) > contrast('#000000', bg);
  const [r, g, b] = rgb(fg);
  for (let k = 0.05; k <= 1; k += 0.05) {
    const c = dark ? [r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k] : [r * (1 - k), g * (1 - k), b * (1 - k)];
    const hex = toHex(c);
    if (contrast(hex, bg) >= target) return hex;
  }
  return dark ? '#FFFFFF' : '#000000';
}

const mix = (a, b, k) => toHex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * k));
const rgbaOf = (hex, a) => `rgba(${rgb(hex).join(',')},${a})`;
// Light when black text reads better on it than white text does (luminance above ~0.18).
export const isLightBg = (hex) => contrast('#000000', hex) >= contrast('#FFFFFF', hex);

// Derives every colour slot from one background colour, so cards, text, borders, glows and
// shadows always suit the background, whatever it is. A faint accent tint keeps it on-brand.
export function deriveColors(bg, accent) {
  if (isLightBg(bg)) {
    const ink = mix('#0F172A', accent, 0.08);
    return {
      bg, glow: mix(bg, accent, 0.07), dot: mix(bg, ink, 0.1), card: mix(bg, '#FFFFFF', 0.85),
      border: mix(mix(bg, ink, 0.13), accent, 0.08), text: ensureContrast(ink, bg, 12), muted: ensureContrast(mix(ink, bg, 0.38), bg, 4.8),
      edge: mix(bg, ink, 0.26), shadow: 'rgba(15,23,42,0.10)', pill: mix(bg, '#FFFFFF', 0.9), panel: rgbaOf(bg, 0.88),
    };
  }
  const tint = mix(bg, accent, 0.06);
  return {
    bg, glow: mix(bg, accent, 0.2), dot: mix(tint, '#FFFFFF', 0.07), card: mix(tint, '#FFFFFF', 0.06),
    border: mix(tint, '#FFFFFF', 0.16), text: ensureContrast('#EEF2FD', bg, 12), muted: ensureContrast(mix('#EEF2FD', bg, 0.42), bg, 4.8),
    edge: mix(tint, '#FFFFFF', 0.22), shadow: 'rgba(0,0,0,0.5)', pill: mix(tint, '#FFFFFF', 0.08), panel: rgbaOf(bg, 0.8),
  };
}

// Background: white by default for every preset. "theme": "dark" uses the preset's own dark palette,
// "bg": "#hex" any colour (light or dark is decided from the colour). opts.bg (--bg) wins over both.
function applyBackground(st, o, sb, cliBg) {
  const want = cliBg || o.bg || o.theme || (sb.theme === 'dark' ? 'dark' : 'white');
  const native = PRESETS[st.preset];
  if (want === 'dark') {
    if (native.theme === 'dark') { st.colors = { ...native.colors }; st.theme = 'dark'; return null; }
    st.colors = deriveColors('#0A0F1E', st.accent); st.theme = 'dark'; return null;
  }
  const bg = want === 'white' || want === 'light' ? '#FFFFFF' : want;
  if (!HEX.test(bg)) return `background must be white, dark or a hex colour like #F4F6FB (got "${want}")`;
  // Dark presets on a light background: status colours that read on light (users' own colours still win).
  if (native.theme === 'dark' && isLightBg(bg)) for (const [k, v] of Object.entries({ good: '#16A34A', bad: '#DC2626', warn: '#D97706' })) if (o[k] === undefined) st[k] = v;
  if (native.theme === 'light' && isLightBg(bg)) st.colors = { ...native.colors, bg, panel: rgbaOf(bg, 0.88), glow: mix(bg, native.colors.glow, 0.6) };
  else st.colors = deriveColors(bg, st.accent);
  st.theme = isLightBg(bg) ? 'light' : 'dark';
  return null;
}

// Returns { style, fontUrl, errors, warnings }.
export function resolveStyle(sb, sbDir, cliBg) {
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
  if (o.theme !== undefined && !['light', 'dark', 'white'].includes(o.theme)) errors.push('style.theme must be light or dark');
  if (o.bg !== undefined && !HEX.test(o.bg)) errors.push('style.bg must be a hex colour like #FFFFFF');
  if (!errors.length) { const e = applyBackground(st, o, sb, cliBg); if (e) errors.push(e); }
  for (const [k, v] of Object.entries(o.colors || {})) {
    if (!(k in st.colors)) errors.push(`style.colors.${k} is not a colour slot (${Object.keys(st.colors).join(', ')})`);
    else if (typeof v !== 'string' || !COLOR.test(v)) errors.push(`style.colors.${k} must be a hex colour like #121A30 or rgb()/rgba()`);
    else st.colors[k] = v;
  }
  for (const [k, v] of Object.entries(o.kinds || {})) { if (!HEX.test(v)) errors.push(`style.kinds.${k} must be hex`); else st.kinds[k] = v; }
  if (o.radius !== undefined) { if (!(o.radius >= 0 && o.radius <= 40)) errors.push('style.radius must be 0-40'); else st.radius = o.radius; }
  if (o.background !== undefined) { if (!['glow-dots', 'grid', 'plain'].includes(o.background)) errors.push('style.background must be glow-dots, grid or plain'); else st.background = o.background; }
  if (o.look !== undefined) { if (!['vivid', 'flat'].includes(o.look)) errors.push('style.look must be vivid or flat'); else st.look = o.look; }
  if (o.blobs !== undefined) { if (!Array.isArray(o.blobs) || !o.blobs.every((c) => HEX.test(c))) errors.push('style.blobs must be a list of hex colours'); else st.blobs = o.blobs; }
  if (o.emblem !== undefined) { if (!['sparkle', 'none'].includes(o.emblem)) errors.push('style.emblem must be sparkle or none'); else st.emblem = o.emblem; }
  if (o.lines !== undefined) st.lines = !!o.lines;
  if (o.motion !== undefined) { if (!['calm', 'standard', 'snappy'].includes(o.motion)) errors.push('style.motion must be calm, standard or snappy'); else st.motion = o.motion; }

  let fontUrl = null;
  if (o.font?.file) {
    const f = resolve(sbDir, o.font.file);
    const rel = relative(resolve(sbDir, '..'), f);
    if (isAbsolute(o.font.file) || rel.startsWith('..') || isAbsolute(rel)) errors.push(`style.font.file must be inside the project: ${o.font.file}`);
    else if (!/\.(woff2?|ttf|otf)$/i.test(f)) errors.push(`style.font.file must be a .woff2, .woff, .ttf or .otf file`);
    else if (!existsSync(f)) errors.push(`style.font.file not found: ${f}`);
    else { fontUrl = pathToFileURL(f).href; st.font.name = 'BrandFont'; st.font.family = `"BrandFont", ${st.font.family}`; }
  } else if (o.font?.family) {
    if (typeof o.font.family !== 'string' || !FONT.test(o.font.family)) errors.push('style.font.family may contain only letters, digits, spaces, hyphens and commas');
    else st.font.family = `${o.font.family.split(',').map((f) => f.trim()).filter(Boolean).map((f) => (/\s/.test(f) ? `"${f}"` : f)).join(', ')}, ${st.font.family}`;
  }

  // Brand colours often fail on the video background; nudge them until readable and say so.
  const bg = st.colors.bg;
  for (const k of ['accent', 'accent2', 'good', 'bad', 'warn']) {
    const fixed = ensureContrast(st[k], bg, 3);
    const userSet = o[k] !== undefined || (k === 'accent' && sb.accent !== undefined);
    if (fixed.toLowerCase() !== st[k].toLowerCase() && userSet) { warnings.push(`style.${k} ${st[k]} has low contrast on ${bg}; using ${fixed}`); }
    st[k] = fixed;
  }
  for (const [k, v] of Object.entries(st.kinds)) st.kinds[k] = ensureContrast(v, bg, 2.6);
  return { style: st, fontUrl, errors, warnings };
}

export function listStyles() {
  return Object.entries(PRESETS).map(([k, v]) => `${k.padEnd(11)} ${v.accent}  ${v.about}`)
    .concat(['', 'Background: white by default for every preset; style.theme "dark" for the preset\'s dark look, style.bg "#hex" for any colour, or --bg white|dark|#hex.']);
}
