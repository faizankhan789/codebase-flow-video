// Read-only queries over graph.json. Every function returns an array of output lines; the CLI caps them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTest } from './build.mjs';

export function prepare(g) {
  g.out = g.defs.map(() => []);
  g.in = g.defs.map(() => []);
  g.calls.forEach((c, k) => {
    if (c.from >= 0) g.out[c.from].push(k);
    (c.to || []).forEach((t) => g.in[t].push(k));
  });
  // Anonymous callbacks belong to the named function that contains them.
  g.kids = g.defs.map(() => []);
  g.defs.forEach((d, i) => { if (d.parent >= 0 && d.anon) g.kids[d.parent].push(i); });
  return g;
}

const loc = (d) => `${d.file}:${d.line}${d.end > d.line ? '-' + d.end : ''}`;
const label = (g, i) => `${g.defs[i].qual}  ${loc(g.defs[i])}`;
const descendants = (g, i) => { const out = [i]; for (let k = 0; k < out.length; k++) out.push(...g.kids[out[k]]); return out; };

// Resolves a user query to def ids. Accepts E<n>, file:line, Qualified.name, name, or a partial name.
export function lookup(g, q) {
  const e = g.entries.find((x) => x.id === q);
  if (e) return { entry: e, defs: e.def !== undefined ? [e.def] : e.handlers || [] };
  const fl = q.match(/^(.+):(\d+)$/);
  if (fl) {
    const line = Number(fl[2]);
    const hits = g.defs.map((d, i) => [d, i]).filter(([d]) => d.file === fl[1] && d.line <= line && d.end >= line);
    hits.sort((a, b) => (a[0].end - a[0].line) - (b[0].end - b[0].line));
    return { defs: hits.length ? [hits[0][1]] : [] };
  }
  let ids = g.defs.map((d, i) => (d.qual === q ? i : -1)).filter((i) => i >= 0);
  if (!ids.length) ids = g.defs.map((d, i) => (d.name === q ? i : -1)).filter((i) => i >= 0);
  if (!ids.length) {
    const lq = q.toLowerCase();
    ids = g.defs.map((d, i) => (!d.anon && d.qual.toLowerCase().includes(lq) ? i : -1)).filter((i) => i >= 0);
  }
  return { defs: ids };
}

function one(g, q) {
  const r = lookup(g, q);
  if (!r.defs.length) return { err: [`no definition matches "${q}" (try: find ${q})`] };
  if (r.defs.length > 1 && !r.entry) {
    return { err: [`"${q}" matches ${r.defs.length} definitions; pass one as file:line`, ...r.defs.slice(0, 15).map((i) => `  ${label(g, i)}`)] };
  }
  return { ids: r.defs, entry: r.entry };
}

function edgeLine(g, c) {
  if (c.status === 'external') return `⇢ ${c.callee}  [external: ${c.ext}]  call ${c.file}:${c.line}`;
  if (c.status === 'ambiguous') return `? ${c.callee}  [${c.to.length} candidates: ${c.to.slice(0, 3).map((t) => loc(g.defs[t])).join(', ')}${c.to.length > 3 ? ', …' : ''}]  call ${c.file}:${c.line}`;
  if (c.status === 'unresolved') return `· ${c.callee}  [unresolved]  call ${c.file}:${c.line}`;
  return `${g.defs[c.to[0]].qual}  ${loc(g.defs[c.to[0]])}  (call ${c.file}:${c.line})`;
}

export function calls(g, q, { depth = 2, all = false } = {}) {
  const r = one(g, q);
  if (r.err) return r.err;
  const out = [];
  if (r.entry) out.push(`${r.entry.id} ${r.entry.kind}  ${r.entry.file}:${r.entry.line}  ${r.entry.text}`);
  const seen = new Set();
  const walk = (i, pre, lvl) => {
    const ks = descendants(g, i).flatMap((d) => g.out[d]).map((k) => g.calls[k])
      .filter((c) => all || c.status !== 'unresolved').sort((a, b) => a.line - b.line);
    const uniq = [];
    const keys = new Set();
    for (const c of ks) { const key = c.to ? c.to.join(',') + c.status : c.callee; if (!keys.has(key)) { keys.add(key); uniq.push(c); } }
    uniq.forEach((c, n) => {
      const last = n === uniq.length - 1;
      const target = c.status === 'resolved' ? c.to[0] : -1;
      const again = target >= 0 && seen.has(target);
      out.push(`${pre}${last ? '└─ ' : '├─ '}${edgeLine(g, c)}${again ? '  ↺' : ''}`);
      if (target >= 0 && !again && lvl < depth) { seen.add(target); walk(target, pre + (last ? '   ' : '│  '), lvl + 1); }
    });
  };
  for (const i of r.ids) { out.push(label(g, i)); seen.add(i); walk(i, '', 1); }
  return out;
}

