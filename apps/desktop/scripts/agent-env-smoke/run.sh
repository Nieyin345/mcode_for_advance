#!/usr/bin/env bash
# Headless smoke for 环境变量的两个方向(agentEnv.ts / terminal/envRefresh.ts).
#
# 纯函数:读几个目录、改几个字符串。不起进程、不碰网络、不写文件 —— 所以没有桩,
# 也不用临时数据根。这两块是「改一个字符串」型的地方,看代码看不出来、错了不报错,
# 只有真调一遍才知道(见 main.ts 的文件头)。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-agent-env-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/agent-env-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
