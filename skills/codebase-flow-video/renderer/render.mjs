#!/usr/bin/env node
// Renders storyboard.json into animated MP4s (16:9, 1:1, 9:16) using headless Chromium + ffmpeg.
//
//   node render.mjs <storyboard.json> [--out DIR] [--formats 16x9,1x1,9x16]
//                   [--preview] [--music FILE] [--volume 0.5] [--fps 30] [--check]
//                   [--list-icons]
import { readFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = pathToFileURL(join(HERE, 'engine', 'index.html')).href;
const ICONS = JSON.parse(readFileSync(join(HERE, 'engine', 'icons.json'), 'utf8'));
const FORMATS = { '16x9': [1920, 1080], '1x1': [1080, 1080], '9x16': [1080, 1920] };
const KINDS = ['actor', 'step', 'decision', 'store', 'external', 'ai', 'output'];

function parseArgs(argv) {
  const opts = { formats: Object.keys(FORMATS), fps: 30, volume: 0.5 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--out') opts.out = next();
    else if (a === '--formats') opts.formats = next().split(',').map((s) => s.trim());
    else if (a === '--preview') opts.preview = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--music') opts.music = next();
    else if (a === '--volume') opts.volume = Number(next());
    else if (a === '--fps') opts.fps = Number(next());
    else if (a === '--list-icons') opts.listIcons = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else rest.push(a);
  }
  opts.storyboard = rest[0];
  return opts;
}

// Returns a list of human-readable problems; empty means the storyboard is renderable.
export function validate(sb) {
  const errs = [];
  if (!sb || typeof sb !== 'object') return ['storyboard must be a JSON object'];
  if (!sb.title) errs.push('missing "title"');
  if (sb.theme && !['dark', 'light'].includes(sb.theme)) errs.push('"theme" must be "dark" or "light"');
  if (sb.accent && !/^#[0-9a-fA-F]{6}$/.test(sb.accent)) errs.push('"accent" must be a hex colour like #7C5CFF');
  if (!Array.isArray(sb.nodes) || !sb.nodes.length) errs.push('"nodes" must be a non-empty array');
  if (!Array.isArray(sb.scenes) || !sb.scenes.length) errs.push('"scenes" must be a non-empty array');
  if (errs.length) return errs;

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

  const revealed = new Set();
  sb.scenes.forEach((s, i) => {
    const at = `scenes[${i}]`;
    if (!s.caption) errs.push(`${at}: missing "caption"`);
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
  });
  if (!revealed.size) errs.push('no scene reveals any node');
  return errs;
}

function softWarnings(sb) {
  const w = [];
  const revealed = new Set(sb.scenes.flatMap((s) => s.reveal || []));
  sb.nodes.forEach((n) => { if (!revealed.has(n.id)) w.push(`node "${n.id}" is never revealed in a scene; it only appears in the outro`); });
  sb.scenes.forEach((s, i) => {
    const words = (s.caption || '').split(/\s+/).filter(Boolean).length;
    if (words > 35) w.push(`scene ${i + 1}: caption is ${words} words; aim for <= 30 so viewers can read it`);
    if ((s.reveal || []).length > 5) w.push(`scene ${i + 1}: reveals ${s.reveal.length} nodes at once; aim for <= 4`);
  });
  const titled = sb.scenes.filter((s) => s.title).length;
  if (titled && titled < sb.scenes.length) w.push(`${titled} of ${sb.scenes.length} scenes have a "title"; give every scene a title or none, so kickers read consistently`);
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

async function openPage(browser, sb, fmt) {
  const [width, height] = FORMATS[fmt];
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(ENGINE);
  await page.evaluate(() => document.fonts.ready);
  let info;
  try {
    info = await page.evaluate(([s, o]) => window.__setup(s, o), [sb, { width, height, icons: ICONS }]);
  } catch (e) {
    fail(`[${fmt}] engine error: ${e.message}${errors.length ? '\n' + errors.join('\n') : ''}`);
  }
  return { page, info, width, height };
}

const fmtTime = (s) => { const r = Math.round(s); return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`; };

async function preview(browser, sb, fmt, outDir) {
  const { page, info } = await openPage(browser, sb, fmt);
  const dir = join(outDir, 'preview');
  mkdirSync(dir, { recursive: true });
  const shots = [['00-intro', 2.0]];
  info.marks.forEach((m, i) => shots.push([`${String(i + 1).padStart(2, '0')}-scene`, m.end - 0.6]));
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
  if (opts.help || !opts.storyboard) {
    console.log('Usage: node render.mjs <storyboard.json> [--out DIR] [--formats 16x9,1x1,9x16] [--preview] [--check] [--music FILE] [--volume 0.5] [--fps 30] [--list-icons]');
    process.exit(opts.help ? 0 : 1);
  }
  const sbPath = resolve(opts.storyboard);
  if (!existsSync(sbPath)) fail(`storyboard not found: ${sbPath}`);
  let sb;
  try { sb = JSON.parse(readFileSync(sbPath, 'utf8')); } catch (e) { fail(`invalid JSON in ${sbPath}: ${e.message}`); }

  const errs = validate(sb);
  if (errs.length) fail(`Storyboard has ${errs.length} problem(s):\n- ${errs.join('\n- ')}`);
  const bad = opts.formats.filter((f) => !FORMATS[f]);
  if (bad.length) fail(`unknown format(s): ${bad.join(', ')} (use ${Object.keys(FORMATS).join(', ')})`);
  if (opts.music && !(existsSync(opts.music) && statSync(opts.music).isFile())) fail(`music file not found: ${opts.music}`);
  if (!opts.check && !opts.preview && spawnSync('ffmpeg', ['-version']).status !== 0) {
    fail('ffmpeg not found. Install it (macOS: brew install ffmpeg, Ubuntu: apt-get install ffmpeg).');
  }

  const outDir = resolve(opts.out || dirname(sbPath));
  mkdirSync(outDir, { recursive: true });
  softWarnings(sb).forEach((w) => console.log(`WARN ${w}`));

  const chromium = await loadPlaywright();
  const browser = await chromium.launch();
  try {
    if (opts.check || opts.preview) {
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

    console.log(`Rendering ${opts.formats.join(', ')} at ${opts.fps} fps into ${outDir}`);
    const results = await Promise.all(opts.formats.map((fmt) => render(browser, sb, fmt, outDir, opts)));
    for (const { out, info } of results) {
      info.warnings.forEach((w) => console.log(`WARN [${basename(out)}] ${w}`));
      console.log(`DONE ${out} (${fmtTime(info.duration)})`);
    }
    const longest = Math.max(...results.map((r) => r.info.duration));
    if (longest > 600) console.log(`WARN video is ${fmtTime(longest)}; LinkedIn caps uploads at 10:00. Consider a highlights storyboard.`);
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => fail(e.stack || String(e)));
}
