# Storyboard guide

`storyboard.json` turns `FLOW.md` into a story a non-technical viewer (client CEO, LinkedIn audience) can follow with the sound off. The renderer handles all animation, layout, camera and timing; you only describe **what** exists and **in which order to tell it**.

Full working example: `examples/storyboard.example.json` in this skill.

**Every box, decision and caption points back to `FLOW.md` through `ref`.** The renderer reads `FLOW.md` next to the storyboard and refuses to render when a ref does not exist or when a branch from `FLOW.md`'s branch index is neither shown nor listed in `omitted`. This keeps the video tied to the code instead of to what sounds good.

## Schema

```jsonc
{
  "title": "InvoiceFlow",                       // product or project name, shown on title card + header
  "subtitle": "How a supplier invoice becomes a scheduled payment",  // one line, the promise
  "theme": "dark",                              // "dark" (default, best on LinkedIn) or "light"
  "accent": "#7C5CFF",                          // optional brand hex colour

  "nodes": [                                    // every box on the map
    { "id": "reader", "label": "AI reads the invoice", "sub": "Amounts, dates, line items",
      "kind": "ai", "icon": "sparkles", "ref": "P1.3" }   // ref = FLOW.md step or branch id(s)
  ],
  "edges": [                                    // every arrow; direction = data flow
    { "from": "confident", "to": "review", "label": "not sure", "ref": "B1" }
  ],
  "scenes": [                                   // the story, in order; one caption each
    { "title": "A safety check",                // optional kicker; default "Step N of M"
      "caption": "If the AI is confident, the invoice moves on. If not, a person checks it first.",
      "reveal": ["confident", "review", "match"],   // nodes that appear in this scene
      "flow": [["reader", "confident"], ["confident", "review"]],  // data packets, in order
      "focus": ["reader", "confident", "review", "match"],        // camera frames these
      "hold": 0.5,                              // optional extra seconds
      "ref": ["P1.3", "B1"] }                   // optional: what this caption is based on
  ],
  "omitted": [                                  // FLOW.md branches deliberately not shown
    { "ref": "B3", "reason": "internal retry when the accounting system is briefly down" }
  ],
  "outro": {
    "caption": "From inbox to payment in under a minute.",   // shown over the full-map shot
    "kicker": "The full picture",               // optional
    "cta": "Every invoice, read, checked and paid automatically."  // end card line
  }
}
```

### Node fields

| Field | Required | Notes |
|---|---|---|
| `id` | yes | unique, code-friendly |
| `label` | yes | 2-5 words, plain language, verb-first for steps ("Checks the payment") |
| `sub` | no | 2-6 word detail line, e.g. the vendor ("Stripe") or what is produced |
| `kind` | no | sets colour + default icon (table below), default `step` |
| `icon` | no | any name from `node renderer/render.mjs --list-icons` |
| `color` | no | hex override; use sparingly |
| `ref` | yes* | FLOW.md id(s) this box shows: a step (`"P1.3"`) or, for a decision, its branch (`"B1"`). String or array. *Every node except actors; the renderer warns when missing |

| kind | Use for | Colour | Default icon |
|---|---|---|---|
| `actor` | people: customer, admin, support agent | blue | user |
| `step` | work the system does | accent | gear |
| `decision` | a branch point; label as a question ("Is it valid?") | amber | branch |
| `store` | database, file storage, cache | teal | database |
| `external` | third-party service (dashed border) | grey | cloud |
| `ai` | LLM / ML model call | pink | sparkles |
| `output` | the final result the business cares about | green | check |

### Edge fields

`from`, `to`, optional `label` (1-3 words), optional `ref` (the branch id for edges leaving a decision). Put a label on **every edge leaving a decision** ("yes" / "no", "too risky" / "borderline", "card" / "bank transfer"). Use edge labels for the condition and node labels for what happens next. Loops (retry, resubmit) are fine; they render as arcs. Self-loops are not allowed; add a "Retry" node instead.

### Scene fields

