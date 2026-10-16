---
name: codebase-flow-video
description: Use when the user wants an animated explainer video of how a codebase, app, AI agent system or data pipeline works end to end, a product/launch walkthrough video for clients, executives, investors or LinkedIn, or a complete map of every step and branch in a repo (FLOW.md). Triggers on "/codebase-flow-video", "make a video of how this works", "explain this repo in a video", "LinkedIn video of my project".
---

# Codebase Flow Video

## Overview

Understand a repository end to end (every pipeline, step and branch), then turn it into an animated explainer in 16:9, 1:1 and 9:16 that **shows the product working**: agents talking and calling tools, a chat answering with sources, a request being checked, a record changing as it moves through a pipeline, real screenshots of the app. The look adapts to the codebase (its brand colours and font, a style preset for its domain), and an original music track is generated to fit the video. Claude writes `FLOW.md` (technical truth) and `storyboard.json` (the story); bundled tools do the graph analysis, verification, capture, animation and music, so Claude never writes animation code.

**Core principle:** the video can only be as accurate as `FLOW.md`, and `FLOW.md` can only claim what the code shows. Every claim carries checkable evidence (`file:line` plus the exact code), is checked by a script and by a fresh subagent, and every scene points back to the `FLOW.md` steps it shows.

## Invocation options

Parse these from the request (natural language or flags); otherwise use the defaults.