export function callers(g, q, { depth = 1 } = {}) {
  const r = one(g, q);
  if (r.err) return r.err;
  const out = [];
  const seen = new Set();
  const walk = (i, pre, lvl) => {
    const ks = g.in[i].map((k) => g.calls[k]);
    ks.forEach((c, n) => {
      const last = n === ks.length - 1;
      const who = c.from >= 0 ? label(g, c.from) : `(top level) ${c.file}`;
      out.push(`${pre}${last ? '└─ ' : '├─ '}${who}  (call ${c.file}:${c.line}${c.status === 'ambiguous' ? ', ambiguous' : ''})`);
      if (c.from >= 0 && !seen.has(c.from) && lvl < depth) { seen.add(c.from); walk(c.from, pre + (last ? '   ' : '│  '), lvl + 1); }
    });
    if (!ks.length && lvl === 1) out.push(`${pre}(no callers found${g.entries.some((e) => e.def === i || e.handlers?.includes(i)) ? '; it is an entry point' : ''})`);
  };
  for (const i of r.ids) { out.push(label(g, i)); walk(i, '', 1); }
  return out;
}

// Shortest call chains from a function or entry to a function, or to an external module ("ext:stripe").
export function path(g, from, to, { max = 3 } = {}) {
  const a = one(g, from);
  if (a.err) return a.err;
  let isTarget;
  if (to.startsWith('ext:')) {
    const m = to.slice(4).toLowerCase();
    isTarget = (i) => descendants(g, i).some((d) => g.out[d].some((k) => g.calls[k].ext?.toLowerCase().includes(m)));
  } else {
    const b = lookup(g, to).defs;
    if (!b.length) return [`no definition matches "${to}"`];
    const set = new Set(b);
    isTarget = (i) => set.has(i);
  }
  const results = [];
  const queue = a.ids.map((i) => [i]);
  const best = new Map(a.ids.map((i) => [i, 0]));
  while (queue.length && results.length < max) {
    const p = queue.shift();
    const i = p[p.length - 1];
    if (isTarget(i)) { results.push(p); continue; }
    if (p.length > 14) continue;
    for (const d of descendants(g, i)) for (const k of g.out[d]) for (const t of g.calls[k].to || []) {
      if ((best.get(t) ?? Infinity) < p.length) continue;
      best.set(t, p.length);
      queue.push([...p, t]);
    }
  }
  if (!results.length) return [`no call path found from ${from} to ${to} (dynamic dispatch, events or queues may connect them; check callers/externals)`];
  return results.flatMap((p, n) => [`path ${n + 1}:`, ...p.map((i, k) => `${'  '.repeat(k)}${k ? '→ ' : ''}${label(g, i)}`)]);
}

export function branches(g, q) {
  let list;
  if (g.files[q]) list = g.branches.filter((b) => b.file === q);
  else {
    const r = one(g, q);
    if (r.err) return r.err;
    const ids = new Set(r.ids.flatMap((i) => descendants(g, i)));
    list = g.branches.filter((b) => ids.has(b.def));
  }
  if (!list.length) return ['(no branch sites)'];
  return list.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line).map((b) => `${b.file}:${b.line}  ${b.kind.replace(/_(statement|expression|clause)$/, '')}  ${b.text}`);
}

export function slice(g, root, spec) {
  const m = spec.match(/^(.+):(\d+)(?:-(\d+))?$/);
  if (!m) return ['usage: slice path/to/file:START-END'];
  const lines = readFileSync(join(root, m[1]), 'utf8').split('\n');
  const a = Math.max(1, Number(m[2])), b = Math.min(lines.length, Number(m[3] || m[2]));
  return lines.slice(a - 1, b).map((l, k) => `${String(a + k).padStart(5)}  ${l}`);
}

export function show(g, root, q, { full = false } = {}) {
  const r = one(g, q);
  if (r.err) return r.err;
  const d = g.defs[r.ids[0]];
  const cap = full ? Infinity : 80;
  const out = slice(g, root, `${d.file}:${d.line}-${Math.min(d.end, d.line + cap - 1)}`);
  if (d.end - d.line + 1 > cap) out.push(`… ${d.end - d.line + 1 - cap} more lines (slice ${d.file}:${d.line + cap}-${d.end})`);
  return [`${d.qual}  ${loc(d)}`, ...out];
}

