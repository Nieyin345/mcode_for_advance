#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# Node 22.13+ transforms the adapter's TypeScript parameter properties in place;
# the other fixture transpiles only the Codex resolver to isolate its pnpm probe.
node --experimental-transform-types scripts/engine-regressions-smoke/main.mjs
