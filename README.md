# codebase-flow-video

A Claude Code skill that reads a codebase end to end and turns its pipeline into an animated explainer video, rendered in three formats:

- `flow-16x9.mp4`: landscape, for client meetings and YouTube
- `flow-1x1.mp4`: square, for the LinkedIn feed
- `flow-9x16.mp4`: vertical, for Reels, Shorts and Stories

It also writes `FLOW.md`, a technical map of every pipeline, step and branch with `file:line` references.

## Install

Requirements: [Claude Code](https://claude.com/claude-code), Node.js 18+, ffmpeg.

In Claude Code:

```
/plugin install codebase-flow-video --marketplace faizankhan789/codebase-flow-video
```

Older Claude Code versions:

```
/plugin marketplace add faizankhan789/codebase-flow-video
/plugin install codebase-flow-video@codebase-flow-video
```

On first use, Claude runs the renderer setup automatically (installs Playwright + headless Chromium, about 150 MB).

ffmpeg: `brew install ffmpeg` (macOS), `sudo apt-get install ffmpeg` (Ubuntu), `winget install ffmpeg` (Windows).

## Use

Open Claude Code in any repository and ask:

> Make an animated video explaining how this codebase works end to end.

Optional: "use `~/Music/track.mp3` as background music", or "only the checkout pipeline".

Everything is saved to `flow-video/` in that repository. Add `flow-video/` to `.gitignore` if you don't want to commit the videos.

## How it works

1. Claude traces the code from each entry point to its outputs and records every step and branch in `FLOW.md`.
2. Claude writes `storyboard.json`: plain-language scenes for a non-technical viewer.
3. The bundled renderer (`skills/codebase-flow-video/renderer/`) lays out the flow, animates nodes, arrows, data packets, branches and camera moves, and captures frames in headless Chromium. ffmpeg encodes them to H.264 MP4.

Video length follows the codebase: each scene lasts as long as its animation and caption need.

You can also run the renderer by hand from a clone of this repo:

```bash
cd skills/codebase-flow-video
bash renderer/setup.sh
node renderer/render.mjs examples/storyboard.example.json --out /tmp/demo
```

## License

MIT
