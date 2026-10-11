#!/usr/bin/env bash
# 【MC-057】故障注入 smoke —— Pi SessionManager.open / Codex thread/resume 失败时
# 绝不静默开新底层会话。
#
# 与其它套件的关键差别:这里**驱动真的 provider 类**(不对生产代码做任何改动),只在
# SDK 边界换桩:
#   - 裸 specifier `@earendil-works/pi-coding-agent` → stubs/piSdkLoader.ts 内置的假 SDK;
#   - 相对 import `./piSdkLoader.js` / `./CodexAppServerClient.js` / `./mcodeExtension.js`
#     / `./piSkillBridge.js` / `./codexProjectScope.js` → `--external:` 整条外置,再各
#     打一份同名桩铺在 bundle 旁边(`--alias` 不收相对名,这是仓库验证过的绕法);
#   - 叶子 @main 模块(dataRoot/logger/pluginManager/浏览器工具/…)→ 内存桩,避免拉进
#     electron / sql.js / 真磁盘。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-resume-fault.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-resume-fault-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

# 外置的相对依赖:每条都要单独 esbuild 成同名 .js 铺在 bundle 旁边,并让主 bundle
# `--external` 它。用 `--packages=external` 让裸 specifier(electron 等)也从 bundle
# 位置解析 —— 故先在 OUT 下放一个 node_modules 软链。
ln -s "$PWD/node_modules" "$OUT/node_modules"
# 让铺在 OUT 里的 .js 桩被当作 ES module(否则 node 会对每个文件重解析并打警告)。
printf '{"type":"module"}\n' > "$OUT/package.json"

COMMON=(
  --bundle --platform=node --format=esm
  --tsconfig=tsconfig.json
  --packages=external
  --banner:js="import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fup } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __dirname = __dn(__fup(import.meta.url));"
)

# ── 外置的相对桩:各打一份同名文件 ──
"$ESBUILD" scripts/resume-fault-smoke/stubs/piSdkLoader.ts "${COMMON[@]}" \
  --outfile="$OUT/piSdkLoader.js" --log-level=error
"$ESBUILD" scripts/resume-fault-smoke/CodexAppServerClient.ts "${COMMON[@]}" \
  --outfile="$OUT/CodexAppServerClient.js" --log-level=error
"$ESBUILD" scripts/resume-fault-smoke/mcodeExtension.ts "${COMMON[@]}" \
  --outfile="$OUT/mcodeExtension.js" --log-level=error
"$ESBUILD" scripts/resume-fault-smoke/piSkillBridge.ts "${COMMON[@]}" \
  --outfile="$OUT/piSkillBridge.js" --log-level=error
"$ESBUILD" scripts/resume-fault-smoke/codexProjectScope.ts "${COMMON[@]}" \
  --outfile="$OUT/codexProjectScope.js" --log-level=error

# ── 主 bundle ──
"$ESBUILD" scripts/resume-fault-smoke/main.ts "${COMMON[@]}" \
  --alias:@main/lib/dataRoot.js=./scripts/resume-fault-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/resume-fault-smoke/stubs/logger.ts \
  --alias:@main/store/repositories.js=./scripts/resume-fault-smoke/stubs/repositories.ts \
  --alias:@main/lib/codexModelsStore.js=./scripts/resume-fault-smoke/stubs/codexModelsStore.ts \
  --alias:@main/lib/piModelsStore.js=./scripts/resume-fault-smoke/stubs/piModelsStore.ts \
  --alias:@main/lib/mcpConfig.js=./scripts/resume-fault-smoke/stubs/mcpConfig.ts \
  --alias:@main/lib/mcpEngines.js=./scripts/resume-fault-smoke/stubs/mcpEngines.ts \
  --alias:@main/lib/engineToolPolicy.js=./scripts/resume-fault-smoke/stubs/engineToolPolicy.ts \
  --alias:@main/lib/fileSnapshotRegistry.js=./scripts/resume-fault-smoke/stubs/fileSnapshotRegistry.ts \
  --alias:@main/lib/binaryResolve.js=./scripts/resume-fault-smoke/stubs/binaryResolve.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/resume-fault-smoke/stubs/pluginManager.ts \
  --alias:@main/mcp/agentEngineBridge.js=./scripts/resume-fault-smoke/stubs/agentEngineBridge.ts \
  --alias:@main/mcp/toolRules.js=./scripts/resume-fault-smoke/stubs/toolRules.ts \
  --alias:@main/mcp/workflowEngineTools.js=./scripts/resume-fault-smoke/stubs/workflowEngineTools.ts \
  --alias:@main/browser/agentBrowserTools.js=./scripts/resume-fault-smoke/stubs/browserTools.ts \
  --alias:@main/memory/engineTools.js=./scripts/resume-fault-smoke/stubs/engineTools.ts \
  --alias:@main/appControl/engineTools.js=./scripts/resume-fault-smoke/stubs/engineTools.ts \
  --alias:@main/library/engineTools.js=./scripts/resume-fault-smoke/stubs/engineTools.ts \
  --alias:@main/providers/codex-sdk/codexBinaryResolve.js=./scripts/resume-fault-smoke/stubs/binaryResolve.ts \
  --external:./piSdkLoader.js \
  --external:./CodexAppServerClient.js \
  --external:./mcodeExtension.js \
  --external:./piSkillBridge.js \
  --external:./codexProjectScope.js \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"
node "$OUT/smoke.mjs"
