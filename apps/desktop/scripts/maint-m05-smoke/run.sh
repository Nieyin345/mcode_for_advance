#!/usr/bin/env bash
# MAINT-2026-09 / M05: Codex message adapter — subagent-thread scoping of
# turn-level notifications and per-turn token accounting.
# Bundles the real CodexMessageAdapter + codexTokenUsage (pure modules) and
# feeds them synthetic app-server notification frames. No codex binary, no
# app-server process, no network, no user data.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-maint-m05.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then echo "esbuild not found in node_modules (no network fallback)" >&2; exit 1; fi

"$ESBUILD" scripts/maint-m05-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
