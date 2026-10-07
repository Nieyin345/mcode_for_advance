#!/usr/bin/env bash
# Headless smoke for 托管上下文的文件层(main/lib/appContext.ts + tokenEstimate.ts).
#
# appContext 是纯核心(不 import electron,路径全靠注入),所以可以直接 bundle:
# 覆盖全局指令的读/收养/写/物化全生命周期(幂等、漂移修复、手写文件保护、
# 空内容语义)与记忆目录的列/读/写,外加工具占用估算。没有覆盖的:IPC 层的
# 路径装配(main/ipc/context.ts,依赖 electron 与真数据根)和各引擎的消费点
# (要活的会话),靠真机验收。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-context-files-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/context-files-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
