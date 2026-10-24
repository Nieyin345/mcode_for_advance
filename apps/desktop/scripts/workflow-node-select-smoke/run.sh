#!/usr/bin/env bash
# workflow-node-select-smoke — W3：点节点 → 右侧显示该节点的参数。
#
# 真 React 19 + 真 react-dom + 真 `WorkflowLibraryView`/`NodeInspector` + 真 Chromium
# 点击。判据全部从**真实鼠标点击**开始（CDP Input.dispatchMouseEvent）—— 原
# `workflow-view-smoke` 直接喂 `selectedNodeId: "B"`，绕过了"用户怎么让它变成 B"。
#
# 只换四处模块（api / sessionStore 切片 / libraryStore 空分类 / monacoSetup），
# 见 build.mjs 与 main.tsx 文件头。需要本机已装 Edge/Chrome（browser.mjs 只用自己的
# profile/port，从不 attached 到既有浏览器）。这是 E1 隔离组件证据，不是 U1。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."          # → apps/desktop
OUT=$(mktemp -d /tmp/mcode-workflow-node-select.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"

# ① 真节点类型目录（主进程内置清单；数据根/插件目录/资料库分组换桩，不碰用户环境）。
"$ESBUILD" scripts/workflow-node-select-smoke/metadata.ts \
  --bundle --platform=node --format=cjs \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/workflow-node-select-smoke/pluginManagerStub.ts \
  --alias:@main/library/groupRegistry.js=./scripts/workflow-node-select-smoke/groupRegistryStub.ts \
  --outfile="$OUT/metadata.cjs" --log-level=error

# 生成物落在**临时目录**（与 `settings-form-lifecycle-smoke` 同一取舍）：它只取决于内置
# 清单，但把它提交进版本库会让"清单改了、夹具没更新"看起来像一份正常的旧文件。经环境
# 变量交给 build.mjs（esbuild 的 --alias 只认包名，跨目录读不了仓库里的相对路径）。
node "$OUT/metadata.cjs" "$OUT/catalog.json"
export MCODE_SMOKE_NODE_CATALOG="$(cat "$OUT/catalog.json")"

# ② 构建 + 起浏览器跑断言。
node scripts/workflow-node-select-smoke/build.mjs
