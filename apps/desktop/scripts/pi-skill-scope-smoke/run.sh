#!/usr/bin/env bash
# 【MC-074】Pi 单轮 Skill 选择范围回归。驱动**真** buildPiSkillLoader,只在裸
# specifier `@earendil-works/pi-coding-agent` 换假 loader(见 stubs/piSdk.ts);
# 其余叶子桩(dataRoot/logger)走通用桩 —— piSkillBridge 会拉 skillEngines → appContext。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-pi-skill-scope.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-pi-skill-scope-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/pi-skill-scope-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@earendil-works/pi-coding-agent=./scripts/pi-skill-scope-smoke/stubs/piSdk.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
