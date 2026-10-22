#!/usr/bin/env node
// Reads a repo's own brand (colours, font) and suggests a style preset and scene visuals from its
// dependencies. Prints JSON; paste "style" into storyboard.json and adjust.
//
//   node detect-style.mjs [REPO]
import { readFileSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listFiles } from './graph/build.mjs';
import { PRESETS } from './style.mjs';

// ---------- colour parsing ----------
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
const hex = (r, g, b) => '#' + [r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('').toUpperCase();
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return hex(f(0) * 255, f(8) * 255, f(4) * 255);
}
function oklchToHex(L, C, H) {
  const hr = (H * Math.PI) / 180, a = C * Math.cos(hr), b = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b, m_ = L - 0.1055613458 * a - 0.0638541728 * b, s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const [l, m, s] = [l_ ** 3, m_ ** 3, s_ ** 3];
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  const g = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055) * 255;
  return hex(g(lin[0]), g(lin[1]), g(lin[2]));
}
// Accepts #RGB, #RRGGBB, #AARRGGBB (Android), 0xFFRRGGBB (Flutter), rgb(), hsl(), oklch(), and shadcn "222 47% 11%".
export function parseColor(raw) {
  const v = String(raw).trim().replace(/!important/, '').trim();
  let m;
  if ((m = v.match(/^#([0-9a-f]{3})$/i))) return hex(...[...m[1]].map((c) => parseInt(c + c, 16)));
  if ((m = v.match(/^#([0-9a-f]{6})$/i))) return '#' + m[1].toUpperCase();
  if ((m = v.match(/^#([0-9a-f]{2})([0-9a-f]{6})$/i))) return '#' + m[2].toUpperCase();
  if ((m = v.match(/^0x([0-9a-f]{2})([0-9a-f]{6})$/i))) return '#' + m[2].toUpperCase();
  if ((m = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i))) return hex(+m[1], +m[2], +m[3]);
  if ((m = v.match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i))) return hslToHex(+m[1], +m[2], +m[3]);
  if ((m = v.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/))) return hslToHex(+m[1], +m[2], +m[3]);
  if ((m = v.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/i))) return oklchToHex(m[2] ? +m[1] / 100 : +m[1], +m[3], +m[4]);
  return null;
}
const lumOf = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const saturation = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); const mx = Math.max(...c), mn = Math.min(...c); return mx ? (mx - mn) / mx : 0; };
// Brand colours are saturated mid-tones, not near-white/black/grey UI chrome.
const hue = (h) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  const x = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (x * 60 + 360) % 360;
};
const hueGap = (a, b) => { const d = Math.abs(hue(a) - hue(b)); return Math.min(d, 360 - d); };
const brandLike = (h) => h && saturation(h) > 0.25 && lumOf(h) > 0.06 && lumOf(h) < 0.9;

// ---------- domain hints ----------
const DOMAINS = [
  ['neural', 'AI / LLM app', /^(openai|anthropic|@anthropic-ai\/.+|langchain.*|@langchain\/.+|llama[-_]?index|llamaindex|crewai|autogen.*|pyautogen|langgraph|@langchain\/langgraph|transformers|torch|tensorflow|@ai-sdk\/.+|ai|ollama|pinecone.*|@pinecone-database\/.+|chromadb|weaviate.*|qdrant.*|sentence[-_]transformers|mistralai|cohere|google-generativeai|@google\/generative-ai|groq.*|litellm|smolagents|pydantic[-_]ai|mastra|@mastra\/.+|@openai\/agents|openai-agents)$/i],
  ['ledger', 'payments / fintech', /^(stripe|@stripe\/.+|plaid|braintree|adyen.*|@adyen\/.+|paypal.*|@paypal\/.+|squareup|square|dwolla.*|coinbase.*|ethers|web3|@solana\/.+|moov.*|razorpay|mollie.*|gocardless.*|wise.*)$/i],
  ['storefront', 'e-commerce', /^(shopify.*|@shopify\/.+|@medusajs\/.+|medusa.*|saleor.*|@commercetools\/.+|woocommerce.*|snipcart|@vendure\/.+|spree.*|solidus.*|bigcommerce.*)$/i],
  ['clinic', 'healthcare', /^(fhir.*|@medplum\/.+|medplum|hl7.*|fhirclient|smart-on-fhir|pydicom|dicom.*)$/i],
  ['ocean', 'data pipelines', /^(apache-airflow|airflow|dagster.*|prefect.*|dbt-.+|pyspark|kafka.*|kafkajs|confluent-kafka|apache-beam|flink.*|duckdb|snowflake.*|google-cloud-bigquery|clickhouse.*|polars|great[-_]expectations)$/i],
  ['terminal', 'developer tool / CLI', /^(commander|yargs|oclif|@oclif\/.+|cobra|github\.com\/spf13\/cobra|click|typer|clap|ink|inquirer|chalk)$/i],
  ['candy', 'game / playful app', /^(phaser|pixi\.js|@pixi\/.+|three|@react-three\/fiber|pygame|bevy|godot.*|kaboom)$/i],
];
const AGENT_DEPS = /^(crewai|autogen.*|pyautogen|langgraph|@langchain\/langgraph|smolagents|pydantic[-_]ai|mastra|@mastra\/.+|@openai\/agents|openai-agents|agno|camel-ai|swarm)$/i;
const RAG_DEPS = /^(pinecone.*|@pinecone-database\/.+|chromadb|weaviate.*|qdrant.*|faiss.*|pgvector|llama[-_]?index|llamaindex|sentence[-_]transformers|@langchain\/community)$/i;

function dependencies(root, files) {
  const deps = new Set();
  const read = (f) => { try { return readFileSync(join(root, f), 'utf8'); } catch { return ''; } };
  for (const f of files) {
    const b = f.split('/').pop();
    if (b === 'package.json') {
      try { const p = JSON.parse(read(f)); for (const k of ['dependencies', 'devDependencies', 'peerDependencies']) Object.keys(p[k] || {}).forEach((d) => deps.add(d)); } catch { /* ignore */ }
    } else if (/^requirements.*\.txt$/.test(b)) {
      read(f).split('\n').forEach((l) => { const m = l.trim().match(/^([A-Za-z0-9_.\-[\]]+)/); if (m && !l.trim().startsWith('#')) deps.add(m[1].replace(/\[.*$/, '').toLowerCase()); });
    } else if (b === 'pyproject.toml' || b === 'Pipfile') {
      for (const m of read(f).matchAll(/^\s*"?([A-Za-z0-9_.-]+)\s*(?:[<>=~^!].*)?"?,?\s*$|^\s*([A-Za-z0-9_.-]+)\s*=\s*["{]/gm)) deps.add((m[1] || m[2]).toLowerCase());
    } else if (b === 'go.mod') {
      for (const m of read(f).matchAll(/^\s*([\w.\-/]+)\s+v[\d.]+/gm)) deps.add(m[1]);
    } else if (b === 'Gemfile') {
      for (const m of read(f).matchAll(/gem\s+['"]([\w-]+)['"]/g)) deps.add(m[1]);
    } else if (b === 'Cargo.toml') {
      for (const m of read(f).matchAll(/^([\w-]+)\s*=/gm)) deps.add(m[1]);
    } else if (b === 'pubspec.yaml') {
      for (const m of read(f).matchAll(/^\s{2}([a-z_]+):/gm)) deps.add(m[1]);
    } else if (/build\.gradle(\.kts)?$/.test(b)) {
      for (const m of read(f).matchAll(/["']([\w.-]+):([\w.-]+):[\w.-]+["']/g)) deps.add(m[2]);
    }
  }
  return deps;
}

// ---------- brand detection ----------
export function detectStyle(root) {
  const files = listFiles(root);
  const read = (f) => { try { return statSync(join(root, f)).size < 400_000 ? readFileSync(join(root, f), 'utf8') : ''; } catch { return ''; } };
  const colors = []; // { hex, source, weight }
  const fonts = []; // { family, source, weight, file? }
  const evidence = [];
  const addColor = (raw, source, weight) => { const h = parseColor(raw); if (brandLike(h)) colors.push({ hex: h, source, weight }); };
  let appBg = null;

  for (const f of files) {
    const b = f.split('/').pop(), ext = extname(f).toLowerCase();
    if (/^tailwind\.config\.(js|ts|cjs|mjs)$/.test(b)) {
      const t = read(f);
      for (const m of t.matchAll(/\b(primary|brand|accent)\b\s*:\s*(?:\{[^}]*?\b(?:DEFAULT|500|600)\b\s*:\s*)?['"]([^'"]+)['"]/g)) addColor(m[2], `${f} (${m[1]})`, m[1] === 'accent' ? 6 : 10);
      const ff = t.match(/fontFamily\s*:\s*\{[\s\S]*?\b(sans|display|heading)\b\s*:\s*\[\s*['"]([^'"]+)['"]/);
      if (ff) fonts.push({ family: ff[2], source: f, weight: 8 });
    } else if (['.css', '.scss', '.sass', '.less', '.pcss'].includes(ext) && !f.includes('node_modules')) {
      const t = read(f);
      for (const m of t.matchAll(/--(?:color-)?(primary|brand|accent)(?:-(?:500|600|color))?\s*:\s*([^;]+);/g)) addColor(m[2], `${f} (--${m[1]})`, m[1] === 'accent' ? 5 : 9);
      for (const m of t.matchAll(/\$(primary|brand)(?:-color)?\s*:\s*([^;]+);/g)) addColor(m[2], `${f} ($${m[1]})`, 8);
      const bg = t.match(/:root[^{]*\{[^}]*--background\s*:\s*([^;]+);/);
      if (bg && !appBg) appBg = parseColor(bg[1]);
      const fam = t.match(/(?:body|html|:root)\s*\{[^}]*font-family\s*:\s*([^;]+);/);
      if (fam) { const first = fam[1].split(',')[0].trim().replace(/['"]/g, ''); if (!/^(var\(|system-ui|-apple-system|sans-serif|serif|inherit|monospace)/.test(first)) fonts.push({ family: first, source: f, weight: 6 }); }
    } else if (/\.(t|j)sx?$/.test(ext)) {
      const t = read(f);
      const nf = t.match(/import\s*\{\s*([A-Z][\w]+)[^}]*\}\s*from\s*['"]next\/font\/google['"]/);
      if (nf) fonts.push({ family: nf[1].replace(/_/g, ' '), source: f, weight: 9 });
      for (const m of t.matchAll(/primary\s*:\s*\{\s*main\s*:\s*['"]([^'"]+)['"]/g)) addColor(m[1], `${f} (MUI primary)`, 9);
      for (const m of t.matchAll(/\bbrand\s*:\s*\{[^}]*?\b500\s*:\s*['"]([^'"]+)['"]/g)) addColor(m[1], `${f} (theme brand.500)`, 8);
    } else if (b === 'colors.xml') {
      for (const m of read(f).matchAll(/<color\s+name="(colorPrimary|primary|brand|colorAccent|accent)\w*"\s*>\s*([^<]+)</g)) addColor(m[2], `${f} (${m[1]})`, /accent/i.test(m[1]) ? 6 : 9);
    } else if (ext === '.dart') {
      for (const m of read(f).matchAll(/(primaryColor|seedColor|colorSchemeSeed)\s*:\s*(?:const\s+)?Color\((0x[0-9A-Fa-f]{8})\)/g)) addColor(m[2], `${f} (${m[1]})`, 9);
    } else if (f.endsWith('AccentColor.colorset/Contents.json')) {
      try {
        const c = JSON.parse(read(f)).colors?.[0]?.color?.components;
        if (c) { const v = (x) => (String(x).startsWith('0x') ? parseInt(x, 16) : parseFloat(x) <= 1 ? parseFloat(x) * 255 : parseFloat(x)); addColor(hex(v(c.red), v(c.green), v(c.blue)), `${f} (iOS AccentColor)`, 9); }
      } catch { /* ignore */ }
    } else if (/(manifest\.json|\.webmanifest)$/.test(b)) {
      const m = read(f).match(/"theme_color"\s*:\s*"([^"]+)"/);
      if (m) addColor(m[1], `${f} (theme_color)`, 5);
    } else if (ext === '.html') {
      const m = read(f).match(/<meta\s+name=["']theme-color["']\s+content=["']([^"']+)["']/i);
      if (m) addColor(m[1], `${f} (theme-color)`, 5);
    } else if (/^(logo|icon|brand|favicon)[\w-]*\.svg$/i.test(b)) {
      for (const m of read(f).matchAll(/(?:fill|stop-color)=["'](#[0-9a-fA-F]{3,6})["']/g)) addColor(m[1], `${f} (logo)`, 3);
    } else if (['.woff2', '.woff', '.ttf', '.otf'].includes(ext) && !/italic|thin|light|black|bold|semibold|medium/i.test(b)) {
      fonts.push({ family: b.replace(/[-_](regular|variable|vf|roman|book|normal)?[^.]*\.\w+$/i, '').replace(/[-_]/g, ' '), source: f, weight: 4, file: f });
    }
  }
  const deps = dependencies(root, files);
  for (const d of deps) {
    const m = d.match(/^@fontsource(?:-variable)?\/(.+)$/);
    if (m) fonts.push({ family: m[1].split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '), source: `package.json (${d})`, weight: 7 });
  }

  // Rank colours by summed weight; the second accent must be a clearly different colour.
  const score = new Map();
  colors.forEach((c) => { const s = score.get(c.hex) || { hex: c.hex, w: 0, sources: [] }; s.w += c.weight; s.sources.push(c.source); score.set(c.hex, s); });
  const ranked = [...score.values()].sort((a, b) => b.w - a.w);
  const accent = ranked[0] || null;
  const accent2 = ranked.find((c) => accent && c.hex !== accent.hex && hueGap(c.hex, accent.hex) > 40) || null;
  let font = fonts.sort((a, b) => b.weight - a.weight)[0] || null;
  if (font && !font.file) {
    // A font file in the repo with the same family name makes the video use the real brand font.
    const key = font.family.toLowerCase().replace(/\s+/g, '');
    const file = fonts.find((f) => f.file && f.family.toLowerCase().replace(/\s+/g, '').startsWith(key));
    if (file) font = { ...font, file: file.file };
  }

  // Domains from dependencies.
  const domains = DOMAINS.map(([preset, label, re]) => {
    const hits = [...deps].filter((d) => re.test(d));
    return { preset, label, score: hits.length, reasons: hits.slice(0, 6) };
  }).filter((d) => d.score > 0).sort((a, b) => b.score - a.score);
  const agentHits = [...deps].filter((d) => AGENT_DEPS.test(d));
  const ragHits = [...deps].filter((d) => RAG_DEPS.test(d));

  const visuals = [];
  if (agentHits.length) visuals.push({ type: 'agents', why: `agent framework: ${agentHits.join(', ')}` });
  if (ragHits.length || domains.some((d) => d.preset === 'neural')) visuals.push({ type: 'chat', why: ragHits.length ? `retrieval: ${ragHits.join(', ')} (show sources)` : 'LLM calls' });
  if (domains.some((d) => d.preset === 'ledger')) visuals.push({ type: 'checklist', why: 'payment / fraud checks' }, { type: 'request', why: 'payment API round trip' });
  if (domains.some((d) => d.preset === 'storefront')) visuals.push({ type: 'request', why: 'checkout' }, { type: 'decision', why: 'stock / payment outcomes' });
  if (domains.some((d) => d.preset === 'ocean')) visuals.push({ type: 'pipeline', why: 'records transformed stage by stage' }, { type: 'queue', why: 'streams / jobs' });
  if ([...deps].some((d) => /^(bullmq|bull|bee-queue|celery|sidekiq|rq|dramatiq|kue|agenda|@aws-sdk\/client-sqs|amqplib|pika|nats)$/i.test(d))) visuals.push({ type: 'queue', why: 'background job queue in dependencies' });
  if ([...deps].some((d) => /^(express|fastify|koa|hono|@nestjs\/core|next|fastapi|flask|django|gin|echo|fiber|rails|laravel\/framework|spring-boot-starter-web)$/i.test(d))) visuals.push({ type: 'request', why: 'HTTP server' });
  visuals.push({ type: 'decision', why: 'every business branch from FLOW.md' });
  const seen = new Set();
  const uniqVisuals = visuals.filter((v) => (seen.has(v.type) ? false : seen.add(v.type)));

  const lightApp = appBg ? lumOf(appBg) > 0.5 : null;
  // Web products with no more specific domain get the cinematic launch look; internal tools the boardroom look.
  const webApp = [...deps].some((d) => /^(next|react|react-dom|vue|nuxt|svelte|@sveltejs\/kit|@angular\/core|remix|@remix-run\/react|astro|solid-js)$/i.test(d));
  const preset = domains[0]?.preset || (webApp ? 'launch' : lightApp ? 'boardroom' : 'midnight');
  const style = { preset };
  if (accent) style.accent = accent.hex;
  if (accent2) style.accent2 = accent2.hex;
  if (font) style.font = font.file ? { family: font.family, file: `../${font.file}` } : { family: font.family };
  if (accent) evidence.push(`accent ${accent.hex} from ${[...new Set(accent.sources)].slice(0, 3).join(', ')}`);
  if (accent2) evidence.push(`accent2 ${accent2.hex} from ${[...new Set(accent2.sources)].slice(0, 2).join(', ')}`);
  if (font) evidence.push(`font "${font.family}" from ${font.source}${font.file ? ' (font file, path relative to flow-video/)' : ' (used only if installed on the rendering machine; otherwise the preset font)'}`);
  if (!accent) evidence.push('no brand colour found; using the preset accent');
  if (appBg) evidence.push(`app background ${appBg} (${lightApp ? 'light' : 'dark'} UI)`);
  return {
    style,
    presetWhy: domains[0] ? `${domains[0].label}: ${domains[0].reasons.join(', ')}` : 'no domain-specific dependencies; general preset',
    alternatives: domains.slice(1, 3).map((d) => ({ preset: d.preset, why: `${d.label}: ${d.reasons.join(', ')}` })),
    visuals: uniqVisuals,
    evidence,
    presets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, v.about])),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(detectStyle(resolve(process.argv[2] || '.')), null, 2));
}
