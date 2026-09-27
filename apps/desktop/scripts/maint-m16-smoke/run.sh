#!/usr/bin/env bash
# MAINT-M16 定向 smoke —— 记忆来源材料的遮蔽/预算顺序 + 项目授权可见性矩阵。
# 见 main.ts 的文件头:为什么"先遮后裁"与"先裁后遮"不是风格问题。
#
# 被测的两个模块都是**纯核心**(`memory/sourceText.ts` 零依赖;`memory/paths.ts` 只引
# contracts 的类目常量),所以直接 bundle,一个桩都不用换 —— 也就没有"桩的形状不对
# 导致假红/假绿"的余地。
#
# 不起进程、不占端口、不碰数据根、不写任何文件。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-maint-m16-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/maint-m16-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"

