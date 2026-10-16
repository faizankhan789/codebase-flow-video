// Builds flow-video/graph.json: files, definitions, resolved calls, branches, imports, entry points.
// Re-parses only files whose content hash changed since the last index.
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EXT_LANG, UNPARSED_EXT, ENTRY_DECORATORS, ENTRY_CALLS } from './langs.mjs';
import { parseFile } from './parse.mjs';

export const GRAPH_VERSION = 1;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'vendor', 'venv', '.venv', 'env', '__pycache__',
  '.next', '.nuxt', 'target', 'coverage', '.turbo', '.cache', 'bower_components', 'Pods', '.gradle', 'flow-video']);
const MAX_BYTES = 1_000_000;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.\w+$|_test\.go$|(^|\/)test_[^/]+\.py$|_spec\.rb$/;
export const isTest = (f) => TEST_FILE.test(f);

export function listFiles(root) {
  const git = spawnSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (git.status === 0) {
    return git.stdout.split('\n').filter(Boolean).filter((f) => !f.split('/').some((p) => SKIP_DIRS.has(p)));
  }
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(rel); } else out.push(rel);
    }
  };
  walk('');
  return out;
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
// Method names so common on built-in types that a receiver call to them says nothing about project code.
const COMMON_METHODS = new Set(('get set has push pop shift unshift map filter forEach reduce find findIndex some every slice splice join ' +
  'split replace trim keys values entries add delete clear then catch finally call apply bind toString valueOf send emit on once off ' +
  'write read end close open run start stop update save load parse format test match exec log info warn error debug append extend insert ' +
  'remove items copy sort reverse index count includes indexOf concat assign create execute fetch post put patch list next lower upper ' +
  'strip encode decode dump dumps loads json text query render use listen resolve reject wait sleep length size flat flatMap fill ' +
  'startsWith endsWith padStart padEnd toLowerCase toUpperCase charAt substring substr pipe subscribe dispatch commit').split(' '));

const looksMinified = (text) => text.length > 5000 && text.length / (text.split('\n').length || 1) > 300;

// ---------- module resolution (local files only) ----------
const JS_EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

