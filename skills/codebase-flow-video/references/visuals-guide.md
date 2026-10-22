# Visuals guide: show what the code does, not boxes

A box-and-arrow chart explains structure; it does not show the product working. Each scene should look like what the code actually does: agents talking to each other, a chat answering, a request being checked, a record changing as it moves through a pipeline. Add `"visual"` to a scene and the renderer draws an animated scene instead of the flow map.

**Rules**

0. **Look.** The default look is vivid: deep colour fields, translucent glass cards, gradient badges, drifting light. `"style": { "look": "flat" }` turns it off (plain cards) for documents or very formal audiences.
1. **Every visual must come from `FLOW.md`.** Agent names, tools, checks, fields, outcomes and queue behaviour are the ones the code has. Example values (an order number, a ticket title) must be realistic and invented, never real customer data. Give the scene a `ref` to the steps or branches it shows.
2. **Pick the visual from the code's shape** (table below). A storyboard can mix visuals and map scenes; the map is best as a short overview, not the whole video. A storyboard with only visuals needs no `nodes`; its outro is a numbered recap of the scene titles.
3. **One idea per scene.** Split long agent conversations or pipelines into several scenes (limits are enforced: 8 agent steps, 7 messages, 6 stages, 7 checks, 4 outcomes, 6 jobs, 16 code lines).
4. **Captions still carry the "so what".** The visual shows *how*; the caption says *why it matters*. No code words in either, except the `code` visual for developer audiences.

## Story arcs: the shape of the video follows the code

Do not use one template for every repo. Pick the arc for what the system is, then fill it from `FLOW.md`. Several pipelines become chapters; each chapter follows the arc of its own pipeline.

| The system is… | Arc (scene types in order) | `journey` item |
|---|---|---|
| Any product, launch or LinkedIn cut ("launch film", like agency SaaS videos) | `headline` hook → `showcase` of the product with callouts → per feature: `headline` (`orb` variant to change section) then the scene that shows it working (`agents`, `chat`, `request`…) → `showcase` of the result → sparkle outro. Style `launch` | the main object |
| AI agents / multi-agent | the request (`chat` or `screen`) → meet the agents (`agents`, cast only) → the work, one `agents` scene per phase with tool calls → guardrails (`checklist`) → outcome branches (`decision`) → the answer (`chat`) | the task or ticket |
| RAG / assistant | the question (`chat`) → retrieval (`pipeline`: query → search → rank → context) → the answer with sources (`chat`) → fallbacks (`decision`) | the question |
| API / SaaS backend | the user action (`screen`) → the request (`request` with real checks) → each business branch (`decision`) → background work (`queue`) → what the user sees (`screen` or `chat`) | the order / record |
| Data / ETL / ML | the source → one record through every stage (`pipeline`, several scenes if needed) → quality gates (`checklist`) → failures and retries (`queue`) → the output (`screen`) | the record |
| E-commerce / marketplace | browse (`screen`) → checkout (`request`) → payment and stock (`decision`) → fulfilment (`queue`) → confirmation (`chat` or `screen`) | the order |
| Fintech / payments | the payment (`request`) → risk and compliance (`checklist`) → approve / review / decline (`decision`) → ledger (`pipeline`) → notifications (`queue`) | the payment |
| Developer tool / CLI / library | the command (`code` or `request`) → what happens inside (`pipeline`) → options and errors (`decision`) → the result (`code` or `screen`) | the command or file |
| Mobile app | the screen (`screen`, device phone) → the API it calls (`request`) → branches (`decision`) → sync / push (`queue`) | the user action |

Layouts also adapt to the data: an agent that talks to every other agent is drawn as a hub in the middle; decision outcomes form a row or a grid; pipelines run left-to-right or top-to-bottom by format.

## Which visual for which code

| The code has… | Use | Examples |
|---|---|---|
| Several LLM agents, planners, tool calls, handoffs (LangGraph, CrewAI, AutoGen, Agents SDK, custom loops) | `agents` | planner → researcher → writer; agent calls search tool |
| A chat UI, assistant, support bot, RAG answer with sources | `chat` | user asks, assistant streams the answer, sources appear |
| An API route or service call with validation, then a save and a response | `request` | checkout POST, refund API, webhook handler |
| A record transformed step by step (ETL, enrichment, extraction, normalisation, ML features) | `pipeline` | invoice → extracted fields → matched → approved |
| A business branch (`if`/`switch` that changes the outcome) | `decision` | approved vs. manual review; in stock vs. sold out |
| A series of validations, fraud rules, guardrails, permission checks | `checklist` | KYC checks, content moderation, pre-send checks |
| Background jobs, workers, retries, dead-letter queues | `queue` | email sending, report generation, webhooks retry |
| A real screen of the app (captured with `capture.mjs`, see `screens-guide.md`) | `screen` | dashboard, checkout page, admin review screen |
| A key rule developers should see (developer audience only) | `code` | the one function that decides the refund limit |
| How everything connects (overview) | map scene (`reveal`/`flow`, no `visual`) | the whole system in one shot |

