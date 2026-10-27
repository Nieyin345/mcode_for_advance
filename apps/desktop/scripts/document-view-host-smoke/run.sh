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
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."

OUT=$(mktemp -d /tmp/mcode-document-view-host-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-document-view-host-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$SCRIPT_DIR/../lib/esbuild-path.sh"

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

# 【ARC-007】跨进程租约夹具：子进程入口打进**同一份源码**
# `src/main/lib/osFileLease.ts`（两包各自内联，但协议与实现是同一文件；租约的互斥
# 事实在磁盘上 —— `<real>.mcode-lock` 由 O_CREAT|O_EXCL 抢占 —— 所以不要求共享
# 模块实例，只要求同一套原语。不能用 `--external:@main/...`：那是 esbuild 别名，
# 产物里的 specifier 在 node 运行时解析不了）。
"$ESBUILD" scripts/document-view-host-smoke/leaseChild.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/leaseChild.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" MCODE_DV_LEASE_CHILD="$OUT/leaseChild.mjs" node "$OUT/smoke.mjs"

# ARC-007: exercise the actual vendor-native Docs preload + scoped main
# registrar. Do not silently fall back to the old hand-written Mcode docs stub.
VENDOR_DOCS="../../genoffice/apps/docs/src/preload/mcode-view.ts"
VENDOR_IPC="../../genoffice/apps/docs/src/main/mcode-ipc.ts"
if [[ -f "$VENDOR_DOCS" && -f "$VENDOR_IPC" ]]; then
  "$ESBUILD" scripts/document-view-host-smoke/nativeDocs.ts \
    --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
    --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
    --alias:electron=./scripts/document-view-host-smoke/stubs/nativeDocsElectron.ts \
    --alias:@genoffice/font-metrics=./scripts/document-view-host-smoke/stubs/nativeDocsFonts.ts \
    --outfile="$OUT/nativeDocs.mjs" --log-level=error
  MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/nativeDocs.mjs"
  # T05c: exercise REAL Docs AI → Mcode RuntimeManager adapter with three
  # fake registered SDK identities. No network, no real user DB/credentials.
  # The AI adapter pulls the voice stack in transitively, and sherpa-onnx ships
  # prebuilt .node binaries that esbuild has no loader for. This suite never
  # speaks, so keep every native addon external instead of bundling it.
  "$ESBUILD" scripts/document-view-host-smoke/nativeAiSdk.ts \
    --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
    --external:sherpa-onnx-node --external:*.node \
    --alias:@main/claude/RuntimeManager.js=./scripts/document-view-host-smoke/stubs/nativeAiMcode.ts \
    --alias:@main/store/repositories.js=./scripts/document-view-host-smoke/stubs/nativeAiMcode.ts \
    --alias:@main/providers/registry.js=./scripts/document-view-host-smoke/stubs/nativeAiMcode.ts \
    --alias:@main/lib/pathGuard.js=./scripts/document-view-host-smoke/stubs/nativeAiMcode.ts \
    --alias:@main/window.js=./scripts/document-view-host-smoke/stubs/nativeAiMcode.ts \
    --alias:electron=./scripts/document-view-host-smoke/stubs/nativeAiMcode.ts \
    --outfile="$OUT/nativeAiSdk.mjs" --log-level=error
  MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/nativeAiSdk.mjs"
else
  echo "document-view-host-smoke: SKIP vendor Docs boundary (gitignored source missing)"
fi
