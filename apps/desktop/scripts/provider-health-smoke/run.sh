#!/usr/bin/env bash
# 【MC-076】Provider 健康探测资源治理回归 —— 超时必须**真的**终止底层 SDK 工作。
#
# 与 resume-fault-smoke 同一套绕法:驱动**真的 provider 类**,只在 SDK 边界换桩。
#   - 裸 specifier `@earendil-works/pi-coding-agent` → 假 SDK;
#   - 相对 import `./piSdkLoader.js` / `./CodexAppServerClient.js` / `./mcodeExtension.js`
#     / `./piSkillBridge.js` / `./codexProjectScope.js` → `--external:` 整条外置,再各打一份
#     同名桩铺在 bundle 旁边(`--alias` 不收相对名);
#   - `@anthropic-ai/claude-agent-sdk` → 假 SDK(记录 iterator.return 调用);
#   - `node:child_process` → 假 execFile(记录 child.kill 调用);
#   - 叶子 @main 模块(dataRoot/logger/pluginManager/…)→ 内存桩,避免拉进 electron / sql.js。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-provider-health.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-provider-health-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

# 外置的相对依赖:每条单独 esbuild 成同名 .js 铺在 bundle 旁边,主 bundle `--external` 它。
# 用 `--packages=external` 让裸 specifier(electron 等)也从 bundle 位置解析 —— 故先软链 node_modules。
ln -s "$PWD/node_modules" "$OUT/node_modules"
printf '{"type":"module"}\n' > "$OUT/package.json"

COMMON=(
  --bundle --platform=node --format=esm
  --tsconfig=tsconfig.json
  --packages=external
  --banner:js="import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fup } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __dirname = __dn(__fup(import.meta.url));"
)

# ── 外置的相对桩:各打一份同名文件 ──
"$ESBUILD" scripts/provider-health-smoke/stubs/piSdkLoader.ts "${COMMON[@]}" \
  --outfile="$OUT/piSdkLoader.js" --log-level=error
"$ESBUILD" scripts/provider-health-smoke/CodexAppServerClient.ts "${COMMON[@]}" \
  --outfile="$OUT/CodexAppServerClient.js" --log-level=error
"$ESBUILD" scripts/provider-health-smoke/mcodeExtension.ts "${COMMON[@]}" \
  --outfile="$OUT/mcodeExtension.js" --log-level=error
"$ESBUILD" scripts/provider-health-smoke/piSkillBridge.ts "${COMMON[@]}" \
  --outfile="$OUT/piSkillBridge.js" --log-level=error
"$ESBUILD" scripts/provider-health-smoke/codexProjectScope.ts "${COMMON[@]}" \
  --outfile="$OUT/codexProjectScope.js" --log-level=error

# ── 主 bundle ──
# 只需最少的叶子桩:真 repositories / 各引擎工具域等模块在这里能正常打包(已在
# 本套件实测);只有会碰 electron / sql.js / 真磁盘或需要注入假 SDK 的边界才换桩。
"$ESBUILD" scripts/provider-health-smoke/main.ts "${COMMON[@]}" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:electron=./scripts/resume-fault-smoke/stubs/electron.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --alias:@main/providers/codex-sdk/codexBinaryResolve.js=./scripts/provider-health-smoke/stubs/codexBinaryResolve.ts \
  --alias:@anthropic-ai/claude-agent-sdk=./scripts/provider-health-smoke/stubs/claudeSdk.ts \
  --alias:node:child_process=./scripts/provider-health-smoke/stubs/childProcess.ts \
  --external:./piSdkLoader.js \
  --external:./CodexAppServerClient.js \
  --external:./mcodeExtension.js \
  --external:./piSkillBridge.js \
  --external:./codexProjectScope.js \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"
node "$OUT/smoke.mjs"
