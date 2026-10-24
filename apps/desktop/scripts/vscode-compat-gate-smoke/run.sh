#!/usr/bin/env bash
# Headless smoke for **VS Code 兼容层的编译期闸门**(F018)。
#
# 它不起 Electron、不联网、不跑产品代码 —— 只做两件真事:
#   1. 在临时目录写 `.ts` 夹具,调真 `tsc --noEmit` 看闸门拦不拦;
#   2. 读 `packages/vscode-compat/tsconfig.json` 与 `src/_gate.ts`。
#
# 判据与预期红数见 main.ts 文件头与 tasks/F/F018-vscode-compat-skeleton.md。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d ./.tmp/mcode-vscode-compat-gate-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/vscode-compat-gate-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
