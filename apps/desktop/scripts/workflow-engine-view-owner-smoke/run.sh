#!/usr/bin/env bash
# W15 无头套件：工作流默认落在原厂画布；同一个 docId 的两个宿主不互相关视图。
#
# 与 `workflow-view-smoke` 同一形状：esbuild 打包（tsconfig paths 生效）→ plain node
# 跑，`prelude.ts` 先装好 window/document/localStorage 的桩。React 走
# `react-dom/server`；**不**起 Electron、**不**碰真 documentViewHost。
#
# 为什么是 CJS：同 `workflow-view-smoke/run.sh` —— `react-dom/server` 是 CommonJS 且
# require node 内建（util），ESM 输出会变成 esbuild 的 `__require` shim 并在加载时抛
# "Dynamic require of \"util\" is not supported"。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-workflow-engine-view-owner.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

source "$HERE/../lib/esbuild-path.sh"

# sessionStore 唯一的动态 import 是 monacoSetup（LSP worker 启动），拖进整个 monaco
# 包 + ?worker/.ttf 资源，只有 vite 能解析。本套件不渲染编辑器，直接留成外部说明符
# （与 workflow-view-smoke 同一取舍）。
"$ESBUILD" scripts/workflow-engine-view-owner-smoke/main.ts \
  --bundle --platform=node --format=cjs \
  --tsconfig=tsconfig.json \
  --external:@renderer/lib/monacoSetup.js \
  --outfile="$OUT/smoke.cjs" --log-level=error

node "$OUT/smoke.cjs"
