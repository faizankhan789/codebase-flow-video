---
name: codebase-flow-video
description: Use when the user wants an animated explainer video of how a codebase, app, or data/AI pipeline works end to end, a walkthrough or flow-diagram video for clients, executives, investors or LinkedIn, or a complete map of every step and branch in a repo (FLOW.md).
---

# Codebase Flow Video

## Overview

Understand a repository end to end (every pipeline, step and branch), then render that flow as an animated MP4 in 16:9, 1:1 and 9:16. Claude writes two files: `FLOW.md` (technical truth) and `storyboard.json` (plain-language story). A bundled renderer does all animation deterministically, so Claude never writes animation code.

**Core principle:** the video can only be as accurate as `FLOW.md`, and `FLOW.md` can only claim what the code shows.

## Outputs (in `<repo>/flow-video/`)

```
FLOW.md            every pipeline, step, branch, with file:line
storyboard.json    scenes for a non-technical audience
preview/           still frames used to check layout
flow-16x9.mp4      landscape: meetings, YouTube
flow-1x1.mp4       square: LinkedIn feed
flow-9x16.mp4      vertical: Reels, Shorts, Stories
```

## Workflow

`<skill-dir>` is this skill's base directory.

1. **Scope.** Confirm the repo (default: current directory), which pipelines (default: all), and an optional music file (default: none, silent video). If the code belongs to someone else, confirm they are allowed to publish a video about it. When running unattended or the user already said "just do it", use the defaults and note them in the report.
2. **Setup.** If `<skill-dir>/renderer/node_modules` does not exist (first run, or after a plugin update), run `bash <skill-dir>/renderer/setup.sh`. Needs Node 18+ and ffmpeg; the script says how to install them if missing.
3. **Analyse.** Follow `references/analysis-guide.md`. Write `flow-video/FLOW.md`. Use parallel subagents for large repos. Verify every branch against the code.
4. **Storyboard.** Follow `references/storyboard-guide.md`. Write `flow-video/storyboard.json` from `FLOW.md`. No code words on screen.
5. **Preview and fix.** `node <skill-dir>/renderer/render.mjs flow-video/storyboard.json --preview`. Fix every error and `WARN`, then Read the three contact sheets (`flow-video/preview/<format>-sheet.png`, every scene in one image) and check for overlapping or tiny text, unclear captions, missing branches. Open a single scene PNG only to inspect a problem. Repeat until clean.
6. **Render.** `node <skill-dir>/renderer/render.mjs flow-video/storyboard.json [--music path/to/track.mp3 --volume 0.5]`. Takes roughly 1-3x the video length.
7. **Report.** List the files, the video duration, the pipelines and branches covered, branches deliberately left out of the video, anything marked `unverified` in `FLOW.md`, and likely bugs noticed while tracing (the video shows intended behaviour, so the user must know where code and story differ).

## Renderer quick reference

| Flag | Effect |
|---|---|
| `--check` | validate + report duration and layout warnings, no images |
| `--preview` | still frame per scene + one contact sheet per format into `preview/` |
| `--formats 16x9,1x1` | subset of formats (default all three) |
| `--music FILE --volume 0.5` | optional; loops, fades and trims the track to video length. Omit for silent |
| `--out DIR` | output folder (default: next to the storyboard) |
| `--list-icons` | icon names usable in `nodes[].icon` |

## Common mistakes

| Mistake | Fix |
|---|---|
| Storyboard written from the README, not the code | Trace the code first; `FLOW.md` before `storyboard.json` |
| Only the happy path shown | Every business-relevant branch in the branch index gets shown with labelled edges |
| Labels like `InvoiceParserService` | 2-5 plain words: "Reads the invoice" |
| `focus` of 7+ nodes, unreadable text | Split the scene or narrow `focus` (preview warns) |
| Skipping the preview images | Always Read the PNGs; validation cannot judge clarity |
| Secrets, hostnames or customer names in captions | Never; the video is public |
