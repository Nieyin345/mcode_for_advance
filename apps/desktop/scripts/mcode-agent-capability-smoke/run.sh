#!/usr/bin/env bash
# 【W21】`mcode-agent` 的 `capability: "read" | "write"` 在 Node-RED 生产路径上
# **真的生效**没有 —— 与 `mcode-node-pack-ports-smoke`(W19)验的是两个不同的东西:
#
#   - W19 把 `RuntimeManager` 整个换成桩,验「生产端口按约定调了它什么」;
#   - 本套**保留真的 `RuntimeManager` + `ApprovalBridge`**,只把**引擎实现**换成
#     假 provider,验「节点声明的 capability 一路走到 `shouldAutoApprove`,真的改
#     变了这一轮工具调用的审批行为」。
#
# ## 为什么必须是真的 RuntimeManager
#
# 本卡要回答的不是「`setPermissionMode` 被调了没有」(那是参数,不是行为),而是
# 「`permissionMode` 真的影响派发了吗」。这条链在**真身**里跨了四个模块:
#
#   nodePackProductionPorts → RuntimeManager.sendTurn → provider 的 ctx.getPermissionMode
#     → ApprovalBridge.permissionModes → shouldAutoApprove(plan, "Write")
#
# 任何一段都是可被单独改坏的;把任何一段换桩,红/绿都只说明桩的行为。所以这里只有
# 引擎实现是假的(它按真 provider 的方式读 ctx.getPermissionMode 再问 shouldAutoApprove),
# 别的全真。假 provider 的 `startTurn` 里做的判断就是 `ClaudeAgentSdkProvider` 的
# canUseTool 那两步(`ctx.isToolAlwaysAllowed` → `ctx.getPermissionMode` → shouldAutoApprove)。
#
# ## 换桩的边界(只换无头环境给不出来的)
#
#   - `dataRoot` / `logger` —— 真的那两个 import electron;
#   - `electron` —— `store/db.ts`、`lib/secretStore.ts`、`lib/theme.js` 那条;
#   - `window` —— 真的那个拿着 BrowserWindow;本套不验渲染端推送;
#   - `@main/providers/registry.js` —— 真的那个在模块底部**注册三家引擎实现**,那条链
#     会把 SDK、`?raw` 的 `.py` 资源和原生模块全拉进来。桩保留注册表的**真行为**
#     (`register/get/list/getRequired`),只是不预注册;本套注册一个假 provider。
#   - `workflows/seed` / `pluginManager` —— 与 node-live-smoke 同一刀:真身是二十几个
#     Vite `?raw` 导入 / 读插件目录 spawn git,与这条链无关。
#
# ## 真的留下的是
#
#   - `nodePackProductionPorts.ts` 本身(被测);
#   - `RuntimeManager` 单例(真的 bindSession / sendTurn / setPermissionMode);
#   - `ApprovalBridge`(真的 permissionModes Map,由 RuntimeManager 持有);
#   - `shouldAutoApprove`(`mcp/toolRules.ts`,真身);
#   - `SessionRepo` / `ProjectRepo`(sql.js,真库)。
#
# ⚠️ **数据根必须是 `mktemp -d`**:`SessionRepo.create` 内部是 `persist()`,会**重写整个
# `mcode.db`**。指到真库等于毁数据 —— `stubs/dataRoot.ts` 那句「没设环境变量就抛」就是
# 为这件事,别去改它。
#
# ⚠️ `--loader:.md=text` 与 `--external:@renderer/lib/monacoSetup.js` 跟 node-live-smoke
# 同一理由:注册表桩被换掉之后,`runner.ts` 仍会经 `library.ts → builtins.ts →
# nodeTypesSeed.ts` 走到 `?raw` 的 `.md`;而那两句是构建期语法,纯 node 解析不了。
# (本套 import 真 `permissionModeForCapability` —— 卡要求「判据 import 真身」。)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

# ⚠️ **产物目录必须在 `.tmp/` 下,不能是 `/tmp`。** `--external:ssh2` 留着的那条 import
# 要由 node 在**运行时**解析,而它从产物目录**往上**找 `node_modules`。`/tmp` 在 Windows
# 上落到 `%LOCALAPPDATA%\Temp`,从那儿往上找不到仓库里的 `node_modules`
# (`ERR_MODULE_NOT_FOUND: Cannot find package 'ssh2'`)。与 agent-mail-smoke 同一理由。
mkdir -p .tmp
OUT=$(mktemp -d ./.tmp/mcode-agent-capability-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-agent-capability-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$HERE/../lib/esbuild-path.sh"
# `--external:ssh2`(`cpu-features` 是原生 `.node`)+ `genofficeNativeVendor` 换仓里的
# build-only 桩:两条都来自 `toolRules.ts` → 四个 MCP server 的 import 链(见那个文件头
# 「代价是引这个文件会连带解析那四个 server 的依赖链」)。本套要用**真** `shouldAutoApprove`
# —— 判据 import 真身,所以这条链躲不掉;agent-mail-smoke 用同一套两刀。
"$ESBUILD" scripts/mcode-agent-capability-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:@renderer/lib/monacoSetup.js \
  --external:ssh2 \
  --loader:.md=text \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/mcode-agent-capability-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/mcode-agent-capability-smoke/stubs/logger.ts \
  --alias:electron=./scripts/mcode-agent-capability-smoke/stubs/electron.ts \
  --alias:@main/window.js=./scripts/mcode-agent-capability-smoke/stubs/window.ts \
  --alias:@main/providers/registry.js=./scripts/mcode-agent-capability-smoke/stubs/providerRegistry.ts \
  --alias:@main/workflows/seed.js=./scripts/node-session-smoke/stubs/workflowsSeed.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/node-session-smoke/stubs/pluginManager.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
