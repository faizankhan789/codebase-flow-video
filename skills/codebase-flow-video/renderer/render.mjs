#!/usr/bin/env node
// Renders storyboard.json into animated MP4s (16:9, 1:1, 9:16) using headless Chromium + ffmpeg.
//
//   node render.mjs <storyboard.json> [--out DIR] [--formats 16x9,1x1,9x16]
//                   [--preview] [--bg white|dark|#hex] [--music FILE | --no-music] [--volume 0.5] [--fps 30] [--check]
//
// Without --music, an original track is generated to fit the video (music.mjs); --no-music renders silent.
//                   [--flow FLOW.md] [--export svg,png] [--list-icons] [--list-styles]
//
// When FLOW.md sits next to the storyboard (or --flow is given), every storyboard "ref" is
// checked against it and every branch in its branch index must be shown or listed in "omitted".
import { readFileSync, mkdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve, basename, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadFlow, flowIds, defaultFlowPath } from './flowdoc.mjs';
import { resolveStyle, listStyles } from './style.mjs';
import { validateVisual, visualText, visualLengthWarnings } from './visuals.mjs';
import { generateMusic } from './music.mjs';
import { exportAssets } from './export-assets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = pathToFileURL(join(HERE, 'engine', 'index.html')).href;
const ICONS = JSON.parse(readFileSync(join(HERE, 'engine', 'icons.json'), 'utf8'));
const FORMATS = { '16x9': [1920, 1080], '1x1': [1080, 1080], '9x16': [1080, 1920] };
const KINDS = ['actor', 'step', 'decision', 'store', 'external', 'ai', 'output'];

function parseArgs(argv) {
  const opts = { formats: Object.keys(FORMATS), fps: 30 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--out') opts.out = next();
    else if (a === '--formats') opts.formats = next().split(',').map((s) => s.trim());
    else if (a === '--preview') opts.preview = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--music') opts.music = next();
    else if (a === '--no-music') opts.noMusic = true;
    else if (a === '--bg') opts.bg = next();
    else if (a === '--export') { const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? next() : 'svg,png'; opts.export = new Set(v.split(',').map((x) => x.trim())); }
    else if (a === '--volume') opts.volume = Number(next());
    else if (a === '--fps') opts.fps = Number(next());
    else if (a === '--flow') opts.flow = next();
    else if (a === '--list-icons') opts.listIcons = true;
    else if (a === '--list-styles') opts.listStyles = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else rest.push(a);
  }
  opts.storyboard = rest[0];
  return opts;
}

// Every "ref" anywhere inside a visual object.
export function visualRefs(v) {
  const out = [];
  const walk = (x) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) { if (k === 'ref') out.push(...[].concat(y)); else walk(y); }
  };
  walk(v);
  return out.filter((r) => typeof r === 'string');
}

// Coverage numbers for the console: how much of FLOW.md the storyboard shows.
export function coverage(sb, flow) {
  const used = new Set([...refHolders(sb).flatMap(([, o]) => asList(o.ref)), ...sb.scenes.flatMap((s) => visualRefs(s.visual))]);
  const om = new Set((sb.omitted || []).map((o) => o && o.ref));
  const steps = [...flow.steps.keys()], branches = [...flow.branches.keys()];
  const shown = (ids) => ids.filter((id) => used.has(id)).length;
  const left = (ids) => ids.filter((id) => !used.has(id) && (om.has(id) || om.has(id.split('.')[0]))).length;
  return { steps: steps.length, stepsShown: shown(steps), stepsOmitted: left(steps), branches: branches.length, branchesShown: shown(branches), branchesOmitted: left(branches) };
}

const asList = (r) => (r === undefined ? [] : Array.isArray(r) ? r : [r]);
// Every object that may carry a "ref" to FLOW.md ids, with a name for messages.
const refHolders = (sb) => [
  ['storyboard', sb],
  ...(sb.nodes || []).map((n) => [`node "${n.id}"`, n]),
  ...(sb.edges || []).map((e) => [`edge ${e.from} -> ${e.to}`, e]),
  ...(sb.scenes || []).map((s, i) => [`scenes[${i}]`, s]),
  ...(sb.outro ? [['outro', sb.outro]] : []),
];

