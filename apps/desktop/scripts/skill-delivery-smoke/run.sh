#!/usr/bin/env bash
# 【MC-077 / MC-094】三引擎**真实交付**负例回归 —— 驱动真 provider 的 startTurn,
# 断言引擎最终拿到的技能目录/名单(见 main.ts 文件头)。
#
# ## 换桩边界(与 resume-fault-smoke 同一套绕法,已验证可跑)
#   - 驱动**真的** ClaudeAgentSdkProvider / CodexAgentSdkProvider / PiAgentSdkProvider;
#   - 只换掉 SDK 边界:
#       · `@anthropic-ai/claude-agent-sdk` → stubs/claudeSdk.ts(记 options.skills);
#       · `@earendil-works/pi-coding-agent` → stubs/piSdkLoader 里的假 SDK(按真实语义扫根);
#       · 相对 import `./sdkBinaryPath.js` / `./CodexAppServerClient.js` / `./piSdkLoader.js`
#         / `./mcodeExtension.js` / `./codexProjectScope.js` → `--external:` 整条外置,
#         再各打一份同名桩铺在 bundle 旁边(`--alias` 不收相对名);
#       · 叶子 `@main` 模块(dataRoot/logger/repositories/pluginManager…)→ 内存桩,
#         避免拉进 electron / sql.js / 真磁盘。
#   - ⚠️ `./piSkillBridge.js` **不换** —— 本套件要驱动**真的** buildPiSkillLoader
#     (MC-094 的项目根接线就在它里面);它由主 bundle 直接编进来。
#
# ## 隔离(缺一不可)
#   - 数据根 mktemp;用户根(HOME/USERPROFILE)也 mktemp —— defaultSkillsRoot() 拼的是
#     homedir()/.mcode/skills,本套件**真往盘上写**技能与矩阵,指到真家目录就是拿测试
#     数据灌用户的技能库。
#   - main.ts 在任何被测 import **之前**就把 HOME/USERPROFILE 指到临时目录。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-skill-delivery.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-skill-delivery-data.XXXXXX)
HOME_DIR=$(mktemp -d /tmp/mcode-skill-delivery-home.XXXXXX)
trap 'rm -rf "$OUT" "$DATA" "$HOME_DIR"' EXIT
source "$HERE/../lib/esbuild-path.sh"

# `--packages=external` 让裸 specifier(electron 等)从 bundle 位置解析 —— 先软链 node_modules。
source scripts/lib/runtime-node-modules.sh
mcode_link_runtime_node_modules "$OUT" "$PWD/node_modules"
printf '{"type":"module"}\n' > "$OUT/package.json"

COMMON=(
  --bundle --platform=node --format=esm
  --tsconfig=tsconfig.json
  --packages=external
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
)

# ── 外置的相对桩:各打一份同名文件铺在 bundle 旁 ──
"$ESBUILD" scripts/skill-delivery-smoke/stubs/sdkBinaryPath.ts "${COMMON[@]}" \
  --outfile="$OUT/sdkBinaryPath.js" --log-level=error
"$ESBUILD" scripts/skill-delivery-smoke/stubs/CodexAppServerClient.ts "${COMMON[@]}" \
  --outfile="$OUT/CodexAppServerClient.js" --log-level=error
"$ESBUILD" scripts/skill-delivery-smoke/stubs/mcodeExtension.ts "${COMMON[@]}" \
  --outfile="$OUT/mcodeExtension.js" --log-level=error
"$ESBUILD" scripts/skill-delivery-smoke/stubs/codexProjectScope.ts "${COMMON[@]}" \
  --outfile="$OUT/codexProjectScope.js" --log-level=error
# Pi 假 SDK:被 --alias 到包名,也铺一份做 `./piSdkLoader.js` 外置(provider 直接 import 它)。
"$ESBUILD" scripts/skill-delivery-smoke/stubs/piSdkLoader.ts "${COMMON[@]}" \
  --outfile="$OUT/piSdkLoader.js" --log-level=error

# ── 主 bundle ──
"$ESBUILD" scripts/skill-delivery-smoke/main.ts "${COMMON[@]}" \
  --alias:electron=./scripts/resume-fault-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/store/repositories.js=./scripts/skill-delivery-smoke/stubs/repositories.ts \
  --alias:@main/lib/piModelsStore.js=./scripts/resume-fault-smoke/stubs/piModelsStore.ts \
  --alias:@main/lib/codexModelsStore.js=./scripts/resume-fault-smoke/stubs/codexModelsStore.ts \
  --alias:@main/providers/codex-sdk/codexBinaryResolve.js=./scripts/resume-fault-smoke/stubs/binaryResolve.ts \
  --alias:@main/lib/binaryResolve.js=./scripts/resume-fault-smoke/stubs/binaryResolve.ts \
  --alias:@anthropic-ai/claude-agent-sdk=./scripts/skill-delivery-smoke/stubs/claudeSdk.ts \
  --alias:@earendil-works/pi-coding-agent=./scripts/skill-delivery-smoke/stubs/piSdkLoader.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --external:./sdkBinaryPath.js \
  --external:./CodexAppServerClient.js \
  --external:./piSdkLoader.js \
  --external:./mcodeExtension.js \
  --external:./codexProjectScope.js \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_HOME="$HOME_DIR"
export MCODE_SMOKE_DATA_ROOT="$DATA"
HOME="$HOME_DIR" USERPROFILE="$HOME_DIR" node "$OUT/smoke.mjs"
