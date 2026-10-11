#!/usr/bin/env bash
# Headless smoke for ARC-013 第一片 —— 场景任务谱系 + 场景级预算账户。
#
# 被测 `@main/orchestration/sceneTaskRegistry.ts` 是**纯内存核心**:只 import
# `@contracts/sceneTask`(纯类型 + 常量),不碰 electron / sql.js / RuntimeManager。
# 所以这套**不需要任何桩**,也不写任何数据 —— 无数据根、无隔离目录,直接 bundle 跑。
#
# 覆盖见 main.ts 头部的失败矩阵。Run: scripts/scene-task-smoke/run.sh
set -euo pipefail
# 先钉住本脚本所在目录的**绝对**路径,再切到 apps/desktop —— 这样从仓库根
# (`bash apps/desktop/scripts/scene-task-smoke/run.sh`)或从 apps/desktop
# (`bash scripts/scene-task-smoke/run.sh`)调用都成立。
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.."          # → apps/desktop

OUT=$(mktemp -d /tmp/mcode-scene-task.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/scene-task-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