// Returns a list of human-readable problems; empty means the storyboard is renderable.
// `flow` is a parsed FLOW.md (flowdoc.parseFlow) or null when none is available.
export function validate(sb, flow = null) {
  const errs = [];
  if (!sb || typeof sb !== 'object') return ['storyboard must be a JSON object'];
  if (!sb.title) errs.push('missing "title"');
  if (sb.theme && !['dark', 'light'].includes(sb.theme)) errs.push('"theme" must be "dark" or "light"');
  if (sb.accent && !/^#[0-9a-fA-F]{6}$/.test(sb.accent)) errs.push('"accent" must be a hex colour like #7C5CFF');
  if (sb.nodes !== undefined && !Array.isArray(sb.nodes)) errs.push('"nodes" must be an array');
  if (!Array.isArray(sb.scenes) || !sb.scenes.length) errs.push('"scenes" must be a non-empty array');
  if (errs.length) return errs;
  sb.nodes = sb.nodes || [];
  const mapScenes = sb.scenes.filter((s) => !s.visual);
  if (!sb.nodes.length && mapScenes.length) errs.push(`${mapScenes.length} scene(s) have no "visual" and there are no "nodes" to show; give each scene a visual or add nodes`);

  const ids = new Set();
  sb.nodes.forEach((n, i) => {
    if (!n.id) errs.push(`nodes[${i}]: missing "id"`);
    else if (ids.has(n.id)) errs.push(`nodes[${i}]: duplicate id "${n.id}"`);
    ids.add(n.id);
    if (!n.label) errs.push(`node "${n.id}": missing "label"`);
    if (n.kind && !KINDS.includes(n.kind)) errs.push(`node "${n.id}": unknown kind "${n.kind}" (use ${KINDS.join(', ')})`);
    if (n.icon && !ICONS[n.icon]) errs.push(`node "${n.id}": unknown icon "${n.icon}" (run --list-icons)`);
    if (n.color && !/^#[0-9a-fA-F]{6}$/.test(n.color)) errs.push(`node "${n.id}": "color" must be hex`);
  });

  const edgeKeys = new Set();
  (sb.edges || []).forEach((e, i) => {
    if (!ids.has(e.from)) errs.push(`edges[${i}]: unknown "from" node "${e.from}"`);
    if (!ids.has(e.to)) errs.push(`edges[${i}]: unknown "to" node "${e.to}"`);
    if (e.from === e.to) errs.push(`edges[${i}]: self-loop on "${e.from}" is not drawable; add a separate retry node`);
    edgeKeys.add(`${e.from}->${e.to}`);
  });
  sb.nodes.forEach((n) => {
    if (n.kind !== 'decision') return;
    const out = (sb.edges || []).filter((e) => e.from === n.id).length;
    if (out < 2) errs.push(`decision "${n.id}" has ${out} outgoing edge(s); a decision needs every outcome drawn (add an outcome node such as "Rejected")`);
  });

  const revealed = new Set();
  sb.scenes.forEach((s, i) => {
    const at = `scenes[${i}]`;
    if (!s.caption && !['headline', 'showcase'].includes(s.visual?.type)) errs.push(`${at}: missing "caption"`);
    (s.reveal || []).forEach((id) => {
      if (!ids.has(id)) errs.push(`${at}.reveal: unknown node "${id}"`);
      revealed.add(id);
    });
    (s.focus || []).forEach((id) => {
      if (!ids.has(id)) errs.push(`${at}.focus: unknown node "${id}"`);
      else if (!revealed.has(id)) errs.push(`${at}.focus: node "${id}" is not revealed yet`);
    });
    (s.flow || []).forEach((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) { errs.push(`${at}.flow: each entry must be ["from","to"]`); return; }
      const [a, b] = pair;
      if (!edgeKeys.has(`${a}->${b}`)) errs.push(`${at}.flow: no edge ${a} -> ${b} in "edges"`);
      else if (!revealed.has(a) || !revealed.has(b)) errs.push(`${at}.flow: ${a} -> ${b} used before both nodes are revealed`);
    });
    if (s.hold !== undefined && !(s.hold >= 0)) errs.push(`${at}.hold must be a number >= 0`);
    if (s.chapter !== undefined && (typeof s.chapter !== 'string' || !s.chapter.trim())) errs.push(`${at}.chapter must be a short title (the pipeline this scene belongs to)`);
    if (s.transition !== undefined && !['rise', 'zoom', 'slide', 'fade'].includes(s.transition)) errs.push(`${at}.transition must be rise, zoom, slide or fade`);
    if (s.visual !== undefined) {
      errs.push(...validateVisual(s.visual, `${at}.visual`, ICONS));
      if (s.flow?.length) errs.push(`${at}: a scene with a "visual" cannot also have "flow" (packets run on the map only)`);
    }
  });
  if (sb.nodes.length && !revealed.size) errs.push('no scene reveals any node');

  if (sb.journey !== undefined && (!sb.journey || typeof sb.journey.item !== 'string')) errs.push('"journey" needs "item": the thing the story follows, e.g. { "item": "Order #1042", "icon": "cart" }');
  if (sb.journey?.icon && !ICONS[sb.journey.icon]) errs.push(`journey.icon: unknown icon "${sb.journey.icon}"`);
  if (sb.intro?.highlights !== undefined) {
    if (!Array.isArray(sb.intro.highlights) || sb.intro.highlights.length > 5) errs.push('intro.highlights: up to 5 items like { "label": "3 agents", "icon": "robot" }');
    else sb.intro.highlights.forEach((h, i) => { if (!(h && (h.label || typeof h === 'string'))) errs.push(`intro.highlights[${i}] needs "label"`); if (h?.icon && !ICONS[h.icon]) errs.push(`intro.highlights[${i}].icon: unknown icon "${h.icon}"`); });
  }
  if (sb.omitted !== undefined && !Array.isArray(sb.omitted)) errs.push('"omitted" must be an array of { "ref", "reason" }');
  const omitted = Array.isArray(sb.omitted) ? sb.omitted : [];
  omitted.forEach((o, i) => {
    if (!o || !o.ref) errs.push(`omitted[${i}]: missing "ref"`);
    if (!o || !o.reason) errs.push(`omitted[${i}]: missing "reason" (say why the viewer does not need it)`);
  });
  if (flow) {
    const known = flowIds(flow);
    const used = new Set();
    for (const [name, obj] of refHolders(sb)) {
      asList(obj.ref).forEach((id) => {
        if (!known.has(id)) errs.push(`${name}: ref "${id}" is not a step or branch id in FLOW.md`);
        used.add(id);
      });
    }
    // Refs inside visuals (an agent step, a pipeline stage, a check, an outcome) count too.
    sb.scenes.forEach((s, i) => visualRefs(s.visual).forEach((id) => {
      if (!known.has(id)) errs.push(`scenes[${i}].visual: ref "${id}" is not a step or branch id in FLOW.md`);
      used.add(id);
    }));
    // Every step must be shown somewhere or deliberately left out: big projects get chapters, not shortcuts.
    const omittedIds = new Set(omitted.map((o) => o && o.ref));
    const covered = (id) => used.has(id) || omittedIds.has(id) || omittedIds.has(id.split('.')[0]);
    const missing = [...flow.steps.keys()].filter((id) => !covered(id));
    if (missing.length) {
      errs.push(`${missing.length} of ${flow.steps.size} FLOW.md steps are not shown in any scene and not in "omitted": ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', …' : ''}. ` +
        'Add "ref" on the scene or visual element that shows each step (a pipeline stage, agent step, check or outcome can carry its own ref), add scenes or chapters, or list it in "omitted" with a reason.');
    }
    omitted.forEach((o, i) => { if (o && /^P\d+$/.test(o.ref || '') && ![...flow.steps.keys()].some((k) => k.startsWith(o.ref + '.'))) errs.push(`omitted[${i}]: no steps in FLOW.md start with ${o.ref}.`); });
    omitted.forEach((o, i) => { if (o && o.ref && !known.has(o.ref) && !/^P\d+$/.test(o.ref)) errs.push(`omitted[${i}]: ref "${o.ref}" is not in FLOW.md`); });
    for (const id of flow.branches.keys()) {
      if (!used.has(id) && !omittedIds.has(id)) errs.push(`branch ${id} from FLOW.md is neither shown (no "ref": "${id}") nor listed in "omitted"`);
    }
  }
  return errs;
}

// Captions are where plain-language translation invents facts: speed, security, absolutes.
const CLAIM_PATTERNS = [
  /\binstant(ly)?\b/i, /\breal[- ]time\b/i, /\bnever\b/i, /\balways\b/i, /\bguarantee[ds]?\b/i,
  /\b100\s?%/, /\bzero\b/i, /\bsecure(ly)?\b/i, /\bbank[- ]grade\b/i, /\bfully\b/i,
  /\b\d+(\.\d+)?\s*(ms|milliseconds?|seconds?|minutes?|hours?|days?|%|x faster|times faster)\b/i,
  /\b(under|within|in) (a |an |one |a few |few |\d+ )?(seconds?|minutes?|hours?)\b/i,
];
const claimIn = (text) => { for (const re of CLAIM_PATTERNS) { const m = (text || '').match(re); if (m) return m[0]; } return null; };

function structureWarnings(sb) {
  const w = [];
  const edges = sb.edges || [];
  const byId = new Map(sb.nodes.map((n) => [n.id, n]));
  const flowed = new Set(sb.scenes.flatMap((s) => (s.flow || []).map(([a, b]) => `${a}->${b}`)));
  edges.forEach((e) => {
    if (byId.get(e.from)?.kind !== 'decision') return;
    if (!e.label) w.push(`edge ${e.from} -> ${e.to} leaves a decision but has no label; name the condition ("yes", "too risky")`);
    if (!flowed.has(`${e.from}->${e.to}`)) w.push(`decision outcome ${e.from} -> ${e.to} never carries a packet in any scene's "flow"; show every option`);
  });
  const actors = sb.nodes.filter((n) => n.kind === 'actor').map((n) => n.id);
  if (actors.length) {
    const seen = new Set(actors), queue = [...actors];
    while (queue.length) {
      const id = queue.shift();
      edges.forEach((e) => { if (e.from === id && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); } });
    }
    sb.nodes.forEach((n) => { if (!seen.has(n.id)) w.push(`node "${n.id}" cannot be reached from any actor; check its edges match the code's data flow`); });
  }
  return w;
}

