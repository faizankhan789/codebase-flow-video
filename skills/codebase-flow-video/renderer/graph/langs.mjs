// Per-language tree-sitter node types used to build the code graph.
// Only named nodes are inspected. Unknown node types are ignored, so a rule that
// does not exist in a grammar is harmless.

export const EXT_LANG = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx',
  '.py': 'python', '.go': 'go', '.java': 'java', '.rb': 'ruby', '.php': 'php',
  '.cs': 'c-sharp', '.rs': 'rust', '.sh': 'bash', '.bash': 'bash',
  '.c': 'cpp', '.h': 'cpp', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp',
};

// Source files we recognise but cannot parse; they are listed so the analysis falls back to grep.
export const UNPARSED_EXT = new Set(['.kt', '.kts', '.swift', '.dart', '.scala', '.ex', '.exs', '.clj',
  '.lua', '.m', '.mm', '.vue', '.svelte', '.erl', '.hs', '.fs', '.r', '.jl', '.groovy', '.pl']);

// Function-like definitions. Value: how to find the name ('name' field unless noted).
const JS_DEFS = {
  function_declaration: 'name', generator_function_declaration: 'name', method_definition: 'name',
  function_expression: 'assigned', arrow_function: 'assigned', function: 'assigned',
};
export const DEFS = {
  javascript: JS_DEFS, typescript: JS_DEFS, tsx: JS_DEFS,
  python: { function_definition: 'name' },
  go: { function_declaration: 'name', method_declaration: 'name', func_literal: 'assigned' },
  java: { method_declaration: 'name', constructor_declaration: 'name' },
  ruby: { method: 'name', singleton_method: 'name' },
  php: { function_definition: 'name', method_declaration: 'name' },
  'c-sharp': { method_declaration: 'name', constructor_declaration: 'name', local_function_statement: 'name' },
  rust: { function_item: 'name' },
  cpp: { function_definition: 'declarator' },
  bash: { function_definition: 'name' },
};

// Containers give methods a qualified name (Class.method).
export const CONTAINERS = new Set(['class_declaration', 'class_definition', 'class', 'module', 'class_specifier',
  'struct_specifier', 'interface_declaration', 'impl_item', 'trait_item', 'struct_declaration', 'record_declaration',
  'abstract_class_declaration', 'object_declaration', 'enum_declaration']);

// Call sites. Value: [calleeField, receiverField?]; receiver joins the callee as "receiver.name".
export const CALLS = {
  call_expression: ['function'], new_expression: ['constructor'], call: ['function'],
  method_invocation: ['name', 'object'], object_creation_expression: ['type'],
  invocation_expression: ['function'], function_call_expression: ['function'],
  member_call_expression: ['name', 'object'], scoped_call_expression: ['name', 'scope'],
  nullsafe_member_call_expression: ['name', 'object'], macro_invocation: ['macro'], command: ['name'],
};
// Ruby's `call` node uses method/receiver instead of function.
export const RUBY_CALL = ['method', 'receiver'];

// Places where the flow can go more than one way.
export const BRANCHES = new Set(['if_statement', 'if_expression', 'if', 'unless', 'if_modifier', 'unless_modifier',
  'elif_clause', 'else_if_clause', 'switch_statement', 'switch_expression', 'expression_switch_statement',
  'type_switch_statement', 'select_statement', 'match_statement', 'match_expression', 'case_statement', 'case',
  'try_statement', 'try_expression', 'catch_clause', 'except_clause', 'rescue', 'conditional_expression',
  'ternary_expression', 'guard_statement', 'when']);

export const IMPORTS = new Set(['import_statement', 'import_from_statement', 'import_declaration', 'import_spec',
  'namespace_use_declaration', 'using_directive', 'use_declaration', 'preproc_include']);

export const DECORATORS = new Set(['decorator', 'annotation', 'marker_annotation', 'attribute_list', 'attribute_item']);

// Entry-point rules. Decorator rules match decorator/annotation text; call rules match the callee text.
export const ENTRY_DECORATORS = [
  ['route', /@(app|router|api|bp|blueprint|\w+_router|\w+Router|\w+_bp)\.(get|post|put|patch|delete|route|websocket|api_route)\b/i],
  ['route', /@(Get|Post|Put|Patch|Delete|All|Head|Options|Request)(Mapping)?\b/],
  ['route', /\[(Http(Get|Post|Put|Patch|Delete)|Route)\b/],
  ['job', /@(shared_task|\w+\.task|Scheduled|KafkaListener|RabbitListener|SqsListener|JmsListener|EventListener|EventPattern|MessagePattern|Cron|Interval|Process|Processor)\b/],
  ['job', /@(dag|task|asset|op|flow)\b/],
  ['cli', /@(click\.(command|group)|\w+\.command|\w+\.group)\b/],
];
export const ENTRY_CALLS = [
  ['route', /^(app|router|server|api|routes?|r|e|g|mux|fastify|bp|\w*[Rr]outer|\w*[Aa]pp)\.(get|post|put|patch|delete|all|options|head|route|handle|HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE|Any)$/],
  ['route', /^http\.(HandleFunc|Handle)$/],
  ['job', /^(cron\.schedule|schedule\.scheduleJob|schedule\.every|\w*[Qq]ueue\.process|channel\.consume|consumer\.run|\w*[Ss]cheduler\.add_job|Worker|CronJob)$/],
  ['cli', /^(program|cli|yargs)\.command$|^argparse\.ArgumentParser$|^ArgumentParser$|^(cobra\.)?Command$|^typer\.Typer$/],
];
