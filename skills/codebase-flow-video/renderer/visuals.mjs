// Validation for scene "visual" objects (the animated scene types drawn by engine/scenes.js).
export const VISUAL_TYPES = ['agents', 'chat', 'request', 'pipeline', 'decision', 'checklist', 'queue', 'screen', 'code'];
const STEP_TYPES = ['message', 'handoff', 'tool', 'result', 'think'];
const EFFECTS = ['add', 'change', 'remove', 'check', 'filter', 'none'];

const arr = (x) => Array.isArray(x) && x.length > 0;

// Returns a list of problems for one visual; `at` prefixes messages, `icons` is the icon set.
export function validateVisual(v, at, icons) {
  const e = [];
  if (!v || typeof v !== 'object' || !v.type) return [`${at}: "visual" needs a "type" (${VISUAL_TYPES.join(', ')})`];
  if (!VISUAL_TYPES.includes(v.type)) return [`${at}: unknown visual type "${v.type}" (${VISUAL_TYPES.join(', ')})`];
  const icon = (name, where) => { if (name && !icons[name]) e.push(`${at}.${where}: unknown icon "${name}" (run --list-icons)`); };
  switch (v.type) {
    case 'agents': {
      if (!arr(v.agents)) { e.push(`${at}.agents: list the agents, e.g. [{ "id": "planner", "name": "Planner" }]`); break; }
      if (v.agents.length > 5) e.push(`${at}.agents: ${v.agents.length} agents; show at most 5 per scene (split the scene)`);
      const ids = new Set();
      v.agents.forEach((a, i) => { if (!a.id || !a.name) e.push(`${at}.agents[${i}]: needs "id" and "name"`); ids.add(a.id); icon(a.icon, `agents[${i}].icon`); });
      const tools = new Set();
      (v.tools || []).forEach((t, i) => { if (!t.id || !t.name) e.push(`${at}.tools[${i}]: needs "id" and "name"`); tools.add(t.id); icon(t.icon, `tools[${i}].icon`); });
      if ((v.tools || []).length > 4) e.push(`${at}.tools: at most 4 tools per scene`);
      if (!arr(v.steps)) e.push(`${at}.steps: list what happens, e.g. [{ "from": "planner", "to": "researcher", "type": "message", "text": "Find refund rules" }]`);
      (v.steps || []).forEach((s, i) => {
        if (!ids.has(s.from)) e.push(`${at}.steps[${i}].from: "${s.from}" is not an agent`);
        if (s.type && !STEP_TYPES.includes(s.type)) e.push(`${at}.steps[${i}].type: use ${STEP_TYPES.join(', ')}`);
        if (s.to !== undefined && !ids.has(s.to) && !tools.has(s.to)) e.push(`${at}.steps[${i}].to: "${s.to}" is not an agent or tool`);
        if (s.type === 'tool' && !tools.has(s.to)) e.push(`${at}.steps[${i}]: a "tool" step needs "to" set to one of the tools`);
        if (s.type !== 'think' && s.to === undefined) e.push(`${at}.steps[${i}]: needs "to" (or type "think")`);
      });
      if ((v.steps || []).length > 8) e.push(`${at}.steps: ${v.steps.length} steps; keep it to 8 per scene so each one is readable`);
      break;
    }
    case 'chat':
      if (!arr(v.messages)) e.push(`${at}.messages: list the conversation, e.g. [{ "from": "user", "text": "Where is my order?" }]`);
      (v.messages || []).forEach((m, i) => { if (!m.text) e.push(`${at}.messages[${i}]: needs "text"`); if (m.sources && !Array.isArray(m.sources)) e.push(`${at}.messages[${i}].sources must be a list of short labels`); });
      if ((v.messages || []).length > 7) e.push(`${at}.messages: keep it to 7 messages per scene`);
      break;
    case 'request':
      (v.checks || []).forEach((c, i) => { if (!c.label) e.push(`${at}.checks[${i}]: needs "label"`); });
      if ((v.checks || []).length > 6) e.push(`${at}.checks: at most 6 checks`);
      for (const k of ['client', 'server', 'store']) { if (v[k] && !v[k].label) e.push(`${at}.${k}: needs "label"`); icon(v[k]?.icon, `${k}.icon`); }
      if (v.response && !v.response.label) e.push(`${at}.response: needs "label"`);
      break;
    case 'pipeline':
      if (!v.item || !Array.isArray(v.item.fields)) e.push(`${at}.item: needs "title" and "fields": [["key", "value"], ...] (one real example record)`);
      if (!arr(v.stages)) e.push(`${at}.stages: list the stages the record goes through`);
      (v.stages || []).forEach((s, i) => {
        if (!s.label) e.push(`${at}.stages[${i}]: needs "label"`);
        if (s.effect && !EFFECTS.includes(s.effect)) e.push(`${at}.stages[${i}].effect: use ${EFFECTS.join(', ')}`);
        if (['add', 'change', 'remove'].includes(s.effect) && !s.field) e.push(`${at}.stages[${i}]: effect "${s.effect}" needs "field"`);
        if (['change', 'remove'].includes(s.effect) && s.field && !(v.item?.fields || []).some(([k]) => k === s.field) && !(v.stages || []).slice(0, i).some((p) => p.effect === 'add' && p.field === s.field)) {
          e.push(`${at}.stages[${i}]: field "${s.field}" does not exist on the record at that point`);
        }
        icon(s.icon, `stages[${i}].icon`);
      });
      if ((v.stages || []).length > 6) e.push(`${at}.stages: at most 6 stages per scene`);
      break;
    case 'decision':
      if (!v.question) e.push(`${at}.question: the condition as a plain question, e.g. "Is the payment approved?"`);
      if (!Array.isArray(v.options) || v.options.length < 2) e.push(`${at}.options: at least two outcomes`);
      (v.options || []).forEach((o, i) => { if (!o.label && !o.outcome) e.push(`${at}.options[${i}]: needs "label" and/or "outcome"`); icon(o.icon, `options[${i}].icon`); });
      if ((v.options || []).length > 4) e.push(`${at}.options: at most 4 outcomes`);
      if (v.chosen !== undefined && v.chosen !== 'all' && !(Number.isInteger(v.chosen) && v.chosen >= 0 && v.chosen < (v.options || []).length)) e.push(`${at}.chosen: an option index or "all"`);
      break;
    case 'checklist':
      if (!arr(v.items)) e.push(`${at}.items: list the checks, e.g. [{ "label": "Card is valid", "ok": true }]`);
      (v.items || []).forEach((it, i) => { if (!it.label) e.push(`${at}.items[${i}]: needs "label"`); if (it.ok !== undefined && ![true, false, 'warn'].includes(it.ok)) e.push(`${at}.items[${i}].ok: true, false or "warn"`); });
      if ((v.items || []).length > 7) e.push(`${at}.items: at most 7 checks`);
      if (v.result && !v.result.label) e.push(`${at}.result: needs "label"`);
      break;
    case 'queue':
      if (!arr(v.jobs)) e.push(`${at}.jobs: a few example job labels, e.g. ["Welcome email", "Invoice PDF"]`);
      if ((v.jobs || []).length > 6) e.push(`${at}.jobs: at most 6 jobs`);
      if (v.workers !== undefined && !(Number.isInteger(v.workers) && v.workers >= 1 && v.workers <= 4) && !(Array.isArray(v.workers) && v.workers.length >= 1 && v.workers.length <= 4)) e.push(`${at}.workers: 1-4, or a list of up to 4 names`);
      break;
    case 'screen':
      if (!v.src) e.push(`${at}.src: path to a screenshot (relative to the storyboard), e.g. "screens/checkout.png"`);
      (v.highlights || []).forEach((h, i) => {
        if (![h.x, h.y, h.w, h.h].every((n) => typeof n === 'number' && n >= 0 && n <= 1)) e.push(`${at}.highlights[${i}]: x, y, w, h are fractions of the screenshot (0-1)`);
      });
      break;
    case 'code':
      if (!arr(v.lines)) e.push(`${at}.lines: the exact code lines, copied from the repo`);
      if ((v.lines || []).length > 16) e.push(`${at}.lines: at most 16 lines; show the part that matters`);
      if (v.highlight && !Array.isArray(v.highlight)) e.push(`${at}.highlight: a list of line numbers (counting from "startLine", default 1)`);
      break;
  }
  return e;
}

// All viewer-facing text in a visual, for the claim checker.
export function visualText(v) {
  if (!v) return '';
  const out = [];
  const walk = (x, key) => {
    if (typeof x === 'string') { if (!['type', 'id', 'from', 'to', 'icon', 'src', 'effect', 'device', 'tone', 'kind', 'color'].includes(key)) out.push(x); }
    else if (Array.isArray(x)) x.forEach((y) => walk(y, key));
    else if (x && typeof x === 'object') Object.entries(x).forEach(([k, y]) => walk(y, k));
  };
  walk(v.type === 'code' ? { note: v.note } : v, '');
  return out.join(' ');
}