function accuracyWarnings(sb, flow) {
  const w = [];
  const hasRef = (o) => asList(o.ref).length > 0;
  const texts = [['subtitle', sb, sb.subtitle], ['outro', sb.outro || {}, sb.outro && `${sb.outro.caption || ''} ${sb.outro.cta || ''}`]];
  sb.nodes.forEach((n) => texts.push([`node "${n.id}"`, n, `${n.label} ${n.sub || ''}`]));
  sb.scenes.forEach((s, i) => texts.push([`scene ${i + 1}`, s, `${s.title || ''} ${s.caption || ''} ${visualText(s.visual)}`]));
  for (const [name, obj, text] of texts) {
    const claim = claimIn(text);
    if (claim && !hasRef(obj)) w.push(`${name}: "${claim}" is a speed/security/absolute claim; keep it only if FLOW.md cites code for it (add "ref"), otherwise remove it`);
  }
  if (flow) {
    sb.scenes.forEach((s, i) => { if (s.visual && !hasRef(s)) w.push(`scene ${i + 1}: animated "${s.visual.type}" scene has no "ref" to the FLOW.md steps it shows`); });
    sb.nodes.forEach((n) => {
      if (n.kind === 'actor') return;
      if (!hasRef(n)) w.push(`node "${n.id}" has no "ref" to a FLOW.md step or branch`);
      else if (n.kind === 'decision' && !asList(n.ref).some((id) => flow.branches.has(id))) w.push(`decision "${n.id}" should ref a branch id (B<n>) from FLOW.md`);
    });
  } else if (refHolders(sb).some(([, o]) => hasRef(o)) || sb.omitted) {
    w.push('storyboard has refs but no FLOW.md was found next to it; refs were not checked (pass --flow FLOW.md)');
  }
  return w;
}

