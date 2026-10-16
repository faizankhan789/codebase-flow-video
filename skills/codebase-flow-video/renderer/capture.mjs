#!/usr/bin/env node
// Captures real screenshots of a running app for "screen" scenes.
//
//   node capture.mjs flow-video/screens.json [--yes] [--allow-remote] [--dry-run]
//
// "start" runs a command from the config file, so it only runs with --yes (after the user approved it).
// It is split into arguments and run without a shell; shell operators are rejected.
//
// screens.json (paths relative to the repo root, which is the folder above flow-video/):
// {
//   "start": "npm run dev",                 optional: command that starts the app (omit if it already runs)
//   "cwd": ".",                             optional: where to run "start"
//   "url": "http://localhost:3000",         base URL
//   "readyTimeout": 90,                     seconds to wait for the app
//   "viewport": { "width": 1440, "height": 900 }   or "device": "phone"
//   "env": { "NEXT_PUBLIC_DEMO": "1" },     extra environment for "start" (demo values only, never production secrets)
//   "pages": [
//     { "id": "checkout", "path": "/checkout", "waitFor": "text=Pay now",
//       "actions": [ { "click": "text=Add to cart" }, { "fill": ["#email", "demo@example.com"] }, { "press": ["#email", "Enter"] }, { "wait": 500 } ],
//       "highlights": [ { "selector": "button:has-text('Pay')", "label": "One-click pay" } ],
//       "mask": [".user-email"], "fullPage": false }
//   ]
// }
// Writes flow-video/screens/<id>.png and flow-video/screens/manifest.json (sizes and highlight boxes as fractions).
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const LOCAL = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w-]+\.local|[\w-]+\.test|[\w-]+\.localhost)$/i;
const SHELL_META = /[;&|`$<>\\\n\r(){}*?!~]/;
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

function fail(msg) { console.error(msg); process.exit(1); }

export function validateConfig(cfg) {
  const e = [];
  if (!cfg || typeof cfg !== 'object') return ['screens.json must be an object'];
  if (!cfg.url || !/^https?:\/\//.test(cfg.url)) e.push('"url" must be an http(s) URL, e.g. "http://localhost:3000"');
  if (cfg.start !== undefined && (typeof cfg.start !== 'string' || SHELL_META.test(cfg.start))) {
    e.push('"start" must be one plain command such as "npm run dev" (no ;, &&, |, $, quotes-in-backticks or redirects)');
  }
  if (cfg.cwd !== undefined && (isAbsolute(cfg.cwd) || String(cfg.cwd).split(/[\\/]/).includes('..'))) e.push('"cwd" must be a folder inside the repo');
  const sameOrigin = (u) => typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') && !u.includes('\\');
  if (!Array.isArray(cfg.pages) || !cfg.pages.length) e.push('"pages" must list at least one page');
  const ids = new Set();
  (cfg.pages || []).forEach((p, i) => {
    if (!p.id || !/^[\w-]+$/.test(p.id)) e.push(`pages[${i}].id must be letters, digits, - or _`);
    if (ids.has(p.id)) e.push(`pages[${i}].id "${p.id}" is duplicated`);
    ids.add(p.id);
    if (p.path !== undefined && !sameOrigin(p.path)) e.push(`pages[${i}].path must start with a single / (same site only)`);
    (p.actions || []).forEach((a, j) => {
      if (!['click', 'fill', 'press', 'wait', 'hover', 'select', 'goto'].some((k) => k in a)) e.push(`pages[${i}].actions[${j}]: use click, fill, press, hover, select, goto or wait`);
      if ('goto' in a && !sameOrigin(a.goto)) e.push(`pages[${i}].actions[${j}].goto must start with a single / (same site only)`);
    });
    (p.highlights || []).forEach((h, j) => { if (!h.selector) e.push(`pages[${i}].highlights[${j}] needs "selector"`); });
  });
  for (const [k, v] of Object.entries(cfg.env || {})) {
    if (/(secret|password|token|private|api[_-]?key)/i.test(k) && !/(demo|test|fake|dummy|example|local)/i.test(String(v))) {
      e.push(`env.${k} looks like a real secret; screenshots are public, use demo/test values only`);
    }
  }
  return e;
}

async function waitForUrl(url, seconds, server) {
  const until = Date.now() + seconds * 1000;
  let last = '';
  while (Date.now() < until) {
    if (server && server.exitCode !== null) throw new Error(`the start command exited with code ${server.exitCode}; see flow-video/screens/server.log`);
    try {
      const r = await fetch(url, { redirect: 'manual' });
      if (r.status < 500) return;
      last = `HTTP ${r.status}`;
    } catch (err) { last = err.cause?.code || err.message; }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`${url} did not respond within ${seconds}s (${last})`);
}

async function main() {
  const args = process.argv.slice(2);
  const cfgPath = args.find((a) => !a.startsWith('--'));
  if (!cfgPath) fail('Usage: node capture.mjs flow-video/screens.json [--yes] [--allow-remote] [--dry-run]');
  const abs = resolve(cfgPath);
  if (!existsSync(abs)) fail(`not found: ${abs}`);
  let cfg;
  try { cfg = JSON.parse(readFileSync(abs, 'utf8')); } catch (err) { fail(`invalid JSON in ${abs}: ${err.message}`); }
  const errs = validateConfig(cfg);
  if (errs.length) fail(`screens.json has ${errs.length} problem(s):\n- ${errs.join('\n- ')}`);
  const base = new URL(cfg.url);
  if (!LOCAL.test(base.hostname) && !args.includes('--allow-remote')) {
    fail(`${base.hostname} is not a local address. Capture a local or staging copy with demo data, or pass --allow-remote if the owner approved capturing it.`);
  }
  const repo = resolve(dirname(abs), '..');
  // Every page the browser visits must stay on the configured site.
  const target = (path) => {
    const u = new URL(path || '/', base);
    if (u.origin !== base.origin) fail(`refusing to visit ${u.href}: it is not on ${base.origin}`);
    return u.href;
  };
  const cwd = resolve(repo, cfg.cwd || '.');
  if (relative(repo, cwd).startsWith('..')) fail(`"cwd" escapes the repo: ${cwd}`);
  const outDir = join(dirname(abs), 'screens');
  if (args.includes('--dry-run')) {
    console.log(`would run: ${cfg.start ? `${cfg.start} (in ${cwd})` : '(no start command; app must already run)'}`);
    cfg.pages.forEach((p) => console.log(`would capture ${p.id}: ${target(p.path)}`));
    return;
  }
  mkdirSync(outDir, { recursive: true });

  let server = null;
  if (cfg.start) {
    if (!args.includes('--yes')) fail(`screens.json asks to run: ${cfg.start}\n  in ${cwd}\nThis executes code from the repo. Run again with --yes once the user has approved this command.`);
    const log = openSync(join(outDir, 'server.log'), 'w');
    const [cmd, ...argv] = cfg.start.trim().split(/\s+/);
    // No shell: arguments go straight to the program. Windows needs a shell to find npm.cmd and friends.
    server = spawn(cmd, argv, { cwd, shell: process.platform === 'win32', detached: true, stdio: ['ignore', log, log], env: { ...process.env, ...(cfg.env || {}) } });
    console.log(`started: ${cfg.start} (pid ${server.pid}), waiting for ${base.href}`);
  }
  const stop = () => { if (server && server.exitCode === null) { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ } } };
  process.on('exit', stop);
  process.on('SIGINT', () => { stop(); process.exit(130); });

  let browser;
  try {
    await waitForUrl(base.href, cfg.readyTimeout || 90, server);
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    const vp = cfg.device === 'phone' ? PHONE : { width: cfg.viewport?.width || 1440, height: cfg.viewport?.height || 900, deviceScaleFactor: 2 };
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.deviceScaleFactor, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch });
    const manifest = {};
    for (const p of cfg.pages) {
      const page = await context.newPage();
      const url = target(p.path);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      for (const a of p.actions || []) {
        if (a.goto) await page.goto(target(a.goto), { waitUntil: 'domcontentloaded' });
        else if (a.click) await page.locator(a.click).first().click();
        else if (a.hover) await page.locator(a.hover).first().hover();
        else if (a.fill) await page.locator(a.fill[0]).first().fill(String(a.fill[1]));
        else if (a.select) await page.locator(a.select[0]).first().selectOption(String(a.select[1]));
        else if (a.press) await page.locator(a.press[0]).first().press(a.press[1]);
        else if (a.wait) await page.waitForTimeout(Number(a.wait));
      }
      if (p.waitFor) await page.locator(p.waitFor).first().waitFor({ timeout: 20000 });
      await page.waitForTimeout(p.settle ?? 600);
      const size = p.fullPage ? await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })) : { w: vp.width, h: vp.height };
      const highlights = [];
      for (const h of p.highlights || []) {
        const box = await page.locator(h.selector).first().boundingBox();
        if (!box) { console.log(`WARN ${p.id}: highlight "${h.selector}" is not visible; skipped`); continue; }
        const pad = 6;
        const scroll = p.fullPage ? await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })) : { x: 0, y: 0 };
        const r = (v) => Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000;
        highlights.push({ x: r((box.x + scroll.x - pad) / size.w), y: r((box.y + scroll.y - pad) / size.h), w: r((box.width + pad * 2) / size.w), h: r((box.height + pad * 2) / size.h), ...(h.label ? { label: h.label } : {}) });
      }
      const file = join(outDir, `${p.id}.png`);
      await page.screenshot({ path: file, fullPage: !!p.fullPage, mask: (p.mask || []).map((m) => page.locator(m)), maskColor: '#9CA3AF' });
      const shown = new URL(url);
      manifest[p.id] = { src: `screens/${p.id}.png`, url: `${LOCAL.test(shown.hostname) ? (cfg.displayHost || 'app') : shown.host}${shown.pathname}`, width: size.w, height: size.h, highlights };
      console.log(`captured ${p.id}: ${file}`);
      await page.close();
    }
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`\nmanifest: ${join(outDir, 'manifest.json')}\nPaste into a scene (then Read each PNG and check it shows no real personal data or secrets):`);
    for (const [id, m] of Object.entries(manifest)) {
      console.log(JSON.stringify({ type: 'screen', src: m.src, url: m.url, device: cfg.device === 'phone' ? 'phone' : 'browser', highlights: m.highlights }));
      void id;
    }
  } finally {
    if (browser) await browser.close();
    stop();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((err) => fail(err.stack || String(err)));
