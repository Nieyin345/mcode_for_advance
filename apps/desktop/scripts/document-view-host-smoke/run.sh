#!/usr/bin/env bash
# Headless smoke for 【ARC-007】受控文档视图宿主(DocumentViewHost + documentView:* IPC)。
# 见 main.ts 文件头。
#
# ## 为什么不起 Electron / 不换整个 electron 包
#
# 宿主把 WebContentsView 构造器和窗口解析都做成了**构造参数**,套件注入假视图 +
# 假窗口就能把状态机(复用/保活/销毁/窗口清理)全部跑一遍。被测链路上唯一碰
# electron 的模块是 `@main/window.js`(宿主默认解析器),换掉它一个就够 ——
# `ipc/documentView.ts` 只 `import type { IpcMain }`,编译后消失。
#
# ## 数据根
#
# 这一套不碰 sql.js / 设置表;dataRoot 桩照例挂上,任何意外触碰都会在没设
# MCODE_SMOKE_DATA_ROOT 时**直接抛**,不会回落到用户的真数据根。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-document-view-host-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-document-view-host-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

# `--banner` 那一行非有不可(与其它套件相同):sql.js 的 asm 构建里有 require(...),
# 而定死的 ESM 输出没有 require。
"$ESBUILD" scripts/document-view-host-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/window.js=./scripts/document-view-host-smoke/stubs/window.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
