import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph, pack, unpack } from '../graph/build.mjs';
import * as Q from '../graph/query.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'polyglot');
const g = Q.prepare(await buildGraph(ROOT));
const text = (lines) => lines.join('\n');

test('parses every supported language and lists unsupported files', () => {
  assert.deepEqual(new Set(Object.values(g.files).map((f) => f.lang)),
    new Set(['javascript', 'python', 'go', 'java', 'ruby', 'php', 'c-sharp', 'rust']));
  assert.deepEqual(g.unparsed, ['misc/screen.kt']);
});

test('finds entry points of each kind, each pointing at its handler', () => {
  const list = text(Q.entries(g));
  for (const re of [/route\s+web\/server\.js:4 .*→ placeOrder/, /route\s+api\/app\/main\.py:7 .*→ ask/, /route\s+svc\/main\.go:19 .*→ handleUser/,
    /route\s+misc\/Order\.java:3 .*→ OrderController\.create/, /route\s+misc\/Ctl\.cs:2 .*→ Ctl\.List/, /main\s+api\/app\/main\.py:13/,
    /script\s+web\/package\.json/, /route\s+web\/server\.js:5 .*→ app\.get callback/]) {
    assert.match(list, re);
  }
  assert.equal(g.entries.filter((e) => e.file === 'api/app/main.py' && e.kind === 'route').length, 1, 'decorator counted once');
});

test('resolves calls across files through require, import, Go packages and methods', () => {
  const order = text(Q.calls(g, 'placeOrder', { depth: 2 }));
  assert.match(order, /parseOrder\s+web\/routes\/orders\.js:18-20/);
  assert.match(order, /charge\s+web\/services\/payments\.js:4-6/);
  assert.match(order, /Db\.saveOrder\s+web\/services\/db\.js:2-4/);
  assert.match(order, /Db\.insert/);
  assert.match(text(Q.calls(g, 'handleUser')), /Find\s+svc\/store\/store\.go:3-10/);
  const ask = text(Q.calls(g, 'ask', { depth: 2 }));
  assert.match(ask, /Planner\.plan/);
  assert.match(ask, /openai\.chat\.completions\.create\s+\[external: openai\]/);
  assert.match(text(Q.calls(g, 'Job.perform')), /Job\.load[\s\S]*Job\.notify/);
});

test('never links calls to a function in another language or to a same-named plain function', () => {
  assert.match(text(Q.calls(g, 'charge')), /stripe\.charges\.create\s+\[external: stripe\]/);
  assert.ok(!g.calls.some((c) => c.status === 'resolved' && g.files[c.file].lang !== g.files[g.defs[c.to[0]].file].lang
    && !['typescript', 'tsx', 'javascript'].includes(g.files[c.file].lang)));
});

test('path finds the chain from an entry point to an external service', () => {
  const p = text(Q.path(g, g.entries.find((e) => e.text.startsWith("app.post('/orders'")).id, 'ext:stripe'));
  assert.match(p, /placeOrder[\s\S]*→ charge/);
});

test('branches lists each decision in a function with its code', () => {
  assert.deepEqual(Q.branches(g, 'placeOrder'), [
    'web/routes/orders.js:6  if  if (!order.items.length) {',
    'web/routes/orders.js:9  try  try {',
    'web/routes/orders.js:11  catch  catch (err) {',
  ]);
  assert.match(text(Q.branches(g, 'run_tool')), /match\s+match name:/);
});

test('compact storage round-trips and unchanged files are not re-parsed', async () => {
  const back = Q.prepare(unpack(JSON.parse(JSON.stringify(pack(g)))));
  assert.equal(back.defs.length, g.defs.length);
  assert.equal(back.calls.length, g.calls.length);
  assert.deepEqual(Q.calls(back, 'placeOrder'), Q.calls(g, 'placeOrder'));
  const again = await buildGraph(ROOT, back);
  assert.equal(again.stats.reparsed, 0);
  assert.deepEqual(Q.entries(Q.prepare(again)), Q.entries(g));
});
