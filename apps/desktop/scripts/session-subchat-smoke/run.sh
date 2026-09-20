#!/usr/bin/env bash
# Headless smoke for 「从一份代理档案建一个子对话」(main/lib/sessionStart.ts 的 side 那一段
# + main/lib/sessionAgentProfile.ts + main/orchestration/prompt.ts 的 resolveAgentPrompt)。
#
# 真的建库、真的写行、真的读回来、真的读磁盘上那份档案文件 —— 但脚下那个数据根换成临时
# 目录(见 stubs/dataRoot.ts 里那句"没设就抛":指错地方等于拿空库盖掉用户的聊天记录)。
#
# 引擎那一侧是假的(stubs/runtimeManager.ts):真的 RuntimeManager 一 bindSession 就会
# 把三个引擎实现全拉起来,无头跑不起来。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-session-subchat-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-session-subchat-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# `--banner` 那一行是给 **sql.js** 的:它的 asm 构建里有 `require("node:fs")`,而定死的
# ESM 输出没有 `require`(理由同 run-store-smoke/run.sh)。
#
# 切的四个桩:
#   - `dataRoot` —— 真的那份 import electron(报错原样打到 stderr,不静默);
#   - `logger`   —— 同上;
#   - `runtimeManager` —— 真的那份一 bindSession 就拖起三个引擎;
#   - `window`   —— 真的那份 `import { BrowserWindow, shell, session } from "electron"`,
#     而这是本套唯一**真的会把 electron 打进来**的一环(`store/db.ts` 那句 `app` 没人用,
#     esbuild 会摇掉;这一句不会)。打进来的症状是
#     `ERR_AMBIGUOUS_MODULE_SYNTAX`(那个包同时有 require 和顶层 await),看着像被测
#     代码坏了 —— claude-ipc-smoke 的 run.sh 里记着同一件事。
#     这一套不验广播推给了谁(那是 claude-ipc-smoke 的活),所以这里用那份现成的窗口桩,
#     它把 `sendToRenderer` 记下来、其余显式抛。
# 其余全是真的:`sessionStart` / `sessionAgentProfile` / `agentProfiles` / `memory/retrieval`
# / `memory/store` / `repositories` / **真 sqlite 库**。
"$ESBUILD" scripts/session-subchat-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/session-subchat-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/session-subchat-smoke/stubs/logger.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/session-subchat-smoke/stubs/runtimeManager.ts \
  --alias:@main/window.js=./scripts/claude-ipc-smoke/stubs/window.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"
node "$OUT/smoke.mjs"
