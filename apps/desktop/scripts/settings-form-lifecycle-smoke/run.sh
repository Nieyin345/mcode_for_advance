#!/usr/bin/env bash
# settings-form-lifecycle-smoke — 【MC-047】设置行的读/存生命周期(loading/ready/error/retry)。
#
# 与 browser-tabs-a11y-smoke 同一套极小 React 运行时(`--alias:react=`),把真
# ShellSection / ScreenshotDirRow / DataDirRow / PersistLoginRow 逐节当根挂载;
# `lib/api.js` 换成可按 key 注入读/写失败的桩。不起浏览器、不写盘。
#
# 【MC-026 复核】追加了三个真实面板(CustomModelsPanel / EngineToolsPanel /
# WorkflowLibraryView purpose=automation)的「读失败可见 / 重试真重发 / 保存失败保留
# 输入」段。自动化那一段的检查器需要**真实节点类型目录** —— 用 metadata.ts 从主进程
# 内置清单生成(与 workflow-ui-smoke 同一手法),数据根与插件目录两个会碰用户环境的
# 模块换桩;生成本身不写用户数据。
set -euo pipefail
cd "$(dirname "$0")/../.."          # → apps/desktop

OUT=$(mktemp -d /tmp/mcode-settings-form-lifecycle.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/settings-form-lifecycle-smoke/metadata.ts \
  --bundle --platform=node --format=cjs \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/settings-form-lifecycle-smoke/pluginManagerStub.ts \
  --alias:@main/library/groupRegistry.js=./scripts/settings-form-lifecycle-smoke/groupRegistryStub.ts \
  --outfile="$OUT/metadata.cjs" --log-level=error

node "$OUT/metadata.cjs" "$OUT/catalog.json"
# 目录经环境变量交给 smoke(esbuild 的 --alias 只认包名;不在仓库里生成文件)。
export MCODE_SMOKE_NODE_CATALOG="$(cat "$OUT/catalog.json")"

"$ESBUILD" scripts/settings-form-lifecycle-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:react=./scripts/settings-form-lifecycle-smoke/fakeReact.ts \
  --alias:react/jsx-runtime=./scripts/settings-form-lifecycle-smoke/jsxRuntime.ts \
  --alias:react-dom=./scripts/ime-enter-smoke/reactDomStub.ts \
  --alias:@tabler/icons-react=./scripts/settings-form-lifecycle-smoke/iconsStub.cjs \
  --alias:@renderer/lib/api.js=./scripts/settings-form-lifecycle-smoke/api-stub.ts \
  --alias:@renderer/lib/monacoSetup.js=./scripts/settings-form-lifecycle-smoke/monacoSetupStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
