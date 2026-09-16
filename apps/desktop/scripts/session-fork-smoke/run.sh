#!/usr/bin/env bash
# Headless smoke for 把一段对话复制成新的一段(main/lib/sessionFork.ts).
#
# 真的建库、真的写行、真的读回来 —— 但脚下那个数据根换成临时目录(见 stubs/dataRoot.ts
# 里那句"没设就抛":指错地方等于拿空库盖掉用户的聊天记录)。
#
# 引擎那一侧是假的(stubs/providerRegistry.ts):真正复制会话文件那一步在 SDK 里,
# 这里验的是调用方有没有把对的参数交出去、拿到之后有没有做对事。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-session-fork-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-session-fork-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# `--banner` 那一行是给 **sql.js** 的:它的 asm 构建里有 `require("node:fs")` /
# `require("node:crypto")`,而定死的 ESM 输出**没有 `require`** —— esbuild 会把它换成
# 一句 `throw new Error('Dynamic require of "node:fs" is not supported')`。给它一个
# 真的 `require`,它就能跑。只用得到内建模块,所以不需要能被解析到 app 的 node_modules。
"$ESBUILD" scripts/session-fork-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/session-fork-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/session-fork-smoke/stubs/logger.ts \
  --alias:@main/lib/sessionSync.js=./scripts/session-fork-smoke/stubs/sessionSync.ts \
  --alias:@main/providers/registry.js=./scripts/session-fork-smoke/stubs/providerRegistry.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