| Option | Values | Default |
|---|---|---|
| `--pipelines` | names from `FLOW.md`, or `all` | all |
| `--style` | `auto` or a preset (`render.mjs --list-styles`) | `auto` (repo brand + domain preset) |
| `--audience` | `linkedin`, `clients`, `executives`, `investors`, `developers` | `linkedin` (non-technical) |
| `--format` | `16x9`, `1x1`, `9x16`, `all` | `all` |
| `--screens` | capture real screenshots of the running app | off (needs the user's yes) |
| `--music FILE` / `--no-music` | own track / silent | generated original track |
| `--cut` | `full`, `highlights` (≤ 60 s, business-critical scenes only) | `full` |

## Outputs (in `<repo>/flow-video/`)

```
FLOW.md            every pipeline, step, branch, with file:line + quoted code
graph.json         code graph (cache; safe to delete)
storyboard.json    the story: scenes, visuals, style
screens/           captured screenshots (only with --screens)
preview/           still frames used to check layout
flow-16x9.mp4      landscape: meetings, YouTube
flow-1x1.mp4       square: LinkedIn feed
flow-9x16.mp4      vertical: Reels, Shorts, Stories
share.md           ready-to-post LinkedIn / X copy
```

## Workflow

`<skill-dir>` is this skill's base directory.

1. **Scope.** Confirm the repo (default: current directory) and the options above. If the code belongs to someone else (employer, client), confirm they may publish a video about it. When running unattended or the user said "just do it", use the defaults and note them in the report.
2. **Setup.** If `<skill-dir>/renderer/node_modules` does not exist (first run, or after a plugin update), run `bash <skill-dir>/renderer/setup.sh`. Needs Node 18+ and ffmpeg; the script says how to install them if missing.
3. **Analyse.** Follow `references/analysis-guide.md`: pin the commit, index the repo with the code graph (`node <skill-dir>/renderer/graph.mjs index .`) and work from graph queries instead of reading whole files, inventory entry points (`graph entry` + grep), trace each pipeline with ids (`P1.3`, `B2`) and quoted evidence, reconcile the branch/config/external-system inventories into `## Coverage`. Write `flow-video/FLOW.md`. Use parallel subagents for large repos.
4. **Verify FLOW.md.** Follow `references/verification-guide.md`. Run `node <skill-dir>/renderer/verify-flow.mjs flow-video/FLOW.md` until it reports 0 errors, then dispatch a fresh subagent to check each claim's meaning against the code. Fix every WRONG verdict, mark unverifiable claims `(unverified: reason)`, then re-run the script.
5. **Look and visuals.** `node <skill-dir>/renderer/detect-style.mjs .` gives the repo's brand colours and font, a style preset for its domain, and suggested scene types. Apply `--style` if the user gave one. Choose a visual for each part of the story from `references/visuals-guide.md` (agents, chat, request, pipeline, decision, checklist, queue, screen, code), based on what the code actually does.
6. **Screens (only with `--screens`, after the user says yes).** Follow `references/screens-guide.md`: write `flow-video/screens.json`, run `capture.mjs`, Read every PNG for personal data or secrets.
7. **Storyboard.** Follow `references/storyboard-guide.md`. Write `flow-video/storyboard.json` from `FLOW.md`: mostly animated visuals, a map scene only as an overview. Every scene and node has a `ref`; every branch is shown or in `omitted`. No code words on screen (except `code` visuals for developers), no claims the code does not back. Example values are realistic but invented.
8. **Check the story.** Dispatch the storyboard claim check (verification guide, pass 3) and fix what it flags.
9. **Preview and fix.** `node <skill-dir>/renderer/render.mjs flow-video/storyboard.json --preview`. It also checks every ref against `FLOW.md`. Fix every error and `WARN`, then Read the three contact sheets (`flow-video/preview/<format>-sheet.png`) and check for overlapping or tiny text, unclear captions, missing branches. Open a single scene PNG only to inspect a problem. Repeat until clean.
10. **Render.** `node <skill-dir>/renderer/render.mjs flow-video/storyboard.json [--formats …] [--music FILE --volume 0.5 | --no-music]`. Takes roughly 1-3x the video length per format. For `--cut highlights`, write `storyboard-highlights.json` with only the business-critical scenes and render it with `--out flow-video/highlights`.
11. **Share copy.** Follow `references/share-guide.md` and write `flow-video/share.md`.
12. **Report.** List the files, the commit analysed, style used (and why), the video duration, the pipelines and branches covered, the `omitted` branches with their reasons, the Coverage numbers, anything marked `unverified`, claims the verifier corrected, screenshots taken (or why not), and `## Suspected bugs`. The video shows what the code actually does; suspected bugs are reported, not hidden.

## Tools (all in `<skill-dir>/renderer/`)

| Tool | Does |
|---|---|
| `graph.mjs index . / summary / entry / calls / callers / path / branches / show / slice / externals / find / unparsed` | code graph: tree-sitter index, small `file:line` answers instead of whole-file reads |
| `verify-flow.mjs FLOW.md` | checks every cited file, line and quote against the code |
| `detect-style.mjs [REPO]` | brand colours, font, style preset and visual suggestions (JSON) |
| `capture.mjs flow-video/screens.json [--dry-run]` | real screenshots of the running app with measured highlights |
| `render.mjs STORYBOARD` | validate, preview and render; flags below |

| `render.mjs` flag | Effect |
|---|---|
| `--check` | validate + report duration and layout warnings, no images |
| `--preview` | still frame per scene + one contact sheet per format into `preview/` |
| `--formats 16x9,1x1` | subset of formats (default all three) |
| `--music FILE --volume 0.5` / `--no-music` | own track (looped, faded, trimmed) / silent. Default: an original track generated for the video |
| `--out DIR` | output folder (default: next to the storyboard) |
| `--flow FILE` | FLOW.md to check refs against (default: `FLOW.md` next to the storyboard) |
| `--list-icons` / `--list-styles` | icon names / style presets |

## Common mistakes

| Mistake | Fix |
|---|---|
| A flowchart for every scene | Show the product working: pick visuals from `visuals-guide.md`; the map is an overview |
| Visuals that look right but are not in the code (agents, checks, fields the code does not have) | Every visual element comes from `FLOW.md`; add `ref`s |
| Real customer data in example records or screenshots | Invented, realistic values; mask and Read every screenshot |
| Storyboard written from the README, not the code | Trace the code first; `FLOW.md` before `storyboard.json` |
| Line numbers or quotes written from memory | Copy the exact code; `verify-flow.mjs` rejects quotes not at the cited line |
| Self-verifying the trace | A fresh subagent checks claims; the author is biased toward what they meant |
| Reading whole files to find out what calls what | `graph calls` / `path` / `branches`, then `show` or `slice` only the lines you cite |
| Only tracing the entry points you happened to see | `graph entry` plus grep; reconcile in `## Coverage` |
| "Instantly", "secure", "always" in captions or visuals | Only with a `ref` to code that proves it; otherwise cut |
| Showing what the code should do | Show what it does; list differences under `## Suspected bugs` |
| Only the happy path shown | Every business-relevant branch gets a `decision` (or map edges) or an `omitted` reason |
| Labels like `InvoiceParserService` | 2-5 plain words: "Reads the invoice" |
| Running the app without asking | `--screens` only after the user's yes, local/staging with demo data |
| Skipping the preview images | Always Read the PNGs; validation cannot judge clarity |
| Secrets, hostnames or customer names anywhere | Never; the video is public |
