---
name: codebase-flow-video
description: Use when the user wants an animated explainer video of how a codebase, app, or data/AI pipeline works end to end, a walkthrough or flow-diagram video for clients, executives, investors or LinkedIn, or a complete map of every step and branch in a repo (FLOW.md).
---

# Codebase Flow Video

## Overview

Understand a repository end to end (every pipeline, step and branch), then render that flow as an animated MP4 in 16:9, 1:1 and 9:16. Claude writes two files: `FLOW.md` (technical truth) and `storyboard.json` (plain-language story). A bundled renderer does all animation deterministically, so Claude never writes animation code.

**Core principle:** the video can only be as accurate as `FLOW.md`, and `FLOW.md` can only claim what the code shows. So every claim carries checkable evidence (`file:line` plus the exact code), is checked by a script and by a fresh subagent, and every storyboard box points back to the `FLOW.md` step it shows.

## Outputs (in `<repo>/flow-video/`)

```
FLOW.md            every pipeline, step, branch, with file:line + quoted code
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
3. **Analyse.** Follow `references/analysis-guide.md`: pin the commit, grep the entry-point inventory, trace each pipeline with ids (`P1.3`, `B2`) and quoted evidence, reconcile the branch/config/external-system inventories into `## Coverage`. Write `flow-video/FLOW.md`. Use parallel subagents for large repos.
4. **Verify FLOW.md.** Follow `references/verification-guide.md`. Run `node <skill-dir>/renderer/verify-flow.mjs flow-video/FLOW.md` until it reports 0 errors, then dispatch a fresh subagent to check each claim's meaning against the code. Fix every WRONG verdict, mark unverifiable claims `(unverified: reason)`, then re-run the script.
5. **Storyboard.** Follow `references/storyboard-guide.md`. Write `flow-video/storyboard.json` from `FLOW.md`. Every non-actor node has a `ref`; every branch is shown or in `omitted`. No code words on screen, no claims the code does not back.
6. **Check the story.** Dispatch the storyboard claim check (verification guide, pass 3) and fix what it flags.
7. **Preview and fix.** `node <skill-dir>/renderer/render.mjs flow-video/storyboard.json --preview`. It also checks every ref against `FLOW.md`. Fix every error and `WARN`, then Read the three contact sheets (`flow-video/preview/<format>-sheet.png`, every scene in one image) and check for overlapping or tiny text, unclear captions, missing branches. Open a single scene PNG only to inspect a problem. Repeat until clean.
8. **Render.** `node <skill-dir>/renderer/render.mjs flow-video/storyboard.json [--music path/to/track.mp3 --volume 0.5]`. Takes roughly 1-3x the video length.
9. **Report.** List the files, the commit analysed, the video duration, the pipelines and branches covered, the `omitted` branches with their reasons, the Coverage numbers, anything marked `unverified` in `FLOW.md`, claims the verifier corrected, and `## Suspected bugs`. `FLOW.md` and the video show what the code actually does; suspected bugs are reported, not hidden.

## Renderer quick reference

| Flag | Effect |
|---|---|
| `--check` | validate + report duration and layout warnings, no images |
| `--preview` | still frame per scene + one contact sheet per format into `preview/` |
| `--formats 16x9,1x1` | subset of formats (default all three) |
| `--music FILE --volume 0.5` | optional; loops, fades and trims the track to video length. Omit for silent |
| `--out DIR` | output folder (default: next to the storyboard) |
| `--flow FILE` | FLOW.md to check refs against (default: `FLOW.md` next to the storyboard) |
| `--list-icons` | icon names usable in `nodes[].icon` |

`node <skill-dir>/renderer/verify-flow.mjs FLOW.md [--root REPO]` checks FLOW.md evidence against the code; exit 1 on errors.

## Common mistakes

| Mistake | Fix |
|---|---|
| Storyboard written from the README, not the code | Trace the code first; `FLOW.md` before `storyboard.json` |
| Line numbers or quotes written from memory | Copy the exact code; `verify-flow.mjs` rejects quotes not at the cited line |
| Self-verifying the trace | A fresh subagent checks claims; the author is biased toward what they meant |
| Only tracing the entry points you happened to see | Grep the entry-point and branch inventories; reconcile in `## Coverage` |
| "Instantly", "secure", "always" in captions | Only with a `ref` to code that proves it; otherwise cut |
| Showing what the code should do | Show what it does; list differences under `## Suspected bugs` |
| Only the happy path shown | Every business-relevant branch in the branch index gets shown with labelled edges |
| Labels like `InvoiceParserService` | 2-5 plain words: "Reads the invoice" |
| `focus` of 7+ nodes, unreadable text | Split the scene or narrow `focus` (preview warns) |
| Skipping the preview images | Always Read the PNGs; validation cannot judge clarity |
| Secrets, hostnames or customer names in captions | Never; the video is public |
