#!/usr/bin/env node
// Code graph for token-efficient analysis: index a repo once, then ask small questions
// instead of reading whole files.
//
//   node graph.mjs index [REPO]            build/refresh flow-video/graph.json (only changed files re-parsed)
//   node graph.mjs summary                 languages, folders, entry points, hubs, external packages
//   node graph.mjs entry [KIND]            entry points (route, page, job, cli, main, serverless, script, process)
//   node graph.mjs calls SYM [--depth N] [--all]   what SYM calls (tree), with file:line
//   node graph.mjs callers SYM [--depth N]         who calls SYM
//   node graph.mjs path FROM TO            call chains; FROM may be E<n>; TO may be ext:<package>
//   node graph.mjs branches SYM|FILE       if/switch/try/... sites with the code line
//   node graph.mjs show SYM [--full]       the definition's lines, numbered
//   node graph.mjs slice FILE:A-B          numbered lines
//   node graph.mjs externals               outside packages and where they are used
//   node graph.mjs find REGEX              definitions by name
//   node graph.mjs unparsed                source files tree-sitter could not parse (use grep for these)
//
// SYM is a name, Class.method, file:line, or an entry id like E3.
// Options: --repo DIR (default: git top level of cwd), --limit N (default 60 output lines).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildGraph, pack, unpack } from './graph/build.mjs';
import * as Q from './graph/query.mjs';

function parseArgs(argv) {
  const opts = { limit: 60, depth: undefined, all: false, full: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') opts.repo = argv[++i];
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--depth') opts.depth = Number(argv[++i]);
    else if (a === '--all') opts.all = true;
    else if (a === '--full') opts.full = true;
    else rest.push(a);
  }
  return { cmd: rest[0], args: rest.slice(1), opts };
}

const gitTop = (dir) => {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : resolve(dir);
};

function print(lines, limit) {
  const shown = lines.slice(0, limit);
  console.log(shown.join('\n'));
  if (lines.length > limit) console.log(`… ${lines.length - limit} more line(s); narrow the query or pass --limit ${lines.length}`);
}

async function main() {
  const { cmd, args, opts } = parseArgs(process.argv.slice(2));
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 20).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  const root = resolve(cmd === 'index' && args[0] ? args[0] : opts.repo || gitTop(process.cwd()));
  const file = join(root, 'flow-video', 'graph.json');

  if (cmd === 'index') {
    const prev = existsSync(file) ? unpack(JSON.parse(readFileSync(file, 'utf8'))) : null;
    const t0 = Date.now();
    const g = await buildGraph(root, prev);
    mkdirSync(join(root, 'flow-video'), { recursive: true });
    writeFileSync(file, JSON.stringify(pack(g)));
    console.log(`indexed ${g.stats.files} files (${g.stats.reparsed} parsed, ${g.stats.files - g.stats.reparsed} unchanged) in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${file}`);
    print(Q.summary(Q.prepare(g)), opts.limit);
    return;
  }

  if (!existsSync(file)) { console.error(`no graph at ${file}; run: node graph.mjs index ${root}`); process.exit(1); }
  const g = unpack(JSON.parse(readFileSync(file, 'utf8')));
  if (!g) { console.error(`graph at ${file} is from another version; run: node graph.mjs index ${root}`); process.exit(1); }
  Q.prepare(g);
  const need = (n, usage) => { if (args.length < n) { console.error(`usage: ${usage}`); process.exit(1); } };
  let out;
  switch (cmd) {
    case 'summary': out = Q.summary(g); break;
    case 'entry': case 'entries': out = Q.entries(g, args[0]); break;
    case 'calls': need(1, 'calls SYM [--depth N] [--all]'); out = Q.calls(g, args[0], { depth: opts.depth ?? 2, all: opts.all }); break;
    case 'callers': need(1, 'callers SYM [--depth N]'); out = Q.callers(g, args[0], { depth: opts.depth ?? 1 }); break;
    case 'path': need(2, 'path FROM TO'); out = Q.path(g, args[0], args[1]); break;
    case 'branches': need(1, 'branches SYM|FILE'); out = Q.branches(g, args[0]); break;
    case 'show': need(1, 'show SYM [--full]'); out = Q.show(g, root, args[0], { full: opts.full }); break;
    case 'slice': need(1, 'slice FILE:A-B'); out = Q.slice(g, root, args[0]); break;
    case 'externals': out = Q.externals(g); break;
    case 'find': need(1, 'find REGEX'); out = Q.find(g, args[0]); break;
    case 'unparsed': out = g.unparsed.length ? g.unparsed : ['(every source file was parsed)']; break;
    default: console.error(`unknown command "${cmd}" (run: node graph.mjs help)`); process.exit(1);
  }
  print(out, opts.full && cmd === 'show' ? Infinity : opts.limit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
