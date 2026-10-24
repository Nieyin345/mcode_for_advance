#!/usr/bin/env bash
# 【T115】新建 docx 必须写 w:eastAsia（HTML 与 Markdown 两条路都要）。
#
# 这套**不需要 esbuild** —— 它不 import 任何主进程代码，只 spawn 真 CLI
# （`genoffice/packages/cli/dist/genoffice.cjs`）并解开产物读 XML。
# 所以这里直接 `node` 跑 main.ts 的做法不可行（TS），改用 esbuild 打一次薄包。
#
# ⚠️ CLI 的 dist 是**构建产物**：改了 `packages/cli/src` 之后要先
#    `cd genoffice/packages/cli && node build.mjs` 再跑这套，
#    否则验的是旧的 dist（T115 的回写区记了这一点）。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
source "$HERE/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "Missing existing esbuild; no dependency installation attempted" >&2; exit 1; fi

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-t115-eastasia.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

"$ESBUILD" scripts/t115-docx-eastasia-font-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