function resolveModule(spec, fromFile, lang, ctx) {
  const has = (f) => ctx.fileSet.has(f);
  const norm = (p) => posix.normalize(p).replace(/^\.\//, '');
  if (['javascript', 'typescript', 'tsx'].includes(lang)) {
    let base = null;
    if (spec.startsWith('.')) base = norm(posix.join(posix.dirname(fromFile), spec));
    else if (spec.startsWith('@/') || spec.startsWith('~/')) base = spec.slice(2);
    else if (spec.startsWith('/')) base = spec.slice(1);
    if (base === null) return [];
    const cands = [base, `src/${base}`];
    for (const c of cands) for (const e of JS_EXT) if (has(c + e)) return [c + e];
    return [];
  }
  if (lang === 'python') {
    const lead = spec.match(/^\.+/)?.[0].length || 0;
    const parts = spec.slice(lead).split('.').filter(Boolean);
    let dirs = [];
    if (lead) { let d = posix.dirname(fromFile); for (let i = 1; i < lead; i++) d = posix.dirname(d); dirs = [d === '.' ? '' : d]; }
    else dirs = ['', 'src', ...ctx.pyRoots];
    for (const d of dirs) {
      const p = posix.join(d || '.', ...parts);
      for (const c of [`${p}.py`, `${p}/__init__.py`]) if (has(norm(c))) return [norm(c)];
    }
    return [];
  }
  if (lang === 'go') {
    const mod = ctx.goModules.find((m) => spec === m.module || spec.startsWith(m.module + '/'));
    if (!mod) return [];
    const dir = posix.join(mod.dir, spec.slice(mod.module.length).replace(/^\//, ''));
    return ctx.files.filter((f) => f.endsWith('.go') && posix.dirname(f) === dir);
  }
  if (lang === 'java') {
    const tail = spec.replace(/\.\*$/, '').replace(/\./g, '/') + '.java';
    return ctx.files.filter((f) => f.endsWith(tail));
  }
  if (lang === 'ruby' && spec) {
    const base = norm(posix.join(posix.dirname(fromFile), spec));
    return [base, `${base}.rb`].filter(has);
  }
  return [];
}

// ---------- entry points from manifests ----------
function manifestEntries(root, fileSet) {
  const out = [];
  const base = (f) => f.split('/').pop();
  for (const f of [...fileSet].filter((x) => base(x) === 'package.json')) {
    const pkg = readJson(join(root, f));
    if (!pkg) continue;
    for (const [k, v] of Object.entries(pkg.scripts || {})) {
      if (/^(start|dev|serve|server|worker|cron|job|cli|main|consume|queue)/.test(k)) out.push({ kind: 'script', file: f, line: 0, text: `${k}: ${v}` });
    }
    const bins = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : pkg.bin || {};
    for (const [k, v] of Object.entries(bins)) out.push({ kind: 'cli', file: f, line: 0, text: `bin ${k}: ${v}` });
  }
  for (const f of [...fileSet].filter((x) => /^(Procfile|Dockerfile|docker-compose\.ya?ml|pyproject\.toml)$/.test(base(x)))) {
    readFileSync(join(root, f), 'utf8').split('\n').forEach((l, i) => {
      const t = l.trim();
      const b = base(f);
      if ((b === 'Procfile' && /^\w+:/.test(t)) || (b === 'Dockerfile' && /^(CMD|ENTRYPOINT)\b/.test(t)) ||
          (b.startsWith('docker-compose') && /^command:/.test(t)) ||
          (b === 'pyproject.toml' && /^[\w-]+\s*=\s*"[\w.]+:\w+"/.test(t))) {
        out.push({ kind: b === 'pyproject.toml' ? 'cli' : 'process', file: f, line: i + 1, text: t.slice(0, 120) });
      }
    });
  }
  return out;
}

function fileRouteKind(f) {
  if (/(^|\/)app\/(.+\/)?route\.(t|j)sx?$/.test(f) || /(^|\/)pages\/api\//.test(f)) return 'route';
  if (/(^|\/)(app\/(.+\/)?page|pages\/(?!_|api\/)[^.]+)\.(t|j)sx?$/.test(f)) return 'page';
  return null;
}

// ---------- compact storage ----------
// On disk, records are grouped by file as tuples without repeated paths or default fields.
export function pack(g) {
  const files = {};
  const localOf = new Map();
  for (const f of Object.keys(g.files)) files[f] = { ...g.files[f], d: [], c: [], b: [], i: [] };
  g.defs.forEach((d, i) => {
    const F = files[d.file];
    localOf.set(i, F.d.length);
    const t = [d.name, d.qual === d.name ? 0 : d.qual, d.kind, d.line, d.end, d.parent >= 0 ? localOf.get(d.parent) : -1, (d.anon ? 1 : 0) | (d.exported ? 2 : 0)];
    if (d.decorators?.length) t.push(d.decorators);
    F.d.push(t);
  });
  g.calls.forEach((c) => {
    const t = [c.line, c.from >= 0 ? localOf.get(c.from) : -1, c.callee, c.name === c.callee ? 0 : c.name, c.status, c.to || 0, c.ext || 0];
    if (c.str || c.idents || c.text || c.dec) t.push(c.str || 0, c.idents || 0, c.text || 0, c.dec || 0);
    while (t.length > 5 && !t[t.length - 1]) t.pop();
    files[c.file].c.push(t);
  });
  g.branches.forEach((b) => files[b.file].b.push([b.line, b.kind, b.text, b.def >= 0 ? localOf.get(b.def) : -1]));
  g.imports.forEach((m) => files[m.file].i.push([m.line, m.module, m.names?.length ? m.names : 0, m.local ? 1 : 0, m.targets || 0, m.relative ? 1 : 0, m.alias ? 1 : 0]));
  const { defs, calls, branches, imports, ...rest } = g;
  return { ...rest, files };
}

export function unpack(p) {
  if (!p || p.version !== GRAPH_VERSION || !p.files) return null;
  const g = { ...p, files: {}, defs: [], calls: [], branches: [], imports: [] };
  for (const [f, F] of Object.entries(p.files)) {
    const off = g.defs.length;
    g.files[f] = { lang: F.lang, lines: F.lines, hash: F.hash };
    F.d.forEach(([name, qual, kind, line, end, parent, flags, decorators]) => g.defs.push({ name, qual: qual || name, kind, file: f, line, end,
      parent: parent >= 0 ? parent + off : -1, anon: !!(flags & 1), exported: !!(flags & 2), decorators: decorators || [] }));
    F.c.forEach(([line, from, callee, name, status, to, ext, str, idents, text, dec]) => g.calls.push({ callee, name: name || callee, line, file: f,
      from: from >= 0 ? from + off : -1, status, ...(to ? { to } : {}), ...(ext ? { ext } : {}), ...(str ? { str } : {}), ...(idents ? { idents } : {}),
      ...(text ? { text } : {}), ...(dec ? { dec } : {}) }));
    F.b.forEach(([line, kind, text, def]) => g.branches.push({ kind, line, text, file: f, def: def >= 0 ? def + off : -1 }));
    F.i.forEach(([line, module, names, local, targets, relative, alias]) => g.imports.push({ module, names: names || [], line, file: f, local: !!local,
      ...(targets ? { targets } : {}), ...(relative ? { relative: true } : {}), ...(alias ? { alias: 1 } : {}) }));
  }
  return g;
}

// Splits a previous graph back into per-file parse results, so unchanged files are not re-parsed.
function previousResults(prev) {
  if (prev?.version !== GRAPH_VERSION) return {};
  const out = {};
  const local = new Map();
  for (const [f, info] of Object.entries(prev.files)) out[f] = { hash: info.hash, res: { defs: [], calls: [], branches: [], imports: [] } };
  prev.defs.forEach((d, i) => {
    const r = out[d.file]?.res;
    if (!r) return;
    local.set(i, r.defs.length);
    r.defs.push({ ...d, parent: d.parent >= 0 ? local.get(d.parent) : -1 });
  });
  const strip = ({ file, status, to, ext, ...rest }) => rest;
  prev.calls.forEach((c) => out[c.file]?.res.calls.push({ ...strip(c), from: c.from >= 0 ? local.get(c.from) : -1 }));
  prev.branches.forEach(({ file, ...b }) => out[file]?.res.branches.push({ ...b, def: b.def >= 0 ? local.get(b.def) : -1 }));
  prev.imports.forEach(({ file, local: l, targets, ...imp }) => out[file]?.res.imports.push(imp));
  return out;
}

// ---------- main ----------
export async function buildGraph(root, previous = null) {
  const all = listFiles(root);
  const fileSet = new Set(all);
  const ctx = { files: all, fileSet, pyRoots: [], goModules: [] };
  for (const f of all.filter((x) => x === 'go.mod' || x.endsWith('/go.mod'))) {
    const module = readFileSync(join(root, f), 'utf8').match(/^module\s+(\S+)/m)?.[1];
    if (module) ctx.goModules.push({ module, dir: posix.dirname(f) });
  }
  ctx.pyRoots = [...new Set(all.filter((f) => f.endsWith('/__init__.py')).map((f) => f.split('/')[0]))].filter((d) => !fileSet.has(`${d}/__init__.py`));

  const prevFiles = previousResults(previous);
  const files = {}, cache = {};
  const unparsed = [];
  let reparsed = 0;
  for (const f of all) {
    const ext = extname(f).toLowerCase();
    const lang = EXT_LANG[ext];
    if (!lang) { if (UNPARSED_EXT.has(ext)) unparsed.push(f); continue; }
    const abs = join(root, f);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isFile() || st.size > MAX_BYTES) { unparsed.push(f); continue; }
    const text = readFileSync(abs, 'utf8');
    if (looksMinified(text)) continue;
    const hash = createHash('sha1').update(text).digest('hex').slice(0, 16);
    let res = prevFiles[f]?.hash === hash ? prevFiles[f].res : null;
    if (!res) {
      try { res = await parseFile(text, lang, f); } catch (e) { unparsed.push(f); continue; }
      reparsed++;
    }
    cache[f] = { hash, res };
    files[f] = { lang, lines: text.split('\n').length, hash };
  }

  // Merge per-file results into global arrays; def ids are global indices.
  const defs = [], calls = [], branches = [], imports = [];
  for (const [f, { res }] of Object.entries(cache)) {
    const off = defs.length;
    res.defs.forEach((d) => defs.push({ ...d, parent: d.parent >= 0 ? d.parent + off : -1 }));
    res.calls.forEach((c) => calls.push({ ...c, file: f, from: c.from >= 0 ? c.from + off : -1 }));
    res.branches.forEach((b) => branches.push({ ...b, file: f, def: b.def >= 0 ? b.def + off : -1 }));
    res.imports.forEach((i) => imports.push({ ...i, file: f }));
  }

  // Index definitions by name, by file.
  const byName = new Map(), byFile = new Map();
  defs.forEach((d, i) => {
    if (d.anon) return;
    if (!byName.has(d.name)) byName.set(d.name, []);
    byName.get(d.name).push(i);
    if (!byFile.has(d.file)) byFile.set(d.file, []);
    byFile.get(d.file).push(i);
  });

  // Imports: local binding name -> { targets (files), member } per file; external modules per file.
  const bindings = new Map();
  const aliases = imports.filter((i) => i.alias);
  for (const imp of imports.filter((i) => !i.alias)) {
    const lang = files[imp.file]?.lang;
    const targets = resolveModule(imp.module, imp.file, lang, ctx);
    imp.local = targets.length > 0 || imp.module.startsWith('.');
    if (targets.length) imp.targets = targets;
    if (!bindings.has(imp.file)) bindings.set(imp.file, new Map());
    for (const n of imp.names || []) if (n.local) bindings.get(imp.file).set(n.local, { targets, member: n.member, module: imp.module, local: imp.local });
  }
  for (const a of aliases) {
    const b = bindings.get(a.file)?.get(a.module);
    if (b) bindings.get(a.file).set(a.names[0].local, { ...b, member: null });
  }
  const family = (f) => { const l = files[f]?.lang; return l === 'typescript' || l === 'tsx' ? 'javascript' : l; };

  const pickNonTest = (ids) => { const nt = ids.filter((i) => !isTest(defs[i].file)); return nt.length ? nt : ids; };
  const inFiles = (files, name) => files.flatMap((f) => (byFile.get(f) || []).filter((i) => defs[i].name === name));

  for (const c of calls) {
    const b = bindings.get(c.file) || new Map();
    const recv = c.callee.includes('.') ? c.callee.slice(0, c.callee.length - c.name.length).replace(/[.:>-]+$/, '') : '';
    const head = (recv || c.callee).split(/[.:(\[-]/)[0];
    let to = [], status = 'unresolved', ext;
    // A method on a call result (readFileSync(...).split) is not a call into the imported module.
    const bind = recv.includes('(') ? null : b.get(head);
    if (bind && bind.targets.length) {
      const member = recv ? c.name : (bind.member && bind.member !== 'default' ? bind.member : c.name);
      to = inFiles(bind.targets, member);
      if (!to.length && !recv && bind.member === 'default') to = inFiles(bind.targets, c.name).concat((byFile.get(bind.targets[0]) || []).filter((i) => defs[i].exported));
    } else if (bind && !bind.local) { status = 'external'; ext = bind.module; }
    const selfCall = /^(this|self|cls|@|super)$/.test(recv);
    if (!to.length && status !== 'external' && (!recv || selfCall)) {
      to = (byFile.get(c.file) || []).filter((i) => defs[i].name === c.name);
    }
    if (!to.length && status !== 'external' && byName.has(c.name)) {
      let cands = pickNonTest(byName.get(c.name).filter((i) => family(defs[i].file) === family(c.file)));
      // Through a receiver (obj.save()) only methods can be the target, never plain functions.
      if (recv && !selfCall) cands = cands.filter((i) => defs[i].qual.includes('.'));
      if (!cands.length) { /* stays unresolved */ }
      else if (cands.length === 1 && !(recv && !selfCall && COMMON_METHODS.has(c.name))) to = cands;
      else { to = cands.slice(0, 6); status = 'ambiguous'; }
    }
    if (to.length && status !== 'ambiguous') status = 'resolved';
    c.status = status;
    if (to.length) c.to = to;
    if (ext) c.ext = ext;
  }

  // Entry points.
  const entries = [];
  defs.forEach((d, i) => {
    for (const [kind, re] of ENTRY_DECORATORS) {
      const hit = d.decorators?.find((t) => re.test(t));
      if (hit) { entries.push({ kind, file: d.file, line: d.line, def: i, text: hit }); break; }
    }
    if (d.name === 'main' && ['go', 'rust', 'java', 'cpp', 'c-sharp'].includes(files[d.file]?.lang)) entries.push({ kind: 'main', file: d.file, line: d.line, def: i, text: `${d.qual}()` });
    if (/^(handler|lambda_handler|handle)$/.test(d.name) && d.exported) entries.push({ kind: 'serverless', file: d.file, line: d.line, def: i, text: d.name });
    const fr = fileRouteKind(d.file);
    if (fr === 'route' && /^(GET|POST|PUT|PATCH|DELETE|handler|default)$/.test(d.name)) entries.push({ kind: 'route', file: d.file, line: d.line, def: i, text: `${d.name} ${d.file}` });
  });
  for (const c of calls) {
    if (c.dec) continue;
    for (const [kind, re] of ENTRY_CALLS) {
      if (!re.test(c.callee) && !re.test(c.name)) continue;
      if (kind === 'route' && !c.str && !c.idents) break;
      const handlers = [];
      for (const id of c.idents || []) {
        const n = id.split('.').pop();
        const same = (byFile.get(c.file) || []).filter((i) => defs[i].name === n);
        const b = (bindings.get(c.file) || new Map()).get(id.split('.')[0]);
        handlers.push(...(same.length ? same : b?.targets?.length ? inFiles(b.targets, b.member && !id.includes('.') ? b.member : n) : []));
      }
      // Inline callbacks defined inside this call.
      defs.forEach((d, i) => { if (d.anon && d.file === c.file && d.line >= c.line && d.line <= c.line + 2 && d.name.startsWith(c.callee.slice(0, 40))) handlers.push(i); });
      entries.push({ kind, file: c.file, line: c.line, text: c.text, ...(handlers.length ? { handlers: [...new Set(handlers)] } : {}) });
      break;
    }
  }
  for (const b of branches) {
    const handlersAt = () => {
      const ids = calls.filter((c) => c.file === b.file && c.line >= b.line && c.line <= b.line + 3 && c.status === 'resolved').map((c) => c.to[0]);
      return ids.length ? { handlers: [...new Set(ids)] } : {};
    };
    if (/__name__\s*==\s*['"]__main__['"]|require\.main\s*===?\s*module|import\.meta\.url\s*===?\s*pathToFileURL\(process\.argv\[1\]\)|import\.meta\.main/.test(b.text)) {
      entries.push({ kind: 'main', file: b.file, line: b.line, text: b.text, ...handlersAt() });
    }
  }
  for (const f of Object.keys(files)) {
    if (fileRouteKind(f) === 'page') entries.push({ kind: 'page', file: f, line: 1, text: f });
  }
  entries.push(...manifestEntries(root, fileSet));
  // A manifest bin entry starts the same code as the main guard in the file it points to.
  for (const e of entries.filter((x) => x.kind === 'cli' && x.text.startsWith('bin '))) {
    const target = posix.normalize(posix.join(posix.dirname(e.file), e.text.split(': ').pop().trim()));
    const main = entries.find((x) => x.kind === 'main' && x.file === target);
    if (main?.handlers) e.handlers = main.handlers;
  }
  entries.sort((a, b) => (a.kind === b.kind ? 0 : a.kind < b.kind ? -1 : 1) || a.file.localeCompare(b.file) || a.line - b.line);
  entries.forEach((e, i) => { e.id = `E${i + 1}`; });

  const commit = spawnSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  return {
    version: GRAPH_VERSION, root, commit: commit.status === 0 ? commit.stdout.trim() : null,
    created: new Date().toISOString(), stats: { files: Object.keys(files).length, reparsed, unparsed: unparsed.length },
    files, unparsed, defs, calls, branches, imports, entries,
  };
}
