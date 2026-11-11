#!/usr/bin/env bash
# 1-Klick-Start (macOS/Linux)
cd "$(dirname "$0")" || exit 1
command -v git >/dev/null && git pull --ff-only
npm install --no-audit --no-fund || exit 1
OPEN_BROWSER=1 node server.js
