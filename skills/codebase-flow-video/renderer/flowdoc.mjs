// Parses and checks FLOW.md so its claims can be verified mechanically.
//
// Conventions (see references/analysis-guide.md):
//   step       list item starting with **P<pipeline>.<step>[a-z] Title**, e.g. "1. **P1.3 Match order**: ..."
//   branch     branch-index table row starting with | B<n> |
//   evidence   `path/to/file.ext:42` `quoted code`   (or :42-58 for a range); the quote must
//              appear at or near the cited line(s). The `path:line` backtick form is reserved
//              for code references.
//   commit     a line "Commit: `<sha>`" near the top pins the revision the lines refer to.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

const SPAN = /(`+)(.+?)\1/g; // markdown inline code spans
const REF = /^([^\s`]+?):(\d+)(?:-(\d+))?$/;
const BARE_FILES = new Set(['Dockerfile', 'Makefile', 'Procfile', 'Gemfile', 'Rakefile', 'Jenkinsfile', 'Containerfile']);
const STEP_DEF = /^\s*(?:\d+\.|[-*])\s+\*\*(P\d+\.\d+[a-z]?)\b/;
const BRANCH_DEF = /^\|\s*(B\d+)\s*\|/;
const BRANCH_MENTION = /\bBranch\s+(B\d+)\b/g;
const UNVERIFIED = /\(unverified:/;
const NEAR = 3; // a quote may sit this many lines from the cited line
const MIN_QUOTE = 8;

const looksLikePath = (p) =>
  !p.includes('://') && (p.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(p) || BARE_FILES.has(p.split('/').pop()));
const norm = (s) => s.replace(/\s+/g, ' ').trim();

// Returns { commit, steps: Map id->line, branches: Map id->line, refs: [{file, from, to, quote, line, text}],
//           defs: [{id, line, text, refs}], mentions: [{id, line}], unverified: number, hasCoverage }
export function parseFlow(text) {
  const lines = text.split('\n');
  const out = { commit: null, steps: new Map(), branches: new Map(), refs: [], defs: [], mentions: [],
    duplicates: [], unverified: 0, hasCoverage: false };
  lines.forEach((line, i) => {
    const ln = i + 1;
    const c = line.match(/^Commit:\s*`?([0-9a-f]{7,40})`?/i);
    if (c && !out.commit) out.commit = c[1];
    if (/^##\s+Coverage\b/i.test(line)) out.hasCoverage = true;
    if (UNVERIFIED.test(line)) out.unverified++;

    // Collect inline code spans in order; a ref followed directly by another span takes it as its quote.
    const spans = [];
    for (const m of line.matchAll(SPAN)) spans.push({ body: m[2].trim(), start: m.index, end: m.index + m[0].length });
    const lineRefs = [];
    spans.forEach((s, k) => {
      const r = s.body.match(REF);
      if (!r || !looksLikePath(r[1])) return;
      const next = spans[k + 1];
      const adjacent = next && /^\s*$/.test(line.slice(s.end, next.start)) && !REF.test(next.body);
      const ref = { file: r[1], from: Number(r[2]), to: Number(r[3] || r[2]), quote: adjacent ? next.body : null, line: ln };
      out.refs.push(ref);
      lineRefs.push(ref);
    });

    const step = line.match(STEP_DEF);
    const branch = line.match(BRANCH_DEF);
    const id = step?.[1] || branch?.[1];
    if (id) {
      const map = step ? out.steps : out.branches;
      if (map.has(id)) out.duplicates.push({ id, line: ln });
      else map.set(id, ln);
      out.defs.push({ id, line: ln, refs: lineRefs, unverified: UNVERIFIED.test(line) });
    }
    if (!branch) for (const m of line.matchAll(BRANCH_MENTION)) out.mentions.push({ id: m[1], line: ln });
  });
  return out;
}

export const flowIds = (flow) => new Set([...flow.steps.keys(), ...flow.branches.keys()]);

function gitHead(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function repoRoot(flowPath) {
  const dir = resolve(flowPath, '..');
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : resolve(dir, '..');
}

// Checks a parsed FLOW.md against the repository at `root`. Returns { errors: [], warnings: [] }.
export function checkFlow(flow, root) {
  const errors = [], warnings = [];
  const cache = new Map();
  const readLines = (file) => {
    if (!cache.has(file)) {
      const abs = resolve(root, file);
      const rel = relative(root, abs);
      let lines = null;
      if (!isAbsolute(file) && !rel.startsWith('..') && existsSync(abs) && statSync(abs).isFile()) {
        lines = readFileSync(abs, 'utf8').split('\n');
      }
      cache.set(file, lines);
    }
    return cache.get(file);
  };

  if (!flow.steps.size) errors.push('no steps found; define each step as a list item starting with **P<pipeline>.<step> Title**');
  flow.duplicates.forEach((d) => errors.push(`FLOW.md:${d.line}: duplicate id ${d.id}`));

  for (const ref of flow.refs) {
    const at = `FLOW.md:${ref.line}: \`${ref.file}:${ref.from}${ref.to !== ref.from ? '-' + ref.to : ''}\``;
    const lines = readLines(ref.file);
    if (!lines) { errors.push(`${at} file not found in repo (${root})`); continue; }
    if (ref.from < 1 || ref.to < ref.from || ref.to > lines.length) {
      errors.push(`${at} line out of range (file has ${lines.length} lines)`); continue;
    }
    if (!ref.quote) continue; // defs without quotes are reported below
    const q = norm(ref.quote);
    if (q.replace(/\s/g, '').length < MIN_QUOTE) warnings.push(`${at} quote "${ref.quote}" is too short to pin the line; quote the distinctive part`);
    const lo = Math.max(1, ref.from - NEAR), hi = Math.min(lines.length, ref.to + NEAR);
    const window = norm(lines.slice(lo - 1, hi).join(' '));
    if (!window.includes(q)) {
      const hit = lines.findIndex((l) => norm(l).includes(q));
      errors.push(`${at} quote "${ref.quote}" not found near line ${ref.from}` +
        (hit >= 0 ? ` (it appears at line ${hit + 1})` : ' (not found anywhere in the file)'));
    }
  }

  for (const d of flow.defs) {
    if (d.unverified) continue;
    if (!d.refs.length) errors.push(`FLOW.md:${d.line}: ${d.id} has no \`path:line\` reference; add one or mark it (unverified: reason)`);
    else if (!d.refs.some((r) => r.quote)) errors.push(`FLOW.md:${d.line}: ${d.id} reference has no quote; follow it with the exact code, e.g. \`file.ts:42\` \`if (total > limit)\``);
  }

  for (const m of flow.mentions) {
    if (!flow.branches.has(m.id)) errors.push(`FLOW.md:${m.line}: Branch ${m.id} is not in the branch index`);
  }
  const mentioned = new Set(flow.mentions.map((m) => m.id));
  for (const [id, line] of flow.branches) {
    if (!mentioned.has(id)) warnings.push(`FLOW.md:${line}: ${id} is in the branch index but no step mentions "Branch ${id}"`);
  }

  if (!flow.hasCoverage) warnings.push('no "## Coverage" section; add the inventory reconciliation (analysis-guide step 5)');
  if (!flow.commit) warnings.push('no "Commit: `<sha>`" line; pin the revision the line numbers refer to');
  else {
    const head = gitHead(root);
    if (head && !head.startsWith(flow.commit)) warnings.push(`FLOW.md was written at ${flow.commit} but the repo is at ${head.slice(0, 12)}; re-run verification after updating`);
  }
  return { errors, warnings };
}

export function loadFlow(path) {
  return parseFlow(readFileSync(path, 'utf8'));
}

export const defaultFlowPath = (storyboardPath) => join(resolve(storyboardPath, '..'), 'FLOW.md');