export function softWarnings(sb, flow = null) {
  const w = [...structureWarnings(sb), ...accuracyWarnings(sb, flow), ...sb.scenes.flatMap((s, i) => visualLengthWarnings(s.visual, `scene ${i + 1}`))];
  const revealed = new Set(sb.scenes.flatMap((s) => s.reveal || []));
  sb.nodes.forEach((n) => { if (!revealed.has(n.id)) w.push(`node "${n.id}" is never revealed in a scene; it only appears in the outro`); });
  sb.scenes.forEach((s, i) => {
    const words = (s.caption || '').split(/\s+/).filter(Boolean).length;
    if (words > 35) w.push(`scene ${i + 1}: caption is ${words} words; aim for <= 30 so viewers can read it`);
    if ((s.reveal || []).length > 5) w.push(`scene ${i + 1}: reveals ${s.reveal.length} nodes at once; aim for <= 4`);
  });
  const stepScenes = sb.scenes.filter((s) => s.visual?.type !== 'headline' && s.caption);
  const titled = stepScenes.filter((s) => s.title).length;
  if (titled && titled < stepScenes.length) w.push(`${titled} of ${stepScenes.length} scenes have a "title"; give every scene a title or none, so kickers read consistently`);
  (sb.edges || []).forEach((e) => {
    if (e.label && e.label.split(/\s+/).length > 3) w.push(`edge ${e.from} -> ${e.to}: label "${e.label}" is long; use 1-3 words`);
  });
  if (!sb.outro || !sb.outro.caption) w.push('no "outro.caption"; the final overview will have no message');
  return w;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

async function loadPlaywright() {
  try {
    return (await import('playwright')).chromium;
  } catch {
    fail(`Playwright is not installed. Run once:\n  bash ${join(HERE, 'setup.sh')}`);
  }
}

// Style, font and screenshot paths are resolved here so the page only receives file URLs.
// Asset paths may point anywhere inside the project the storyboard belongs to (the folder above it),
// never outside it, and only to image or font files.
export function assetPath(sbDir, p, exts) {
  const base = resolve(sbDir, '..');
  const f = resolve(sbDir, p);
  const rel = relative(base, f);
  if (isAbsolute(p) || rel.startsWith('..') || isAbsolute(rel)) return { error: `${p} is outside the project (${base})` };
  if (!exts.test(f)) return { error: `${p} is not an allowed file type` };
  return { file: f };
}

function prepareAssets(sb, sbDir, bg) {
  const r = resolveStyle(sb, sbDir, bg);
  const images = {}, errors = [...r.errors];
  for (const s of sb.scenes) {
    if (!['screen', 'showcase'].includes(s.visual?.type) || !s.visual.src) continue;
    const a = assetPath(sbDir, s.visual.src, /\.(png|jpe?g|webp|gif)$/i);
    if (a.error) { errors.push(`screenshot ${a.error}`); continue; }
    const f = a.file;
    if (!existsSync(f)) errors.push(`screenshot not found: ${f}`);
    else images[s.visual.src] = pathToFileURL(f).href;
  }
  return { style: r.style, fontUrl: r.fontUrl, images, errors, warnings: r.warnings };
}

async function openPage(browser, sb, fmt) {
  const [width, height] = FORMATS[fmt];
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(ENGINE);
  await page.evaluate(() => document.fonts.ready);
  let info;
  try {
    const a = sb.__assets;
    info = await page.evaluate(([s, o]) => window.__setup(s, o), [sb, { width, height, icons: ICONS, style: a.style, images: a.images, fontUrl: a.fontUrl }]);
  } catch (e) {
    fail(`[${fmt}] engine error: ${e.message}${errors.length ? '\n' + errors.join('\n') : ''}`);
  }
  frameGate(info, fmt);
  return { page, info, width, height };
}

// Frame rule: nothing in a video may be cut by the frame, in any aspect ratio. The engine shrinks
// scenes that reach past the frame (reported once per format); anything still cut stops the render.
// Previews still write their frames so the problem can be seen, but exit with an error.
const gateSeen = new Set();
let gateSoft = false;
function frameGate(info, fmt) {
  if (!gateSeen.has(fmt)) (info.notes || []).forEach((n) => console.log(`FIT [${fmt}] ${n}`));
  gateSeen.add(fmt);
  const errs = info.clipErrors || [];
  if (!errs.length) return;
  errs.forEach((e) => console.error(`ERROR [${fmt}] ${e}`));
  const msg = `[${fmt}] ${errs.length} element(s) cut by the frame; shorten the text or use fewer items in those scenes`;
  if (gateSoft) { console.error(`ERROR ${msg}`); process.exitCode = 1; } else fail(msg);
}

const fmtTime = (s) => { const r = Math.round(s); return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`; };

async function preview(browser, sb, fmt, outDir) {
  const { page, info } = await openPage(browser, sb, fmt);
  const dir = join(outDir, 'preview');
  mkdirSync(dir, { recursive: true });
  const shots = [['00-intro', 2.0]];
  info.marks.forEach((m, i) => shots.push([`${String(i + 1).padStart(2, '0')}-scene`, m.end - 0.6]));
  (info.chapters || []).forEach((c, i) => shots.push([`${String(info.marks.findIndex((m) => m.start >= c.end) + 1).padStart(2, '0')}-chapter${i + 1}`, (c.start + c.end) / 2]));
  shots.push(['98-outro', info.endStart - 0.3], ['99-end', info.duration - 0.2]);
  const files = [];
  for (const [name, t] of shots) {
    await page.evaluate((x) => window.__seek(x), t);
    const file = join(dir, `${fmt}-${name}.png`);
    await page.screenshot({ path: file, type: 'png' });
    files.push(file);
  }
  await page.close();
  // One contact sheet per format so all scenes can be reviewed in a single image.
  const sheet = join(dir, `${fmt}-sheet.png`);
  const cols = 4, rows = Math.ceil(files.length / cols);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-pattern_type', 'glob', '-i', join(dir, `${fmt}-[0-9]*.png`),
    '-vf', `scale=${fmt === '9x16' ? 270 : 480}:-1,tile=${cols}x${rows}:padding=8:color=white`, '-frames:v', '1', sheet]);
  if (r.status === 0) files.unshift(sheet);
  return { info, files, sheet: r.status === 0 ? sheet : null };
}

async function render(browser, sb, fmt, outDir, opts) {
  const { page, info } = await openPage(browser, sb, fmt);
  const out = join(outDir, `flow-${fmt}.mp4`);
  const total = Math.ceil(info.duration * opts.fps);
  const args = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(opts.fps), '-c:v', 'mjpeg', '-i', '-'];
  if (opts.music) args.push('-stream_loop', '-1', '-i', opts.music);
  args.push('-map', '0:v', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(opts.fps));
  if (opts.music) {
    const d = info.duration;
    args.push('-map', '1:a', '-af', `volume=${opts.volume},afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, d - 3).toFixed(2)}:d=3`,
      '-c:a', 'aac', '-b:a', '192k', '-t', d.toFixed(3));
  }
  args.push('-movflags', '+faststart', out);

  const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'pipe'] });
  let ffErr = '';
  ff.stderr.on('data', (d) => { ffErr += d; });
  const done = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}: ${ffErr.trim()}`)))));
  const write = (buf) => new Promise((res) => (ff.stdin.write(buf) ? res() : ff.stdin.once('drain', res)));

  let lastPct = -1;
  for (let f = 0; f < total; f++) {
    await page.evaluate((x) => window.__seek(x), f / opts.fps);
    await write(await page.screenshot({ type: 'jpeg', quality: 95 }));
    const pct = Math.floor((f / total) * 10) * 10;
    if (pct !== lastPct) { lastPct = pct; console.log(`  [${fmt}] ${pct}%`); }
  }
  ff.stdin.end();
  await done;
  await page.close();
  return { out, info };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.listIcons) { console.log(Object.keys(ICONS).join('\n')); return; }
  if (opts.listStyles) { console.log(listStyles().join('\n')); return; }
  if (opts.help || !opts.storyboard) {
    console.log('Usage: node render.mjs <storyboard.json> [--out DIR] [--formats 16x9,1x1,9x16] [--preview] [--check] [--bg white|dark|#hex] [--music FILE | --no-music] [--volume 0.5] [--fps 30] [--flow FLOW.md] [--export svg,png] [--list-icons] [--list-styles]');
    process.exit(opts.help ? 0 : 1);
  }
  const sbPath = resolve(opts.storyboard);
  if (!existsSync(sbPath)) fail(`storyboard not found: ${sbPath}`);
  let sb;
  try { sb = JSON.parse(readFileSync(sbPath, 'utf8')); } catch (e) { fail(`invalid JSON in ${sbPath}: ${e.message}`); }

  const flowPath = opts.flow ? resolve(opts.flow) : defaultFlowPath(sbPath);
  if (opts.flow && !existsSync(flowPath)) fail(`FLOW.md not found: ${flowPath}`);
  const flow = existsSync(flowPath) ? loadFlow(flowPath) : null;
  if (flow) console.log(`Checking refs against ${flowPath} (${flow.steps.size} steps, ${flow.branches.size} branches)`);

  const errs = validate(sb, flow);
  if (errs.length) fail(`Storyboard has ${errs.length} problem(s):\n- ${errs.join('\n- ')}`);
  if (flow) {
    const c = coverage(sb, flow);
    console.log(`Coverage: steps ${c.stepsShown}/${c.steps} shown, ${c.stepsOmitted} omitted; branches ${c.branchesShown}/${c.branches} shown, ${c.branchesOmitted} omitted`);
    if (c.steps && c.stepsOmitted / c.steps > 0.25) console.log(`WARN ${c.stepsOmitted} of ${c.steps} steps are left out; for a large project use chapters (one per pipeline) or one storyboard per pipeline instead of trimming`);
  }
  const bad = opts.formats.filter((f) => !FORMATS[f]);
  if (bad.length) fail(`unknown format(s): ${bad.join(', ')} (use ${Object.keys(FORMATS).join(', ')})`);
  if (opts.music && !(existsSync(opts.music) && statSync(opts.music).isFile())) fail(`music file not found: ${opts.music}`);
  if (!opts.check && !opts.preview && spawnSync('ffmpeg', ['-version']).status !== 0) {
    fail('ffmpeg not found. Install it (macOS: brew install ffmpeg, Ubuntu: apt-get install ffmpeg).');
  }

  const outDir = resolve(opts.out || dirname(sbPath));
  mkdirSync(outDir, { recursive: true });
  const assets = prepareAssets(sb, dirname(sbPath), opts.bg);
  if (assets.errors.length) fail(`Storyboard has ${assets.errors.length} problem(s):\n- ${assets.errors.join('\n- ')}`);
  Object.defineProperty(sb, '__assets', { value: assets, enumerable: false });
  assets.warnings.forEach((w) => console.log(`WARN ${w}`));
  console.log(`Style: ${assets.style.preset}, ${assets.style.theme} background ${assets.style.colors.bg}`);
  softWarnings(sb, flow).forEach((w) => console.log(`WARN ${w}`));

  const chromium = await loadPlaywright();
  const browser = await chromium.launch();
  try {
    if (opts.export) {
      const kinds = { svg: opts.export.has('svg'), png: opts.export.has('png') };
      if (!kinds.svg && !kinds.png) fail('--export takes svg, png or svg,png');
      for (const fmt of opts.formats) {
        const { page, info } = await openPage(browser, sb, fmt);
        const r = await exportAssets(page, info, fmt, outDir, kinds);
        await page.close();
        console.log(`[${fmt}] exported ${r.elements} element(s) from ${r.scenes} scene(s) to ${r.dir}`);
      }
    }
    if (opts.check || opts.preview) {
      gateSoft = true;
      for (const fmt of opts.formats) {
        if (opts.check) {
          const { page, info } = await openPage(browser, sb, fmt);
          await page.close();
          info.warnings.forEach((w) => console.log(`WARN [${fmt}] ${w}`));
          console.log(`[${fmt}] OK, duration ${fmtTime(info.duration)} (${info.duration.toFixed(1)}s), ${info.marks.length} scenes`);
        } else {
          const { info, files, sheet } = await preview(browser, sb, fmt, outDir);
          info.warnings.forEach((w) => console.log(`WARN [${fmt}] ${w}`));
          console.log(`[${fmt}] ${files.length} preview frames in ${join(outDir, 'preview')}, duration ${fmtTime(info.duration)}`);
          if (sheet) console.log(`[${fmt}] contact sheet: ${sheet}`);
        }
      }
      return;
    }

    let generated = null;
    if (!opts.music && !opts.noMusic) {
      // Compose a track that changes chord at each scene start, using the first format's timing.
      const { page, info } = await openPage(browser, sb, opts.formats[0]);
      await page.close();
      generated = join(outDir, '.music.wav');
      generateMusic(generated, { duration: info.duration, boundaries: [info.intro, ...info.marks.map((m) => m.start), info.outroStart, info.endStart], style: assets.style });
      opts.music = generated;
      opts.volume = opts.volume ?? 0.35;
      console.log(`Music: original track generated for this video (${assets.style.preset}, ${assets.style.motion}); pass --no-music for silence`);
    }
    opts.volume = opts.volume ?? 0.5;
    console.log(`Rendering ${opts.formats.join(', ')} at ${opts.fps} fps into ${outDir}`);
    const results = await Promise.all(opts.formats.map((fmt) => render(browser, sb, fmt, outDir, opts)));
    for (const { out, info } of results) {
      info.warnings.forEach((w) => console.log(`WARN [${basename(out)}] ${w}`));
      console.log(`DONE ${out} (${fmtTime(info.duration)})`);
    }
    if (generated) rmSync(generated, { force: true });
    const longest = Math.max(...results.map((r) => r.info.duration));
    if (longest > 600) console.log(`WARN video is ${fmtTime(longest)}; LinkedIn caps uploads at 10:00. Consider a highlights storyboard.`);
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => fail(e.stack || String(e)));
}
