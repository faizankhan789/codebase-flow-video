# Verification guide

The agent that traced the code is the worst judge of its own trace: it remembers what it meant, not what the code says. So verification happens twice, by different means. A script checks that every piece of evidence exists. A fresh subagent checks what the evidence means.

## Pass 1: mechanical (`verify-flow.mjs`)

```bash
node <skill-dir>/renderer/verify-flow.mjs flow-video/FLOW.md [--root <repo>]
```

Paths resolve against the git top level (override with `--root`). Exit code 1 on any `ERROR`.

| Message | Meaning | Fix |
|---|---|---|
| `file not found in repo` | invented or mistyped path | find the real file with `git grep` |
| `line out of range` | invented line number | re-read the file |
| `quote ... not found near line N (it appears at line M)` | line drifted | change the line number to M, after checking it is the same code path |
| `quote ... not found anywhere in the file` | quote retyped from memory, or the claim is wrong | re-read the code, copy the exact text, rethink the claim |
| `P1.4 has no path:line reference` / `has no quote` | claim without evidence | add the evidence, or mark it `(unverified: reason)` |
| `Branch B7 is not in the branch index` | index incomplete | add a row with evidence |
| `WARN ... no "## Coverage" section` | recall not shown | add the inventory table (analysis-guide step 5) |
| `WARN FLOW.md was written at X but the repo is at Y` | code moved since tracing | re-run both passes |

Repeat until it reports 0 errors.

## Pass 2: independent claim check (fresh subagent)

Dispatch **one** subagent (or one per pipeline for large repos, in parallel, in a single message). It must not be the agent that wrote `FLOW.md` and must not receive your trace notes, only the file and the repo. Prompt:

> You are verifying `flow-video/FLOW.md` against the code in this repository. Treat every claim as unproven. For each step (`**P…**`) and each branch-index row (`| B… |`):
> 1. Open the cited `file:line` and read enough surrounding code to judge the claim. Use the code graph instead of reading whole files: `node <skill-dir>/renderer/graph.mjs show <file:line>` prints the enclosing function, `calls` / `callers` show what it calls and who calls it.
> 2. Check the "Does" line, the In/Out data, the condition and every listed outcome.
> 3. Check that the step really follows the previous one: the previous step calls it, enqueues it or hands its data to it.
> 4. For branches: is the condition reachable? Is the default config value as stated? Are there outcomes the line lists but the code does not have, or outcomes the code has that the line omits?
>
> Return only a table: `id | verdict (CONFIRMED / WRONG / UNVERIFIABLE) | evidence (file:line) | correction (for WRONG)`. Then list any branch sites you saw in the cited functions that are missing from the branch index, and any behaviour that looks like a bug. Do not rewrite FLOW.md.

Then:

- **WRONG**: fix `FLOW.md` and re-run pass 1.
- **UNVERIFIABLE**: mark the claim `(unverified: <reason the verifier gave>)`.
- **Missing branch sites**: add them to the branch index, or count them as trivial guards in Coverage.
- **Bugs**: add to `## Suspected bugs`.

## Pass 3: storyboard claim check (after writing `storyboard.json`)

The renderer checks the storyboard's structure and refs: every `ref` must exist in `FLOW.md`, every branch must be shown or listed in `omitted`, and claim-like words in unreferenced text produce a warning. It cannot judge whether a caption says what the referenced steps do. Dispatch a fresh subagent:

> Compare `flow-video/storyboard.json` with `flow-video/FLOW.md`. For each node, edge label and scene caption, find what it says in FLOW.md through its `ref` (for scenes without a ref, use the refs of the nodes in its `reveal` and `flow`). Flag any statement FLOW.md does not support: invented steps, wrong order, wrong outcome, an outcome shown as automatic that involves a person (or the reverse), and speed, scale, security or "always/never" claims. Also flag edges whose direction contradicts the data flow in FLOW.md. Return only: `location | statement | problem | suggested wording`.

Fix every flagged item, then re-run `render.mjs --preview`.