`node <skill-dir>/renderer/detect-style.mjs .` also suggests visuals from the dependencies.

## Schemas

All text is short, plain language. `icon` accepts any name from `render.mjs --list-icons`.

### agents
```json
{ "type": "agents",
  "agents": [ { "id": "planner", "name": "Planner", "role": "Breaks down the request" },
              { "id": "research", "name": "Researcher", "role": "Finds the facts", "icon": "search" } ],
  "tools":  [ { "id": "orders", "name": "Order database", "icon": "database" } ],
  "steps":  [ { "from": "planner", "type": "think", "text": "Duplicate charge" },
              { "from": "planner", "to": "research", "type": "handoff", "text": "Check order #1042" },
              { "from": "research", "to": "orders", "type": "tool", "text": "Look up payments" },
              { "from": "research", "to": "planner", "type": "result", "text": "Charged twice" } ] }
```
Step types: `think` (thought bubble, no `to`), `message`, `handoff`, `result` (between agents), `tool` (`to` is a tool; shows a spinner, then a tick). Up to 5 agents, 4 tools, 8 steps. In 16:9 an activity log narrates the steps (`"log": false` hides it). Use `"kind": "user"` on an agent to show a person.

### chat
```json
{ "type": "chat", "title": "Support assistant",
  "messages": [ { "from": "user", "text": "Where is my order?" },
                { "from": "system", "text": "Looked up order #1042", "icon": "search" },
                { "from": "assistant", "text": "It ships today and arrives Friday.", "sources": ["Order #1042", "Shipping policy"] } ] }
```
`from`: `user` (right, accent bubble), `assistant`/anything else (left, streams word by word after typing dots), `system`/`tool` (small centred event chip). `sources` shows citation chips (RAG).

### request
```json
{ "type": "request", "client": { "label": "Customer app", "icon": "phone" }, "server": { "label": "Orders service" },
  "store": { "label": "Orders database" }, "request": "Place order",
  "checks": [ { "label": "Items in stock", "ok": true }, { "label": "Card approved", "ok": true } ],
  "save": "Order saved", "response": { "label": "Order confirmed", "ok": true } }
```
Checks tick in order; the first `"ok": false` stops the flow (no save) and the response should then be `"ok": false`. `store` is optional.

### pipeline
```json
{ "type": "pipeline",
  "item": { "title": "Invoice INV-2041", "icon": "file", "fields": [["supplier", "Acme Ltd"], ["total", "€1,240"], ["status", "received"]] },
  "stages": [ { "label": "Read by AI", "effect": "add", "field": "due date", "value": "12 Jun" },
              { "label": "Match order", "effect": "check", "badge": "Matches PO" },
              { "label": "Approve", "effect": "change", "field": "status", "value": "approved" } ],
  "output": { "label": "Scheduled", "icon": "check" } }
```
Effects: `add` (new field slides in), `change` (value flips, highlighted), `remove` (struck out), `check` (badge), `filter`/`none` (station only). The record must look like real data from the code's model, with invented values.

### decision
```json
{ "type": "decision", "item": "Refund #1042", "question": "Is it under the auto-approve limit?",
  "options": [ { "label": "yes", "outcome": "Refunded automatically", "ok": true },
               { "label": "no", "outcome": "Manager approves", "icon": "users", "tone": "warn" } ],
  "chosen": 0 }
```
`chosen`: index of the path the item takes, or `"all"` (default) to send it down every path in turn. Show every outcome the code has (2-4); `tone` is `good`, `bad`, `warn` (or use `ok`).

### checklist
```json
{ "type": "checklist", "title": "Fraud checks", "subject": "Payment #8812",
  "items": [ { "label": "Card not reported stolen", "ok": true }, { "label": "Amount within usual range", "ok": "warn" } ],
  "result": { "label": "Approved with review", "ok": true } }
```

