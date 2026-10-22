#!/usr/bin/env node
// Mechanically verifies FLOW.md against the code: every `path:line` exists, every quote sits at
// the cited line, every step and branch carries evidence, the commit pin matches, and (with
// flow-video/graph.json present) no entry point or decision-making function on a traced path was skipped.
//
//   node verify-flow.mjs <FLOW.md> [--root REPO]
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadFlow, checkFlow, checkGraphCoverage, repoRoot } from './flowdoc.mjs';
import { unpack } from './graph/build.mjs';

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
  // With the code graph next to FLOW.md, also check that nothing was skipped.
  const graphPath = join(dirname(path), 'graph.json');
  if (existsSync(graphPath)) {
    const g = unpack(JSON.parse(readFileSync(graphPath, 'utf8')));
    if (g) {
      const c = checkGraphCoverage(flow, g);
      errors.push(...c.errors);
      warnings.push(...c.warnings);
      console.log(`Graph coverage: ${g.entries.length} entry points checked against FLOW.md`);
    }
  } else warnings.push(`no graph.json next to FLOW.md; run graph.mjs index first so skipped entry points and functions can be detected`);
  errors.forEach((e) => console.log(`ERROR ${e}`));
  warnings.forEach((w) => console.log(`WARN ${w}`));
  console.log(`${flow.steps.size} steps, ${flow.branches.size} branches, ${flow.refs.length} code references, ` +
    `${flow.unverified} unverified claim(s); ${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(errors.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
