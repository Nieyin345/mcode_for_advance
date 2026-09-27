#!/usr/bin/env bash
# MAINT-2026-09 / M13: plugin install-slot containment and reserved names.
# Same isolation as plugins-smoke: SettingRepo stubbed in memory, HOME and
# USERPROFILE redirected so ~/.mcode/plugins is a throwaway directory.
# main.ts also refuses to run unless PLUGINS_ROOT resolves inside that home.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-maint-m13.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then echo "esbuild not found in node_modules (no network fallback)" >&2; exit 1; fi

"$ESBUILD" scripts/maint-m13-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/store/repositories.js=./scripts/maint-m13-smoke/stub-repositories.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

SMOKE_HOME="$OUT/home"
mkdir -p "$SMOKE_HOME"
HOME="$SMOKE_HOME" USERPROFILE="$SMOKE_HOME" MAINT_M13_HOME="$SMOKE_HOME" node "$OUT/smoke.mjs"
