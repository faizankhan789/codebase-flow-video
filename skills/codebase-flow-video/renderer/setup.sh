#!/usr/bin/env bash
# One-time setup for the renderer: installs Playwright + headless Chromium and checks ffmpeg.
set -euo pipefail
cd "$(dirname "$0")"

command -v node >/dev/null || { echo "ERROR: Node.js 18+ is required (https://nodejs.org)"; exit 1; }
command -v ffmpeg >/dev/null || {
  echo "ERROR: ffmpeg is required."
  echo "  macOS:   brew install ffmpeg"
  echo "  Ubuntu:  sudo apt-get install -y ffmpeg"
  echo "  Windows: winget install ffmpeg"
  exit 1
}

if [ ! -d node_modules/playwright ]; then
  npm install --no-audit --no-fund --loglevel=error
fi
npx playwright install chromium
echo "Renderer ready."
