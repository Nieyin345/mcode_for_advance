#!/usr/bin/env bash
# Headless smoke for **视觉中继**那半能无头验的 —— `main/lib/visionRelayCore.ts`。
# 见 main.ts 文件头:挑模型、一次性消息流的 content block 形状(图真的进没进去)、
# 系统提示词的数据边界、用户文字拼接。
#
# ## 为什么几乎不用换桩
#
# `visionRelayCore.ts` 是**零依赖**的(只 import contracts 的常量与 SDK 的**类型**,
# 类型会被 esbuild 抹掉)—— 不拉 db / electron / ssh2。所以这里直接引它。
# 这也是一道**守卫**:哪天有人往 core 里加了重依赖,这一套会**打包失败**,不是静默跑过。
#
# ⚠️ 但 contracts 那条链(`@contracts/ipc` → 别的 contracts 模块)可能间接碰到
# `node:*`,所以 `--banner` 那行(给 `require` 兜底)照旧保留 —— 与其它套件一致。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-vision-relay-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/vision-relay-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