- `caption` (required): one or two short sentences, at most 30 words. Write for the ear: what happens and **why it matters to the business**.
- `reveal`: nodes that pop in during this scene. Reveal 1-4 per scene. Every node should be revealed somewhere (otherwise it only appears in the outro).
- `flow`: ordered `[from, to]` pairs; each must match an edge, and both nodes must already be revealed (this scene or earlier). Packets travel in the listed order. For a decision, flow every outcome so the viewer sees both paths.
- `focus`: nodes the camera frames. Default: this scene's `reveal` plus its `flow` endpoints. Keep it to about 2-5 neighbouring nodes; the preview warns when text would be too small. Nodes outside the focus dim.
- `hold`: extra seconds when a scene needs to breathe.
- `ref`: FLOW.md ids the caption is based on. Required in practice when a caption states a speed, scale, security or "always/never" fact (see writing rule 9).

- `title`: short kicker above the caption (2-5 words, the business point: "Never oversell"). Give **every** scene a title or **none** (then each shows "Step N of M"); mixing reads oddly.

Arrows appear automatically once both of their nodes have been revealed.

### Top level: `omitted` and `ref`

- `omitted`: one `{ "ref": "B<n>", "reason": "..." }` per branch in FLOW.md's branch index that the video leaves out. The reason says why a viewer does not need it ("internal retry", "admin-only path"). Every branch is either shown (some node, edge or scene refs it) or omitted; the renderer errors otherwise. The report lists the omitted branches.
- `ref` on the storyboard itself or on `outro` backs a claim in the `subtitle` or outro text.

The renderer finds `FLOW.md` next to `storyboard.json` (or pass `--flow path`). Without it, refs are not checked and it warns.

## Layout tips

The layout runs left-to-right in 16:9 and top-to-bottom in 1:1 and 9:16, ordered by data flow. The camera can only frame nodes that sit near each other, so:

- **Keep outcomes local.** When a branch leads to something that happens much later or elsewhere (a queue, a background worker, an email), give that branch its own small outcome box right next to the decision ("Flagged for review", "Customer emailed"), instead of drawing an arrow across the whole map to a shared box.
- **Avoid hub boxes** that many distant steps flow into (one "Queue" or "Email service" box fed from five places). Either split them per use, or reveal them only in the scene that explains them.
- **Fan-outs:** a decision with 3+ outcomes is wide; focus on the decision and its outcomes only.
- **The outro overview is decorative.** With more than ~12 nodes its text is too small to read; that is fine, it shows scale. The outro caption carries the message.

## Writing rules (the video is for non-engineers)

1. **No code words on screen.** No file names, function names, class names, HTTP verbs, table names, env vars. Translate: `POST /invoices` becomes "Invoice arrives"; `pgvector similarity search` becomes "Finds similar past cases".
2. **Name vendors only when it builds trust or is the point** ("Payments via Stripe"). Otherwise use the role ("Payment provider").
3. **Every scene answers "so what?"** Prefer "so nobody retypes data" over "the data is parsed".
4. **Show the options.** Each decision from `FLOW.md`'s branch index that changes the business outcome gets its own scene, or shares one with its outcomes. Minor technical branches (cache hit/miss, internal retries) can be summarised as one "safety net" scene or left in `FLOW.md` only.
5. **One idea per scene.** If a caption needs "and then", split it.
6. **Structure:** hook (who starts it) → the main happy path → the branches and safety nets → the result. Then the outro sums up the value in one sentence.
7. **Several pipelines:** either tell them one after another in a single map (shared nodes are reused), or make one storyboard per pipeline (`storyboard-<name>.json`). Choose separate storyboards when the pipelines share almost nothing.
8. **Length follows the code.** Do not pad or cut to hit a time. Rough guide: 1 scene per 1-3 meaningful steps. Each scene lasts about 5-9 s depending on caption length and animation. If the full video runs past ~3 minutes and the user wants a social cut, offer an extra `storyboard-highlights.json` with only the business-critical scenes, rendered with `--out flow-video/highlights`.

9. **Claim only what the code shows.** Speed ("in seconds", "instantly"), scale, security ("secure", "bank-grade"), automation ("fully automatic") and absolutes ("always", "never", "zero errors") need code behind them: a ref to the FLOW.md step that implements the timeout, schedule, encryption or check. Without that, drop the claim. The renderer warns on these words in any text without a `ref`. Business value belongs in "so what" phrasing ("so nobody retypes data"), not in invented numbers.
10. **Decisions show every outcome.** Each `decision` needs at least two outgoing edges, each labelled, and every outcome carries a packet in some scene's `flow`. The renderer errors or warns otherwise.

## Never put in a storyboard

Secrets, API keys, tokens, passwords, internal hostnames or IPs, real customer or employee names, personal data, or anything the code owner would not publish. The video is meant to be shared publicly.
