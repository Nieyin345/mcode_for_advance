#!/usr/bin/env bash
# 【思考强度映射 · Codex 半条链】回归 —— 驱动**真的** `CodexAgentSdkProvider`，
# 断言「映射翻译之后，turn/start 真正发出去的 effort 是什么」（见 main.ts 文件头）。
#
# ## 换桩边界（与 resume-fault-smoke / skill-delivery-smoke 同一套绕法，已验证可跑）
#   - 驱动**真的** provider 类（不做任何生产代码改动）；
#   - 只换掉 SDK 边界：
#       · 相对 import `./CodexAppServerClient.js` / `./codexBinaryResolve.js` /
#         `./codexProjectScope.js` → `--external:` 整条外置，再各打一份同名桩铺在
#         bundle 旁边（`--alias` 不收相对名）；
#       · 叶子 `@main` 模块（dataRoot/logger/pluginManager/codexModelsStore/…）→ 内存桩，
#         避免拉进 electron / sql.js / 真磁盘。
#   - ⚠️ `./CodexMessageAdapter.js` / `./CodexMessageHelpers.js` / `./codexTurnScope.js`
#     / `./codexTurnDiff.js` **不换** —— 它们是纯逻辑，真的跑得动，而且真 adapter 的
#     收尾通知正是本套"回合真的跑完"的依据。
#
# ## 隔离（缺一不可）
#   - 数据根 mktemp；用户根（HOME/USERPROFILE）也 mktemp —— `ensureCodexHomeIdentity`
#     会往 `<home>/.mcode/codex/` 写 AGENTS.md，技能矩阵与插件根也拼在 homedir() 下，
#     指到真家目录就是拿测试数据灌用户的技能库。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-codex-effort.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-codex-effort-data.XXXXXX)
HOME_DIR=$(mktemp -d /tmp/mcode-codex-effort-home.XXXXXX)
trap 'rm -rf "$OUT" "$DATA" "$HOME_DIR"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

# `--packages=external` 让裸 specifier(electron 等)从 bundle 位置解析 —— 先软链 node_modules。
source scripts/lib/runtime-node-modules.sh
mcode_link_runtime_node_modules "$OUT" "$PWD/node_modules"
printf '{"type":"module"}\n' > "$OUT/package.json"

COMMON=(
  --bundle --platform=node --format=esm
  --tsconfig=tsconfig.json
  --packages=external
  --banner:js="import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fup } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __dirname = __dn(__fup(import.meta.url));"
)

# ── 外置的相对桩：各打一份同名文件铺在 bundle 旁 ──
"$ESBUILD" scripts/codex-effort-smoke/stubs/CodexAppServerClient.ts "${COMMON[@]}" \
  --outfile="$OUT/CodexAppServerClient.js" --log-level=error
"$ESBUILD" scripts/codex-effort-smoke/stubs/codexBinaryResolve.ts "${COMMON[@]}" \
  --outfile="$OUT/codexBinaryResolve.js" --log-level=error
"$ESBUILD" scripts/codex-effort-smoke/stubs/codexProjectScope.ts "${COMMON[@]}" \
  --outfile="$OUT/codexProjectScope.js" --log-level=error

# ── 主 bundle ──
"$ESBUILD" scripts/codex-effort-smoke/main.ts "${COMMON[@]}" \
  --alias:electron=./scripts/resume-fault-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/store/repositories.js=./scripts/resume-fault-smoke/stubs/repositories.ts \
  --alias:@main/lib/codexModelsStore.js=./scripts/codex-effort-smoke/stubs/codexModelsStore.ts \
  --alias:@main/lib/mcpConfig.js=./scripts/resume-fault-smoke/stubs/mcpConfig.ts \
  --alias:@main/lib/mcpEngines.js=./scripts/resume-fault-smoke/stubs/mcpEngines.ts \
  --alias:@main/lib/engineToolPolicy.js=./scripts/resume-fault-smoke/stubs/engineToolPolicy.ts \
  --alias:@main/lib/fileSnapshotRegistry.js=./scripts/resume-fault-smoke/stubs/fileSnapshotRegistry.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/resume-fault-smoke/stubs/pluginManager.ts \
  --alias:@main/mcp/agentEngineBridge.js=./scripts/resume-fault-smoke/stubs/agentEngineBridge.ts \
  --alias:@main/mcp/toolRules.js=./scripts/resume-fault-smoke/stubs/toolRules.ts \
  --alias:@main/mcp/workflowEngineTools.js=./scripts/resume-fault-smoke/stubs/workflowEngineTools.ts \
  --alias:@main/browser/agentBrowserTools.js=./scripts/resume-fault-smoke/stubs/browserTools.ts \
  --alias:@main/memory/engineTools.js=./scripts/resume-fault-smoke/stubs/engineTools.ts \
  --alias:@main/appControl/engineTools.js=./scripts/resume-fault-smoke/stubs/engineTools.ts \
  --alias:@main/library/engineTools.js=./scripts/resume-fault-smoke/stubs/engineTools.ts \
  --external:./CodexAppServerClient.js \
  --external:./codexBinaryResolve.js \
  --external:./codexProjectScope.js \
  --outfile="$OUT/smoke.mjs" --log-level=error

# ⚠️ 两个变量都是**安全前提**，不是一个指纹：
#   - `MCODE_SMOKE_DATA_ROOT` —— 桩里没设时**直接抛**（指到真数据根 = 拿测试数据盖真库）。
#   - `USERPROFILE` / `HOME` —— provider 会往 homedir()/.mcode 下写 AGENTS.md、读技能矩阵。
export MCODE_SMOKE_DATA_ROOT="$DATA"
HOME="$HOME_DIR" USERPROFILE="$HOME_DIR" node "$OUT/smoke.mjs"