export function entries(g, kind) {
  const list = g.entries.filter((e) => !kind || e.kind === kind);
  if (!list.length) return ['(no entry points detected; check manifests and grep, see analysis guide)'];
  return list.map((e) => {
    const h = e.def !== undefined ? ` → ${g.defs[e.def].qual}` : e.handlers?.length ? ` → ${e.handlers.map((i) => g.defs[i].qual).join(', ')}` : '';
    return `${e.id.padEnd(4)} ${e.kind.padEnd(10)} ${e.file}${e.line ? ':' + e.line : ''}  ${e.text}${h}`;
  });
}

export function externals(g) {
  const mods = new Map();
  const add = (m, f, line, how) => {
    const key = m.replace(/^node:/, '').split('/').slice(0, m.startsWith('@') ? 2 : 1).join('/');
    if (!mods.has(key)) mods.set(key, { files: new Set(), calls: 0, first: [] });
    const e = mods.get(key);
    e.files.add(f);
    if (how === 'call') e.calls++;
    if (e.first.length < 3) e.first.push(`${f}:${line}`);
  };
  g.imports.filter((i) => !i.local && !i.alias && !isTest(i.file)).forEach((i) => add(i.module, i.file, i.line, 'import'));
  g.calls.filter((c) => c.status === 'external' && !isTest(c.file)).forEach((c) => add(c.ext, c.file, c.line, 'call'));
  return [...mods.entries()].sort((a, b) => b[1].files.size - a[1].files.size || b[1].calls - a[1].calls)
    .map(([m, e]) => `${m.padEnd(28)} ${String(e.files.size).padStart(3)} file(s) ${String(e.calls).padStart(4)} call(s)  ${e.first.join(', ')}`);
}

export function find(g, pattern) {
  let re;
  try { re = new RegExp(pattern, 'i'); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  const ids = g.defs.map((d, i) => (!d.anon && re.test(d.qual) ? i : -1)).filter((i) => i >= 0);
  return ids.length ? ids.map((i) => label(g, i)) : [`no definitions match /${pattern}/`];
}

export function summary(g) {
  const langs = {};
  Object.values(g.files).forEach((f) => { langs[f.lang] = (langs[f.lang] || 0) + 1; });
  const dirs = new Map();
  for (const f of Object.keys(g.files)) {
    const parts = f.split('/');
    const d = parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length > 1 ? parts[0] : '.';
    dirs.set(d, (dirs.get(d) || 0) + 1);
  }
  const defsIn = new Map();
  g.defs.forEach((d) => { if (d.anon) return; const parts = d.file.split('/'); const k = parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length > 1 ? parts[0] : '.'; defsIn.set(k, (defsIn.get(k) || 0) + 1); });
  const counts = { resolved: 0, ambiguous: 0, external: 0, unresolved: 0 };
  g.calls.forEach((c) => { counts[c.status]++; });
  const hubs = g.defs.map((d, i) => [i, g.in[i].length]).filter(([i, n]) => n > 1 && !isTest(g.defs[i].file)).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const kinds = {};
  g.entries.forEach((e) => { kinds[e.kind] = (kinds[e.kind] || 0) + 1; });
  return [
    `repo ${g.root} @ ${g.commit || 'no git'}  (indexed ${g.created.slice(0, 16)})`,
    `files: ${g.stats.files} parsed (${Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`).join(', ')})` +
      (g.unparsed.length ? `; ${g.unparsed.length} not parsed (run: unparsed)` : ''),
    `definitions: ${g.defs.filter((d) => !d.anon).length}  branch sites: ${g.branches.length}  calls: ${counts.resolved} resolved, ${counts.ambiguous} ambiguous, ${counts.external} external, ${counts.unresolved} unresolved`,
    `entry points: ${g.entries.length} (${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}); list: entry`,
    'top folders (files / definitions):',
    ...[...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([d, n]) => `  ${d.padEnd(32)} ${String(n).padStart(4)} / ${defsIn.get(d) || 0}`),
    'most-called functions:',
    ...(hubs.length ? hubs.map(([i, n]) => `  ${String(n).padStart(3)}×  ${label(g, i)}`) : ['  (none)']),
    'external packages (top 10):',
    ...externals(g).slice(0, 10).map((l) => `  ${l}`),
  ];
}
