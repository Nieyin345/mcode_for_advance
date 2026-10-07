#!/usr/bin/env bash
# Headless smoke for **同一个对话里每一格各有各的常驻会话**(`main/orchestration/runner.ts`
# 的 `nodeSessionOf` / `Session.nodeId` / `SessionRepo.listNodesByParent`)。见 main.ts 文件头。
#
# 真的跑 `startWorkflowRun`(真库、真会话行、真调度),只把**引擎那一侧**换成桩
# (`stubs/runtimeManager.ts`)—— 真的 RuntimeManager 一 `bindSession` 就会把三个引擎
# 实现和每个的 MCP 工具表全拉起来,无头跑不起来。
#
# ⚠️ 数据根指向 `mktemp -d`(见 stubs/dataRoot.ts 里那句"没设就抛"):这一套会建库、
# 写会话行,指错了就是拿空库盖掉用户的聊天记录。跑完连目录一起删。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-node-session-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-node-session-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [ -z "$ESBUILD" ]; then ESBUILD="npx esbuild"; fi

# `--banner` 那一行是给 **sql.js** 的:它的 asm 构建里有 `require("node:fs")`,
# 而定死的 ESM 输出**没有 `require`** —— esbuild 会把它换成一句 throw。
# 那几个 `--alias` 各挡一条无头跑不了的链(与 `node-live-smoke` 同一套,理由见那里)。
"$ESBUILD" scripts/node-session-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:@renderer/lib/monacoSetup.js \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/node-session-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/node-session-smoke/stubs/logger.ts \
  --alias:electron=./scripts/node-session-smoke/stubs/electron.ts \
  --alias:@main/window.js=./scripts/node-session-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/node-session-smoke/stubs/runtimeManager.ts \
  --alias:@main/providers/registry.js=./scripts/node-session-smoke/stubs/providerRegistry.ts \
  --alias:@main/workflows/seed.js=./scripts/node-session-smoke/stubs/workflowsSeed.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/node-session-smoke/stubs/pluginManager.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
