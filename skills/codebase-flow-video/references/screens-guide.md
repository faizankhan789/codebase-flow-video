# Screens guide: real screenshots of the running app

`screen` scenes show the real product. `renderer/capture.mjs` starts the app (optional), opens pages in headless Chromium, runs a few clicks or form fills, masks personal data, saves PNGs and measures highlight boxes from real elements.

**Running someone's app executes their code.** Only capture when the user said yes in this session, and:

- Use a **local or staging copy with demo data**. `capture.mjs` refuses non-local URLs unless `--allow-remote` is passed, and that needs the owner's approval.
- Never put production credentials in `screens.json`. The script rejects env values that look like real secrets; demo/test keys only. Prefer the project's documented dev setup (`npm run dev`, `docker compose up`, seed scripts).
- **Mask** anything that can identify a person (names, emails, avatars, addresses) with `"mask": [selectors]`, then **Read every PNG** before using it. If a screenshot shows real personal data, secrets, internal URLs or anything the owner would not publish, recapture or drop it.
- If the app cannot start (missing services, keys, database), say so in the report and continue without screens; never fake a screenshot.

## Steps

1. Find how the app runs: `G entry` (scripts, Procfile, Dockerfile) and the README's dev section. Find the routes worth showing from `FLOW.md` (the pages where the pipelines start or end).
2. Write `flow-video/screens.json`:

```json
{
  "start": "npm run dev",
  "url": "http://localhost:3000",
  "readyTimeout": 90,
  "viewport": { "width": 1440, "height": 900 },
  "env": { "NEXT_PUBLIC_DEMO_MODE": "1" },
  "pages": [
    { "id": "checkout", "path": "/checkout", "waitFor": "text=Pay now",
      "actions": [ { "click": "text=Add to cart" }, { "fill": ["#email", "demo@example.com"] } ],
      "highlights": [ { "selector": "button:has-text('Pay now')", "label": "One-click pay" } ],
      "mask": [".account-email"] }
  ]
}
```

   - Omit `start` if the user already runs the app. `"device": "phone"` captures a 390x844 mobile view.
   - Actions: `click`, `fill: [selector, value]`, `press: [selector, key]`, `select: [selector, value]`, `hover`, `goto`, `wait: ms`. Selectors are Playwright selectors (`text=…`, CSS, `role=button[name="Pay"]`).
   - `displayHost` sets the host shown in the browser bar instead of `localhost` (default `app`).
3. `node <skill-dir>/renderer/capture.mjs flow-video/screens.json --dry-run`, then without `--dry-run`. It stops the app when done; server output is in `flow-video/screens/server.log`.
4. Read each PNG. Paste the printed `{"type":"screen", ...}` snippet into the scene, adjust labels to plain words.
