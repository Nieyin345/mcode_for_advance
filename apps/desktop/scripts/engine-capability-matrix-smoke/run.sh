#!/usr/bin/env bash
# Headless smoke for 「能力 × 引擎」矩阵(renderer/components/settings/engineCapabilityData.ts).
#
# 纯核:矩阵数据 + skillEngines / mcpEngines / engineToolPolicy 三个纯模块,以及 i18n
# core。provider 的能力面读源码字面量。不 import electron、不起浏览器、不碰 ~/.mcode。
set -euo pipefail
cd "$(dirname "$0")/../.."          # → apps/desktop

OUT=$(mktemp -d /tmp/mcode-engine-capability-matrix.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "${ESBUILD:-}" ]]; then echo "esbuild not found in node_modules (no network fallback)" >&2; exit 1; fi

"$ESBUILD" scripts/engine-capability-matrix-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
