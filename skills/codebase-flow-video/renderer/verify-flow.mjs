#!/usr/bin/env node
// Mechanically verifies FLOW.md against the code: every `path:line` exists, every quote sits at
// the cited line, every step and branch carries evidence, and the commit pin matches.
//
//   node verify-flow.mjs <FLOW.md> [--root REPO]
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadFlow, checkFlow, repoRoot } from './flowdoc.mjs';

function main() {
  const args = process.argv.slice(2);
  let root;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') root = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') { console.log('Usage: node verify-flow.mjs <FLOW.md> [--root REPO]'); return; }
    else rest.push(args[i]);
  }
  if (!rest[0]) { console.error('Usage: node verify-flow.mjs <FLOW.md> [--root REPO]'); process.exit(1); }
  const path = resolve(rest[0]);
  if (!existsSync(path)) { console.error(`not found: ${path}`); process.exit(1); }
  root = resolve(root || repoRoot(path));

  const flow = loadFlow(path);
  const { errors, warnings } = checkFlow(flow, root);
  errors.forEach((e) => console.log(`ERROR ${e}`));
  warnings.forEach((w) => console.log(`WARN ${w}`));
  console.log(`${flow.steps.size} steps, ${flow.branches.size} branches, ${flow.refs.length} code references, ` +
    `${flow.unverified} unverified claim(s); ${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(errors.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
