#!/usr/bin/env bash
# Settings first-open guard: the settings shell must stay light (no editor
# engines in its static graph) and every panel must remain bundled on demand.
# Pure esbuild analysis of the real sources; no Electron, no user data.
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/settings-lazy-smoke/main.mjs
