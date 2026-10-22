# URL guide: making a video from a link

The user can give a link instead of opening Claude Code in a project. This works the same in the Claude Code CLI, the VS Code / JetBrains extensions, the desktop app and Claude Code on the web, wherever Node 18+ and ffmpeg are available.

```bash
node <skill-dir>/renderer/fetch-source.mjs <url> [--out DIR] [--pages N]
```

## Git repository → full code video

GitHub, GitLab, Bitbucket, Codeberg, or any `https://…/repo.git` / `git@host:owner/repo.git` URL. A `/tree/<branch>/<folder>` link selects the branch and the folder (monorepos).

1. `fetch-source.mjs` shallow-clones into `./<repo>` (or `--out`) and prints `REPO <folder>`. Only https and ssh transports are allowed, submodules are not fetched, and cloning runs no code from the repository.
2. Run the normal workflow with that folder as the repo: graph index, `FLOW.md`, verify, storyboard, render. Outputs land in `<folder>/flow-video/`.
3. Before publishing, confirm the user may publish a video about someone else's code (licence, employer, client).

## Website → product tour video

Any other https URL. `fetch-source.mjs` opens the page and up to `--pages` (default 4) same-site pages from its navigation, saves screenshots to `<out>/flow-video/screens/` and writes `<out>/flow-video/site.json`:

```json
{ "url": "...", "pages": [ { "id": "home", "url": "...", "file": "screens/home.png", "title": "...", "description": "...",
  "h1": ["..."], "h2": ["..."], "h3": ["..."], "buttons": ["..."], "nav": [{ "label": "...", "href": "..." }],
  "brand": { "accent": "rgb(…)", "font": "Inter" } } ] }
```

It is read-only: no forms, no logins, no clicks beyond loading pages, and navigation to other sites is blocked. Private, loopback and link-local addresses (localhost, 10.x, 192.168.x, cloud metadata and so on) are refused, for the page and for everything it loads; pass `--allow-local` only for a host the user owns. URLs with credentials in them are refused. There is no code, so there is no `FLOW.md`; the rules change accordingly:

- **Claims come only from the site's own words** (`h1`, `h2`, `description`, buttons). Never add features, numbers or customers the site does not state.
- **Style:** `launch` for SaaS and AI products, or the closest preset; put `brand.accent` (converted to hex) in `style.accent` and `brand.font` in `style.font.family`.
- **Arc ("launch film"):** `headline` (the `h1`) → `showcase` of the home screenshot with 2-3 callouts from `h2`/`h3` → `headline` variant `orb` for the next section → `showcase` of each further page → outro with the site's call to action. Headline and showcase scenes need no caption; add captions only where a sentence helps.
- Read every screenshot before using it (cookie banners, personal data, pop-ups). Recapture or drop pages that look broken.

A product with both a repo and a website can combine them: code scenes from `FLOW.md`, plus `showcase` scenes of the real site.
