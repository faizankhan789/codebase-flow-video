#!/usr/bin/env node
// Gets the source for a video from a URL.
//
//   node fetch-source.mjs <url> [--out DIR] [--pages N]
//
// Git repository (github.com/owner/repo, gitlab, bitbucket, codeberg, any https or ssh .git URL):
//   shallow clone into DIR (default ./<repo>); /tree/<branch>/<folder> links pick the branch and folder.
//   Prints the folder to analyse. Cloning runs no code from the repository.
// Website (any other https URL):
//   visits the page and up to N same-site pages from its navigation (default 4), saves screenshots and
//   writes site.json (title, description, headings, navigation, brand colour and font) into DIR/flow-video/.
//   Read-only: no forms, no logins, never leaves the site.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const GIT_HOSTS = /^(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|gitea\.com|sr\.ht|git\.sr\.ht)$/i;

export function classify(raw) {
  const url = String(raw || '').trim();
  const ssh = url.match(/^git@([\w.-]+):([\w.-]+)\/([\w.-]+?)(\.git)?$/);
  if (ssh) return { kind: 'git', clone: url, host: ssh[1], owner: ssh[2], repo: ssh[3] };
  let u;
  try { u = new URL(url); } catch { return { kind: 'invalid', reason: 'not a URL' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { kind: 'invalid', reason: `${u.protocol} URLs are not supported (use https)` };
  const parts = u.pathname.split('/').filter(Boolean);
  if (GIT_HOSTS.test(u.hostname) && parts.length >= 2) {
    const [owner, repoRaw, sep, ...rest] = parts;
    const repo = repoRaw.replace(/\.git$/, '');
    let branch = null, sub = null;
    if (sep === 'tree' || sep === '-' && rest[0] === 'tree') {
      const r = sep === '-' ? rest.slice(1) : rest;
      branch = r[0] || null;
      sub = r.slice(1).join('/') || null;
    }
    return { kind: 'git', clone: `https://${u.hostname}/${owner}/${repo}.git`, host: u.hostname, owner, repo, branch, sub };
  }
  if (u.pathname.endsWith('.git')) return { kind: 'git', clone: url, host: u.hostname, owner: parts[0], repo: parts[parts.length - 1].replace(/\.git$/, '') };
  return { kind: 'site', url: u.href, host: u.hostname };
}

function cloneRepo(c, out) {
  if (existsSync(out)) return { error: `${out} already exists; pass --out to choose another folder` };
  const args = ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always',
    'clone', '--depth', '1', '--no-recurse-submodules', '--filter=blob:limit=5m'];
  if (c.branch) args.push('--branch', c.branch);
  args.push('--', c.clone, out);
  const r = spawnSync('git', args, { stdio: 'inherit', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.status !== 0) return { error: `git clone failed (exit ${r.status}); check the URL and that the repository is public or your git credentials work` };
  const root = c.sub ? join(out, c.sub) : out;
  if (!existsSync(root)) return { error: `folder ${c.sub} not found in the repository` };
  return { root };
}

async function tourSite(c, out, maxPages) {
  const { chromium } = await import('playwright');
  const dir = join(out, 'flow-video');
  mkdirSync(join(dir, 'screens'), { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const origin = new URL(c.url).origin;
  const site = { url: c.url, pages: [] };
  try {
    const visit = async (url, id) => {
      const page = await ctx.newPage();
      // Never leave the site: block requests for top-level documents on other origins.
      await page.route('**/*', (route) => {
        const r = route.request();
        if (r.isNavigationRequest() && r.frame() === page.mainFrame() && new URL(r.url()).origin !== origin) return route.abort();
        return route.continue();
      });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
      await page.waitForTimeout(800);
      const info = await page.evaluate(() => {
        const text = (sel, n) => [...document.querySelectorAll(sel)].map((e) => e.innerText.trim().replace(/\s+/g, ' ')).filter((t) => t && t.length < 160).slice(0, n);
        const meta = (name) => document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.content || null;
        // Brand colour: the first clearly coloured button or link background (opaque, saturated).
        const vivid = (c) => { const m = c && c.match(/rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)/); if (!m) return false; const [r, g, b, a = 1] = m.slice(1).map((x) => (x === undefined ? 1 : +x)); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return a >= 0.6 && mx > 40 && (mx - mn) / mx > 0.3; };
        const btn = [...document.querySelectorAll('a, button')].find((b) => b.offsetWidth > 60 && vivid(getComputedStyle(b).backgroundColor));
        const nav = [...document.querySelectorAll('header a[href], nav a[href]')].map((a) => ({ label: a.innerText.trim().replace(/\s+/g, ' '), href: a.href })).filter((l) => l.label && l.label.length < 40);
        return {
          title: document.title, description: meta('description') || meta('og:description'), image: meta('og:image'),
          h1: text('h1', 3), h2: text('h2', 10), h3: text('h3', 12), buttons: text('a[class*="btn"], button, a[class*="button"]', 8),
          nav, brand: { accent: btn ? getComputedStyle(btn).backgroundColor : null, font: getComputedStyle(document.body).fontFamily.split(',')[0].replace(/['"]/g, '').trim() },
        };
      });
      const file = `screens/${id}.png`;
      await page.screenshot({ path: join(dir, file) });
      await page.close();
      return { id, url, file, ...info };
    };
    const home = await visit(c.url, 'home');
    site.pages.push(home);
    const seen = new Set([new URL(c.url).pathname]);
    const next = home.nav.filter((l) => { try { const u = new URL(l.href); if (u.origin !== origin || seen.has(u.pathname) || u.hash && u.pathname === new URL(c.url).pathname) return false; seen.add(u.pathname); return true; } catch { return false; } }).slice(0, maxPages);
    for (const [i, l] of next.entries()) {
      try { site.pages.push(await visit(l.href, `page-${i + 1}`)); } catch (err) { console.log(`skipped ${l.href}: ${err.message.split('\n')[0]}`); }
    }
  } finally { await browser.close(); }
  writeFileSync(join(dir, 'site.json'), JSON.stringify(site, null, 2));
  return { dir, pages: site.pages.length };
}

async function main() {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith('--'));
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  if (!url) { console.error('Usage: node fetch-source.mjs <url> [--out DIR] [--pages N]'); process.exit(1); }
  const c = classify(url);
  if (c.kind === 'invalid') { console.error(`Cannot use ${url}: ${c.reason}`); process.exit(1); }
  if (c.kind === 'git') {
    const out = resolve(opt('--out', c.repo));
    const r = cloneRepo(c, out);
    if (r.error) { console.error(r.error); process.exit(1); }
    console.log(`REPO ${r.root}`);
    console.log('Next: run the normal workflow with this folder as the repo (graph index, FLOW.md, verify, storyboard, render).');
    return;
  }
  const out = resolve(opt('--out', `site-${c.host.replace(/[^\w.-]/g, '')}`));
  const r = await tourSite(c, out, Math.max(0, Math.min(8, Number(opt('--pages', 4)))));
  console.log(`SITE ${r.dir}/site.json (${r.pages} page(s), screenshots in ${r.dir}/screens)`);
  console.log('Next: write a storyboard from site.json (headline + showcase scenes using the screenshots); see references/url-guide.md.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((err) => { console.error(err.stack || String(err)); process.exit(1); });
