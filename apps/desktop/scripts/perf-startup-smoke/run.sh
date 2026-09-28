#!/usr/bin/env bash
# Startup-weight guard: heavy editors/previewers must stay OUT of the desktop
# App's static import graph (they load on demand), yet remain in the bundle.
# esbuild metafile only — no browser, no Electron, no user data.
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/perf-startup-smoke/main.mjs
