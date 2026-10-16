// Parses one source file with tree-sitter and extracts definitions, calls, branches and imports.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFS, CONTAINERS, CALLS, RUBY_CALL, BRANCHES, IMPORTS, DECORATORS, ENTRY_CALLS } from './langs.mjs';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'));

let TS = null;
const languages = new Map();

async function language(name) {
  if (!TS) {
    TS = require('@vscode/tree-sitter-wasm');
    const dir = dirname(require.resolve('@vscode/tree-sitter-wasm'));
    await TS.Parser.init({ locateFile: (f) => join(dir, f) });
    TS.dir = dir;
  }
  if (!languages.has(name)) languages.set(name, await TS.Language.load(join(TS.dir, `tree-sitter-${name}.wasm`)));
  return languages.get(name);
}

const ALIAS_NODES = { variable_declarator: ['name', 'value'], assignment: ['left', 'right'], short_var_declaration: ['left', 'right'] };

const firstLine = (s, max = 120) => {
  const l = s.split('\n')[0].trim();
  return l.length > max ? l.slice(0, max - 1) + '…' : l;
};
const oneLine = (s, max = 80) => {
  const l = s.replace(/\s+/g, ' ').trim();
  return l.length > max ? l.slice(0, max - 1) + '…' : l;
};
const unquote = (s) => s.replace(/^[`'"]|[`'"]$/g, '');
export const lastName = (callee) => {
  const m = callee.replace(/<[^<>]*>/g, '').match(/([A-Za-z_$][\w$]*!?)\s*$/);
  return m ? m[1] : callee;
};

function assignedName(node) {
  const p = node.parent;
  if (!p) return null;
  const field = { variable_declarator: 'name', assignment_expression: 'left', pair: 'key', public_field_definition: 'name',
    field_definition: 'property', short_var_declaration: 'left', assignment: 'left', property_assignment: 'name' }[p.type];
  if (field) return p.childForFieldName(field)?.text || null;
  if (p.type === 'expression_list' && p.parent?.type === 'short_var_declaration') return p.parent.childForFieldName('left')?.text || null;
  return null;
}

function cppName(node) {
  let d = node.childForFieldName('declarator');
  while (d && !['identifier', 'field_identifier', 'qualified_identifier', 'destructor_name', 'operator_name'].includes(d.type)) {
    d = d.childForFieldName('declarator') || d.namedChild(0);
  }
  return d?.text || null;
}

function decoratorsOf(node) {
  const out = [];
  const take = (n) => { if (n && DECORATORS.has(n.type)) out.push(oneLine(n.text, 160)); };
  if (node.parent?.type === 'decorated_definition') node.parent.namedChildren.forEach(take);
  for (const c of node.namedChildren) {
    take(c);
    if (c.type === 'modifiers') c.namedChildren.forEach(take);
  }
  let s = node.previousNamedSibling;
  while (s && DECORATORS.has(s.type)) { take(s); s = s.previousNamedSibling; }
  return out;
}

function importOf(node, lang) {
  const t = node.type;
  if (t === 'import_statement' && (lang === 'javascript' || lang === 'typescript' || lang === 'tsx')) {
    const src = node.childForFieldName('source');
    if (!src) return null;
    const names = [];
    const clause = node.namedChildren.find((c) => c.type === 'import_clause');
    if (clause) {
      for (const c of clause.namedChildren) {
        if (c.type === 'identifier') names.push({ local: c.text, member: 'default' });
        else if (c.type === 'namespace_import') names.push({ local: c.namedChild(0)?.text, member: null });
        else if (c.type === 'named_imports') {
          for (const s of c.namedChildren.filter((x) => x.type === 'import_specifier')) {
            const name = s.childForFieldName('name')?.text, alias = s.childForFieldName('alias')?.text;
            names.push({ local: alias || name, member: name });
          }
        }
      }
    }
    return { module: unquote(src.text), names };
  }
  if (t === 'import_statement' && lang === 'python') {
    return node.namedChildren.map((c) => {
      const mod = c.type === 'aliased_import' ? c.childForFieldName('name')?.text : c.text;
      const alias = c.type === 'aliased_import' ? c.childForFieldName('alias')?.text : null;
      return { module: mod, names: [{ local: alias || mod.split('.')[0], member: null, whole: !alias }] };
    });
  }
  if (t === 'import_from_statement') {
    const mod = node.childForFieldName('module_name')?.text || '';
    const names = [];
    node.namedChildren.slice(1).forEach((c) => {
      if (c.type === 'dotted_name') names.push({ local: c.text, member: c.text });
      else if (c.type === 'aliased_import') names.push({ local: c.childForFieldName('alias')?.text, member: c.childForFieldName('name')?.text });
    });
    return { module: mod, names };
  }
  if (t === 'import_spec') {
    const path = unquote(node.childForFieldName('path')?.text || '');
    const alias = node.childForFieldName('name')?.text;
    return { module: path, names: [{ local: alias || path.split('/').pop(), member: null }] };
  }
  if (t === 'import_declaration' && lang === 'go') return null;
  if (t === 'import_declaration') {
    const mod = node.text.replace(/^import\s+(static\s+)?/, '').replace(/;\s*$/, '').trim();
    return { module: mod, names: [{ local: mod.split('.').pop(), member: null }] };
  }
  if (t === 'preproc_include') return { module: unquote(node.childForFieldName('path')?.text || '').replace(/^<|>$/g, ''), names: [] };
  const mod = oneLine(node.text.replace(/^(use|using|namespace)\s+/, '').replace(/;\s*$/, ''), 120);
  return { module: mod, names: [] };
}

// Returns { defs, calls, branches, imports } for one file. Line numbers are 1-based.
export async function parseFile(text, lang, file) {
  const lng = await language(lang);
  const parser = new TS.Parser();
  parser.setLanguage(lng);
  const tree = parser.parse(text);
  const defRules = DEFS[lang] || {};
  const defs = [], calls = [], branches = [], imports = [];
  const containers = [], defStack = [];
  let inDecorator = 0;

  const visit = (node) => {
    const type = node.type;
    let pushedDef = false, pushedContainer = false;
    const isDecorator = DECORATORS.has(type);
    if (isDecorator) inDecorator++;

    if (CONTAINERS.has(type)) {
      const name = node.childForFieldName('name')?.text || node.childForFieldName('type')?.text;
      if (name) { containers.push(name); pushedContainer = true; }
    }

    const rule = defRules[type];
    if (rule) {
      let name = rule === 'name' ? node.childForFieldName('name')?.text
        : rule === 'declarator' ? cppName(node) : assignedName(node);
      let anon = false;
      if (!name && rule === 'assigned') {
        // A callback passed straight into a call: name it after that call so entries can point at it.
        const call = node.parent?.type === 'arguments' ? node.parent.parent : null;
        if (call && CALLS[call.type]) {
          const f = call.childForFieldName(CALLS[call.type][0]);
          name = `${f ? oneLine(f.text, 40) : 'call'} callback`;
          anon = true;
        }
      }
      if (name) {
        const container = containers[containers.length - 1];
        defs.push({
          name: oneLine(name, 60), qual: container && !anon ? `${container}.${oneLine(name, 60)}` : oneLine(name, 60),
          kind: type, file, line: node.startPosition.row + 1, end: node.endPosition.row + 1,
          parent: defStack.length ? defStack[defStack.length - 1] : -1, anon,
          decorators: decoratorsOf(node),
          exported: node.parent?.type === 'export_statement' || node.parent?.parent?.parent?.type === 'export_statement',
        });
        defStack.push(defs.length - 1);
        pushedDef = true;
      }
    }

    const callRule = lang === 'ruby' && type === 'call' ? RUBY_CALL : CALLS[type];
    if (callRule) {
      const fn = node.childForFieldName(callRule[0]);
      if (fn) {
        const recv = callRule[1] ? node.childForFieldName(callRule[1]) : null;
        const callee = oneLine(recv ? `${recv.text}.${fn.text}` : fn.text, 80);
        const rec = { callee, name: lastName(callee), line: node.startPosition.row + 1, from: defStack.length ? defStack[defStack.length - 1] : -1 };
        const isRequire = rec.name === 'require' || rec.name === 'require_relative';
        const maybeEntry = ENTRY_CALLS.some(([, re]) => re.test(callee) || re.test(rec.name));
        // Arguments and source text are only kept where they matter, to keep graph.json small.
        const args = (isRequire || maybeEntry) ? node.childForFieldName('arguments') : null;
        if (args) {
          const strs = [], idents = [];
          for (const a of args.namedChildren) {
            if (/string|template_string|interpreted_string_literal/.test(a.type)) strs.push(unquote(oneLine(a.text, 60)));
            else if (a.type === 'identifier' || a.type === 'member_expression' || a.type === 'attribute') idents.push(oneLine(a.text, 60));
          }
          if (strs.length) rec.str = strs[0];
          if (idents.length) rec.idents = idents.slice(0, 4);
          if (isRequire && rec.str) {
            const decl = node.parent?.type === 'variable_declarator' ? node.parent.childForFieldName('name') : null;
            const names = [];
            if (decl?.type === 'identifier') names.push({ local: decl.text, member: null });
            else if (decl?.type === 'object_pattern') decl.namedChildren.forEach((c) => names.push({ local: c.text.split(':').pop().trim(), member: c.text.split(':')[0].trim() }));
            imports.push({ module: rec.str, names, line: rec.line, relative: rec.name === 'require_relative' });
          }
        }
        if (maybeEntry) rec.text = firstLine(text.split('\n')[node.startPosition.row] || '', 120);
        // Calls inside a decorator (@app.post(...)) are reported through the decorated function instead.
        if (maybeEntry && inDecorator) rec.dec = 1;
        calls.push(rec);
      }
    }

    // `x = new Stripe(...)`, `client = OpenAI()`: x behaves like the module its constructor came from.
    const alias = ALIAS_NODES[type];
    if (alias) {
      let left = node.childForFieldName(alias[0]), right = node.childForFieldName(alias[1]);
      if (left?.type === 'expression_list') left = left.namedChildCount === 1 ? left.namedChild(0) : null;
      if (right?.type === 'expression_list') right = right.namedChild(0);
      if (right?.type === 'await_expression') right = right.namedChild(0);
      const rule = right && CALLS[right.type];
      const fn = rule && right.childForFieldName(rule[0]);
      if (left && /^(identifier|name)$/.test(left.type) && fn) {
        imports.push({ module: fn.text.split(/[.(:]/)[0], names: [{ local: left.text, member: null }], line: node.startPosition.row + 1, alias: 1 });
      }
    }

    if (node.isNamed && BRANCHES.has(type)) {
      branches.push({ kind: type, line: node.startPosition.row + 1, text: firstLine(node.text),
        def: defStack.length ? defStack[defStack.length - 1] : -1 });
    }

    if (IMPORTS.has(type)) {
      const imp = importOf(node, lang);
      for (const i of [].concat(imp || [])) if (i.module) imports.push({ ...i, line: node.startPosition.row + 1 });
      // Import nodes hold nothing else worth walking, except Go's import block of import_specs.
      if (!(lang === 'go' && type === 'import_declaration')) return;
    }

    for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i));
    if (pushedDef) defStack.pop();
    if (pushedContainer) containers.pop();
    if (isDecorator) inDecorator--;
  };
  visit(tree.rootNode);
  tree.delete();
  parser.delete();
  return { defs, calls, branches, imports };
}
