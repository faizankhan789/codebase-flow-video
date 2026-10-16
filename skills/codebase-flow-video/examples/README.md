# Example storyboards

Fictional products, written by hand to show what the renderer can do. Real runs start from the code: `FLOW.md` first, then a storyboard with a `ref` on every scene.

| Example | Shows | Render |
|---|---|---|
| `helpdesk-agents/` | animated scenes only: chat, agents with tools, checklist, decision, request, pipeline, queue, code; `neural` style; recap outro | `node ../renderer/render.mjs helpdesk-agents/storyboard.json --out /tmp/helpdesk` |
| `invoice-flow/` | the box-and-arrow map with branches and a loop; `midnight` style | `node ../renderer/render.mjs invoice-flow/storyboard.json --out /tmp/invoice` |