### queue
```json
{ "type": "queue", "label": "Email queue", "jobs": ["Receipt", "Welcome email", "Invoice PDF"], "workers": 2,
  "retry": true, "deadLetter": false, "done": "Sent" }
```
`retry` shows one job failing and retrying; `deadLetter` sends it to a "needs attention" bin instead (`deadLabel` renames it). Only show what the code does.

### screen
```json
{ "type": "screen", "src": "screens/checkout.png", "url": "shop.example/checkout", "device": "browser",
  "highlights": [ { "x": 0.62, "y": 0.70, "w": 0.3, "h": 0.09, "label": "One-click pay" } ] }
```
`src` is relative to the storyboard. Paste the snippet `capture.mjs` prints (highlights are measured from real elements). `device`: `browser`, `phone` or `none`.

### headline (kinetic title)
```json
{ "type": "headline", "text": "Smart control", "sub": "One dashboard for every agent", "icon": "sparkles", "variant": "lines" }
```
Big gradient words revealed one by one under a glowing emblem with light lines (`variant: "lines"`, default), or zooming through a glass lens with orbiting orbs (`variant: "orb"`). 2-6 words; `sub` one short line. Use it to open the video, to open each section or chapter, and before the payoff. No caption needed.

### showcase (the product in 3D)
```json
{ "type": "showcase",
  "src": "screens/home.png", "url": "app.example.com",
  "ui": { "app": "NeuraDesk", "nav": [{ "label": "Dashboard", "icon": "chart" }, { "label": "Tickets", "icon": "message" }],
          "greeting": "Hello, Mark", "headline": "How can I help you today?", "actions": ["Ask AI", "New ticket"],
          "widgets": [ { "type": "stat", "title": "Open tickets", "value": "24", "sub": "6 need a person" }, { "type": "ring", "title": "Resolved by AI", "value": 82 },
                       { "type": "list", "title": "Today", "items": ["Refund for #1042"] }, { "type": "chart", "title": "This week", "items": [4, 6, 5, 8] },
                       { "type": "chat", "title": "Ask", "value": "Summarise ticket #88" } ] },
  "callouts": [ { "title": "Live status", "text": "Every agent's work, as it happens", "icon": "bolt" } ] }
```
A glass window tilted in real 3D that slowly turns and moves closer, with a light sweep, blurred ghost panels behind it for depth, and up to 4 callout cards popping out around it (left/right on 16:9, above/below on square and vertical). Give either `src` (a real screenshot from `capture.mjs` or `fetch-source.mjs`; preferred) or `ui` (a dashboard mock-up). A `ui` mock-up must use the product's real screen names, navigation and data shapes from the code (routes, models, labels) with invented example values; never invent features. No caption needed.

### code (developer audiences only)
```json
{ "type": "code", "file": "src/refunds/policy.ts", "startLine": 12, "highlight": [14],
  "lines": ["export function decide(refund) {", "  const limit = settings.autoRefundLimit;", "  if (refund.amount <= limit) {"],
  "note": "One setting controls the limit" }
```
Lines are copied exactly from the repo (use `graph.mjs show`); `highlight` uses real line numbers. Never show secrets or credentials.

## Style

The renderer's look comes from `"style"` (see `storyboard-guide.md`). Run `node <skill-dir>/renderer/detect-style.mjs .` for the repo's own brand colours and font plus a preset suggestion; `node <skill-dir>/renderer/render.mjs --list-styles` lists presets:

Every preset renders on **white by default**; the preset sets the accents, glow colours, corners, font and pace. Use `"theme": "dark"` (or `--bg dark`) for its dark cinematic look, or `"bg": "#hex"` for a brand background; every card, text, icon and glow adapts.

| Preset | For |
|---|---|
| `launch` | cinematic SaaS / AI product launch: navy-black, electric blue glow, light lines, sparkle outro |
| `midnight` | default, anything (violet) |
| `daylight` | light version for documents and slides |
| `neural` | AI, agents, LLM apps |
| `ledger` | fintech, payments, banking, insurance |
| `storefront` | e-commerce, marketplaces, consumer apps |
| `clinic` | healthcare, wellness, education |
| `terminal` | developer tools, CLIs, infrastructure |
| `boardroom` | enterprise, B2B SaaS, internal tools |
| `ocean` | data pipelines, analytics, IoT |
| `candy` | playful apps, games, kids' education |
